/**
 * extensionScan
 *
 * Shared browser-extension detection used by BOTH the continuous
 * ExtensionWatchdog (during an exam) and the pre-entry gate on the briefing
 * page (Phase 1c completion). Keeping the fingerprint list + scan logic in
 * one place means the entry gate and the in-exam monitor can never drift.
 *
 * A web page cannot disable extensions — it can only detect ones that inject
 * visible DOM. Silent extensions remain invisible; for real lockdown use Safe
 * Exam Browser (high-stake tier, Phase 3).
 */

import { probeExtensionIds } from './extensionIdProbe';
import { detectApiTampering } from './apiIntegrity';

export type Fingerprint = { key: string; selector: string; label: string };

// Conservative — only extensions that insert visible UI elements.
export const EXTENSION_FINGERPRINTS: Fingerprint[] = [
  // Grammarly — injects custom elements at body level
  { key: 'grammarly',  selector: 'grammarly-desktop-integration, grammarly-extension, [data-grammarly-shadow-root]', label: 'Grammarly' },
  { key: 'gr-button',  selector: 'gr-textarea-button, [data-gramm]', label: 'Grammarly button' },

  // AI sidebar / assistant extensions
  { key: 'monica',     selector: '#monica-extension-root, [class*="monica-"]', label: 'Monica AI' },
  { key: 'sider',      selector: '#sider-extension-root, [class^="sider-"]', label: 'Sider AI' },
  { key: 'maxai',      selector: '#maxai-floating-action-button, [class*="maxai-"]', label: 'MaxAI' },
  { key: 'glasp',      selector: '[class*="glasp-"], #glasp-extension-root', label: 'Glasp' },
  { key: 'webchatgpt', selector: '#webchatgpt, [class*="webchatgpt-"]', label: 'WebChatGPT' },
  { key: 'merlin',     selector: '#merlin-extension-root, [class*="merlin-"]', label: 'Merlin' },
  { key: 'harpa',      selector: '#harpa-ui, [class*="harpa-"]', label: 'HARPA AI' },
  { key: 'compose-ai', selector: '[class*="compose-ai-"]', label: 'Compose AI' },

  // Translation / language helpers
  { key: 'languagetool', selector: '[class*="lt-marker-"], [class*="languagetool-"]', label: 'LanguageTool' },

  // Note / clipping
  { key: 'notion-clipper', selector: '#notion-web-clipper', label: 'Notion Web Clipper' },
  { key: 'evernote',       selector: '#evernoteFloater, [class*="evernote-"]', label: 'Evernote' },

  // Password / autofill (visible UI variants)
  { key: 'lastpass',       selector: 'div[data-lastpass-icon-root], #__lpform_root', label: 'LastPass' },
  { key: 'dashlane',       selector: 'div[data-dashlane-rid], div[data-dashlane-classification]', label: 'Dashlane' },

  // ── Question AI ───────────────────────────────────────────────
  //
  // `qai` is Question AI, observed on a live briefing page mounting four
  // shadow hosts: qaiSidebarShadowHostEl, qaiWebPageCopilotShadowHostEl,
  // qaiUnderlineWordShadowHostEl, qaiChromeosQuestionnaireShadowHostEl.
  //
  // It is worth saying plainly that this is the highest-signal entry in the
  // whole list. Most of the names above are writing aids that happen to be
  // unwelcome in an exam; this one exists to answer questions on the page it
  // is looking at, which is the entire threat model in one extension. The
  // "Questionnaire" and "WebPageCopilot" hosts are that capability naming
  // itself.
  //
  // The label is the product, not the framework, because this string reaches
  // an examiner deciding about a person. An earlier revision of this line
  // guessed "QuillBot" from the `qai` prefix — wrong, and wrong in the one
  // direction that matters, since the record would have accused a student of
  // running a paraphraser rather than an answer engine. The plasmo entry below
  // still catches it if these ids ever change; what it cannot do is name it.
  //
  // The `[id$="ShadowHostEl"]` half of the selector is not decoration:
  // `[id^="qai"]` alone is three characters and could plausibly collide with
  // an id this app or a future dependency invents. Anchoring both ends matches
  // every host observed and nothing that merely starts with the same letters.
  { key: 'question-ai', selector: '[id^="qai"][id$="ShadowHostEl"], [class*="question-ai-"], #question-ai-root', label: 'Question AI' },

  // Wordtune — mounts several custom elements, all four observed live:
  // wordtune-app-toolbar, wordtune-spices-nudge, wordtune-read-toolbar,
  // wordtune-cards.
  { key: 'wordtune',   selector: 'wordtune-app-toolbar, wordtune-cards, wordtune-read-toolbar, wordtune-spices-nudge, [class*="wordtune-"]', label: 'Wordtune' },

  // ── Extension FRAMEWORK markers ───────────────────────────────
  //
  // `plasmo-csui` is the custom element Plasmo mounts a content-script UI
  // into. It is worth naming for the same reason the framework is worth
  // knowing about: nothing but a browser extension ever emits that tag, so
  // matching it is as certain as matching a vendor's own id, and it covers
  // every extension built on Plasmo including ones written after this line.
  //
  // This is what closes the case that prompted it. A Plasmo-based AI sidebar
  // injects into the PAGE rather than opening browser chrome, so it changes
  // neither innerWidth nor outerWidth, never drops fullscreen, and produces no
  // blur — the entire geometry-and-focus battery is blind to it by
  // construction. The only surface it cannot avoid presenting is its own DOM.
  { key: 'plasmo',     selector: 'plasmo-csui, [id^="plasmo-"], [class^="plasmo-"]', label: 'Plasmo-based extension (AI sidebar)' },

  // Generic markers — extensions often append <div id="*-extension-root"> or use shadow DOM
  { key: 'extension-root', selector: '[id$="-extension-root"], [id^="chrome-extension-"]', label: 'Generic extension root' },
];

/**
 * One-shot synchronous scan. Returns the list of detected extension labels
 * (empty = clean). Used by the briefing entry gate. Bad selectors are ignored.
 */
export function scanForExtensions(): string[] {
  if (typeof document === 'undefined') return [];
  const found: string[] = [];
  for (const fp of EXTENSION_FINGERPRINTS) {
    try {
      if (document.querySelector(fp.selector)) found.push(fp.label);
    } catch {
      // Bad selector — ignore
    }
  }
  return found;
}

// ══════════════════════════════════════════════════════════════════
// GENERIC FOREIGN-DOM DETECTION
// ══════════════════════════════════════════════════════════════════
//
// The fingerprint list above only ever sees extensions somebody thought to
// add, and it ages the moment an extension renames an element. This finds the
// shape instead of the name: an extension that injects visible UI has to put
// a node somewhere, and it cannot put it inside our React tree — it appends at
// the top level, as a sibling of the app root.
//
// That makes the rule cheap AND strict. This app renders entirely into
// #root — there is not one createPortal in the codebase — so a top-level
// element that is neither the root nor a script/style tag was not put there by
// us. The check reads a handful of direct children rather than walking the
// document, which is what lets it run on every mutation without cost.
//
// ── WHY THIS IS A SEPARATE SEVERITY, NOT A LONGER LIST ────────────
//
// A named fingerprint match feeds reportExtensionCheck, and the server FREEZES
// the attempt on tiers that require the extension check. Since D-30 a freeze
// has no automatic exit — a human has to clear it.
//
// A generic detector's whole premise is firing on things nobody enumerated,
// which is the same thing as saying its false positives are unknowable in
// advance. Wiring that into a state only an invigilator can leave would mean a
// password manager, an IME candidate window or some future browser feature
// could stop a live sitting until someone intervened, once per student.
//
// So the two severities are structurally different signals: a named match
// stays freeze-eligible, and a foreign node is reported as `foreign_dom`,
// which nothing in the freeze path listens for. The reviewer gets told what
// was seen; the student keeps writing. That split is asserted by tests, not
// just intended.

/** Element ids/tags that belong to the page itself and are never foreign. */
const APP_ROOT_ID = 'root';
const BENIGN_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'TEMPLATE', 'NOSCRIPT']);

/**
 * OUR OWN top-level nodes.
 *
 * The claim above — "this app renders entirely into #root, there is not one
 * createPortal in the codebase" — is true of the React tree and false of the
 * page. Firebase App Check initialises reCAPTCHA v3 (`firebase.ts`), and
 * reCAPTCHA appends its own container and badge at body level. Every sitting,
 * on every machine, with no extension installed at all.
 *
 * So the generic detector reported the app's own infrastructure to the
 * reviewer as an unrecognised element, in the same list as a genuine AI
 * sidebar — on the briefing page it read `<div#fire_app_check_[DEFAULT]>`
 * right next to the real findings. Noise in a detector is not a cosmetic
 * problem: this list is the evidence a human weighs, and a signal that fires
 * for everyone teaches its reader to ignore it. It also blocks enforcement
 * outright, since anything acting on this list would act on every student.
 *
 * Matched by PREFIX because the App Check container is named for the Firebase
 * app instance (`fire_app_check_[DEFAULT]`), and the bracketed suffix is not
 * ours to promise. Kept deliberately short: every entry here is a hole in the
 * detector, so it earns its place by being something this codebase itself
 * causes to exist.
 */
const APP_OWNED_ID_PREFIXES = [
  'fire_app_check_',   // Firebase App Check container
  'recaptcha-',        // reCAPTCHA v3 challenge/badge containers
];

/** reCAPTCHA's badge and challenge iframes carry these class markers. */
const APP_OWNED_CLASS_MARKERS = ['grecaptcha-badge', 'grecaptcha-logo'];

function isAppOwned(el: Element): boolean {
  if (el.id && APP_OWNED_ID_PREFIXES.some((p) => el.id.startsWith(p))) return true;
  const cls = typeof el.className === 'string' ? el.className : '';
  if (APP_OWNED_CLASS_MARKERS.some((m) => cls.includes(m))) return true;
  // reCAPTCHA's badge is a bare <div> wrapping an iframe pointed at Google's
  // recaptcha endpoint. Identified by what it CONTAINS rather than by a class,
  // because the wrapper itself carries no stable marker.
  const frame = el.querySelector?.('iframe[src*="recaptcha"]');
  return !!frame;
}

/** Extension-owned URL schemes, across the browsers that expose one. */
const EXTENSION_SCHEMES = ['chrome-extension://', 'moz-extension://', 'safari-web-extension://', 'ms-browser-extension://'];

/** A short, reviewer-readable description of one node. Never its content. */
function describeNode(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  // First class only, and truncated: enough for a reviewer to recognise the
  // culprit, short enough that a hostile class attribute cannot bloat the
  // violation detail it ends up in.
  const cls = !id && typeof el.className === 'string' && el.className.trim()
    ? `.${el.className.trim().split(/\s+/)[0]}`
    : '';
  return `<${tag}${id || cls}>`.slice(0, 80);
}

/**
 * Unrecognised top-level nodes and extension-scheme iframes.
 *
 * Returns descriptors, not labels — it cannot name what it finds, and saying
 * "unrecognised element <x-foo>" is the honest report. Naming a guess is the
 * mistake the DevTools width heuristic used to make.
 */
export function scanForForeignDom(): string[] {
  if (typeof document === 'undefined') return [];
  const found: string[] = [];

  const inspect = (el: Element) => {
    if (BENIGN_TAGS.has(el.tagName)) return;
    if (el.id === APP_ROOT_ID) return;
    if (isAppOwned(el)) return;
    found.push(describeNode(el));
  };

  try {
    for (const el of Array.from(document.body?.children ?? [])) inspect(el);
    // Siblings of <body> — rarer, but an extension that appends to
    // documentElement would otherwise be invisible to the check above.
    for (const el of Array.from(document.documentElement?.children ?? [])) {
      if (el.tagName === 'HEAD' || el.tagName === 'BODY') continue;
      inspect(el);
    }
    // An extension iframe can legitimately live INSIDE our tree (injected into
    // a container it found), so this one is a document-wide query. It is
    // scheme-matched rather than shape-matched, so it cannot false-positive on
    // an iframe the exam itself renders.
    for (const frame of Array.from(document.querySelectorAll('iframe'))) {
      const src = frame.getAttribute('src') ?? '';
      if (EXTENSION_SCHEMES.some((s) => src.startsWith(s))) {
        found.push(`<iframe ${src.split('/')[2] ?? 'extension'}>`.slice(0, 80));
      }
    }
  } catch {
    // A detector must never be the thing that breaks an exam.
  }

  return Array.from(new Set(found));
}

// ══════════════════════════════════════════════════════════════════
// BASELINE — what was already here, versus what turned up
// ══════════════════════════════════════════════════════════════════
//
// The long note above explains why a foreign element is recorded mid-exam and
// never freezes: the check fires on things nobody enumerated, so its false
// positives are unknowable, and a freeze has no automatic exit.
//
// The ENTRY GATE changed the premise that argument rests on. Since any foreign
// element now refuses entry, a student who is sitting the exam has already
// demonstrated a page with none. A password manager, an IME, a corporate
// agent — every ordinary injector the note worried about — was caught at the
// door or the student never got in.
//
// So a top-level node that appears mid-sitting is no longer an unknown
// quantity. It is a change against a state this system verified minutes
// earlier, and the set of things that produce one is small and deliberate:
// somebody enabled an extension after passing the check.
//
// That is worth a freeze, and it is the last route an extension had into a
// sitting — entry blocks it, re-entry blocks it, and until now switching it on
// once inside merely wrote a line in a log nobody reads until afterwards.
//
// ── THE SETTLE WINDOW, AND WHY IT IS NOT A LOOPHOLE ───────────────
//
// Not everything present at entry is present at the first scan. Extensions
// inject late, and the exam's own first paint races them. Treating a slow
// arrival as "appeared" would freeze a student for something that was already
// there when they were admitted — the precise false positive this whole
// design is organised against.
//
// So findings in the first few seconds join the baseline instead of firing.
// The cost is a student who enables an extension inside that window getting
// baseline treatment; they are still recorded as foreign_dom, and they have to
// do it in the opening seconds of a paper. Set against freezing an honest
// student for a late-loading node, that trade is not close.

/** How long after the sitting starts a new finding is still treated as pre-existing. */
export const FOREIGN_BASELINE_SETTLE_MS = 6000;

/** Was this element here when the student was admitted, or did it turn up after? */
export type ForeignSeverity =
  /** Present at (or racing) the start. Recorded, never freezes. */
  | 'baseline'
  /** Appeared against a page verified clean at entry. Freeze-eligible. */
  | 'appeared';

/**
 * Classify one foreign descriptor against what was already known.
 *
 * Pure, and the caller owns the baseline set — the same split as
 * readViewportGeometry in IntegrityEngine, for the same reason: the rule is
 * the part worth testing and the measurement is not.
 *
 * `baselineOpen` is the settle window. While it holds, everything is baseline;
 * the caller is expected to add it to the set so the answer stays stable once
 * the window closes.
 */
export function classifyForeignElement(
  descriptor: string,
  baseline: ReadonlySet<string>,
  baselineOpen: boolean,
): ForeignSeverity {
  if (baseline.has(descriptor)) return 'baseline';
  return baselineOpen ? 'baseline' : 'appeared';
}

/** What a settled scan found, split by how much the finding can be trusted. */
export type ExtensionScanResult = {
  /** Matched a known fingerprint, or was proven present by ID. Blocks entry. */
  named: string[];
  /** Unrecognised top-level DOM. Recorded only — never blocks, never freezes. */
  foreign: string[];
  /**
   * The ID probe was refused by this page's own CSP.
   *
   * Carried so a caller can tell "probed and found nothing" from "never got to
   * probe". Nothing gates on it today; it exists so that promoting the
   * Report-Only policy in vercel.json to enforcing surfaces as a visible
   * degradation rather than as a detector that quietly always passes.
   */
  idProbeBlocked?: boolean;
};

/**
 * The entry gate's extension condition: ANY finding blocks.
 *
 * Both halves of the scan are treated alike here, which is the opposite of how
 * they are treated inside the exam. The asymmetry is the point, and it follows
 * from what being wrong costs on each surface:
 *
 *   entry    — nothing has started. A false positive costs the student the
 *              time it takes to disable an extension and press Re-check. The
 *              remedy is theirs and it is seconds long.
 *   mid-exam — a freeze has no automatic exit (D-30). A false positive strands
 *              a student mid-paper until a human intervenes.
 *
 * So the generic detector, whose false positives are unknowable by
 * construction, is allowed to block the recoverable one and never the
 * unrecoverable one.
 *
 * Extracted as a function rather than left inline because it is now the rule
 * standing between a student and their exam, and both call sites — the mount
 * scan and the click-time re-scan — have to apply it identically. Two copies
 * of this condition drifting apart is how the click-time check ends up
 * admitting exactly the student the mount scan would have refused.
 */
export function extensionGateBlocks(result: ExtensionScanResult): boolean {
  return result.named.length > 0 || result.foreign.length > 0;
}

/**
 * Scan twice with a settle delay in between, because some extensions inject
 * their DOM a beat after page load. Resolves to the union of both passes, so a
 * slow-injecting extension isn't missed by a single instant-scan.
 *
 * Runs BOTH detectors, which is the point: the entry gate and the in-exam
 * monitor now share real coverage rather than a shared file. They still act
 * differently on the result, because the two surfaces have different costs for
 * being wrong — a false positive in here locks a student out of an exam
 * entirely, so only the named half is allowed to do that.
 */
export async function scanForExtensionsWithSettle(settleMs = 1500): Promise<ExtensionScanResult> {
  const firstNamed = scanForExtensions();
  const firstForeign = scanForForeignDom();

  // The ID probe runs CONCURRENTLY with the settle delay rather than after it.
  // Both are waits — one for slow-injecting DOM, one for the browser to answer
  // a handful of local requests — and running them in sequence would add the
  // probe's budget to the time a student stares at "Checking for browser
  // extensions…" before they can start.
  const [, probe] = await Promise.all([
    new Promise((r) => setTimeout(r, settleMs)),
    probeExtensionIds().catch(() => ({ found: [], blockedByCsp: false })),
  ]);

  return {
    // Probe hits join `named` because that is exactly what they are: a
    // conclusively identified extension. A hit is stronger evidence than any
    // selector match — a store ID cannot be renamed by a release the way an
    // element can — so it belongs on the side that acts, not the advisory one.
    // API tampering joins `named` because it is the least ambiguous finding the
    // scanner can make. A selector match says an extension is present; a
    // document that owns its own `hidden` property says something has
    // deliberately disabled the detectors this exam runs on. It belongs on the
    // side that blocks, not the advisory one.
    named: Array.from(new Set([
      ...firstNamed, ...scanForExtensions(), ...probe.found, ...detectApiTampering(),
    ])),
    foreign: Array.from(new Set([...firstForeign, ...scanForForeignDom()])),
    ...(probe.blockedByCsp ? { idProbeBlocked: true } : {}),
  };
}