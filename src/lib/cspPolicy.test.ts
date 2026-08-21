/**
 * The shipped Content-Security-Policy, checked against what the app needs.
 *
 * ── THE BUG THIS WOULD HAVE CAUGHT ────────────────────────────────
 *
 * The report-only policy — the one written to be promoted to enforcing — had
 * no `*.cloudfunctions.net` in `connect-src`. Every Firebase callable this
 * platform has is an XHR to exactly that host: createAuthUser,
 * setAccountStatus, restoreInstituteAccess, getRosterSignInState,
 * revokeSessions, and the entire exam grading and submission path. Promoting
 * that policy would have broken account creation and exam grading in
 * production, while every login page a reviewer would think to open stayed
 * perfectly fine.
 *
 * A CSP is a list of origins and the app depends on a list of origins, and
 * nothing compared the two. This file is that comparison, and it reads the
 * REAL vercel.json rather than a copy — so a future edit that drops a host
 * fails here rather than in production.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────
 *
 * It does not prove the policy is complete. Only a browser running the real
 * pages can find a directive nobody thought to list, and the exam shell in
 * particular is not reachable from a test. This asserts the origins we KNOW
 * are load-bearing, and the structural properties that make the policy worth
 * having at all; the report-only header and api/csp-report remain how anything
 * missed gets found.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCsp, permits, hasKeyword, effectiveSources } from './cspPolicy';

const vercel = JSON.parse(readFileSync(resolve(__dirname, '../../vercel.json'), 'utf8'));

function header(key: string): string {
  const headers = vercel.headers?.[0]?.headers ?? [];
  const found = headers.find((h: { key: string }) => h.key.toLowerCase() === key.toLowerCase());
  if (!found) throw new Error(`vercel.json has no ${key} header`);
  return found.value;
}

const enforced = parseCsp(header('Content-Security-Policy'));
const reportOnly = parseCsp(header('Content-Security-Policy-Report-Only'));

/**
 * Every origin this app talks to from the browser, and what breaks without it.
 * Add a row here when a new external dependency lands — that is the point.
 */
const REQUIRED_CONNECT: Array<[string, string, string]> = [
  ['Firestore', 'https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents', 'every read and write in the app'],
  ['Identity Toolkit', 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword', 'sign-in for all four roles'],
  ['Secure Token', 'https://securetoken.googleapis.com/v1/token', 'ID-token refresh — sessions die within the hour without it'],
  ['App Check', 'https://firebaseappcheck.googleapis.com/v1/projects/p/apps/a:exchangeRecaptchaV3Token', 'callables reject unattested clients'],
  ['Firebase Installations', 'https://firebaseinstallations.googleapis.com/v1/projects/p/installations', 'App Check cannot register the app'],
  ['Cloud Storage', 'https://firebasestorage.googleapis.com/v0/b/b/o/x', 'question-bank attachments'],
  ['Cloud Functions', 'https://us-central1-exam-forge-1-40ba7.cloudfunctions.net/setAccountStatus', 'EVERY callable — account creation, disable, grading, submission'],
  ['reCAPTCHA', 'https://www.google.com/recaptcha/api2/reload', 'App Check token minting'],
];

describe('the enforcing policy permits everything the app depends on', () => {
  for (const [name, url, breaks] of REQUIRED_CONNECT) {
    it(`${name} — without it: ${breaks}`, () => {
      expect(permits(enforced, 'connect-src', url)).toBe(true);
    });
  }

  it('loads its own bundle, styles and self-hosted face models', () => {
    // The face-detection models moved off a CDN onto this origin, so they are
    // a same-origin fetch and `connect-src 'self'` is what permits them.
    for (const url of [
      'https://exam-forge.example/assets/index-abc123.js',
      'https://exam-forge.example/models/tiny_face_detector_model-shard1',
    ]) {
      expect(permits(enforced, 'connect-src', url)).toBe(true);
    }
  });

  it('loads webfonts and the Firebase/reCAPTCHA scripts', () => {
    expect(permits(enforced, 'style-src', 'https://fonts.googleapis.com/css2?family=Inter')).toBe(true);
    expect(permits(enforced, 'font-src', 'https://fonts.gstatic.com/s/inter/v1/x.woff2')).toBe(true);
    expect(permits(enforced, 'script-src', 'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js')).toBe(true);
    expect(permits(enforced, 'frame-src', 'https://www.google.com/recaptcha/api2/anchor')).toBe(true);
  });

  it('renders question images from the arbitrary https hosts the product allows', () => {
    // BulkUploadModal tells authors to supply "pre-hosted image links (must
    // start with https://)", so `img-src https:` is a product decision rather
    // than an oversight. Anyone tightening it has to change that feature first.
    expect(permits(enforced, 'img-src', 'https://some-university.example/figure-3.png')).toBe(true);
    // And the data: URLs every logo upload produces.
    expect(permits(enforced, 'img-src', 'data:image/png;base64,iVBORw0KGgo=')).toBe(true);
  });

  it('permits the blob: URLs workers and media are built from', () => {
    // media-src is named explicitly rather than left to fall back to
    // `default-src 'self'`, which would block a blob: source outright.
    expect(permits(enforced, 'worker-src', 'blob:https://exam-forge.example/uuid')).toBe(true);
    expect(permits(enforced, 'media-src', 'blob:https://exam-forge.example/uuid')).toBe(true);
  });
});

describe('the enforcing policy still refuses what it is for', () => {
  it('blocks script injection from an attacker-controlled host', () => {
    expect(permits(enforced, 'script-src', 'https://evil.example.com/x.js')).toBe(false);
  });

  it("carries no 'unsafe-inline' on script-src — the whole point of enforcing it", () => {
    // With 'unsafe-inline' present an injected <script> executes and the
    // policy buys almost nothing against XSS. The built index.html has no
    // inline script of its own, which is what makes dropping it possible.
    expect(hasKeyword(enforced, 'script-src', 'unsafe-inline')).toBe(false);
  });

  it('carries no eval permission of any kind', () => {
    // Verified against the built bundle: no global eval, no Function
    // constructor, and no WebAssembly anywhere — including the face-api chunk.
    expect(hasKeyword(enforced, 'script-src', 'unsafe-eval')).toBe(false);
    expect(hasKeyword(enforced, 'script-src', 'wasm-unsafe-eval')).toBe(false);
  });

  it('blocks exfiltration to an origin it does not name', () => {
    // The reason connect-src matters here: sessions never expire and live in
    // IndexedDB, so an XSS that cannot phone home is a much smaller incident.
    for (const url of ['https://evil.example.com/steal', 'https://attacker.test/?t=token']) {
      expect(permits(enforced, 'connect-src', url)).toBe(false);
    }
  });

  it('does not permit the bare apex of a wildcarded host', () => {
    // `*.googleapis.com` is not `googleapis.com`. Asserted because a matcher
    // that got this wrong would quietly widen every wildcard in the policy.
    expect(permits(enforced, 'connect-src', 'https://googleapis.com/x')).toBe(false);
  });

  it('keeps the four structural directives that were already enforced', () => {
    expect(effectiveSources(enforced, 'object-src')).toEqual(["'none'"]);
    expect(effectiveSources(enforced, 'base-uri')).toEqual(["'self'"]);
    expect(effectiveSources(enforced, 'form-action')).toEqual(["'self'"]);
    expect(effectiveSources(enforced, 'frame-ancestors')).toEqual(["'none'"]);
  });

  it('still reports, so the next tightening has evidence', () => {
    expect(enforced.has('report-uri')).toBe(true);
    expect(enforced.has('report-to')).toBe(true);
  });
});

describe('the report-only policy is the next step, not a copy of this one', () => {
  // A report-only header identical to the enforcing one reports nothing and
  // teaches nothing. It should always be strictly tighter, so api/csp-report
  // keeps earning its keep.
  it('narrows the googleapis wildcard to the services actually used', () => {
    expect(permits(enforced, 'connect-src', 'https://translate.googleapis.com/x')).toBe(true);
    expect(permits(reportOnly, 'connect-src', 'https://translate.googleapis.com/x')).toBe(false);
  });

  it('still permits every origin the app depends on', () => {
    // Tighter must not mean broken: if this fails, the candidate would break
    // the app on the day somebody promotes it — which is exactly the mistake
    // that shipped in the version this replaces.
    for (const [name, url] of REQUIRED_CONNECT) {
      expect(permits(reportOnly, 'connect-src', url), name).toBe(true);
    }
  });
});
