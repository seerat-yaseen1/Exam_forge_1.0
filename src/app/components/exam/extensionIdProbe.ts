/**
 * extensionIdProbe
 *
 * Detects specific extensions by their STORE ID rather than by the DOM they
 * inject, by asking the browser for a resource the extension publishes at
 * `chrome-extension://<id>/<path>`. The browser serves it only if that
 * extension is installed and lists the path in `web_accessible_resources`.
 *
 * ── WHY THIS EXISTS ALONGSIDE THE DOM SCAN ────────────────────────
 *
 * A store ID is fixed for the life of an extension. The DOM it injects is not:
 * every selector in extensionScan.ts is a description of a vendor's private
 * implementation, and it breaks on the release that renames an element. The
 * `qai*` hosts this codebase now matches were correct on the day they were
 * observed and carry no promise beyond it.
 *
 * ── THE PROPERTY THAT DECIDES HOW THIS IS WIRED ───────────────────
 *
 * The probe is SOUND BUT NOT COMPLETE.
 *
 *   a hit  — conclusive. Nothing but that extension can serve that URL, so a
 *            load proves the extension is installed in this profile.
 *   a miss — proves nothing. The extension may be installed and simply not
 *            expose that path; may use MV3's `use_dynamic_url`, which
 *            randomises the URL per session and defeats this entirely; may
 *            restrict the resource to certain origins; or the request may have
 *            been blocked before it left the page (see the CSP note below).
 *
 * So a hit is treated as a NAMED detection — the tier already blocks entry on
 * those — and a miss changes nothing at all. In particular a clean probe sweep
 * must never be reported as "no extensions": it is the absence of one specific
 * kind of evidence, and the DOM scan remains the broader net.
 *
 * ── THE CSP TRAP ──────────────────────────────────────────────────
 *
 * A CSP that restricts `img-src` blocks these requests, and a blocked request
 * fires the same `error` event as a missing one. The enforcing policy in
 * vercel.json today sets only frame-ancestors/object-src/base-uri/form-action,
 * so nothing here is blocked — but the Report-Only policy sitting beside it
 * DOES specify `img-src 'self' data: blob: https:`, and promoting that policy
 * to enforcing would turn every probe into a silent miss.
 *
 * A detector that fails silently to "clean" is worse than no detector: it
 * reports safety it never checked. So violations are listened for, and a probe
 * sweep that was blocked says so rather than returning an empty list.
 */

/** One extension worth probing for by identity. */
export type ProbeTarget = {
  /** Chrome Web Store ID — the 32-character string in the store URL. */
  id: string;
  label: string;
  /**
   * Paths to try, in order. A hit on ANY means installed.
   *
   * These are the maintenance burden and the honest weak point: unlike the ID,
   * a resource path is not published anywhere authoritative and has to be
   * confirmed against a real install (DevTools ▸ Network while the extension
   * renders, or the unpacked manifest's `web_accessible_resources`). Wrong
   * paths cost nothing but a miss, which is why a miss is inconclusive by
   * design rather than by apology.
   */
  paths: string[];
};

/**
 * Extensions probed by identity.
 *
 * IDs verified against the Chrome Web Store listing, not recalled — the same
 * standard the `qai` fingerprint had to be corrected to meet. The store URL is
 * `chromewebstore.google.com/detail/<slug>/<id>`, and the id is the last
 * segment.
 */
export const PROBE_TARGETS: ProbeTarget[] = [
  {
    // chromewebstore.google.com/detail/questionai-homework-power/hajphibbdloomfdkeoejchiikjggnaif
    id: 'hajphibbdloomfdkeoejchiikjggnaif',
    label: 'Question AI',
    paths: ['icon.png', 'assets/icon.png', 'icons/icon128.png', 'logo.png'],
  },
  {
    // chromewebstore.google.com/detail/wordtune-ai-paraphrasing/nllcnknpjnininklegdoijpljgdjkijc
    id: 'nllcnknpjnininklegdoijpljgdjkijc',
    label: 'Wordtune',
    paths: ['icon.png', 'images/icon128.png', 'assets/logo.png', 'favicon.ico'],
  },
  // ── Visibility spoofers ───────────────────────────────────────
  //
  // These exist to disable exactly the detectors this exam depends on: their
  // own listing describes overwriting document.visibilityState and
  // document.hidden and suppressing visibilitychange and blur.
  //
  // Both ids resolve to a chromewebstore.google.com/detail listing, and there
  // are more clones than these under near-identical titles — which is the
  // argument for apiIntegrity.ts rather than for a longer list here. The
  // structural check catches every one of them, named or not, and these
  // entries only add the ability to say WHICH.
  {
    // chromewebstore.google.com/detail/always-active-window-—-al/bkedpobpnbpecnojdoileepmkgpedihe
    id: 'bkedpobpnbpecnojdoileepmkgpedihe',
    label: 'Always Active Window (visibility spoofer)',
    paths: ['icon.png', 'icons/48.png', 'data/icon.png', 'images/icon48.png'],
  },
  {
    // chromewebstore.google.com/detail/always-active-window-alwa/ehllkhjndgnlokhomdlhgbineffifcbj
    id: 'ehllkhjndgnlokhomdlhgbineffifcbj',
    label: 'Always Active Window (visibility spoofer)',
    paths: ['icon.png', 'icons/48.png', 'data/icon.png', 'images/icon48.png'],
  },
];

/** Schemes to try per target. Firefox and Safari use their own. */
const SCHEMES = ['chrome-extension', 'moz-extension', 'safari-web-extension'];

/** Per-request ceiling. A blocked or dropped request may never settle. */
export const PROBE_TIMEOUT_MS = 1200;

export type ProbeOutcome = {
  /** Labels of extensions proven present. */
  found: string[];
  /**
   * True if at least one request was refused by this page's own CSP.
   *
   * The caller must not read `found: []` as "clean" when this is set — the
   * sweep did not run, it was prevented.
   */
  blockedByCsp: boolean;
};

/**
 * Ask the browser for one extension-owned URL.
 *
 * An <img> rather than fetch(): fetch to an extension scheme rejects on some
 * browsers before the resource is consulted at all, which would make every
 * target look absent. An image load is answered by the extension's own
 * resource handler, so `onload` means the bytes arrived.
 *
 * Never rejects. A detector must not be the thing that breaks an exam.
 */
function probeUrl(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') { resolve(false); return; }
    let settled = false;
    const done = (hit: boolean) => {
      if (settled) return;
      settled = true;
      img.onload = null;
      img.onerror = null;
      window.clearTimeout(timer);
      resolve(hit);
    };
    const img = new Image();
    img.onload = () => done(true);
    img.onerror = () => done(false);
    const timer = window.setTimeout(() => done(false), timeoutMs);
    try {
      img.src = url;
    } catch {
      done(false);
    }
  });
}

/**
 * Probe every target. Resolves to what was PROVEN, plus whether the page's own
 * policy stopped the attempt.
 *
 * Targets run in parallel and paths within a target run in parallel: the whole
 * sweep is a handful of requests that never leave the machine, and serialising
 * them would put the timeout budget on the critical path of entering an exam,
 * multiplied by every path tried.
 */
export async function probeExtensionIds(
  targets: ProbeTarget[] = PROBE_TARGETS,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeOutcome> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { found: [], blockedByCsp: false };
  }

  // A CSP refusal and a missing resource produce the same `error` event on the
  // image, so the difference has to come from somewhere else. This is the only
  // place the browser tells them apart.
  let blockedByCsp = false;
  const onViolation = (e: SecurityPolicyViolationEvent) => {
    if (typeof e.blockedURI === 'string' && e.blockedURI.includes('-extension:')) {
      blockedByCsp = true;
    }
  };
  document.addEventListener('securitypolicyviolation', onViolation);

  try {
    const results = await Promise.all(targets.map(async (target) => {
      const urls = SCHEMES.flatMap((scheme) =>
        target.paths.map((p) => `${scheme}://${target.id}/${p}`));
      const hits = await Promise.all(urls.map((u) => probeUrl(u, timeoutMs)));
      return hits.some(Boolean) ? target.label : null;
    }));
    return {
      found: Array.from(new Set(results.filter((r): r is string => r !== null))),
      blockedByCsp,
    };
  } finally {
    document.removeEventListener('securitypolicyviolation', onViolation);
  }
}
