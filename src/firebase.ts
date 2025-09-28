// src/firebase.ts
import { initializeApp, getApps } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

/**
 * SANDBOX / LOCAL: hardcode your Firebase config so CodeSandbox doesn't need import.meta
 * Replace the strings below with the values from your Firebase console.
 */
const firebaseConfig = {
  apiKey: "AIzaSyDHjBy-hSz6B2Efc9L_Nqp5IPjSXsfR-_0",
  authDomain: "aba-scheduler-77f49.firebaseapp.com", // e.g. your-app.firebaseapp.com
  projectId: "aba-scheduler-77f49", // e.g. your-app
  storageBucket: "aba-scheduler-77f49.firebasestorage.app", // e.g. your-app.appspot.com
  messagingSenderId: "142099323419",
  appId: "1:142099323419:web:2db0361964fe14bb6c36be",
};

// Avoid re-initializing during hot reloads
const app = getApps().length ? getApps()[0]! : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);

/* 
// PRODUCTION ON VERCEL: use env vars instead of hardcoded values
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string,
};
*/
