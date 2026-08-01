import { db, persistenceReady } from "./firebase-config.js";
import {
  doc, collection,
  setDoc, addDoc, deleteDoc, updateDoc,
  query, orderBy, onSnapshot, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ─── State ──────────────────────────────────────────────
let currentUser    = null;
let allTransactions = [];
let budgets        = {};
let allLoans        = [];
let allBorrowings   = [];
let weeklyChart = null, categoryChart = null, budgetChart = null;

// ─── Pending-writes tracking ────────────────────────────
// Track which listeners have pending (unsynced) writes.
// When any listener reports hasPendingWrites, we show the sync badge.
const _pendingSources = new Set();
function _reportPending(source, hasPending) {
  if (hasPending) _pendingSources.add(source);
  else _pendingSources.delete(source);
  const badge = document.getElementById("pendingSyncBadge");
  if (badge) {
    badge.classList.toggle("hidden", _pendingSources.size === 0);
  }
}

// ─── Category config ────────────────────────────────────
const CATEGORIES = {
  food:          { label: "Food & Drinks",          icon: "fa-utensils",    color: "#f97316" },
  transport:     { label: "Transport",              icon: "fa-bus",         color: "#3b82f6" },
  medicine:      { label: "Medicine & Health",      icon: "fa-heart-pulse", color: "#ec4899" },
  accommodation: { label: "Accommodation (Bodim)",  icon: "fa-house",       color: "#8b5cf6" },
  events:        { label: "Events & Entertainment", icon: "fa-ticket",      color: "#f59e0b" },
  travel:        { label: "Travel",                 icon: "fa-plane",       color: "#06b6d4" },
  education:     { label: "Education & Books",      icon: "fa-book",        color: "#10b981" },
  other:         { label: "Other",                  icon: "fa-circle-dot",  color: "#6b7280" },
};

// ─── Helpers ────────────────────────────────────────────
const $    = id => document.getElementById(id);
const fmt  = n  => `LKR ${Number(n).toLocaleString("en-LK", { minimumFractionDigits: 2 })}`;
const todayStr = () => new Date().toISOString().slice(0, 10);

function showToast(msg, color = "var(--primary)") {
  const t = $("toast");
  t.textContent  = msg;
  t.style.background = color;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2800);
}

// ─── Connection Status ──────────────────────────────────
function initConnectionStatus() {
  const statusEl = $("connectionStatus");
  const iconEl   = $("connectionIcon");
  const textEl   = $("connectionText");

  function update() {
    const online = navigator.onLine;
    statusEl.classList.toggle("offline", !online);
    statusEl.classList.toggle("online", online);
    iconEl.className = online ? "fas fa-wifi" : "fas fa-triangle-exclamation";
    textEl.textContent = online ? "Online" : "Offline";
    statusEl.title = online
      ? "Connected to server"
      : "Working offline — changes will sync when back online";
  }

  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

// ─── Safe balance update using increment() ──────────────
// Atomic balance mutation: uses Firestore increment() so multiple
// offline writes don't read stale cached values.
async function adjustBalance(delta) {
  const balRef = doc(db, "users", currentUser.uid, "profile", "balance");
  try {
    await updateDoc(balRef, {
      amount: increment(delta),
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    if (err.code === "not-found") {
      // First-time user: balance doc doesn't exist yet
      await setDoc(balRef, {
        amount: delta,
        updatedAt: new Date().toISOString()
      });
    } else {
      throw err;
    }
  }
}

// ─── Navigation ─────────────────────────────────────────
function initNav() {
  const sections     = document.querySelectorAll(".content-section");
  const navItems     = document.querySelectorAll(".nav-item");
  const titleEl      = $("sectionTitle");
  const sidebar      = $("sidebar");
  const hamburger    = $("hamburger");
  const sidebarClose = $("sidebarClose");

  function showSection(name) {
    sections.forEach(s => s.classList.toggle("active", s.id === `section-${name}`));
    navItems.forEach(a => a.classList.toggle("active", a.dataset.section === name));
    const labels = { overview: "Overview", transactions: "Transactions", analytics: "Analytics", budget: "Budget", loans: "Loans", about: "About Us" };
    if (name === "loans") { renderLoans(); renderBorrowedLoans(); }
    titleEl.textContent = labels[name] || name;
    sidebar.classList.remove("open");
    if (name === "analytics")    renderAnalytics();
    if (name === "budget")       renderBudget();
    if (name === "transactions") renderAllTransactions();

  }

  navItems.forEach(a => a.addEventListener("click", e => { e.preventDefault(); showSection(a.dataset.section); }));

  document.querySelectorAll("[data-section]").forEach(el => {
    if (!el.classList.contains("nav-item"))
      el.addEventListener("click", e => { e.preventDefault(); showSection(el.dataset.section); });
  });

  hamburger.addEventListener("click",    () => sidebar.classList.toggle("open"));
  sidebarClose.addEventListener("click", () => sidebar.classList.remove("open"));

  $("todayDate").textContent = new Date().toLocaleDateString("en-LK", { weekday: "short", month: "short", day: "numeric" });
  $("txDate").value = todayStr();
}

// ─── Form type tabs ─────────────────────────────────────
function initFormTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  tabs.forEach(t => t.addEventListener("click", () => {
    tabs.forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    const catSel = $("txCategory");
    if (t.dataset.type === "income") {
      catSel.innerHTML = `
        <option value="income">Salary / Allowance</option>
        <option value="income">Part-time Job</option>
        <option value="income">Gift / Transfer</option>
        <option value="income">Other Income</option>`;
    } else {
      catSel.innerHTML = Object.entries(CATEGORIES)
        .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
    }
  }));
}

// ─── Balance (real-time) ────────────────────────────────
function listenBalance() {
  const ref = doc(db, "users", currentUser.uid, "profile", "balance");
  onSnapshot(ref, snap => {
    _reportPending("balance", snap.metadata.hasPendingWrites);
    const bal = snap.exists() ? snap.data().amount : 0;
    $("balanceDisplay").textContent = fmt(bal);
    $("balanceSub").textContent = snap.exists()
      ? `Last updated ${new Date(snap.data().updatedAt).toLocaleDateString("en-LK")}`
      : "Set your balance to get started";
  });
}

function initBalanceModal() {
  $("updateBalanceBtn").addEventListener("click", () => {
    $("balanceModal").classList.add("open");
    $("newBalance").focus();
  });
  $("balanceModalClose").addEventListener("click", () => $("balanceModal").classList.remove("open"));
  $("balanceModal").addEventListener("click", e => {
    if (e.target === $("balanceModal")) $("balanceModal").classList.remove("open");
  });

  $("saveBalanceBtn").addEventListener("click", async () => {
    const val = parseFloat($("newBalance").value);
    if (isNaN(val) || val < 0) { showToast("Enter a valid amount", "var(--red)"); return; }
    try {
      await setDoc(doc(db, "users", currentUser.uid, "profile", "balance"), {
        amount: val, updatedAt: new Date().toISOString()
      });
      $("balanceModal").classList.remove("open");
      $("newBalance").value = "";
      showToast("Balance updated!");
    } catch (err) {
      console.error("Balance write error:", err);
      showToast(err.code === "permission-denied" ? "Permission denied — fix Firestore rules" : "Error: " + err.message, "var(--red)");
    }
  });
}

// ─── Add Transaction ────────────────────────────────────
function initAddForm() {
  $("addTransactionForm").addEventListener("submit", async e => {
    e.preventDefault();
    const type     = document.querySelector(".tab-btn.active")?.dataset.type || "expense";
    const amount   = parseFloat($("txAmount").value);
    const category = $("txCategory").value;
    const note     = $("txNote").value.trim();
    const date     = $("txDate").value;

    if (!amount || amount <= 0) { showToast("Enter a valid amount", "var(--red)"); return; }
    if (!date)                  { showToast("Pick a date", "var(--red)"); return; }

    try {
      // Save transaction
      await addDoc(collection(db, "users", currentUser.uid, "transactions"), {
        type, amount, category, note, date, createdAt: new Date().toISOString()
      });

      // Adjust balance atomically (safe for offline queuing)
      await adjustBalance(type === "expense" ? -amount : amount);

      $("addTransactionForm").reset();
      $("txDate").value = todayStr();
      showToast(`${type === "expense" ? "Expense" : "Income"} added!`);
    } catch (err) {
      console.error("Write error:", err);
      if (err.code === "permission-denied") {
        showToast("Permission denied — fix Firestore rules (see console)", "var(--red)");
      } else {
        showToast("Error: " + err.message, "var(--red)");
      }
    }
  });
}

// ─── Listen transactions (real-time) ────────────────────
function listenTransactions() {
  const ref = query(
    collection(db, "users", currentUser.uid, "transactions"),
    orderBy("date", "desc")
  );
  onSnapshot(ref, snap => {
    _reportPending("transactions", snap.metadata.hasPendingWrites);
    allTransactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderOverview();
    // Also refresh whichever section is currently visible
    if ($("section-transactions").classList.contains("active")) renderAllTransactions();
    if ($("section-analytics").classList.contains("active"))    renderAnalytics();
    if ($("section-budget").classList.contains("active"))       renderBudget();
  });
}

// ─── Overview ───────────────────────────────────────────
function renderOverview() {
  const now      = new Date();
  const ym       = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const today    = todayStr();
  const monthTxs = allTransactions.filter(t => t.date.startsWith(ym));

  const income   = monthTxs.filter(t => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const expense  = monthTxs.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const saving   = income - expense;
  const todayExp = allTransactions
    .filter(t => t.type === "expense" && t.date === today)
    .reduce((s, t) => s + t.amount, 0);

  $("monthIncome").textContent  = fmt(income);
  $("monthExpense").textContent = fmt(expense);
  $("monthSaving").textContent  = fmt(saving);
  $("todayExpense").textContent = fmt(todayExp);

  renderCategoryBreakdown(monthTxs);
  renderRecentList(allTransactions.slice(0, 6));
}

function renderCategoryBreakdown(txs) {
  const expenses = txs.filter(t => t.type === "expense");
  const total    = expenses.reduce((s, t) => s + t.amount, 0);
  const byCat    = {};
  expenses.forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
  const sorted   = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const el       = $("categoryList");

  if (!sorted.length) {
    el.innerHTML = `<div class="empty-state"><i class="fas fa-chart-pie"></i>No expenses this month</div>`;
    return;
  }
  el.innerHTML = sorted.map(([cat, amt]) => {
    const cfg = CATEGORIES[cat] || { label: cat, color: "#6b7280" };
    const pct = total ? Math.round((amt / total) * 100) : 0;
    return `
      <div class="category-item">
        <div class="category-row">
          <span class="category-name">
            <span class="category-dot" style="background:${cfg.color}"></span>${cfg.label}
          </span>
          <span class="category-amount">${fmt(amt)}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${pct}%;background:${cfg.color}"></div>
        </div>
      </div>`;
  }).join("");
}

// ─── Transaction cards ──────────────────────────────────
function txIcon(tx) {
  if (tx.type === "income") return `<div class="tx-icon cat-income-bg"><i class="fas fa-arrow-down"></i></div>`;
  const cfg = CATEGORIES[tx.category] || { icon: "fa-circle-dot" };
  return `<div class="tx-icon cat-${tx.category}-bg"><i class="fas ${cfg.icon}"></i></div>`;
}

function txCard(tx) {
  const cfg  = tx.type === "income" ? { label: "Income" } : (CATEGORIES[tx.category] || { label: tx.category });
  const sign = tx.type === "expense" ? "-" : "+";
  return `
    <div class="tx-item">
      ${txIcon(tx)}
      <div class="tx-info">
        <p class="tx-name">${tx.note || cfg.label}</p>
        <p class="tx-meta">${cfg.label} · ${tx.date}</p>
      </div>
      <span class="tx-amount ${tx.type}">${sign}${fmt(tx.amount)}</span>
      <button class="tx-delete" data-id="${tx.id}" data-amount="${tx.amount}" data-type="${tx.type}" title="Delete">
        <i class="fas fa-trash"></i>
      </button>
    </div>`;
}

function renderRecentList(txs) {
  const el = $("recentList");
  el.innerHTML = txs.length
    ? txs.map(txCard).join("")
    : `<div class="empty-state"><i class="fas fa-receipt"></i>No transactions yet</div>`;
  attachDeleteHandlers(el);
}

function renderAllTransactions() {
  const el          = $("allTransactionsList");
  const catFilter   = $("filterCategory").value;
  const typeFilter  = $("filterType").value;
  const monthFilter = $("filterMonth").value;

  let txs = [...allTransactions];
  if (catFilter  !== "all") txs = txs.filter(t => t.category === catFilter);
  if (typeFilter !== "all") txs = txs.filter(t => t.type     === typeFilter);
  if (monthFilter)          txs = txs.filter(t => t.date.startsWith(monthFilter));

  el.innerHTML = txs.length
    ? txs.map(txCard).join("")
    : `<div class="empty-state"><i class="fas fa-filter"></i>No transactions match the filter</div>`;
  attachDeleteHandlers(el);
}

function attachDeleteHandlers(container) {
  container.querySelectorAll(".tx-delete").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this transaction?")) return;
      const id     = btn.dataset.id;
      const amount = parseFloat(btn.dataset.amount);
      const type   = btn.dataset.type;

      await deleteDoc(doc(db, "users", currentUser.uid, "transactions", id));

      // Reverse the balance effect atomically
      await adjustBalance(type === "expense" ? amount : -amount);

      showToast("Transaction deleted", "var(--red)");
    });
  });
}

// ─── Filters ────────────────────────────────────────────
function initFilters() {
  ["filterCategory", "filterType", "filterMonth"].forEach(id => {
    $(id)?.addEventListener("change", renderAllTransactions);
  });
  const now = new Date();
  $("filterMonth").value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
}

// ─── Excel Export ────────────────────────────────────────
function initExport() {
  const now = new Date();
  $("exportMonth").value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;

  $("exportBtn").addEventListener("click", () => {
    $("exportModal").classList.add("open");
  });
  $("exportModalClose").addEventListener("click", () => $("exportModal").classList.remove("open"));
  $("exportModal").addEventListener("click", e => {
    if (e.target === $("exportModal")) $("exportModal").classList.remove("open");
  });

  $("downloadExcelBtn").addEventListener("click", () => {
    const XLSX = window.XLSX;
    if (!XLSX) { showToast("Excel library not loaded, please refresh", "var(--red)"); return; }

    const ym = $("exportMonth").value;
    if (!ym) { showToast("Please select a month", "var(--red)"); return; }

    const [yearStr, monthStr] = ym.split("-");
    const yearNum  = parseInt(yearStr);
    const monthNum = parseInt(monthStr);  // 1-based
    const monthName = new Date(yearNum, monthNum - 1, 1)
      .toLocaleString("en-LK", { month: "long", year: "numeric" });
    const txs = allTransactions.filter(t => t.date.startsWith(ym));

    if (!txs.length) { showToast("No transactions for selected month", "var(--red)"); return; }

    const wb = XLSX.utils.book_new();

    // ── Sheet 1: All Transactions ──
    if ($("chkTransactions").checked) {
      const rows = [["Date", "Type", "Category", "Note", "Amount (LKR)"]];
      [...txs].sort((a, b) => a.date.localeCompare(b.date)).forEach(t => {
        const cat = t.type === "income" ? "Income" : (CATEGORIES[t.category]?.label || t.category);
        rows.push([t.date, t.type.charAt(0).toUpperCase() + t.type.slice(1), cat, t.note || "", t.amount]);
      });
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = [{ wch: 14 }, { wch: 10 }, { wch: 26 }, { wch: 28 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(wb, ws, "Transactions");
    }

    // ── Sheet 2: Monthly Summary ──
    if ($("chkSummary").checked) {
      const income  = txs.filter(t => t.type === "income").reduce((s, t) => s + t.amount, 0);
      const expense = txs.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
      const saving  = income - expense;
      const rows = [
        ["Monthly Summary — " + monthName],
        [],
        ["Metric", "Amount (LKR)"],
        ["Total Income",        income],
        ["Total Expenses",      expense],
        ["Net Savings",         saving],
        ["Savings Rate",        income > 0 ? `${((saving / income) * 100).toFixed(1)}%` : "0%"],
        ["No. of Transactions", txs.length],
      ];
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = [{ wch: 24 }, { wch: 18 }];
      XLSX.utils.book_append_sheet(wb, ws, "Monthly Summary");
    }

    // ── Sheet 3: Weekly Breakdown ──
    if ($("chkWeekly").checked) {
      const daysInMonth = new Date(yearNum, monthNum, 0).getDate();
      const weeks = [
        { label: "Week 1", from: 1,  to: 7           },
        { label: "Week 2", from: 8,  to: 14          },
        { label: "Week 3", from: 15, to: 21          },
        { label: "Week 4", from: 22, to: daysInMonth },
      ];
      const rows = [["Week", "Income (LKR)", "Expenses (LKR)", "Savings (LKR)"]];
      weeks.forEach(w => {
        const wTxs = txs.filter(t => { const d = parseInt(t.date.slice(8)); return d >= w.from && d <= w.to; });
        const inc  = wTxs.filter(t => t.type === "income").reduce((s, t) => s + t.amount, 0);
        const exp  = wTxs.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
        rows.push([w.label, inc, exp, inc - exp]);
      });
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = [{ wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(wb, ws, "Weekly Breakdown");
    }

    // ── Sheet 4: Category Breakdown ──
    if ($("chkCategory").checked) {
      const expenses = txs.filter(t => t.type === "expense");
      const total    = expenses.reduce((s, t) => s + t.amount, 0);
      const byCat    = {};
      expenses.forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
      const rows = [["Category", "Amount (LKR)", "% of Total"]];
      Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([cat, amt]) => {
        rows.push([
          CATEGORIES[cat]?.label || cat,
          amt,
          total > 0 ? `${((amt / total) * 100).toFixed(1)}%` : "0%"
        ]);
      });
      rows.push([], ["TOTAL EXPENSES", total, "100%"]);
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = [{ wch: 26 }, { wch: 16 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, "Category Breakdown");
    }

    const fileName = `UniWallet_${monthName.replace(/\s+/g, "_")}.xlsx`;
    XLSX.writeFile(wb, fileName);
    $("exportModal").classList.remove("open");
    showToast(`Downloaded ${fileName}`);
  });
}

// ─── Analytics ──────────────────────────────────────────
function renderAnalytics() {
  const now      = new Date();
  const ym       = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const monthTxs = allTransactions.filter(t => t.date.startsWith(ym));
  renderWeeklyChart(monthTxs, now);
  renderCategoryChart(monthTxs);
  renderWeeklySummary(monthTxs, now);
}

function getWeekBuckets(txs, month) {
  const year        = month.getFullYear();
  const mon         = month.getMonth();
  const daysInMonth = new Date(year, mon + 1, 0).getDate();
  const weeks       = [
    { label: "Week 1", from: 1,  to: 7            },
    { label: "Week 2", from: 8,  to: 14           },
    { label: "Week 3", from: 15, to: 21           },
    { label: "Week 4", from: 22, to: daysInMonth  },
  ];
  return weeks.map(w => {
    const wTxs   = txs.filter(t => { const d = parseInt(t.date.slice(8)); return d >= w.from && d <= w.to; });
    const expense = wTxs.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
    const income  = wTxs.filter(t => t.type === "income").reduce((s, t) => s + t.amount, 0);
    return { label: w.label, expense, income, saving: income - expense };
  });
}

function renderWeeklyChart(txs, month) {
  const ctx   = document.getElementById("weeklyChart").getContext("2d");
  const weeks = getWeekBuckets(txs, month);
  if (weeklyChart) weeklyChart.destroy();
  weeklyChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: weeks.map(w => w.label),
      datasets: [
        { label: "Expenses", data: weeks.map(w => w.expense),            backgroundColor: "rgba(248,113,113,0.75)", borderRadius: 6 },
        { label: "Income",   data: weeks.map(w => w.income),             backgroundColor: "rgba(74,222,128,0.75)",  borderRadius: 6 },
        { label: "Savings",  data: weeks.map(w => Math.max(0, w.saving)),backgroundColor: "rgba(124,110,255,0.75)", borderRadius: 6 },
      ]
    },
    options: chartOptions("LKR")
  });
}

function renderCategoryChart(txs) {
  const ctx      = document.getElementById("categoryChart").getContext("2d");
  const expenses = txs.filter(t => t.type === "expense");
  const byCat    = {};
  expenses.forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
  const entries  = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  if (categoryChart) categoryChart.destroy();
  categoryChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: entries.map(([c]) => CATEGORIES[c]?.label || c),
      datasets: [{
        data: entries.map(([, v]) => v),
        backgroundColor: entries.map(([c]) => CATEGORIES[c]?.color || "#6b7280"),
        borderWidth: 0, hoverOffset: 8,
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "right", labels: { color: "#8888aa", font: { family: "Inter", size: 12 }, padding: 12 } },
        tooltip: { callbacks: { label: ctx => ` LKR ${ctx.parsed.toLocaleString("en-LK", { minimumFractionDigits: 2 })}` } }
      },
      cutout: "65%",
    }
  });
}

function renderWeeklySummary(txs, month) {
  const weeks = getWeekBuckets(txs, month);
  $("weeklySummary").innerHTML = weeks.map(w => `
    <div class="week-card">
      <p class="week-label">${w.label}</p>
      <div class="week-stat"><span>Income</span>  <span class="pos">${fmt(w.income)}</span></div>
      <div class="week-stat"><span>Expenses</span><span class="neg">${fmt(w.expense)}</span></div>
      <div class="week-stat"><span>Savings</span> <span class="${w.saving >= 0 ? "pos" : "neg"}">${fmt(w.saving)}</span></div>
    </div>`).join("");
}

function chartOptions(yLabel) {
  return {
    responsive: true,
    plugins: {
      legend: { labels: { color: "#8888aa", font: { family: "Inter", size: 12 } } },
      tooltip: { callbacks: { label: ctx => ` LKR ${(ctx.parsed.y ?? 0).toLocaleString("en-LK", { minimumFractionDigits: 2 })}` } }
    },
    scales: {
      x: { ticks: { color: "#8888aa" }, grid: { color: "rgba(255,255,255,0.05)" } },
      y: { ticks: { color: "#8888aa", callback: v => `LKR ${v.toLocaleString("en-LK")}` }, grid: { color: "rgba(255,255,255,0.05)" } }
    }
  };
}

// ─── Budget ─────────────────────────────────────────────
function listenBudgets() {
  const ref = doc(db, "users", currentUser.uid, "profile", "budgets");
  onSnapshot(ref, snap => {
    _reportPending("budgets", snap.metadata.hasPendingWrites);
    budgets = snap.exists() ? snap.data() : {};
    if ($("section-budget").classList.contains("active")) renderBudget();
  });
}

function renderBudget() {
  const now     = new Date();
  const ym      = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const monthly = allTransactions.filter(t => t.type === "expense" && t.date.startsWith(ym));
  const byCat   = {};
  monthly.forEach(t => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });

  $("budgetList").innerHTML = Object.entries(CATEGORIES).map(([cat, cfg]) => {
    const actual    = byCat[cat] || 0;
    const limit     = budgets[cat] || 0;
    const over      = limit > 0 && actual > limit;
    const statusTxt = limit > 0
      ? (over ? `Over by LKR ${(actual - limit).toFixed(2)}` : `Under by LKR ${(limit - actual).toFixed(2)}`)
      : "";
    return `
      <div class="budget-item">
        <label><i class="fas ${cfg.icon}" style="color:${cfg.color};width:18px;margin-right:6px"></i>${cfg.label}</label>
        <input class="budget-input" type="number" data-cat="${cat}" value="${limit || ""}" placeholder="No limit" min="0" step="0.01" />
        <span class="budget-actual">Spent: ${fmt(actual)}</span>
        ${statusTxt ? `<span class="budget-status ${over ? "over" : "ok"}">${statusTxt}</span>` : ""}
      </div>`;
  }).join("");

  renderBudgetChart(byCat);

  $("saveBudgetBtn").onclick = async () => {
    const newBudgets = {};
    document.querySelectorAll(".budget-input").forEach(inp => {
      if (inp.value) newBudgets[inp.dataset.cat] = parseFloat(inp.value);
    });
    await setDoc(doc(db, "users", currentUser.uid, "profile", "budgets"), newBudgets);
    showToast("Budget saved!");
  };
}

function renderBudgetChart(byCat) {
  const cats    = Object.keys(CATEGORIES);
  const ctx     = document.getElementById("budgetChart").getContext("2d");
  if (budgetChart) budgetChart.destroy();
  budgetChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: cats.map(c => CATEGORIES[c].label),
      datasets: [
        { label: "Spent",  data: cats.map(c => byCat[c] || 0),   backgroundColor: cats.map(c => CATEGORIES[c].color + "cc"), borderRadius: 6 },
        { label: "Budget", data: cats.map(c => budgets[c] || 0), backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 6, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)" },
      ]
    },
    options: {
      ...chartOptions("LKR"),
      indexAxis: "y",
      scales: {
        x: { ticks: { color: "#8888aa", callback: v => `LKR ${v.toLocaleString("en-LK")}` }, grid: { color: "rgba(255,255,255,0.05)" } },
        y: { ticks: { color: "#8888aa", font: { size: 11 } }, grid: { color: "rgba(255,255,255,0.05)" } }
      }
    }
  });
}

// ─── Feedback Form (Web3Forms) ──────────────────────────
function initFeedbackForm(user) {
  const form = $("feedbackForm");
  if (!form) return;

  const nameInput = $("feedbackName");
  const savedName = localStorage.getItem("uw_display_name");
  nameInput.value = savedName || user.displayName || "";

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("feedbackSubmitBtn");
    const name = $("feedbackName").value.trim();
    const message = $("feedbackMessage").value.trim();

    if (!name || !message) {
      showToast("Please fill in all fields", "var(--red)");
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';

    try {
      const res = await fetch("https://api.web3forms.com/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_key: "a208fa1b-8d24-405d-9d41-c31a93fc73be",
          subject: "UniWallet Feedback from " + name,
          from_name: name,
          email: user.email || "noreply@uniwallet.app",
          message: message,
          botcheck: ""
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast("Feedback sent! Thank you");
        $("feedbackMessage").value = "";
      } else {
        showToast("Failed to send. Try again.", "var(--red)");
      }
    } catch (err) {
      showToast("Network error. Please try again.", "var(--red)");
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Feedback';
    }
  });
}

// ─── Bootstrap ──────────────────────────────────────────
window.addEventListener("userReady", ({ detail: { user } }) => {
  currentUser = user;
  initConnectionStatus();
  initNav();
  initFormTabs();
  initBalanceModal();
  initAddForm();
  initFilters();
  initExport();
  initAbout(user);
  initFeedbackForm(user);
  initAddLoanModal();
  initRecordPaymentModal();
  initLoanTabs();
  initAddBorrowedModal();
  initRecordRepaymentModal();
  listenBalance();
  listenBudgets();
  listenTransactions();
  listenLoans();
  listenBorrowings();
});

// ─── About Us — profile & name change ───────────────────
function initAbout(user) {
  const avatar = $("aboutAvatar");
  const nameEl = $("aboutDisplayName");
  const emailEl = $("aboutEmail");

  if (avatar) avatar.src = user.photoURL || "";

  const savedName = localStorage.getItem("uw_display_name");
  const displayName = savedName || user.displayName || user.email;
  if (nameEl)  nameEl.textContent  = displayName;
  if (emailEl) emailEl.textContent = user.email;

  // also update sidebar name if user has a custom name saved
  if (savedName) {
    const un = $("userName");
    if (un) un.textContent = savedName;
  }

  const modal    = $("changeNameModal");
  const closeBtn = $("changeNameModalClose");
  const input    = $("newDisplayName");
  const saveBtn  = $("saveDisplayNameBtn");
  const openBtn  = $("changeNameBtn");

  if (!modal) return;

  openBtn?.addEventListener("click", () => {
    input.value = localStorage.getItem("uw_display_name") || user.displayName || "";
    modal.classList.add("open");
  });
  closeBtn?.addEventListener("click", () => modal.classList.remove("open"));
  modal.addEventListener("click", e => { if (e.target === modal) modal.classList.remove("open"); });

  saveBtn?.addEventListener("click", () => {
    const name = input.value.trim();
    if (!name) return;
    localStorage.setItem("uw_display_name", name);
    if (nameEl) nameEl.textContent = name;
    const un = $("userName");
    if (un) un.textContent = name;
    modal.classList.remove("open");
    showToast("Display name updated!");
  });
}

// ─── Loans ──────────────────────────────────────────────
function listenLoans() {
  const ref = query(
    collection(db, "users", currentUser.uid, "loans"),
    orderBy("createdAt", "desc")
  );
  onSnapshot(ref, snap => {
    _reportPending("loans", snap.metadata.hasPendingWrites);
    allLoans = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if ($("section-loans").classList.contains("active")) renderLoans();
  });
}

function renderLoans() {
  const pending = allLoans.filter(l => l.status === "pending");
  const settled = allLoans.filter(l => l.status === "settled");

  // Lent summary stats
  const totalLent     = allLoans.reduce((s, l) => s + l.totalAmount, 0);
  const totalPending  = pending.reduce((s, l) => s + l.remainingAmount, 0);

  $("loanTotalLent").textContent     = fmt(totalLent);
  $("loanTotalPending").textContent  = fmt(totalPending);

  // Borrowed summary stats
  const totalBorrowed   = allBorrowings.reduce((s, l) => s + l.totalAmount, 0);
  const borrowPending   = allBorrowings.filter(l => l.status === "pending").reduce((s, l) => s + l.remainingAmount, 0);
  $("borrowTotalBorrowed").textContent = fmt(totalBorrowed);
  $("borrowTotalPending").textContent  = fmt(borrowPending);

  // Group pending loans by friend name
  const groupedPending = groupPendingByFriend(pending);

  // Pending list
  const pendingEl = $("pendingLoansList");
  if (!groupedPending.length) {
    pendingEl.innerHTML = `<div class="empty-state"><i class="fas fa-handshake"></i>No pending loans</div>`;
  } else {
    pendingEl.innerHTML = groupedPending.map(groupedLoanCard).join("");
    attachLoanHandlers(pendingEl);
  }

  // Settled list
  const settledEl = $("settledLoansList");
  $("settledCount").textContent = `${settled.length} settled`;
  if (!settled.length) {
    settledEl.innerHTML = `<div class="empty-state"><i class="fas fa-check-circle"></i>No settled loans yet</div>`;
  } else {
    settledEl.innerHTML = settled.map(settledLoanCard).join("");
    attachLoanDeleteHandlers(settledEl);
  }
}

// Group pending loans by friend name into combined entries
function groupPendingByFriend(pendingLoans) {
  const friendMap = {};
  pendingLoans.forEach(loan => {
    const name = loan.friendName;
    if (!friendMap[name]) {
      friendMap[name] = {
        friendName: name,
        loanIds: [],
        totalAmount: 0,
        remainingAmount: 0,
        payments: [],
        loanEntries: [],
        affectBalance: false,
        latestDate: loan.date,
      };
    }
    const group = friendMap[name];
    group.loanIds.push(loan.id);
    group.totalAmount += loan.totalAmount;
    group.remainingAmount += loan.remainingAmount;
    group.payments.push(...(loan.payments || []));
    if (loan.affectBalance) group.affectBalance = true;

    // Collect individual loan entries for history display
    // Use loanEntries if available (merged loans), otherwise create from the loan itself
    if (loan.loanEntries && loan.loanEntries.length) {
      group.loanEntries.push(...loan.loanEntries);
    } else {
      group.loanEntries.push({
        amount: loan.totalAmount,
        date: loan.date,
        note: loan.note || "",
        createdAt: loan.createdAt
      });
    }

    // Track the latest date
    if (loan.date > group.latestDate) group.latestDate = loan.date;
  });

  // Sort payments by date
  Object.values(friendMap).forEach(g => {
    g.payments.sort((a, b) => a.date.localeCompare(b.date));
    g.loanEntries.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  });

  return Object.values(friendMap);
}

function groupedLoanCard(group) {
  const pct = group.totalAmount > 0
    ? Math.round(((group.totalAmount - group.remainingAmount) / group.totalAmount) * 100)
    : 0;

  // Loan entries history (individual loans given to this person)
  const entriesHtml = (group.loanEntries && group.loanEntries.length > 1)
    ? `<div class="loan-entries">
         <p class="loan-entries-title"><i class="fas fa-layer-group"></i> Loan History</p>
         ${group.loanEntries.map(e => `
            <div class="loan-entry-item">
              <span>${e.date}</span>
              <span class="loan-payment-note">${e.note || ""}</span>
              <span class="neg">+${fmt(e.amount)}</span>
            </div>`).join("")}
       </div>`
    : "";

  // Payment history
  const paymentsHtml = (group.payments && group.payments.length)
    ? `<div class="loan-payments">
         <p class="loan-payments-title"><i class="fas fa-history"></i> Payment History</p>
         ${group.payments.map(p => `
            <div class="loan-payment-item">
              <span>${p.date}</span>
              <span class="loan-payment-note">${p.note || ""}</span>
              <span class="pos">+${fmt(p.amount)}</span>
            </div>`).join("")}
       </div>`
    : "";

  // All loan IDs for delete (comma-separated)
  const allIds = group.loanIds.join(",");
  const loanCountLabel = group.loanEntries.length > 1
    ? `<span class="loan-count-badge">${group.loanEntries.length} loans combined</span>`
    : "";

  return `
    <div class="loan-card">
      <div class="loan-card-top">
        <div class="loan-avatar"><i class="fas fa-user"></i></div>
        <div class="loan-info">
          <p class="loan-friend">${group.friendName} ${loanCountLabel}</p>
          <p class="loan-date"><i class="fas fa-calendar"></i> Latest: ${group.latestDate}</p>
        </div>
        <div class="loan-amounts">
          <p class="loan-remaining">Pending: <strong>${fmt(group.remainingAmount)}</strong></p>
          <p class="loan-total-small">of ${fmt(group.totalAmount)}</p>
        </div>
      </div>
      <div class="loan-progress">
        <div class="loan-progress-bar">
          <div class="loan-progress-fill" style="width:${pct}%"></div>
        </div>
        <span class="loan-pct">${pct}% returned</span>
      </div>
      ${entriesHtml}
      ${paymentsHtml}
      <div class="loan-actions">
        <button class="btn btn-loan-pay" data-ids="${allIds}" data-name="${group.friendName}" data-remaining="${group.remainingAmount}">
          <i class="fas fa-money-bill-wave"></i> Record Payment
        </button>
        <button class="btn btn-loan-delete" data-ids="${allIds}" title="Delete all loans for ${group.friendName}">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>`;
}

function settledLoanCard(loan) {
  return `
    <div class="loan-card settled">
      <div class="loan-card-top">
        <div class="loan-avatar settled-avatar"><i class="fas fa-check"></i></div>
        <div class="loan-info">
          <p class="loan-friend">${loan.friendName}</p>
          <p class="loan-date"><i class="fas fa-calendar"></i> ${loan.date}${loan.note ? ` · ${loan.note}` : ""}</p>
        </div>
        <div class="loan-amounts">
          <p class="loan-settled-amount">${fmt(loan.totalAmount)}</p>
          <p class="loan-settled-label">Fully returned</p>
        </div>
      </div>
      <div class="loan-actions">
        <button class="btn btn-loan-delete" data-id="${loan.id}" title="Delete loan">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>`;
}

function attachLoanHandlers(container) {
  container.querySelectorAll(".btn-loan-pay").forEach(btn => {
    btn.addEventListener("click", () => {
      const ids       = btn.dataset.ids.split(",");
      const name      = btn.dataset.name;
      const remaining = parseFloat(btn.dataset.remaining);
      // Store all loan IDs for this grouped friend
      $("paymentLoanId").value        = ids.join(",");
      $("paymentFriendName").textContent = name;
      $("paymentRemaining").textContent  = `Remaining: ${fmt(remaining)}`;
      $("paymentAmount").max = remaining;
      $("paymentDate").value = todayStr();
      $("paymentNote").value = "";
      $("paymentAmount").value = "";
      // Auto-check the balance toggle if any of the loans was deducted from balance
      const anyAffect = ids.some(id => {
        const loan = allLoans.find(l => l.id === id);
        return loan?.affectBalance;
      });
      $("paymentAffectBalance").checked = anyAffect;
      $("recordPaymentModal").classList.add("open");
      $("paymentAmount").focus();
    });
  });
  attachLoanDeleteHandlers(container);
}

function attachLoanDeleteHandlers(container) {
  container.querySelectorAll(".btn-loan-delete").forEach(btn => {
    btn.addEventListener("click", async () => {
      // Support both single ID (settled) and multiple IDs (grouped pending)
      const ids = (btn.dataset.ids || btn.dataset.id || "").split(",").filter(Boolean);
      if (!ids.length) return;
      const msg = ids.length > 1 ? "Delete all loan records for this person?" : "Delete this loan record?";
      if (!confirm(msg)) return;
      for (const id of ids) {
        await deleteDoc(doc(db, "users", currentUser.uid, "loans", id));
      }
      showToast(ids.length > 1 ? "All loans deleted" : "Loan deleted", "var(--red)");
    });
  });
}

// ─── Add Loan Modal ─────────────────────────────────────
function getUniqueFriends() {
  // Build a map of unique friend names with their loan summary
  const friendMap = {};
  allLoans.forEach(loan => {
    const name = loan.friendName;
    if (!friendMap[name]) {
      friendMap[name] = { name, pendingCount: 0, settledCount: 0, totalPending: 0 };
    }
    if (loan.status === "pending") {
      friendMap[name].pendingCount++;
      friendMap[name].totalPending += loan.remainingAmount;
    } else {
      friendMap[name].settledCount++;
    }
  });
  return Object.values(friendMap);
}

function renderFriendSuggestions(filter = "") {
  const suggestionsEl = $("loanFriendSuggestions");
  const friends = getUniqueFriends();
  const query = filter.toLowerCase().trim();

  // Filter friends by typed text
  const filtered = query
    ? friends.filter(f => f.name.toLowerCase().includes(query))
    : friends;

  if (!filtered.length) {
    suggestionsEl.classList.remove("show");
    return;
  }

  suggestionsEl.innerHTML = filtered.map(f => {
    const initial = f.name.charAt(0).toUpperCase();
    const hasPending = f.pendingCount > 0;
    const badgeText = hasPending
      ? `${f.pendingCount} pending · ${fmt(f.totalPending)}`
      : `${f.settledCount} settled`;
    const badgeClass = hasPending ? "" : "settled";

    return `
      <div class="friend-suggestion" data-name="${f.name}">
        <div class="friend-suggest-avatar">${initial}</div>
        <div class="friend-suggest-info">
          <span class="friend-suggest-name">${f.name}</span>
          <span class="friend-suggest-detail">${f.pendingCount + f.settledCount} loan${(f.pendingCount + f.settledCount) > 1 ? "s" : ""}</span>
        </div>
        <span class="friend-suggest-badge ${badgeClass}">${badgeText}</span>
      </div>`;
  }).join("");

  suggestionsEl.classList.add("show");

  // Attach click handlers to suggestions
  suggestionsEl.querySelectorAll(".friend-suggestion").forEach(el => {
    el.addEventListener("click", () => {
      $("loanFriendName").value = el.dataset.name;
      suggestionsEl.classList.remove("show");
      $("loanAmount").focus();
    });
  });
}

function initAddLoanModal() {
  const friendInput = $("loanFriendName");
  const suggestionsEl = $("loanFriendSuggestions");

  $("addLoanBtn").addEventListener("click", () => {
    $("addLoanForm").reset();
    $("loanDate").value = todayStr();
    $("addLoanModal").classList.add("open");
    friendInput.focus();
    // Show all friends when modal opens (if any exist)
    setTimeout(() => renderFriendSuggestions(""), 50);
  });
  $("addLoanModalClose").addEventListener("click", () => {
    $("addLoanModal").classList.remove("open");
    suggestionsEl.classList.remove("show");
  });
  $("addLoanModal").addEventListener("click", e => {
    if (e.target === $("addLoanModal")) {
      $("addLoanModal").classList.remove("open");
      suggestionsEl.classList.remove("show");
    }
  });

  // Show/filter suggestions on input
  friendInput.addEventListener("input", () => {
    renderFriendSuggestions(friendInput.value);
  });

  // Show suggestions on focus (if there are existing friends)
  friendInput.addEventListener("focus", () => {
    renderFriendSuggestions(friendInput.value);
  });

  // Keyboard navigation for suggestions
  friendInput.addEventListener("keydown", (e) => {
    const items = suggestionsEl.querySelectorAll(".friend-suggestion");
    if (!items.length || !suggestionsEl.classList.contains("show")) return;

    const current = suggestionsEl.querySelector(".friend-suggestion.active");
    let idx = Array.from(items).indexOf(current);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (current) current.classList.remove("active");
      idx = (idx + 1) % items.length;
      items[idx].classList.add("active");
      items[idx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (current) current.classList.remove("active");
      idx = idx <= 0 ? items.length - 1 : idx - 1;
      items[idx].classList.add("active");
      items[idx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      friendInput.value = current.dataset.name;
      suggestionsEl.classList.remove("show");
      $("loanAmount").focus();
    } else if (e.key === "Escape") {
      suggestionsEl.classList.remove("show");
    }
  });

  // Hide suggestions when clicking outside
  document.addEventListener("click", (e) => {
    if (!$("loanFriendWrap")?.contains(e.target)) {
      suggestionsEl.classList.remove("show");
    }
  });

  $("addLoanForm").addEventListener("submit", async e => {
    e.preventDefault();
    const friendName     = friendInput.value.trim();
    const amount         = parseFloat($("loanAmount").value);
    const date           = $("loanDate").value;
    const note           = $("loanNote").value.trim();
    const affectBalance  = $("loanAffectBalance").checked;

    if (!friendName) { showToast("Enter friend's name", "var(--red)"); return; }
    if (!amount || amount <= 0) { showToast("Enter a valid amount", "var(--red)"); return; }
    if (!date) { showToast("Pick a date", "var(--red)"); return; }

    try {
      // Check if this friend already has a pending loan — merge if so
      const existingLoan = allLoans.find(
        l => l.friendName.toLowerCase() === friendName.toLowerCase() && l.status === "pending"
      );

      if (existingLoan) {
        // Merge into existing pending loan
        const newTotal     = existingLoan.totalAmount + amount;
        const newRemaining = existingLoan.remainingAmount + amount;
        const existingEntries = existingLoan.loanEntries || [{
          amount: existingLoan.totalAmount,
          date: existingLoan.date,
          note: existingLoan.note || "",
          createdAt: existingLoan.createdAt
        }];
        const newEntries = [...existingEntries, {
          amount,
          date,
          note,
          createdAt: new Date().toISOString()
        }];

        await updateDoc(doc(db, "users", currentUser.uid, "loans", existingLoan.id), {
          totalAmount: newTotal,
          remainingAmount: newRemaining,
          loanEntries: newEntries,
          affectBalance: existingLoan.affectBalance || affectBalance,
        });

        // Deduct from balance if toggle is on
        if (affectBalance) {
          await adjustBalance(-amount);
        }

        $("addLoanModal").classList.remove("open");
        suggestionsEl.classList.remove("show");
        showToast(affectBalance
          ? `${fmt(amount)} added to ${friendName}'s loan & balance deducted!`
          : `${fmt(amount)} added to ${friendName}'s existing loan!`);

      } else {
        // Create new loan document
        await addDoc(collection(db, "users", currentUser.uid, "loans"), {
          friendName,
          totalAmount: amount,
          remainingAmount: amount,
          date,
          note,
          payments: [],
          loanEntries: [{ amount, date, note, createdAt: new Date().toISOString() }],
          status: "pending",
          affectBalance,
          createdAt: new Date().toISOString()
        });

        // Deduct from main balance if toggle is on
        if (affectBalance) {
          await adjustBalance(-amount);
        }

        $("addLoanModal").classList.remove("open");
        suggestionsEl.classList.remove("show");
        showToast(affectBalance
          ? `Loan to ${friendName} added & balance deducted!`
          : `Loan to ${friendName} added!`);
      }
    } catch (err) {
      console.error("Loan write error:", err);
      showToast("Error: " + err.message, "var(--red)");
    }
  });
}

// ─── Record Payment Modal ───────────────────────────────
function initRecordPaymentModal() {
  $("recordPaymentModalClose").addEventListener("click", () => $("recordPaymentModal").classList.remove("open"));
  $("recordPaymentModal").addEventListener("click", e => {
    if (e.target === $("recordPaymentModal")) $("recordPaymentModal").classList.remove("open");
  });

  $("recordPaymentForm").addEventListener("submit", async e => {
    e.preventDefault();
    const loanIdsStr    = $("paymentLoanId").value;
    const loanIds       = loanIdsStr.split(",").filter(Boolean);
    const amount        = parseFloat($("paymentAmount").value);
    const date          = $("paymentDate").value;
    const note          = $("paymentNote").value.trim();
    const affectBalance = $("paymentAffectBalance").checked;

    if (!amount || amount <= 0) { showToast("Enter a valid amount", "var(--red)"); return; }
    if (!date) { showToast("Pick a date", "var(--red)"); return; }

    // Calculate total remaining across all loan documents for this friend
    const friendLoans = loanIds.map(id => allLoans.find(l => l.id === id)).filter(Boolean);
    const totalRemaining = friendLoans.reduce((s, l) => s + l.remainingAmount, 0);
    const friendName = friendLoans[0]?.friendName || "";

    if (amount > totalRemaining) {
      showToast(`Amount exceeds remaining (${fmt(totalRemaining)})`, "var(--red)");
      return;
    }

    try {
      // Apply payment across loans (oldest first by createdAt)
      let remaining = amount;
      const sortedLoans = [...friendLoans]
        .filter(l => l.remainingAmount > 0)
        .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

      for (const loan of sortedLoans) {
        if (remaining <= 0) break;
        const applyAmount = Math.min(remaining, loan.remainingAmount);
        const newRemaining = Math.max(0, loan.remainingAmount - applyAmount);
        const newPayments  = [...(loan.payments || []), { amount: applyAmount, date, note, affectBalance }];
        const newStatus    = newRemaining <= 0 ? "settled" : "pending";

        await updateDoc(doc(db, "users", currentUser.uid, "loans", loan.id), {
          remainingAmount: newRemaining,
          payments: newPayments,
          status: newStatus
        });

        remaining -= applyAmount;
      }

      // Add to main balance if toggle is on
      if (affectBalance) {
        await adjustBalance(amount);
      }

      $("recordPaymentModal").classList.remove("open");
      // Check if ALL loans for this friend are now settled
      const allSettled = (amount >= totalRemaining);
      if (allSettled) {
        showToast(`${friendName} has fully returned the loan! 🎉`);
      } else {
        showToast(affectBalance
          ? `Payment of ${fmt(amount)} recorded & balance updated!`
          : `Payment of ${fmt(amount)} recorded!`);
      }
    } catch (err) {
      console.error("Payment write error:", err);
      showToast("Error: " + err.message, "var(--red)");
    }
  });
}

// ─── Loan Tab Switching ─────────────────────────────────
function initLoanTabs() {
  const tabs = document.querySelectorAll(".loan-tab-btn");
  const lentTab = $("loanTabLent");
  const borrowedTab = $("loanTabBorrowed");

  tabs.forEach(btn => btn.addEventListener("click", () => {
    tabs.forEach(t => t.classList.remove("active"));
    btn.classList.add("active");

    const tab = btn.dataset.loanTab;
    lentTab.classList.toggle("active", tab === "lent");
    borrowedTab.classList.toggle("active", tab === "borrowed");

    if (tab === "borrowed") renderBorrowedLoans();
    if (tab === "lent") renderLoans();
  }));
}

// ─── Borrowings Firestore Listener ──────────────────────
function listenBorrowings() {
  const ref = query(
    collection(db, "users", currentUser.uid, "borrowings"),
    orderBy("createdAt", "desc")
  );
  onSnapshot(ref, snap => {
    _reportPending("borrowings", snap.metadata.hasPendingWrites);
    allBorrowings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if ($("section-loans").classList.contains("active")) {
      renderBorrowedLoans();
      // Also refresh stats in renderLoans
      renderLoans();
    }
  });
}

// ─── Render Borrowed Loans ──────────────────────────────
function renderBorrowedLoans() {
  const pending = allBorrowings.filter(l => l.status === "pending");
  const settled = allBorrowings.filter(l => l.status === "settled");

  // Group pending by friend
  const grouped = groupBorrowedByFriend(pending);

  const pendingEl = $("pendingBorrowedList");
  if (!grouped.length) {
    pendingEl.innerHTML = `<div class="empty-state"><i class="fas fa-hand-holding-hand"></i>No pending borrowings</div>`;
  } else {
    pendingEl.innerHTML = grouped.map(groupedBorrowedCard).join("");
    attachBorrowedHandlers(pendingEl);
  }

  const settledEl = $("settledBorrowedList");
  $("settledBorrowedCount").textContent = `${settled.length} settled`;
  if (!settled.length) {
    settledEl.innerHTML = `<div class="empty-state"><i class="fas fa-check-circle"></i>No settled borrowings yet</div>`;
  } else {
    settledEl.innerHTML = settled.map(settledBorrowedCard).join("");
    attachBorrowedDeleteHandlers(settledEl);
  }
}

function groupBorrowedByFriend(pendingBorrowings) {
  const friendMap = {};
  pendingBorrowings.forEach(loan => {
    const name = loan.friendName;
    if (!friendMap[name]) {
      friendMap[name] = {
        friendName: name,
        loanIds: [],
        totalAmount: 0,
        remainingAmount: 0,
        payments: [],
        loanEntries: [],
        affectBalance: false,
        latestDate: loan.date,
      };
    }
    const group = friendMap[name];
    group.loanIds.push(loan.id);
    group.totalAmount += loan.totalAmount;
    group.remainingAmount += loan.remainingAmount;
    group.payments.push(...(loan.payments || []));
    if (loan.affectBalance) group.affectBalance = true;

    if (loan.loanEntries && loan.loanEntries.length) {
      group.loanEntries.push(...loan.loanEntries);
    } else {
      group.loanEntries.push({
        amount: loan.totalAmount,
        date: loan.date,
        note: loan.note || "",
        createdAt: loan.createdAt
      });
    }

    if (loan.date > group.latestDate) group.latestDate = loan.date;
  });

  Object.values(friendMap).forEach(g => {
    g.payments.sort((a, b) => a.date.localeCompare(b.date));
    g.loanEntries.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  });

  return Object.values(friendMap);
}

function groupedBorrowedCard(group) {
  const pct = group.totalAmount > 0
    ? Math.round(((group.totalAmount - group.remainingAmount) / group.totalAmount) * 100)
    : 0;

  const entriesHtml = (group.loanEntries && group.loanEntries.length > 1)
    ? `<div class="loan-entries">
         <p class="loan-entries-title"><i class="fas fa-layer-group"></i> Borrow History</p>
         ${group.loanEntries.map(e => `
            <div class="loan-entry-item">
              <span>${e.date}</span>
              <span class="loan-payment-note">${e.note || ""}</span>
              <span class="neg">+${fmt(e.amount)}</span>
            </div>`).join("")}
       </div>`
    : "";

  const paymentsHtml = (group.payments && group.payments.length)
    ? `<div class="loan-payments">
         <p class="loan-payments-title"><i class="fas fa-history"></i> Repayment History</p>
         ${group.payments.map(p => `
            <div class="loan-payment-item">
              <span>${p.date}</span>
              <span class="loan-payment-note">${p.note || ""}</span>
              <span class="pos">-${fmt(p.amount)}</span>
            </div>`).join("")}
       </div>`
    : "";

  const allIds = group.loanIds.join(",");
  const loanCountLabel = group.loanEntries.length > 1
    ? `<span class="loan-count-badge">${group.loanEntries.length} borrows combined</span>`
    : "";

  return `
    <div class="loan-card borrowed-card">
      <div class="loan-card-top">
        <div class="loan-avatar"><i class="fas fa-user"></i></div>
        <div class="loan-info">
          <p class="loan-friend">${group.friendName} ${loanCountLabel}</p>
          <p class="loan-date"><i class="fas fa-calendar"></i> Latest: ${group.latestDate}</p>
        </div>
        <div class="loan-amounts">
          <p class="loan-remaining">I owe: <strong>${fmt(group.remainingAmount)}</strong></p>
          <p class="loan-total-small">of ${fmt(group.totalAmount)}</p>
        </div>
      </div>
      <div class="loan-progress">
        <div class="loan-progress-bar">
          <div class="loan-progress-fill" style="width:${pct}%"></div>
        </div>
        <span class="loan-pct">${pct}% paid back</span>
      </div>
      ${entriesHtml}
      ${paymentsHtml}
      <div class="loan-actions">
        <button class="btn btn-loan-repay" data-ids="${allIds}" data-name="${group.friendName}" data-remaining="${group.remainingAmount}">
          <i class="fas fa-money-bill-wave"></i> Pay Back
        </button>
        <button class="btn btn-loan-delete" data-ids="${allIds}" data-collection="borrowings" title="Delete all borrowings from ${group.friendName}">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>`;
}

function settledBorrowedCard(loan) {
  return `
    <div class="loan-card settled borrowed-card">
      <div class="loan-card-top">
        <div class="loan-avatar settled-avatar"><i class="fas fa-check"></i></div>
        <div class="loan-info">
          <p class="loan-friend">${loan.friendName}</p>
          <p class="loan-date"><i class="fas fa-calendar"></i> ${loan.date}${loan.note ? ` · ${loan.note}` : ""}</p>
        </div>
        <div class="loan-amounts">
          <p class="loan-settled-amount">${fmt(loan.totalAmount)}</p>
          <p class="loan-settled-label">Fully paid back</p>
        </div>
      </div>
      <div class="loan-actions">
        <button class="btn btn-loan-delete" data-id="${loan.id}" data-collection="borrowings" title="Delete borrowing">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>`;
}

function attachBorrowedHandlers(container) {
  container.querySelectorAll(".btn-loan-repay").forEach(btn => {
    btn.addEventListener("click", () => {
      const ids       = btn.dataset.ids.split(",");
      const name      = btn.dataset.name;
      const remaining = parseFloat(btn.dataset.remaining);
      $("repaymentLoanId").value        = ids.join(",");
      $("repaymentFriendName").textContent = name;
      $("repaymentRemaining").textContent  = `Remaining: ${fmt(remaining)}`;
      $("repaymentAmount").max = remaining;
      $("repaymentDate").value = todayStr();
      $("repaymentNote").value = "";
      $("repaymentAmount").value = "";
      const anyAffect = ids.some(id => {
        const loan = allBorrowings.find(l => l.id === id);
        return loan?.affectBalance;
      });
      $("repaymentAffectBalance").checked = anyAffect;
      $("recordRepaymentModal").classList.add("open");
      $("repaymentAmount").focus();
    });
  });
  attachBorrowedDeleteHandlers(container);
}

function attachBorrowedDeleteHandlers(container) {
  container.querySelectorAll(".btn-loan-delete[data-collection='borrowings']").forEach(btn => {
    btn.addEventListener("click", async () => {
      const ids = (btn.dataset.ids || btn.dataset.id || "").split(",").filter(Boolean);
      if (!ids.length) return;
      const msg = ids.length > 1 ? "Delete all borrowing records for this person?" : "Delete this borrowing record?";
      if (!confirm(msg)) return;
      for (const id of ids) {
        await deleteDoc(doc(db, "users", currentUser.uid, "borrowings", id));
      }
      showToast(ids.length > 1 ? "All borrowings deleted" : "Borrowing deleted", "var(--red)");
    });
  });
}

// ─── Add Borrowed Modal ─────────────────────────────────
function getUniqueBorrowedFriends() {
  const friendMap = {};
  allBorrowings.forEach(loan => {
    const name = loan.friendName;
    if (!friendMap[name]) {
      friendMap[name] = { name, pendingCount: 0, settledCount: 0, totalPending: 0 };
    }
    if (loan.status === "pending") {
      friendMap[name].pendingCount++;
      friendMap[name].totalPending += loan.remainingAmount;
    } else {
      friendMap[name].settledCount++;
    }
  });
  return Object.values(friendMap);
}

function renderBorrowedFriendSuggestions(filter = "") {
  const suggestionsEl = $("borrowFriendSuggestions");
  const friends = getUniqueBorrowedFriends();
  const q = filter.toLowerCase().trim();

  const filtered = q
    ? friends.filter(f => f.name.toLowerCase().includes(q))
    : friends;

  if (!filtered.length) {
    suggestionsEl.classList.remove("show");
    return;
  }

  suggestionsEl.innerHTML = filtered.map(f => {
    const initial = f.name.charAt(0).toUpperCase();
    const hasPending = f.pendingCount > 0;
    const badgeText = hasPending
      ? `${f.pendingCount} pending · ${fmt(f.totalPending)}`
      : `${f.settledCount} settled`;
    const badgeClass = hasPending ? "" : "settled";

    return `
      <div class="friend-suggestion" data-name="${f.name}">
        <div class="friend-suggest-avatar">${initial}</div>
        <div class="friend-suggest-info">
          <span class="friend-suggest-name">${f.name}</span>
          <span class="friend-suggest-detail">${f.pendingCount + f.settledCount} borrow${(f.pendingCount + f.settledCount) > 1 ? "s" : ""}</span>
        </div>
        <span class="friend-suggest-badge ${badgeClass}">${badgeText}</span>
      </div>`;
  }).join("");

  suggestionsEl.classList.add("show");

  suggestionsEl.querySelectorAll(".friend-suggestion").forEach(el => {
    el.addEventListener("click", () => {
      $("borrowFriendName").value = el.dataset.name;
      suggestionsEl.classList.remove("show");
      $("borrowAmount").focus();
    });
  });
}

function initAddBorrowedModal() {
  const friendInput = $("borrowFriendName");
  const suggestionsEl = $("borrowFriendSuggestions");

  $("addBorrowedBtn").addEventListener("click", () => {
    $("addBorrowedForm").reset();
    $("borrowDate").value = todayStr();
    $("addBorrowedModal").classList.add("open");
    friendInput.focus();
    setTimeout(() => renderBorrowedFriendSuggestions(""), 50);
  });
  $("addBorrowedModalClose").addEventListener("click", () => {
    $("addBorrowedModal").classList.remove("open");
    suggestionsEl.classList.remove("show");
  });
  $("addBorrowedModal").addEventListener("click", e => {
    if (e.target === $("addBorrowedModal")) {
      $("addBorrowedModal").classList.remove("open");
      suggestionsEl.classList.remove("show");
    }
  });

  friendInput.addEventListener("input", () => {
    renderBorrowedFriendSuggestions(friendInput.value);
  });
  friendInput.addEventListener("focus", () => {
    renderBorrowedFriendSuggestions(friendInput.value);
  });

  // Keyboard nav
  friendInput.addEventListener("keydown", (e) => {
    const items = suggestionsEl.querySelectorAll(".friend-suggestion");
    if (!items.length || !suggestionsEl.classList.contains("show")) return;

    const current = suggestionsEl.querySelector(".friend-suggestion.active");
    let idx = Array.from(items).indexOf(current);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (current) current.classList.remove("active");
      idx = (idx + 1) % items.length;
      items[idx].classList.add("active");
      items[idx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (current) current.classList.remove("active");
      idx = idx <= 0 ? items.length - 1 : idx - 1;
      items[idx].classList.add("active");
      items[idx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      friendInput.value = current.dataset.name;
      suggestionsEl.classList.remove("show");
      $("borrowAmount").focus();
    } else if (e.key === "Escape") {
      suggestionsEl.classList.remove("show");
    }
  });

  document.addEventListener("click", (e) => {
    if (!$("borrowFriendWrap")?.contains(e.target)) {
      suggestionsEl.classList.remove("show");
    }
  });

  $("addBorrowedForm").addEventListener("submit", async e => {
    e.preventDefault();
    const friendName     = friendInput.value.trim();
    const amount         = parseFloat($("borrowAmount").value);
    const date           = $("borrowDate").value;
    const note           = $("borrowNote").value.trim();
    const affectBalance  = $("borrowAffectBalance").checked;

    if (!friendName) { showToast("Enter friend's name", "var(--red)"); return; }
    if (!amount || amount <= 0) { showToast("Enter a valid amount", "var(--red)"); return; }
    if (!date) { showToast("Pick a date", "var(--red)"); return; }

    try {
      // Check if this friend already has a pending borrowing — merge if so
      const existingBorrow = allBorrowings.find(
        l => l.friendName.toLowerCase() === friendName.toLowerCase() && l.status === "pending"
      );

      if (existingBorrow) {
        const newTotal     = existingBorrow.totalAmount + amount;
        const newRemaining = existingBorrow.remainingAmount + amount;
        const existingEntries = existingBorrow.loanEntries || [{
          amount: existingBorrow.totalAmount,
          date: existingBorrow.date,
          note: existingBorrow.note || "",
          createdAt: existingBorrow.createdAt
        }];
        const newEntries = [...existingEntries, {
          amount,
          date,
          note,
          createdAt: new Date().toISOString()
        }];

        await updateDoc(doc(db, "users", currentUser.uid, "borrowings", existingBorrow.id), {
          totalAmount: newTotal,
          remainingAmount: newRemaining,
          loanEntries: newEntries,
          affectBalance: existingBorrow.affectBalance || affectBalance,
        });

        if (affectBalance) {
          await adjustBalance(amount);
        }

        $("addBorrowedModal").classList.remove("open");
        suggestionsEl.classList.remove("show");
        showToast(affectBalance
          ? `${fmt(amount)} added to ${friendName}'s borrowing & balance updated!`
          : `${fmt(amount)} added to ${friendName}'s existing borrowing!`);

      } else {
        await addDoc(collection(db, "users", currentUser.uid, "borrowings"), {
          friendName,
          totalAmount: amount,
          remainingAmount: amount,
          date,
          note,
          payments: [],
          loanEntries: [{ amount, date, note, createdAt: new Date().toISOString() }],
          status: "pending",
          affectBalance,
          createdAt: new Date().toISOString()
        });

        if (affectBalance) {
          await adjustBalance(amount);
        }

        $("addBorrowedModal").classList.remove("open");
        suggestionsEl.classList.remove("show");
        showToast(affectBalance
          ? `Borrowed from ${friendName} added & balance updated!`
          : `Borrowed from ${friendName} added!`);
      }
    } catch (err) {
      console.error("Borrowed write error:", err);
      showToast("Error: " + err.message, "var(--red)");
    }
  });
}

// ─── Record Repayment Modal ─────────────────────────────
function initRecordRepaymentModal() {
  $("recordRepaymentModalClose").addEventListener("click", () => $("recordRepaymentModal").classList.remove("open"));
  $("recordRepaymentModal").addEventListener("click", e => {
    if (e.target === $("recordRepaymentModal")) $("recordRepaymentModal").classList.remove("open");
  });

  $("recordRepaymentForm").addEventListener("submit", async e => {
    e.preventDefault();
    const loanIdsStr    = $("repaymentLoanId").value;
    const loanIds       = loanIdsStr.split(",").filter(Boolean);
    const amount        = parseFloat($("repaymentAmount").value);
    const date          = $("repaymentDate").value;
    const note          = $("repaymentNote").value.trim();
    const affectBalance = $("repaymentAffectBalance").checked;

    if (!amount || amount <= 0) { showToast("Enter a valid amount", "var(--red)"); return; }
    if (!date) { showToast("Pick a date", "var(--red)"); return; }

    const friendBorrowings = loanIds.map(id => allBorrowings.find(l => l.id === id)).filter(Boolean);
    const totalRemaining = friendBorrowings.reduce((s, l) => s + l.remainingAmount, 0);
    const friendName = friendBorrowings[0]?.friendName || "";

    if (amount > totalRemaining) {
      showToast(`Amount exceeds remaining (${fmt(totalRemaining)})`, "var(--red)");
      return;
    }

    try {
      let remaining = amount;
      const sortedLoans = [...friendBorrowings]
        .filter(l => l.remainingAmount > 0)
        .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

      for (const loan of sortedLoans) {
        if (remaining <= 0) break;
        const applyAmount = Math.min(remaining, loan.remainingAmount);
        const newRemaining = Math.max(0, loan.remainingAmount - applyAmount);
        const newPayments  = [...(loan.payments || []), { amount: applyAmount, date, note, affectBalance }];
        const newStatus    = newRemaining <= 0 ? "settled" : "pending";

        await updateDoc(doc(db, "users", currentUser.uid, "borrowings", loan.id), {
          remainingAmount: newRemaining,
          payments: newPayments,
          status: newStatus
        });

        remaining -= applyAmount;
      }

      if (affectBalance) {
        await adjustBalance(-amount);
      }

      $("recordRepaymentModal").classList.remove("open");
      const allSettled = (amount >= totalRemaining);
      if (allSettled) {
        showToast(`Fully paid back ${friendName}! 🎉`);
      } else {
        showToast(affectBalance
          ? `Repayment of ${fmt(amount)} recorded & balance updated!`
          : `Repayment of ${fmt(amount)} recorded!`);
      }
    } catch (err) {
      console.error("Repayment write error:", err);
      showToast("Error: " + err.message, "var(--red)");
    }
  });
}
