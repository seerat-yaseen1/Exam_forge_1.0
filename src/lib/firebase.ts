import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getAuth } from 'firebase/auth';
import { getFunctions } from 'firebase/functions';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';

// Firebase configuration
// Replace these with your actual Firebase project credentials from Firebase Console
const firebaseConfig = {
  apiKey: "AIzaSyAGT8IAn2YWEJNHiZVwuGmy4JFSdh2km5E",
  authDomain: "exam-forge-1-40ba7.firebaseapp.com",
  projectId: "exam-forge-1-40ba7",
  storageBucket: "exam-forge-1-40ba7.firebasestorage.app",
  messagingSenderId: "530247377004",
  appId: "1:530247377004:web:ec88e6ebadcb61026d7849"
};

// Initialize Firebase (only if not already initialized)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// ── Firebase App Check ────────────────────────────────────────────
// Blocks Firestore/Storage calls from anything other than your real web app.
// To enable:
//   1. Firebase console → App Check → Register web app with reCAPTCHA v3
//   2. Paste the site key into RECAPTCHA_V3_SITE_KEY below
//   3. (Dev only) set window.FIREBASE_APPCHECK_DEBUG_TOKEN = true before this
//      file loads, then copy the printed debug token into the console allowlist.
const RECAPTCHA_V3_SITE_KEY = '6LfgVkItAAAAAHU_amh7GG6R5IuvFVN6D-YTkg7h'; // ← paste your site key here

if (typeof window !== 'undefined' && RECAPTCHA_V3_SITE_KEY) {
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(RECAPTCHA_V3_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (err) {
    console.warn('[firebase] App Check init failed:', err);
  }
}

// Initialize Firestore
export const db = getFirestore(app);

// Initialize Firebase Storage
export const storage = getStorage(app);

// Firebase Auth — used by Web Owner login (Phase 2). Other roles still use
// the legacy custom-password flow until they are migrated.
export const auth = getAuth(app);

// Callable Cloud Functions client — used to invoke admin-only endpoints like
// createAuthUser(role, profile, password). Region defaults to us-central1;
// change here if functions are deployed elsewhere.
export const functions = getFunctions(app);

export default app;