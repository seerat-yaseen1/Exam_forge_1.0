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
//   3. (Dev only) see the debug-token block further down.
// Env-configurable for the same reason as the project above: a second Firebase
// project needs its own reCAPTCHA registration, and a staging build pointed at
// staging data while attesting with production's site key would fail App Check
// for every request. Same fallback rule — unset means today's key, so nothing
// changes until someone opts in.
const RECAPTCHA_V3_SITE_KEY =
  env.VITE_RECAPTCHA_V3_SITE_KEY ?? '6LfgVkItAAAAAHU_amh7GG6R5IuvFVN6D-YTkg7h';

if (typeof window !== 'undefined' && RECAPTCHA_V3_SITE_KEY) {
  // ── DEV ONLY — App Check debug token ────────────────────────────
  //
  // WHY THIS EXISTS NOW AND DID NOT BEFORE. The callables enforce App Check
  // (functions/src/index.ts, APP_CHECK_ENFORCED, live since 2026-08-15), so a
  // client that cannot mint a token no longer degrades — it gets
  // `unauthenticated` and stops working entirely. reCAPTCHA v3 only issues a
  // token on a domain registered for the site key, which localhost and every
  // ephemeral Vercel preview URL are not. So the environments where the code is
  // actually written became the environments that cannot call the backend.
  //
  // The previous note here said to set the global "before this file loads",
  // which is stricter than the SDK requires and is awkward to arrange in a Vite
  // app where this module is imported first by almost everything. The SDK reads
  // the global inside `initializeAppCheck` (initializeDebugMode), so setting it
  // immediately before that call — as below — is sufficient and keeps the whole
  // mechanism in one place.
  //
  // TWO ACCEPTED SHAPES, and the difference matters:
  //   VITE_APPCHECK_DEBUG_TOKEN=true    → SDK MINTS a token, persists it in
  //                                       localStorage and prints it to the
  //                                       console. Copy it into Firebase console
  //                                       → App Check → Apps → Manage debug
  //                                       tokens. Do this once per browser.
  //   VITE_APPCHECK_DEBUG_TOKEN=<uuid>  → reuse an already-registered token.
  // The coercion below is NOT cosmetic: Vite env values are always strings, and
  // the SDK treats any string as a literal token. Passing through the string
  // "true" would register as a debug token literally named `true`, match nothing,
  // and fail in a way that looks identical to the token never being set.
  //
  // GATED ON import.meta.env.DEV, deliberately and not negotiably. Vite INLINES
  // VITE_* at build time, so a value set in a Vercel environment would be baked
  // into the shipped bundle — and a leaked debug token is a permanent App Check
  // bypass for anyone who reads it. DEV is false for `vite build`, so a
  // production bundle cannot carry one even if the variable is set by mistake.
  // Put it in `.env.local` (gitignored), never in Vercel.
  if (import.meta.env.DEV && env.VITE_APPCHECK_DEBUG_TOKEN) {
    const raw = String(env.VITE_APPCHECK_DEBUG_TOKEN).trim();
    (window as unknown as Record<string, unknown>).FIREBASE_APPCHECK_DEBUG_TOKEN =
      raw === 'true' ? true : raw;
    console.warn(
      '[firebase] App Check DEBUG MODE — this build attests with a debug token,'
      + ' not real reCAPTCHA. Never set VITE_APPCHECK_DEBUG_TOKEN outside local dev.',
    );
  }

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

// Firebase Auth — used by ALL FOUR roles: webOwner, institute, faculty and
// student. Every one of the four auth contexts (AuthContext,
// InstituteAuthContext, FacultyAuthContext, StudentAuthContext) imports from
// 'firebase/auth' and calls signInWithEmailAndPassword and
// reauthenticateWithCredential against this instance.
//
// CORRECTED 2026-08-15. This comment previously read "used by Web Owner login
// (Phase 2); other roles still use the legacy custom-password flow until they
// are migrated". That migration completed long ago and there is no legacy
// custom-password flow anywhere in src/ — the stale wording gave a materially
// wrong picture of the whole auth layer to anyone reading this file first.
export const auth = getAuth(app);

// Callable Cloud Functions client — used to invoke admin-only endpoints like
// createAuthUser(role, profile, password). Region defaults to us-central1;
// change here if functions are deployed elsewhere.
//
// NOTE: these callables enforce App Check. A caller without a valid token gets
// `unauthenticated` before the handler runs — see the debug-token block above
// if you are hitting that in local dev.
export const functions = getFunctions(app);

export default app;
