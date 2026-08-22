/**
 * SEB verification endpoint (Phase 3, Stage 2 → Stage 4) — Vercel serverless.
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
 * WHERE THE KEYS COME FROM (Stage 4 — Firestore-authoritative)
 * Resolution order, first non-empty wins:
 *   1. sebAssessmentKeys/{assessmentId}.keys   — per-exam override (webOwner-set)
 *   2. platformSettings/seb.configKeys         — platform keys (settings page)
 *   3. SEB_CONFIG_KEYS env                     — emergency fallback only
 * Firestore is read over REST with a service account (no firebase-admin — this
 * bundle stays dependency-free). Results are cached ~2 minutes, so a key added
 * on the settings page is live within that window, no redeploy. If the service
 * account is missing/broken or Firestore is unreachable, we fall back to the
 * env keys — a Firestore outage must never brick a scheduled exam, and the env
 * fallback is exactly as strong as the pre-Stage-4 behaviour.
 *
 * TOKEN BINDING (Stage 4)
 * The minted token now carries the assessmentId it verified against (`aid`).
 * Without it, a session verified under the PLATFORM config could be replayed
 * against an exam that demands its OWN config — per-exam keys would be
 * decorative. assertSEB in the Cloud Functions compares aid to the attempt's
 * assessment and rejects mismatches.
 *
 * WHOSE TOKEN IS IT?
 * We verify the caller's Firebase ID token (RS256, against Google's public
 * certs) and bind the minted token to that authenticated uid — otherwise one
 * student in SEB could mint proofs for friends sitting in Chrome.
 *
 * ORDER OF CHECKS — LOAD-BEARING, NOT INCIDENTAL
 * Nothing whose cost the CALLER can multiply may run before authentication.
 * The config-key lookup reads `sebAssessmentKeys/{assessmentId}` and caches
 * the result, both keyed on a caller-supplied string, so with authentication
 * after it an anonymous request could spend a Firestore read and a cache slot
 * per invented id. The hash header does not gate that — it stops an ordinary
 * browser, and forging it costs an attacker one line. So the sequence is:
 * shape checks (free) → hash header present (free) → AUTHENTICATE → resolve
 * keys (Firestore) → compare hash → mint. Adding a step means asking which
 * side of the authenticate line it belongs on.
 *
 * ENV (Vercel project settings — never exposed to the browser):
 *   SEB_CONFIG_KEYS        comma-separated fallback Config Keys
 *   SEB_SIGNING_SECRET     shared with the Cloud Functions. Comma-separated
 *                          list allowed: this endpoint MINTS with the first,
 *                          the functions ACCEPT any. See DEPLOY.md §9.
 *   FIREBASE_PROJECT_ID    e.g. exam-forge-1-40ba7
 *   FIREBASE_CLIENT_EMAIL  service account email (Firestore REST reads)
 *   FIREBASE_PRIVATE_KEY   service account private key, \n-escaped
 */

import {
  createHash, createHmac, createVerify, createPublicKey, createSign, timingSafeEqual,
} from 'node:crypto';

const TOKEN_TTL_SECONDS = 90; // heartbeat (15s) refreshes it comfortably
const KEYS_CACHE_MS = 2 * 60 * 1000;   // Firestore key docs
const SA_TOKEN_SLACK_S = 300;          // refresh SA token 5 min before expiry

/**
 * Hard cap on distinct assessment ids held in `keysCache`.
 *
 * The cache is keyed by a value the CALLER supplies, so its size is not a
 * function of how many exams exist — it is a function of how many distinct
 * strings someone has sent. Without a cap that is an unbounded Map on a warm
 * serverless instance. 500 is far above any real concurrent exam count and far
 * below anything that matters for memory.
 *
 * Eviction is oldest-first, which a Map gives for free: iteration order is
 * insertion order, so the first key is the least recently ADDED. Deliberately
 * not LRU — the entries expire after KEYS_CACHE_MS anyway, so the only job here
 * is to stop the Map growing, not to keep the hottest keys.
 */
const MAX_KEYS_CACHE_ENTRIES = 500;

/** Longest assessment id accepted. Real ones are ~30 chars (`assess_<ms>_<7>`). */
const MAX_ASSESSMENT_ID_LENGTH = 200;

/**
 * Is this string shaped like a document id this platform could have issued?
 *
 * DELIBERATELY PERMISSIVE. It is not trying to prove the exam exists — the
 * Firestore read does that. It exists to reject input that could only be
 * hostile (a 40 KB string, a path fragment, a control character) before that
 * string is used to build a URL or a cache key.
 *
 * It does NOT pin the `assess_` prefix, on purpose: rejecting a legitimate id
 * locks a student out of an exam they are sitting, which is a far worse
 * outcome than accepting a junk id that the Firestore read will then miss.
 * Requiring the first character to be alphanumeric is what rules out `.`, `..`
 * and the reserved `__…__` form without enumerating them.
 */
export function isPlausibleAssessmentId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ASSESSMENT_ID_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}
const GOOGLE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ── Caches (survive warm invocations) ─────────────────────────────
let certCache = { certs: null, fetchedAt: 0 };
let saTokenCache = { token: null, exp: 0 };
const keysCache = new Map(); // cacheKey → { keys: string[]|null, fetchedAt }

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
const b64url = (buf) => Buffer.from(buf).toString('base64url');

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

// ── Service-account OAuth (JWT bearer flow, no SDK) ───────────────

function getServiceAccountEnv() {
  const email = process.env.FIREBASE_CLIENT_EMAIL || '';
  // Vercel stores the \n sequences literally; the signer needs real newlines.
  const key = String(process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key.includes('BEGIN PRIVATE KEY')) return null;
  return { email, key };
}

async function getServiceAccountToken() {
  const nowS = Math.floor(Date.now() / 1000);
  if (saTokenCache.token && saTokenCache.exp - nowS > SA_TOKEN_SLACK_S) {
    return saTokenCache.token;
  }
  const sa = getServiceAccountEnv();
  if (!sa) throw new Error('SA_NOT_CONFIGURED');

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: GOOGLE_TOKEN_URL,
    iat: nowS,
    exp: nowS + 3600,
  }));
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(sa.key);
  const assertion = `${header}.${claims}.${b64url(signature)}`;

  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!r.ok) throw new Error(`SA_TOKEN_HTTP_${r.status}`);
  const data = await r.json();
  if (!data.access_token) throw new Error('SA_TOKEN_EMPTY');
  saTokenCache = { token: data.access_token, exp: nowS + (data.expires_in || 3600) };
  return saTokenCache.token;
}

// ── Firestore REST reads ──────────────────────────────────────────

/** Extract a string array field from Firestore REST field format. */
function firestoreStringArray(fields, name) {
  const values = fields?.[name]?.arrayValue?.values;
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => String(v?.stringValue || '').trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
}

/**
 * Read a key list from a Firestore doc, cached. Returns:
 *   string[]  — the (possibly empty) validated key list from the doc
 *   null      — the doc does not exist
 * Throws on transport/auth failure (caller falls back).
 */
async function readKeyDoc(projectId, docPath, fieldName) {
  const cached = keysCache.get(docPath);
  if (cached && Date.now() - cached.fetchedAt < KEYS_CACHE_MS) return cached.keys;

  const bearer = await getServiceAccountToken();
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${docPath}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });

  let keys;
  if (r.status === 404) {
    keys = null;
  } else if (r.ok) {
    const data = await r.json();
    keys = firestoreStringArray(data.fields, fieldName);
  } else {
    throw new Error(`FIRESTORE_HTTP_${r.status}`);
  }
  cachePut(keysCache, docPath, { keys, fetchedAt: Date.now() }, MAX_KEYS_CACHE_ENTRIES);
  return keys;
}

/**
 * Insert into a Map that is not allowed to grow past `max`.
 *
 * Split out from readKeyDoc so the bound is testable without standing up a
 * service account and a Firestore transport — the thing worth asserting is
 * "the Map never exceeds max", and that is arithmetic, not I/O.
 *
 * Re-inserting an existing key must not evict anything, so the existing entry
 * is deleted first: without that, refreshing a cached doc while the Map is
 * full would drop an unrelated entry on every refresh.
 */
export function cachePut(cache, key, value, max) {
  cache.delete(key);
  // Iteration order is insertion order, so the first key is the oldest.
  while (cache.size >= max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, value);
  return cache;
}

/**
 * Stage 4 resolution: per-assessment override → platform doc → env fallback.
 * Also returns which source won, for the response's debug field.
 */
async function resolveConfigKeys(projectId, assessmentId, envKeys) {
  try {
    if (assessmentId) {
      const perExam = await readKeyDoc(
        projectId, `sebAssessmentKeys/${encodeURIComponent(assessmentId)}`, 'keys',
      );
      if (Array.isArray(perExam) && perExam.length > 0) {
        return { keys: perExam, source: 'assessment' };
      }
    }
    const platform = await readKeyDoc(projectId, 'platformSettings/seb', 'configKeys');
    if (Array.isArray(platform) && platform.length > 0) {
      return { keys: platform, source: 'platform' };
    }
    // Docs exist but are empty / absent → env keeps exams alive.
    return { keys: envKeys, source: 'env_empty_docs' };
  } catch {
    // Service account missing, Firestore unreachable, etc. Never brick a
    // scheduled exam because of a settings read — env is the safety net.
    return { keys: envKeys, source: 'env_fallback' };
  }
}

/** Mint the SEB proof: v1.<b64url(JSON)>.<hex hmac>, bound to uid AND exam. */
function mintSebToken(uid, assessmentId, secret) {
  const body = {
    uid,
    aid: assessmentId,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    v: 2,
  };
  const b64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(b64).digest('hex');
  return { token: `v1.${b64}.${sig}`, expiresAt: body.exp };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const envKeys = String(process.env.SEB_CONFIG_KEYS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  // The MINTER uses the FIRST secret; the verifier in Cloud Functions accepts
  // ANY of them (see sebSecrets there). That asymmetry is what makes rotation
  // seamless — a new secret is taught to the verifier first, then promoted to
  // the front here, and no proof in flight is ever rejected. DEPLOY.md §9 has
  // the procedure. A single secret with no comma behaves exactly as before.
  const secret = String(process.env.SEB_SIGNING_SECRET || '')
    .split(',').map((x) => x.trim()).filter(Boolean)[0] || '';
  const projectId = process.env.FIREBASE_PROJECT_ID || '';

  if (!secret || !projectId) {
    // Fail CLOSED but say so clearly — a misconfigured server must never look
    // like a valid SEB session.
    return res.status(500).json({ ok: false, error: 'SEB_NOT_CONFIGURED' });
  }

  // Stage 4: the assessment being verified for. Required — the token binds to
  // it. An old cached SPA that omits it gets a clear error and recovers on
  // reload (the deployed frontend always sends it).
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const assessmentId = String(body?.assessmentId || '').trim();
  if (!assessmentId) {
    return res.status(400).json({ ok: false, error: 'SEB_VERIFY_BAD_REQUEST', reason: 'missing_assessment' });
  }
  if (!isPlausibleAssessmentId(assessmentId)) {
    return res.status(400).json({ ok: false, error: 'SEB_VERIFY_BAD_REQUEST', reason: 'bad_assessment_id' });
  }

  // 1. The SEB header must be present. Chrome never sends it.
  //
  // This is a gate against an ordinary BROWSER, not against an attacker: the
  // header is trivially forgeable with any junk value, so passing it proves
  // nothing and must not be treated as having proved anything. Everything
  // expensive below is ordered on that assumption.
  const headers = req.headers || {};
  const received = String(headers['x-safeexambrowser-configkeyhash'] || '').toLowerCase();
  if (!received) {
    return res.status(403).json({ ok: false, error: 'SEB_REQUIRED', reason: 'no_header' });
  }

  // 2. Authenticate the caller — BEFORE anything that costs a Firestore read.
  //
  // WHY THE ORDER MATTERS (and why it changed). Step 3 reads
  // `sebAssessmentKeys/{assessmentId}`, and assessmentId is supplied by the
  // caller. With this check below that read, an UNAUTHENTICATED caller who
  // sent any junk hash header could drive one Firestore read — and one cache
  // entry — per distinct id they invented. Billable, and unbounded in memory.
  //
  // Verifying here costs no network in the steady state: Google's signing
  // certs are cached for five minutes and the RS256 check is local CPU, so
  // this step's cost does not scale with anything the caller controls.
  //
  // NO LEGITIMATE CLIENT SEES A DIFFERENCE. getSebToken refuses to call this
  // endpoint without a signed-in user (assessmentService.ts), so the only
  // caller that reaches the moved check unauthenticated is one that was never
  // going to be issued a token anyway. It now learns that at 401 instead of
  // at 403, which tells it strictly less than before.
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

  // 3. Resolve the allowed keys (per-exam → platform → env), then recompute
  //    SHA256(url + configKey). Constant URL → constant target.
  const { keys: configKeys, source } = await resolveConfigKeys(projectId, assessmentId, envKeys);
  if (!configKeys.length) {
    return res.status(500).json({ ok: false, error: 'SEB_NOT_CONFIGURED', reason: `no_keys_${source}` });
  }

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

  // 4. Mint the short-lived proof, bound to the authenticated uid + exam.
  //    `uid` came from step 2 — the caller was authenticated before any of
  //    the work above, which is what stops an anonymous caller spending our
  //    Firestore quota. Binding to it is still what stops a student in SEB
  //    minting tokens for classmates sitting in Chrome.
  const { token, expiresAt } = mintSebToken(uid, assessmentId, secret);
  return res.status(200).json({
    ok: true, sebToken: token, expiresAt, ttlSeconds: TOKEN_TTL_SECONDS, keySource: source,
  });
}