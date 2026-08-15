/**
 * CSP violation sink — Vercel serverless.
 *
 * WHY THIS EXISTS
 *
 * vercel.json shipped a Content-Security-Policy-Report-Only header carrying the
 * policy that actually matters — script-src, connect-src, default-src, img-src —
 * and no `report-uri` or `report-to`. A report-only policy with nowhere to
 * report is a policy that runs, finds violations, writes them to a browser
 * console nobody is looking at, and discards them. It reads like coverage and
 * provides none.
 *
 * That gap is also what blocks the real goal. The report-only policy exists to
 * be PROMOTED to enforcing, and the only responsible way to promote one is to
 * watch it produce zero legitimate violations for a while first. Without a sink
 * there is no "watch", so the policy could never graduate and the enforcing
 * header stayed at the four directives it could be sure of.
 *
 * WHAT THIS IS NOT
 *
 * Not a security control. It observes; it blocks nothing. It is deliberately
 * unauthenticated because browsers send violation reports as a separate,
 * credential-less request — requiring auth here would mean receiving nothing.
 *
 * That makes it an unauthenticated endpoint that writes to logs, so it is bound
 * on every axis an anonymous caller controls: total body size, number of
 * reports per request, and the length of every field echoed into a log line.
 * Without those bounds the sink is a log-flooding amplifier pointed at the
 * project's own billing.
 *
 * BOTH REPORT FORMATS, because browsers disagree:
 *   • `application/csp-report`   — legacy `report-uri`. One `{"csp-report":{…}}`.
 *   • `application/reports+json` — Reporting API `report-to`. An ARRAY of
 *     envelopes, each `{type, url, body}`, and it batches, which is why the
 *     per-request report cap below is not theoretical.
 * vercel.json sends both directives, so this handler accepts both shapes rather
 * than assuming whichever the first browser tested happened to use.
 */

/** Hard ceiling on the raw body. Anything larger is refused unparsed. */
const MAX_BODY_BYTES = 64 * 1024;
/** Reporting API batches; only this many are logged per request. */
const MAX_REPORTS_PER_REQUEST = 20;
/** Every value echoed into a log line is clipped to this. */
const MAX_FIELD_CHARS = 300;

/**
 * Clip an untrusted value to something safe to put in a log line.
 *
 * Newlines are stripped, not just truncated. A blocked-uri is attacker-chosen,
 * and a value containing a newline could otherwise forge a second log entry —
 * the log-injection equivalent of the header-injection this endpoint exists to
 * help prevent.
 */
function field(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_FIELD_CHARS);
}

/** Normalise either wire format to the handful of fields worth recording. */
function normalise(report) {
  if (!report || typeof report !== 'object') return null;
  // Reporting API envelope: the CSP fields sit under `body`. Legacy: at the top.
  const r = report.body && typeof report.body === 'object' ? report.body : report;

  const directive = field(r.effectiveDirective || r['effective-directive']
    || r.violatedDirective || r['violated-directive']);
  const blocked = field(r.blockedURL || r['blocked-uri'] || r.blockedURI);
  if (!directive && !blocked) return null;   // not a CSP report shape

  return {
    directive,
    blocked,
    document: field(r.documentURL || r['document-uri']),
    source: field(r.sourceFile || r['source-file']),
    line: Number.isFinite(r.lineNumber) ? r.lineNumber
      : (Number.isFinite(r['line-number']) ? r['line-number'] : null),
    disposition: field(r.disposition) || 'report',
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  // Vercel parses JSON bodies by content-type and will not have parsed
  // `application/csp-report` or `application/reports+json`, so a string body is
  // the NORMAL case here rather than the fallback.
  let body = req.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      return res.status(413).json({ ok: false, error: 'PAYLOAD_TOO_LARGE' });
    }
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    // Malformed reports are not worth an error page — the browser is not
    // listening and cannot act on one. Accept and drop.
    return res.status(204).end();
  }

  const raw = Array.isArray(body)
    ? body                                   // Reporting API batch
    : [body['csp-report'] || body];          // legacy single, or a bare body

  let logged = 0;
  for (const entry of raw) {
    if (logged >= MAX_REPORTS_PER_REQUEST) break;
    const v = normalise(entry);
    if (!v) continue;
    logged++;
    // One line per violation, greppable by prefix. `disposition` distinguishes
    // a report-only finding from an enforced block, which is the difference
    // between "this would have broken" and "this did break".
    console.warn(
      `[csp] disposition=${v.disposition} directive=${v.directive} blocked=${v.blocked}`
      + ` document=${v.document} source=${v.source} line=${v.line ?? '-'}`,
    );
  }

  return res.status(204).end();
}
