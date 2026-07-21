import { db } from "./firebase-config.js";
import {
  doc, collection,
  setDoc, getDoc, addDoc, deleteDoc, updateDoc,
  query, orderBy, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ─── State ──────────────────────────────────────────────
let currentUser    = null;
let allTransactions = [];
let budgets        = {};
let allLoans        = [];
let weeklyChart = null, categoryChart = null, budgetChart = null;

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
    titleEl.textContent = labels[name] || name;
    sidebar.classList.remove("open");
    if (name === "analytics")    renderAnalytics();
    if (name === "budget")       renderBudget();
    if (name === "transactions") renderAllTransactions();
    if (name === "loans")        renderLoans();
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

      // Adjust balance
      const balRef  = doc(db, "users", currentUser.uid, "profile", "balance");
      const balSnap = await getDoc(balRef);
      const cur     = balSnap.exists() ? balSnap.data().amount : 0;
      await setDoc(balRef, {
        amount: type === "expense" ? cur - amount : cur + amount,
        updatedAt: new Date().toISOString()
      });

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

      // Reverse the balance effect
      const balRef  = doc(db, "users", currentUser.uid, "profile", "balance");
      const balSnap = await getDoc(balRef);
      const cur     = balSnap.exists() ? balSnap.data().amount : 0;
      await setDoc(balRef, {
        amount: type === "expense" ? cur + amount : cur - amount,
        updatedAt: new Date().toISOString()
      });

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
  listenBalance();
  listenBudgets();
  listenTransactions();
  listenLoans();
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
    allLoans = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if ($("section-loans").classList.contains("active")) renderLoans();
  });
}

function renderLoans() {
  const pending = allLoans.filter(l => l.status === "pending");
  const settled = allLoans.filter(l => l.status === "settled");

  // Summary stats
  const totalLent     = allLoans.reduce((s, l) => s + l.totalAmount, 0);
  const totalPending  = pending.reduce((s, l) => s + l.remainingAmount, 0);
  const totalReturned = totalLent - totalPending;

  $("loanTotalLent").textContent     = fmt(totalLent);
  $("loanTotalPending").textContent  = fmt(totalPending);
  $("loanTotalReturned").textContent = fmt(totalReturned);

  // Pending list
  const pendingEl = $("pendingLoansList");
  if (!pending.length) {
    pendingEl.innerHTML = `<div class="empty-state"><i class="fas fa-handshake"></i>No pending loans</div>`;
  } else {
    pendingEl.innerHTML = pending.map(loanCard).join("");
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

function loanCard(loan) {
  const pct = loan.totalAmount > 0
    ? Math.round(((loan.totalAmount - loan.remainingAmount) / loan.totalAmount) * 100)
    : 0;
  const returned = loan.totalAmount - loan.remainingAmount;
  const paymentsHtml = (loan.payments && loan.payments.length)
    ? `<div class="loan-payments">
         <p class="loan-payments-title"><i class="fas fa-history"></i> Payment History</p>
         ${loan.payments.map(p => `
           <div class="loan-payment-item">
             <span>${p.date}</span>
             <span class="loan-payment-note">${p.note || ""}</span>
             <span class="pos">+${fmt(p.amount)}</span>
           </div>`).join("")}
       </div>`
    : "";

  return `
    <div class="loan-card">
      <div class="loan-card-top">
        <div class="loan-avatar"><i class="fas fa-user"></i></div>
        <div class="loan-info">
          <p class="loan-friend">${loan.friendName}</p>
          <p class="loan-date"><i class="fas fa-calendar"></i> ${loan.date}${loan.note ? ` · ${loan.note}` : ""}</p>
        </div>
        <div class="loan-amounts">
          <p class="loan-remaining">Pending: <strong>${fmt(loan.remainingAmount)}</strong></p>
          <p class="loan-total-small">of ${fmt(loan.totalAmount)}</p>
        </div>
      </div>
      <div class="loan-progress">
        <div class="loan-progress-bar">
          <div class="loan-progress-fill" style="width:${pct}%"></div>
        </div>
        <span class="loan-pct">${pct}% returned</span>
      </div>
      ${paymentsHtml}
      <div class="loan-actions">
        <button class="btn btn-loan-pay" data-id="${loan.id}" data-name="${loan.friendName}" data-remaining="${loan.remainingAmount}">
          <i class="fas fa-money-bill-wave"></i> Record Payment
        </button>
        <button class="btn btn-loan-delete" data-id="${loan.id}" title="Delete loan">
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
      const id        = btn.dataset.id;
      const name      = btn.dataset.name;
      const remaining = parseFloat(btn.dataset.remaining);
      $("paymentLoanId").value        = id;
      $("paymentFriendName").textContent = name;
      $("paymentRemaining").textContent  = `Remaining: ${fmt(remaining)}`;
      $("paymentAmount").max = remaining;
      $("paymentDate").value = todayStr();
      $("paymentNote").value = "";
      $("paymentAmount").value = "";
      $("recordPaymentModal").classList.add("open");
      $("paymentAmount").focus();
    });
  });
  attachLoanDeleteHandlers(container);
}

function attachLoanDeleteHandlers(container) {
  container.querySelectorAll(".btn-loan-delete").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this loan record?")) return;
      await deleteDoc(doc(db, "users", currentUser.uid, "loans", btn.dataset.id));
      showToast("Loan deleted", "var(--red)");
    });
  });
}

// ─── Add Loan Modal ─────────────────────────────────────
function initAddLoanModal() {
  $("addLoanBtn").addEventListener("click", () => {
    $("addLoanForm").reset();
    $("loanDate").value = todayStr();
    $("addLoanModal").classList.add("open");
    $("loanFriendName").focus();
  });
  $("addLoanModalClose").addEventListener("click", () => $("addLoanModal").classList.remove("open"));
  $("addLoanModal").addEventListener("click", e => {
    if (e.target === $("addLoanModal")) $("addLoanModal").classList.remove("open");
  });

  $("addLoanForm").addEventListener("submit", async e => {
    e.preventDefault();
    const friendName = $("loanFriendName").value.trim();
    const amount     = parseFloat($("loanAmount").value);
    const date       = $("loanDate").value;
    const note       = $("loanNote").value.trim();

    if (!friendName) { showToast("Enter friend's name", "var(--red)"); return; }
    if (!amount || amount <= 0) { showToast("Enter a valid amount", "var(--red)"); return; }
    if (!date) { showToast("Pick a date", "var(--red)"); return; }

    try {
      await addDoc(collection(db, "users", currentUser.uid, "loans"), {
        friendName,
        totalAmount: amount,
        remainingAmount: amount,
        date,
        note,
        payments: [],
        status: "pending",
        createdAt: new Date().toISOString()
      });
      $("addLoanModal").classList.remove("open");
      showToast(`Loan to ${friendName} added!`);
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
    const loanId = $("paymentLoanId").value;
    const amount = parseFloat($("paymentAmount").value);
    const date   = $("paymentDate").value;
    const note   = $("paymentNote").value.trim();

    if (!amount || amount <= 0) { showToast("Enter a valid amount", "var(--red)"); return; }
    if (!date) { showToast("Pick a date", "var(--red)"); return; }

    const loan = allLoans.find(l => l.id === loanId);
    if (!loan) { showToast("Loan not found", "var(--red)"); return; }

    if (amount > loan.remainingAmount) {
      showToast(`Amount exceeds remaining (${fmt(loan.remainingAmount)})`, "var(--red)");
      return;
    }

    const newRemaining = Math.max(0, loan.remainingAmount - amount);
    const newPayments  = [...(loan.payments || []), { amount, date, note }];
    const newStatus    = newRemaining <= 0 ? "settled" : "pending";

    try {
      await updateDoc(doc(db, "users", currentUser.uid, "loans", loanId), {
        remainingAmount: newRemaining,
        payments: newPayments,
        status: newStatus
      });
      $("recordPaymentModal").classList.remove("open");
      if (newStatus === "settled") {
        showToast(`${loan.friendName} has fully returned the loan! 🎉`);
      } else {
        showToast(`Payment of ${fmt(amount)} recorded!`);
      }
    } catch (err) {
      console.error("Payment write error:", err);
      showToast("Error: " + err.message, "var(--red)");
    }
  });
}
