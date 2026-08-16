/**
 * The builder's crash net.
 *
 * ── WHAT WAS WRONG ────────────────────────────────────────────────
 * Nothing in the builder survived leaving it. The top bar's Cancel called
 * onClose directly — no confirm, no warning — and a browser refresh, a closed
 * tab or a dead laptop lost the lot. Building a three-section paper means
 * picking subjects, narrowing topics, naming sections, setting timings and
 * writing selection rules: fifteen minutes of decisions held in React state
 * and nowhere else. One mis-click on a control sitting four pixels from the
 * step indicator threw all of it away.
 *
 * ── WHY LOCAL, NOT THE SERVER ─────────────────────────────────────
 * The obvious alternative is to write the draft to Firestore as it is typed.
 * That is a better product — the draft would follow the author to another
 * machine — and a considerably worse change: it puts half-built assessment
 * documents in the live collection, which every query, every rules clause and
 * every cleanup job then has to know are not real. This buys back the cases
 * that actually happen (refresh, crash, mis-click, closed tab) without
 * teaching the rest of the system a new kind of document.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────
 * It does not auto-restore. A draft that silently reappears is indistinguishable
 * from a bug the first time it happens, and the author cannot tell whether they
 * are looking at their own work or someone else's. The caller is handed the
 * snapshot and asks.
 *
 * It also never persists across a SAVE. Once the assessment exists, Firestore
 * is the truth, and a stale local copy racing it is a data-loss bug wearing a
 * safety net's clothes. clear() runs on every successful save.
 */

const KEY_PREFIX = 'ef.builder.draft';
const VERSION = 1;

/**
 * How long a stashed draft stays offerable.
 *
 * Long enough to survive a crash and a coffee; short enough that a draft found
 * next week is not offered as though it were still in progress. An author who
 * abandoned something eight days ago has moved on, and restoring it would be
 * archaeology rather than recovery.
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type StashedDraft<T> = {
  version: number;
  /** ISO. Shown to the author so they can judge whether they want it. */
  savedAt: string;
  /** The assessment being EDITED, or null in create mode. */
  assessmentId: string | null;
  /** Whatever the builder chose to snapshot. Opaque here on purpose. */
  data: T;
};

/**
 * Scoped per assessment, so an interrupted edit of exam A is never offered
 * while opening exam B. Create mode gets its own slot.
 */
function keyFor(assessmentId: string | null): string {
  return `${KEY_PREFIX}.${assessmentId ?? 'new'}`;
}

export function stashDraft<T>(assessmentId: string | null, data: T): void {
  try {
    const payload: StashedDraft<T> = {
      version: VERSION,
      savedAt: new Date().toISOString(),
      assessmentId,
      data,
    };
    localStorage.setItem(keyFor(assessmentId), JSON.stringify(payload));
  } catch {
    // Private browsing, a full quota, or storage disabled by policy. The
    // builder works exactly as it did before this file existed; it simply has
    // no net. Failing loudly here would interrupt someone mid-sentence to tell
    // them about a feature they never asked for.
  }
}

export function readDraft<T>(assessmentId: string | null): StashedDraft<T> | null {
  try {
    const raw = localStorage.getItem(keyFor(assessmentId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StashedDraft<T>;
    // A snapshot written by an older builder may not match today's state
    // shape. Restoring it half-way is worse than not offering it.
    if (parsed?.version !== VERSION) { clearDraft(assessmentId); return null; }
    if (Date.now() - Date.parse(parsed.savedAt) > MAX_AGE_MS) {
      clearDraft(assessmentId);
      return null;
    }
    return parsed;
  } catch {
    // Corrupt JSON — drop it rather than letting it throw on every open.
    clearDraft(assessmentId);
    return null;
  }
}

export function clearDraft(assessmentId: string | null): void {
  try { localStorage.removeItem(keyFor(assessmentId)); } catch { /* see stashDraft */ }
}
