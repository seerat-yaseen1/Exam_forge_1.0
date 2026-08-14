/**
 * apiIntegrity
 *
 * Detects a page whose own visibility and focus APIs have been replaced.
 *
 * ── THE THREAT ────────────────────────────────────────────────────
 *
 * A class of extension exists solely to make a tab claim it is still visible
 * and focused after the user switches away — "Always Active Window" and its
 * clones. Their published description is precise about the method: a script is
 * injected into every page that overwrites `document.visibilityState` and
 * `document.hidden`, plus the vendor-prefixed variants, and suppresses the
 * `visibilitychange` and `blur` events.
 *
 * That is an exact list of the inputs to this exam's two most consequential
 * detectors. `tab_switch` reads `document.hidden`; `focus_loss` listens for
 * `blur`. They are two of the three WARNING_VIOLATION_TYPES that drive
 * termination. An extension that turns both off does not evade one signal — it
 * removes the majority of the integrity system, and every remaining detector
 * goes on reporting a clean sitting.
 *
 * ── WHY THIS IS NOT A FINGERPRINT ─────────────────────────────────
 *
 * The obvious response is another row in EXTENSION_FINGERPRINTS. That would
 * catch the one extension somebody named, in the release they named it in, and
 * these clone freely — the store carries several under near-identical titles.
 *
 * The tampering itself is a better thing to look for than the tamperer. There
 * is no way to spoof `document.hidden` for the page's own scripts without
 * leaving the evidence this file reads, so the check covers every tool that
 * does it, including ones written after today, and it holds when they rename
 * their elements.
 *
 * It is also a DIRECT observation rather than an inference. IntegrityEngine
 * already infers tampering behaviourally — `focus_state_mismatch` when a blur
 * never arrives, `render_throttled` when frames stop while the page claims to
 * be in front. Both are real signals and both are circumstantial. This one
 * reads the modification.
 *
 * ── WHAT MAKES IT PRECISE ─────────────────────────────────────────
 *
 * `hidden`, `visibilityState` and `hasFocus` are defined on `Document.prototype`,
 * not on the document instance. A page cannot make them lie without installing
 * an OWN property on `document` that shadows the prototype — which is exactly
 * what `Object.defineProperty(document, 'hidden', …)` does, and it is how these
 * extensions are built.
 *
 * So the check is: does the instance own a member that only the prototype
 * should define? On an untouched page the answer is no, in every browser and
 * in jsdom, which is what makes this precise rather than heuristic. No
 * `toString()` sniffing for `[native code]`, which would be defeated by a
 * `toString` override and which reports differently across engines.
 */

/**
 * Document members that must live on the prototype.
 *
 * The vendor-prefixed variants are here because the extensions name them:
 * older code reads `webkitHidden`, so a tool that only spoofed the modern
 * property would be caught by pages this one is not. Listing them costs
 * nothing and closes the same door twice.
 *
 * `onvisibilitychange` is included for the event half. Assigning to it is the
 * lazy way to displace a listener, and unlike `addEventListener` it is not
 * something an analytics library wraps in passing.
 */
export const PROTOTYPE_ONLY_DOCUMENT_MEMBERS = [
  'hidden',
  'visibilityState',
  'webkitHidden',
  'webkitVisibilityState',
  'mozHidden',
  'mozVisibilityState',
  'msHidden',
  'msVisibilityState',
  'hasFocus',
  'onvisibilitychange',
  // Swallowing the registration is the other way to kill visibilitychange and
  // blur. Deliberately checked on the INSTANCE only: wrapping
  // EventTarget.prototype.addEventListener is something ordinary libraries do,
  // and flagging that would trade this check's precision for nothing.
  'addEventListener',
  'removeEventListener',
] as const;

/**
 * Which of those members have been shadowed on the document instance.
 *
 * Returns member names, not a verdict, so the caller decides what it means and
 * a reviewer is told exactly what was altered rather than being handed a
 * conclusion.
 *
 * Takes the document as an argument purely so this is testable against a
 * constructed one; production always passes the real thing.
 */
export function shadowedDocumentMembers(doc: Document = document): string[] {
  const found: string[] = [];
  for (const name of PROTOTYPE_ONLY_DOCUMENT_MEMBERS) {
    try {
      if (Object.getOwnPropertyDescriptor(doc, name) !== undefined) found.push(name);
    } catch {
      // A getter that throws is itself abnormal, but a detector must never be
      // the thing that breaks an exam.
    }
  }
  return found;
}

/**
 * The label a shadowed visibility API is reported under.
 *
 * Names the MODIFICATION, not a product. The check cannot know which extension
 * did it — several ship the same behaviour — and this string reaches an
 * examiner, so it says what was observed. It reads as an accusation because
 * unlike an unrecognised `<div>` this one is: there is no accidental way for a
 * document to acquire its own `hidden` property.
 */
export const VISIBILITY_TAMPER_LABEL =
  'Page visibility/focus API modified — tab-switch detection disabled';

/**
 * One line naming what was altered, for the violation detail.
 *
 * Bounded, like every other detail this codebase stores: the member list is
 * short and fixed, but the formatting is shared with strings that are not.
 */
export function describeTampering(members: string[]): string {
  return `document.${members.join(', document.')} replaced on this page`.slice(0, 500);
}

/**
 * Has anything exam-critical been replaced?
 *
 * The convenience wrapper the scanners call. Returns the label list rather
 * than a boolean so it drops straight into the `named` half of a scan result,
 * where the entry gate and the freeze path already act on it.
 */
export function detectApiTampering(doc: Document = document): string[] {
  return shadowedDocumentMembers(doc).length > 0 ? [VISIBILITY_TAMPER_LABEL] : [];
}
