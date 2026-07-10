/**
 * SEB same-origin diagnostic (Phase 3, Stage 1b) — Vercel serverless function.
 *
 * WHY THIS EXISTS
 * The cross-origin diagnostic proved SEB does NOT inject its
 * X-SafeExamBrowser-ConfigKeyHash header into requests to cloudfunctions.net
 * (a different origin from the app). SEB sends the keys to the exam domain
 * only — sensible, since leaking the key to arbitrary third-party hosts would
 * be a hole in SEB itself.
 *
 * So verification must happen HERE, on the app's own origin. This endpoint
 * answers the remaining question: does SEB inject the header into a
 * same-origin request to /api/* on Vercel — for a plain navigation AND for a
 * fetch() from the page?
 *
 * It is a READ-ONLY echo. It grants nothing and changes nothing.
 *
 * The hash SEB computes is SHA256(absoluteRequestURL + ConfigKey), URL first,
 * hex-encoded, with any #fragment stripped. The URL includes the query string,
 * so passing ?candidateKey=... changes the URL that SEB hashed — which is fine,
 * because we hash the URL exactly as received here. Self-consistent.
 *
 * Usage:
 *   GET /api/seb-echo                      → are SEB headers present?
 *   GET /api/seb-echo?candidateKey=<hex>   → also test which URL form matches
 *
 * Remove once Stage 2 enforcement is calibrated.
 */

import { createHash } from 'node:crypto';

export default function handler(req, res) {
  const headers = req.headers || {};

  // Every SEB header we received, verbatim.
  const sebHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase().startsWith('x-safeexambrowser')) {
      sebHeaders[k] = Array.isArray(v) ? v.join(',') : String(v);
    }
  }

  const proto = headers['x-forwarded-proto'] || 'https';
  const host = headers['x-forwarded-host'] || headers.host || '';
  const path = req.url || '';
  const pathNoQuery = path.split('?')[0];

  // Candidate absolute URLs this request could correspond to.
  const urlCandidates = {
    full: `${proto}://${host}${path}`,
    noQuery: `${proto}://${host}${pathNoQuery}`,
    forcedHttps: `https://${host}${path}`,
    forcedHttpsNoQuery: `https://${host}${pathNoQuery}`,
  };

  const received = (
    sebHeaders['x-safeexambrowser-configkeyhash'] ||
    sebHeaders['X-SafeExamBrowser-ConfigKeyHash'] ||
    ''
  ).toLowerCase();

  // If a candidate key is supplied, show which URL form reproduces the hash.
  const candidateKey = (req.query && req.query.candidateKey) || '';
  const matches = {};
  if (candidateKey && received) {
    for (const [name, url] of Object.entries(urlCandidates)) {
      if (!url) continue;
      const h = createHash('sha256').update(url + candidateKey, 'utf8').digest('hex');
      matches[name] = h.toLowerCase() === received;
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    where: 'vercel-same-origin',
    sawAnySebHeader: Object.keys(sebHeaders).length > 0,
    sebHeaders,
    receivedConfigKeyHash: received || null,
    urlCandidates,
    matches, // {} unless candidateKey supplied
    raw: {
      host,
      xForwardedHost: headers['x-forwarded-host'] || null,
      proto,
      path,
      method: req.method,
    },
    userAgent: headers['user-agent'] || null,
  });
}