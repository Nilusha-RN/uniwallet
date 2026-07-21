import { auth } from "./firebase-config.js";
import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const isLoginPage = document.getElementById("googleSignInBtn") !== null;

if (isLoginPage) {
  onAuthStateChanged(auth, user => {
    if (user) window.location.href = "dashboard.html";
  });

  document.getElementById("googleSignInBtn").addEventListener("click", async () => {
    const btn = document.getElementById("googleSignInBtn");
    btn.disabled = true;
    btn.querySelector("span").textContent = "Signing in…";
    try {
      await signInWithPopup(auth, provider);
      window.location.href = "dashboard.html";
    } catch (err) {
      console.error("Sign-in error:", err.code, err.message);
      btn.disabled = false;
      btn.querySelector("span").textContent = "Continue with Google";
      if (err.code === "auth/popup-blocked") {
        alert("Popup was blocked. Please allow popups for this site and try again.");
      } else if (err.code === "auth/unauthorized-domain") {
        alert("This domain is not authorized in Firebase.\n\nGo to Firebase Console → Authentication → Settings → Authorized domains → Add your domain.");
      } else if (err.code !== "auth/cancelled-popup-request" && err.code !== "auth/popup-closed-by-user") {
        alert("Sign-in failed: " + err.message);
      }
    }
  });

} else {
  onAuthStateChanged(auth, user => {
    if (!user) {
      window.location.href = "index.html";
      return;
    }
    const avatar = user.photoURL || "";
    const name   = user.displayName || user.email;

    const ua = document.getElementById("userAvatar");
    const un = document.getElementById("userName");
    const ta = document.getElementById("topbarAvatar");
    if (ua) ua.src = avatar;
    if (un) un.textContent = name;
    if (ta) ta.src = avatar;

    window.dispatchEvent(new CustomEvent("userReady", { detail: { user } }));
  });

  document.getElementById("signOutBtn")?.addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "index.html";
  });
}
