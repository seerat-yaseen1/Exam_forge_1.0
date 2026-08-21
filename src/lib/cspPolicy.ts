// ── Content-Security-Policy, as something that can be checked ─────
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────
//
// The enforcing CSP in vercel.json used to carry four directives — the four
// that could be asserted without knowing anything about the app. The policy
// that actually matters (script-src, connect-src, default-src, img-src) sat in
// the report-only header, waiting to be promoted once somebody had watched it
// produce no legitimate violations. api/csp-report.js says so in its own
// header: "the only responsible way to promote one is to watch it produce zero
// legitimate violations for a while first".
//
// When that policy was finally checked against reality, it turned out it could
// not have been promoted as written: `connect-src` had no entry for
// `*.cloudfunctions.net`, and every Firebase callable in this platform —
// createAuthUser, setAccountStatus, gradeAttempt, the whole exam submission
// path — is an XHR to exactly that host. Enforcing it verbatim would have
// broken account creation and exam grading in production, and the login page
// no reviewer would have thought to look past would have been perfectly fine.
//
// That is the bug class this module exists to make impossible: a policy is a
// list of origins, the app depends on a list of origins, and nothing compared
// the two. cspPolicy.test.ts now does, in CI, against the real vercel.json.
//
// ── SCOPE ─────────────────────────────────────────────────────────
//
// Enough of the CSP source-matching grammar to answer "does this policy permit
// this URL for this directive", which is the question the test asks. Not a
// general CSP engine: no nonces, no hashes, no 'strict-dynamic' resolution.
// Those govern how a browser treats SCRIPTS it has already fetched; this is
// about whether a request is allowed to be made at all.

/** A parsed policy: directive name → its source list, both lower-cased. */
export type CspPolicy = Map<string, string[]>;

export function parseCsp(header: string): CspPolicy {
  const policy: CspPolicy = new Map();
  for (const chunk of header.split(';')) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const name = parts[0].toLowerCase();
    // First occurrence wins, matching the browser: a repeated directive is
    // ignored rather than merged, so a policy that names connect-src twice is
    // governed by the first one. Silently merging here would make this
    // disagree with the thing it is modelling.
    if (!policy.has(name)) policy.set(name, parts.slice(1));
  }
  return policy;
}

/**
 * Which directive actually governs a fetch, following the fallback chain.
 *
 * This is the half people forget. `media-src` absent does not mean "anything
 * goes" — it means `default-src` decides, and a `default-src 'self'` policy
 * therefore blocks a `blob:` video with no directive naming media anywhere in
 * the header. Reading the policy literally would call that permitted.
 */
const FALLBACK: Record<string, string[]> = {
  'script-src': ['default-src'],
  'style-src': ['default-src'],
  'img-src': ['default-src'],
  'font-src': ['default-src'],
  'connect-src': ['default-src'],
  'media-src': ['default-src'],
  'manifest-src': ['default-src'],
  'object-src': ['default-src'],
  'frame-src': ['child-src', 'default-src'],
  'worker-src': ['child-src', 'default-src'],
};

/** The directives that stand alone — no fallback, absent means unrestricted. */
const NO_FALLBACK = new Set(['base-uri', 'form-action', 'frame-ancestors', 'report-uri', 'report-to']);

export function effectiveSources(policy: CspPolicy, directive: string): string[] | null {
  const name = directive.toLowerCase();
  const own = policy.get(name);
  if (own) return own;
  if (NO_FALLBACK.has(name)) return null;
  for (const fallback of FALLBACK[name] ?? ['default-src']) {
    const sources = policy.get(fallback);
    if (sources) return sources;
  }
  return null;
}

/**
 * Does one source expression match this URL?
 *
 * `*.example.com` matches any subdomain at any depth — `a.b.example.com` as
 * well as `a.example.com` — but NOT the bare `example.com`. That last part is
 * the one worth stating: a policy listing only `*.googleapis.com` does not
 * permit `googleapis.com` itself.
 */
function sourceMatches(source: string, url: URL): boolean {
  const src = source.trim();
  if (!src || src.startsWith("'")) return false;          // keyword, handled by the caller

  // scheme-source: `https:`, `data:`, `blob:`
  if (/^[a-z][a-z0-9+.-]*:$/i.test(src)) return url.protocol.toLowerCase() === src.toLowerCase();

  const schemeMatch = src.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : null;
  let rest = schemeMatch ? src.slice(schemeMatch[0].length) : src;

  // A source may carry a path; only the host and port decide a match here.
  rest = rest.split('/')[0];

  let port: string | null = null;
  const portMatch = rest.match(/:(\*|\d+)$/);
  if (portMatch) {
    port = portMatch[1];
    rest = rest.slice(0, -portMatch[0].length);
  }
  const host = rest.toLowerCase();
  const urlHost = url.hostname.toLowerCase();

  if (scheme && url.protocol.toLowerCase() !== `${scheme}:`) {
    // A bare `https` source also permits `wss`-style upgrades in no sane
    // reading, so a mismatch is a mismatch. Kept explicit rather than clever.
    return false;
  }

  if (host === '*') return true;
  if (host.startsWith('*.')) {
    const suffix = host.slice(1);                          // '.example.com'
    if (!urlHost.endsWith(suffix)) return false;
  } else if (host !== urlHost) {
    return false;
  }

  if (port && port !== '*') {
    const actual = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'wss:' ? '443' : '80');
    if (actual !== port) return false;
  }
  return true;
}

/**
 * Would this policy allow `url` to be fetched under `directive`?
 *
 * @param selfOrigin the origin the document is served from, for `'self'`.
 */
export function permits(
  policy: CspPolicy,
  directive: string,
  url: string,
  selfOrigin = 'https://exam-forge.example',
): boolean {
  const sources = effectiveSources(policy, directive);
  if (sources === null) return true;                       // no directive governs it
  if (sources.length === 0) return false;
  if (sources.some((s) => s.toLowerCase() === "'none'")) return false;

  let parsed: URL;
  let self: URL;
  try {
    parsed = new URL(url);
    self = new URL(selfOrigin);
  } catch {
    return false;
  }

  for (const source of sources) {
    const lower = source.toLowerCase();
    if (lower === "'self'") {
      // 'self' is origin equality, and scheme is part of an origin: a page on
      // https does not reach its own origin over ws by way of 'self'.
      if (parsed.protocol === self.protocol && parsed.host === self.host) return true;
      continue;
    }
    if (lower.startsWith("'")) continue;                   // unsafe-inline and friends
    if (sourceMatches(source, parsed)) return true;
  }
  return false;
}

/** Is a keyword such as `'unsafe-inline'` present on a directive? */
export function hasKeyword(policy: CspPolicy, directive: string, keyword: string): boolean {
  const sources = effectiveSources(policy, directive);
  if (!sources) return false;
  const wanted = keyword.startsWith("'") ? keyword.toLowerCase() : `'${keyword.toLowerCase()}'`;
  return sources.some((s) => s.toLowerCase() === wanted);
}
