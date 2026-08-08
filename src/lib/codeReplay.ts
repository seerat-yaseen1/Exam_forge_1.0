/**
 * CODE REPLAY — reconstructing what a candidate saw, from what they did
 *
 * Telemetry stores edits as ranges: replace [from, to) with text. Applied in
 * order from a known starting document, they reproduce every intermediate state
 * the editor was ever in. That is the whole mechanism.
 *
 * ── THE ONE THING THIS MUST NOT DO ────────────────────────────────
 *
 * SHOW A DOCUMENT THE CANDIDATE NEVER SAW, WITHOUT SAYING SO.
 *
 * A replay is watched by someone forming a judgement about a person. Every
 * reconstruction failure here is silent by nature — an edit applied to the
 * wrong base produces text, not an error, and the text looks exactly as
 * authoritative as a correct reconstruction. So this module tracks whether it
 * still knows what it is doing, and `reliability` is reported alongside every
 * frame rather than being something the caller can forget to ask about.
 *
 * The failures it can detect:
 *   • no opening keyframe, so the starting document is unknown;
 *   • an edit whose range falls outside the document it is being applied to,
 *     which means events are missing between here and the last keyframe.
 */

import { isEdit, type TelemetryEvent } from './codeTelemetry';

export type Reliability =
  | { ok: true }
  | { ok: false; reason: 'no-keyframe' | 'out-of-range'; fromIndex: number };

export interface ReplayFrame {
  /** Milliseconds from the start of the recording. */
  t: number;
  /** The document as it stood immediately after this event. */
  doc: string;
  /** Index into the source event list. */
  index: number;
  /** The event that produced this frame. */
  event: TelemetryEvent;
  /**
   * Whether the document above is trustworthy from this point on.
   *
   * Once reconstruction breaks it stays broken — a later keyframe restores it,
   * and nothing else can.
   */
  reliability: Reliability;
}

/** Apply one edit to a document, or report that it cannot be applied. */
function applyEdit(doc: string, from: number, to: number, text: string): string | null {
  // A range outside the document is not a recoverable rounding error: it means
  // the document being edited is not the document the event was recorded
  // against, so everything after this point would be fiction.
  if (from < 0 || to < from || to > doc.length) return null;
  return doc.slice(0, from) + text + doc.slice(to);
}

/**
 * Build every frame of the recording, in order.
 *
 * Frames are materialised up front rather than computed on demand. The event
 * count is bounded and documents are small, so the cost is trivial, and it
 * makes scrubbing instant — which matters, because the way a reviewer actually
 * uses a replay is by dragging back and forth over the interesting minute.
 */
export function buildFrames(events: TelemetryEvent[]): ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  let doc: string | null = null;          // null until the first keyframe
  let reliability: Reliability = { ok: false, reason: 'no-keyframe', fromIndex: 0 };

  events.forEach((event, index) => {
    if (event.k === 'lang' && event.doc !== undefined) {
      // A keyframe is ground truth. It repairs a broken reconstruction, which
      // is the only thing that can.
      doc = event.doc;
      reliability = { ok: true };
    } else if (isEdit(event) && doc !== null) {
      const next = applyEdit(doc, event.from, event.to, event.text);
      if (next === null) {
        if (reliability.ok) reliability = { ok: false, reason: 'out-of-range', fromIndex: index };
        // The edit is skipped rather than guessed at. Guessing produces a
        // plausible document, which is worse than an unchanged one, because a
        // reviewer cannot tell the difference.
      } else {
        doc = next;
      }
    }

    frames.push({ t: event.t, doc: doc ?? '', index, event, reliability });
  });

  return frames;
}

/**
 * The document as it stood at `tMs`.
 *
 * Returns the last frame at or before that time — the document does not change
 * between events, so this is exact rather than interpolated.
 */
export function frameAt(frames: ReplayFrame[], tMs: number): ReplayFrame | null {
  if (frames.length === 0) return null;
  if (tMs < frames[0].t) {
    // Before the first event. The recording has not started; showing the first
    // frame's document here would show work that had not been done yet.
    return null;
  }
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (frames[mid].t <= tMs) lo = mid; else hi = mid - 1;
  }
  return frames[lo];
}

/** Total length of the recording. */
export function duration(frames: ReplayFrame[]): number {
  if (frames.length === 0) return 0;
  const last = frames[frames.length - 1];
  const tail = isEdit(last.event) ? (last.event.dur ?? 0) : 0;
  return last.t + tail;
}

// ══════════════════════════════════════════════════════════════════
// MARKS — what a reviewer scrubs to
// ══════════════════════════════════════════════════════════════════

export type MarkKind = 'paste' | 'run' | 'blur' | 'lang' | 'idle';

export interface ReplayMark {
  t: number;
  kind: MarkKind;
  label: string;
  index: number;
}

/**
 * The moments worth jumping to.
 *
 * Nobody watches an hour of typing. A replay is used by scrubbing between the
 * few instants that carry information, so those are surfaced as marks on the
 * timeline rather than left to be discovered.
 *
 * Every mark is descriptive. A paste mark says a block appeared at a rate no
 * one types at; it does not say the candidate cheated, and the label is worded
 * so that a reviewer reading it quickly is not handed a conclusion.
 */
export function buildMarks(
  events: TelemetryEvent[],
  opts: { pasteMinChars: number; pasteMaxCharsPerSec: number; idleGapMs: number },
): ReplayMark[] {
  const marks: ReplayMark[] = [];
  let prevEnd: number | null = null;

  events.forEach((e, index) => {
    if (prevEnd !== null && e.t - prevEnd >= opts.idleGapMs) {
      const gap = Math.round((e.t - prevEnd) / 1000);
      marks.push({ t: prevEnd, kind: 'idle', label: `No activity for ${gap}s`, index });
    }
    prevEnd = e.t + (isEdit(e) ? (e.dur ?? 0) : 0);

    if (isEdit(e)) {
      if (e.text.length >= opts.pasteMinChars) {
        const seconds = (e.dur ?? 0) / 1000;
        const rate = seconds > 0 ? e.text.length / seconds : Infinity;
        if (rate > opts.pasteMaxCharsPerSec) {
          marks.push({
            t: e.t,
            kind: 'paste',
            label: `${e.text.length} characters appeared at once`,
            index,
          });
        }
      }
      return;
    }
    if (e.k === 'run')  marks.push({ t: e.t, kind: 'run',  label: 'Ran sample tests', index });
    if (e.k === 'blur') marks.push({ t: e.t, kind: 'blur', label: 'Left the editor', index });
    if (e.k === 'lang') marks.push({ t: e.t, kind: 'lang', label: `Switched to ${e.to}`, index });
  });

  return marks;
}

/** Reassemble stored chunks into one ordered stream. */
export function mergeChunks(
  chunks: Array<{ seq: number; events: TelemetryEvent[] }>,
): TelemetryEvent[] {
  // By seq, not by arrival: chunks are written by separate calls and a
  // Firestore query gives no ordering guarantee this can rely on. Getting this
  // wrong applies later edits before earlier ones, which reconstructs nothing.
  return [...chunks]
    .sort((a, b) => a.seq - b.seq)
    .flatMap((c) => c.events ?? []);
}
