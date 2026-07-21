// Single source of truth for Firebase — all other files import from here
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth }       from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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

export { app, auth, db };
