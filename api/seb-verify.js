/**
 * SEB verification endpoint (Phase 3, Stage 2) — Vercel serverless function.
 *
 * WHY IT LIVES HERE AND NOT IN A CLOUD FUNCTION
 * Measured, not assumed (see the Stage-1 diagnostics):
 *   • SEB does NOT inject its keys into cross-origin requests (cloudfunctions.net).
 *   • SEB DOES inject them into same-origin requests to this app's own domain,
 *     on both GET and POST, with an identical hash (SEB hashes the URL only —
 *     not the method, not the body).
 * So the header can only be read here. The Cloud Functions therefore trust a
 * short-lived token that THIS endpoint mints after checking the hash.
 *
 * THE HASH
 *   SHA256(absoluteRequestURL + ConfigKey), URL first, hex, lowercase.
 *   Confirmed byte-for-byte against a real SEB 3.10.1 request.
 *   Because we POST to a constant URL, the hash target never varies.
 *
 * THE HARD PART: WHOSE TOKEN IS IT?
 * If we trusted a client-supplied uid, one student running SEB could mint
 * tokens for friends sitting in Chrome, and the whole control would be
 * worthless. So we verify the caller's Firebase ID token (RS256, against
 * Google's public certs) and bind the minted token to that authenticated uid.
 * gradeAttempt/startExam/etc. then check token.uid === request.auth.uid.
 *
 * The minted token is deliberately SHORT-LIVED. A student who verifies in SEB
 * and then switches to Chrome loses access as soon as it expires, because
 * Chrome sends no SEB header and cannot mint a new one.
 *
 * ENV (Vercel project settings — never exposed to the browser):
 *   SEB_CONFIG_KEYS      comma-separated Config Keys (array → allows rotation)
 *   SEB_SIGNING_SECRET   shared with the Cloud Functions (must match exactly)
 *   FIREBASE_PROJECT_ID  e.g. exam-forge-1-40ba7
 */

import { createHash, createHmac, createVerify, createPublicKey, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_SECONDS = 90; // heartbeat (15s) refreshes it comfortably
const GOOGLE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

// Cache Google's signing certs across warm invocations.
let certCache = { certs: null, fetchedAt: 0 };

async function getGoogleCerts() {
  const FIVE_MIN = 5 * 60 * 1000;
  if (certCache.certs && Date.now() - certCache.fetchedAt < FIVE_MIN) return certCache.certs;
  const r = await fetch(GOOGLE_CERTS_URL);
  if (!r.ok) throw new Error('Could not fetch Google signing certificates.');
  const certs = await r.json();
  certCache = { certs, fetchedAt: Date.now() };
  return certs;
}

const b64urlToBuf = (s) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Verify a Firebase ID token (RS256) without firebase-admin.
 * Returns the uid, or throws.
 */
async function verifyFirebaseIdToken(idToken, projectId) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed ID token.');
  const [h64, p64, s64] = parts;

  const header = JSON.parse(b64urlToBuf(h64).toString('utf8'));
  const payload = JSON.parse(b64urlToBuf(p64).toString('utf8'));

  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm.');
  if (!header.kid) throw new Error('ID token has no key id.');

  const certs = await getGoogleCerts();
  const cert = certs[header.kid];
  if (!cert) throw new Error('Unknown token key id.');

  const pub = createPublicKey(cert); // X.509 PEM → public key
  const ok = createVerify('RSA-SHA256')
    .update(`${h64}.${p64}`)
    .verify(pub, b64urlToBuf(s64));
  if (!ok) throw new Error('ID token signature invalid.');

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error('ID token audience mismatch.');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('ID token issuer mismatch.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('ID token expired.');
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) throw new Error('ID token not yet valid.');
  if (!payload.sub) throw new Error('ID token has no subject.');

  return payload.sub; // the uid
}

/** Mint the SEB proof: v1.<b64url(JSON)>.<hex hmac> */
function mintSebToken(uid, secret) {
  const body = { uid, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS, v: 1 };
  const b64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(b64).digest('hex');
  return { token: `v1.${b64}.${sig}`, expiresAt: body.exp };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const configKeys = String(process.env.SEB_CONFIG_KEYS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const secret = process.env.SEB_SIGNING_SECRET || '';
  const projectId = process.env.FIREBASE_PROJECT_ID || '';

  if (!configKeys.length || !secret || !projectId) {
    // Fail CLOSED but say so clearly — a misconfigured server must never look
    // like a valid SEB session.
    return res.status(500).json({ ok: false, error: 'SEB_NOT_CONFIGURED' });
  }

  // 1. The SEB header must be present. Chrome never sends it.
  const headers = req.headers || {};
  const received = String(headers['x-safeexambrowser-configkeyhash'] || '').toLowerCase();
  if (!received) {
    return res.status(403).json({ ok: false, error: 'SEB_REQUIRED', reason: 'no_header' });
  }

  // 2. Recompute SHA256(url + configKey). Constant URL → constant target.
  const proto = headers['x-forwarded-proto'] || 'https';
  const host = headers['x-forwarded-host'] || headers.host || '';
  const url = `${proto}://${host}${req.url}`;

  let matched = false;
  for (const key of configKeys) {
    const expected = createHash('sha256').update(url + key, 'utf8').digest('hex');
    // Constant-time compare; both are 64-char hex so lengths always agree.
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(received, 'utf8');
    if (a.length === b.length && timingSafeEqual(a, b)) { matched = true; break; }
  }
  if (!matched) {
    return res.status(403).json({ ok: false, error: 'SEB_CONFIG_MISMATCH', reason: 'hash_mismatch' });
  }

  // 3. Authenticate the caller. Without this, a student in SEB could mint
  //    tokens for classmates sitting in Chrome.
  const auth = String(headers.authorization || '');
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!idToken) {
    return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
  }

  let uid;
  try {
    uid = await verifyFirebaseIdToken(idToken, projectId);
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'AUTH_INVALID', reason: e.message });
  }

  // 4. Mint the short-lived proof, bound to the authenticated uid.
  const { token, expiresAt } = mintSebToken(uid, secret);
  return res.status(200).json({ ok: true, sebToken: token, expiresAt, ttlSeconds: TOKEN_TTL_SECONDS });
}