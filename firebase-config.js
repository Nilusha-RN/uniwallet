// Single source of truth for Firebase — all other files import from here
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth }       from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, enableMultiTabIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCjyRdc2XbbajVBXgmd0CCkDE99jnQB1SE",
  authDomain: "my-web-24544.firebaseapp.com",
  projectId: "my-web-24544",
  storageBucket: "my-web-24544.firebasestorage.app",
  messagingSenderId: "761560182628",
  appId: "1:761560182628:web:f32072c8773876c0249471",
  measurementId: "G-EQ5FDN7V7K"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ─── Offline Persistence ────────────────────────────────
// Enable Firestore's built-in IndexedDB persistence with multi-tab support.
// This allows all reads/writes to work offline; Firestore auto-syncs when
// the network is restored. No custom IndexedDB code needed.
const persistenceReady = enableMultiTabIndexedDbPersistence(db)
  .then(() => {
    console.log("✅ Firestore offline persistence enabled (multi-tab)");
  })
  .catch((err) => {
    if (err.code === "failed-precondition") {
      // Multiple tabs open — only one can enable persistence at a time.
      // The app still works, just without offline persistence in this tab.
      console.warn(
        "⚠️ Firestore persistence unavailable: another tab already has it. " +
        "Offline writes will only queue in the original tab."
      );
    } else if (err.code === "unimplemented") {
      // The current browser does not support all features required for persistence.
      console.warn("⚠️ Firestore persistence not supported by this browser.");
    } else {
      console.error("❌ Firestore persistence error:", err);
    }
  });

export { app, auth, db, persistenceReady };
