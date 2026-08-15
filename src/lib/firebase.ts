import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getAuth } from 'firebase/auth';
import { getFunctions } from 'firebase/functions';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';

// ══════════════════════════════════════════════════════════════════
// FIREBASE PROJECT — env-configurable, with the current project as default
// (audit S-7 / R-4)
// ══════════════════════════════════════════════════════════════════
//
// These values were hardcoded, and `grep -rn "import.meta.env" src/` returned
// nothing at all: there was no way to point a build at a different Firebase
// project without editing this file. That is what made S-7 an availability
// finding rather than a style one — **a rules change could not be rehearsed
// anywhere but production**, because a staging deploy needs a second project
// and a second project needed a code edit.
//
// ── THESE ARE NOT SECRETS ─────────────────────────────────────────
//
// Worth stating plainly, because the instinct on seeing an `apiKey` move to an
// env var is that something was leaking. A Firebase web apiKey is a public
// project identifier: it ships in every client bundle by design, and Google
// documents it as such. What protects the data is Firestore rules, the
// callables' claim checks, and App Check — none of which live here.
//
// So the fallbacks below are safe to keep in source, and keeping them is the
// point of the design: **behaviour is identical when nothing is set.** A
// deploy that forgets the variables gets today's project rather than an app
// wired to `undefined`, which is the failure mode that would take the platform
// down on the first misconfigured build.
//
// ── POINTING A BUILD SOMEWHERE ELSE ───────────────────────────────
//
// Set these in the Vercel project (or a local `.env.local`, which is
// gitignored). The `VITE_` prefix is required — Vite only exposes prefixed
// variables to client code, which is the mechanism that keeps a stray server
// secret out of the bundle:
//
//   VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID,
//   VITE_FIREBASE_STORAGE_BUCKET, VITE_FIREBASE_MESSAGING_SENDER_ID,
//   VITE_FIREBASE_APP_ID, VITE_RECAPTCHA_V3_SITE_KEY
//
// They are read at BUILD time, not runtime — Vite inlines them — so changing
// one needs a redeploy, not a restart.
const env = import.meta.env;

const firebaseConfig = {
  apiKey:            env.VITE_FIREBASE_API_KEY             ?? "AIzaSyAGT8IAn2YWEJNHiZVwuGmy4JFSdh2km5E",
  authDomain:        env.VITE_FIREBASE_AUTH_DOMAIN         ?? "exam-forge-1-40ba7.firebaseapp.com",
  projectId:         env.VITE_FIREBASE_PROJECT_ID          ?? "exam-forge-1-40ba7",
  storageBucket:     env.VITE_FIREBASE_STORAGE_BUCKET      ?? "exam-forge-1-40ba7.firebasestorage.app",
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "530247377004",
  appId:             env.VITE_FIREBASE_APP_ID              ?? "1:530247377004:web:ec88e6ebadcb61026d7849"
};

// Which project is this build talking to?
//
// Answerable from the browser console rather than inferred from a URL. A
// staging build that silently kept the production defaults — one missing
// variable in a Vercel environment — is otherwise indistinguishable from a
// correct one until someone notices real data, which is far too late. Names
// the project only; nothing here that is not already in the bundle.
if (typeof window !== 'undefined') {
  console.info(
    `[firebase] project=${firebaseConfig.projectId}`
    + (env.VITE_FIREBASE_PROJECT_ID ? ' (from env)' : ' (built-in default)'),
  );
}

// Initialize Firebase (only if not already initialized)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// ── Firebase App Check ────────────────────────────────────────────
// Blocks Firestore/Storage calls from anything other than your real web app.
// To enable:
//   1. Firebase console → App Check → Register web app with reCAPTCHA v3
//   2. Paste the site key into RECAPTCHA_V3_SITE_KEY below
//   3. (Dev only) set window.FIREBASE_APPCHECK_DEBUG_TOKEN = true before this
//      file loads, then copy the printed debug token into the console allowlist.
// Env-configurable for the same reason as the project above: a second Firebase
// project needs its own reCAPTCHA registration, and a staging build pointed at
// staging data while attesting with production's site key would fail App Check
// for every request. Same fallback rule — unset means today's key, so nothing
// changes until someone opts in.
const RECAPTCHA_V3_SITE_KEY =
  env.VITE_RECAPTCHA_V3_SITE_KEY ?? '6LfgVkItAAAAAHU_amh7GG6R5IuvFVN6D-YTkg7h';

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