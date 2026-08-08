/**
 * CODE TELEMETRY — what a candidate did, not just what they submitted
 *
 * Stage C's foundation. Replay, plagiarism, similarity and performance
 * analytics are all derived from the same record, and none of them can be
 * built retroactively: an exam that was not recorded cannot be replayed later,
 * however good the analysis becomes. That ordering is the whole reason this
 * comes first.
 *
 * Pure, and separate from the editor, so the decisions that matter — what
 * counts as a paste, how much is kept, what is thrown away — are proven by the
 * suite rather than inferred from a component.
 *
 * ── WHAT IS RECORDED, AND WHY THAT MUCH ───────────────────────────
 *
 * Document edits with their text, timestamps, and the discrete acts a
 * candidate performs (run, language switch, focus loss). The text is included
 * because REPLAY NEEDS IT — a record of "12 characters were inserted at
 * position 40" reconstructs nothing a human can watch, and replay is the point.
 *
 * What is NOT recorded: keystrokes as such. A CodeMirror change is already the
 * meaningful unit, and capturing raw keydown would add modifier noise, capture
 * text typed into other fields, and produce a stream nothing consumes.
 *
 * ── PRIVACY IS A DESIGN CONSTRAINT, NOT A DISCLAIMER ──────────────
 *
 * This is a recording of a person working. It is personal data of a more
 * intimate kind than an answer, because it captures hesitation, deletion and
 * false starts — things a candidate chose not to submit. Three consequences
 * run through this file:
 *
 *   • it is OFF unless the tier turns it on, and off entirely for practice;
 *   • it is bounded, so it cannot grow into an unmanaged archive;
 *   • it belongs in its own collection, staff-only, and inside the platform's
 *     erasure machinery — never on the attempt document a student can read.
 */

// ══════════════════════════════════════════════════════════════════
// §1 — EVENTS
// ══════════════════════════════════════════════════════════════════

/** A document edit: text replacing the range [from, to). */
export interface EditEvent {
  k: 'edit';
  /** Milliseconds since the recording started. Relative, so it survives clock changes. */
  t: number;
  /** How long this event took to produce. Non-zero only after compaction. */
  dur?: number;
  from: number;
  to: number;
  /** Inserted text. Empty for a pure deletion. */
  text: string;
}

export interface ActEvent {
  k: 'run' | 'blur' | 'focus';
  t: number;
}

/**
 * A language selection, carrying the buffer as it stood at that moment.
 *
 * THE `doc` FIELD IS WHAT MAKES REPLAY POSSIBLE, and it is not optional in
 * practice even though the type permits its absence for older records.
 *
 * Edit events are ranges into a document — `replace [from, to) with text` — so
 * reconstructing anything requires knowing what the document was to begin
 * with. Two moments make that unknowable without a snapshot:
 *
 *   • the session start, where the editor already contains starter code that
 *     no edit event ever produced;
 *   • a language switch, which replaces the whole buffer at once with that
 *     language's draft or starter.
 *
 * Without a snapshot at each, replay applies subsequent edits to the wrong base
 * and renders a document the candidate never saw — confidently, and with no
 * sign anything is wrong. So a lang event doubles as a keyframe: one is emitted
 * when recording begins, and one on every switch.
 */
export interface LanguageEvent {
  k: 'lang';
  t: number;
  to: string;
  /** The full buffer immediately after this event. Absent only on legacy records. */
  doc?: string;
}

export type TelemetryEvent = EditEvent | ActEvent | LanguageEvent;

export const isEdit = (e: TelemetryEvent): e is EditEvent => e.k === 'edit';

// ══════════════════════════════════════════════════════════════════
// §2 — BOUNDS
// ══════════════════════════════════════════════════════════════════

/**
 * Caps, because an unbounded recorder is a liability rather than a feature.
 *
 * A candidate writing for an hour produces thousands of raw events, and a
 * cohort of 200 doing that on four questions is a lot of documents. Compaction
 * does most of the work; these are the backstop for the case it does not — a
 * script pasting in a loop, or a program generating edits.
 */
export const MAX_EVENTS = 4000;
export const MAX_TEXT_BYTES = 512 * 1024;

/** A single inserted string longer than this is stored truncated. */
export const MAX_SINGLE_INSERT = 8 * 1024;

// ══════════════════════════════════════════════════════════════════
// §3 — COMPACTION
// ══════════════════════════════════════════════════════════════════

/** Consecutive typing merges while gaps stay under this. */
export const TYPING_GAP_MS = 1500;

/**
 * Merge runs of ordinary typing into single events.
 *
 * Without this, "def solve():" is twelve events and an hour of work is
 * unstorable. With it, the same typing is one event carrying the text and the
 * duration it took — which is strictly MORE informative, because the duration
 * is what separates typing from pasting.
 *
 * Only forward, adjacent, purely-insertive edits merge. A deletion, a jump
 * elsewhere in the document, or a pause longer than TYPING_GAP_MS all break
 * the run, because each of those is a thing a reviewer would want to see
 * happening separately in a replay.
 */
export function compact(events: TelemetryEvent[]): TelemetryEvent[] {
  const out: TelemetryEvent[] = [];

  for (const e of events) {
    const prev = out[out.length - 1];

    if (
      isEdit(e) && prev && isEdit(prev)
      // both pure insertions
      && e.from === e.to && prev.from === prev.to
      // this one continues exactly where the last left off
      && e.from === prev.from + prev.text.length
      // and it followed closely enough to be the same act of typing
      && e.t - (prev.t + (prev.dur ?? 0)) <= TYPING_GAP_MS
      && prev.text.length + e.text.length <= MAX_SINGLE_INSERT
    ) {
      out[out.length - 1] = {
        ...prev,
        text: prev.text + e.text,
        // Duration runs from the start of the first keystroke to this one, so
        // a merged run reports how long it actually took to produce.
        dur: e.t - prev.t,
      };
      continue;
    }

    out.push(e);
  }

  return out;
}

/**
 * Enforce the caps on an already-compacted stream.
 *
 * Drops from the MIDDLE, keeping the beginning and the end. The opening of a
 * session shows how a candidate started — blank page, or a large block
 * appearing at once — and the end shows what they submitted. The middle is the
 * most compressible part of the story and the least often decisive.
 */
export function bound(events: TelemetryEvent[]): { events: TelemetryEvent[]; truncated: number } {
  let kept = events;
  let truncated = 0;
  // Keyframes are never dropped. Losing one costs the whole replay after it,
  // not one moment of it — every later edit would be applied to a document
  // that never existed.
  const keyframes = events.filter((e) => e.k === 'lang' && e.doc !== undefined);

  const oversize = (list: TelemetryEvent[]) =>
    list.reduce((n, e) => n + (isEdit(e) ? e.text.length : 0), 0) > MAX_TEXT_BYTES;

  if (kept.length > MAX_EVENTS || oversize(kept)) {
    const half = Math.floor(MAX_EVENTS / 2);
    while ((kept.length > MAX_EVENTS || oversize(kept)) && kept.length > 2) {
      const head = kept.slice(0, half);
      const tail = kept.slice(-half);
      const middleKeyframes = keyframes.filter(
        (k) => !head.includes(k) && !tail.includes(k));
      truncated += kept.length - head.length - tail.length - middleKeyframes.length;
      const next = [...head, ...middleKeyframes, ...tail]
        .sort((a, b) => a.t - b.t);
      if (next.length >= kept.length) break;   // cannot shrink further
      kept = next;
    }
  }

  return { events: kept, truncated };
}

// ══════════════════════════════════════════════════════════════════
// §4 — SIGNALS
// ══════════════════════════════════════════════════════════════════

/**
 * An insertion no human produced by typing.
 *
 * The test is rate, not size. A 600-character block appearing in one event
 * with no elapsed duration was pasted or inserted programmatically; the same
 * 600 characters typed over two minutes is a candidate working. Size alone
 * would flag anyone who writes quickly, and this is a signal that gets shown
 * to a human deciding something about a person — it has to be defensible.
 *
 * ADVISORY ONLY. Nothing in the platform marks anyone down for this. A
 * candidate moving their own code from one function to another produces a
 * genuine paste, and in a practice exam pasting is explicitly permitted.
 */
export const PASTE_MIN_CHARS = 120;
export const PASTE_MAX_CHARS_PER_SEC = 40;

export function isPasteShaped(e: TelemetryEvent): boolean {
  if (!isEdit(e) || e.text.length < PASTE_MIN_CHARS) return false;
  const seconds = (e.dur ?? 0) / 1000;
  if (seconds <= 0) return true;
  return e.text.length / seconds > PASTE_MAX_CHARS_PER_SEC;
}

export interface TelemetrySummary {
  /** Wall time from first to last event. */
  spanMs: number;
  /** Time spent within TYPING_GAP_MS of an edit — roughly, time actually working. */
  activeMs: number;
  /** Gaps longer than IDLE_GAP_MS, and their total. */
  idleCount: number;
  idleMs: number;
  edits: number;
  runs: number;
  /** Times the editor lost focus. High counts are worth a look, not an accusation. */
  blurs: number;
  languageSwitches: number;
  pasteShaped: number;
  largestInsert: number;
  /** Characters typed, excluding paste-shaped insertions. */
  typedChars: number;
}

export const IDLE_GAP_MS = 30_000;

/**
 * Reduce a stream to the numbers a reviewer or an analytics view would use.
 *
 * Every field here is descriptive. None of it is a verdict, and nothing in the
 * grading path reads any of it — a mark comes from tests passing, and that
 * separation is deliberate: the moment behaviour affects a score, a candidate
 * is being marked on how they worked rather than on what they produced.
 */
export function summarise(events: TelemetryEvent[]): TelemetrySummary {
  const s: TelemetrySummary = {
    spanMs: 0, activeMs: 0, idleCount: 0, idleMs: 0,
    edits: 0, runs: 0, blurs: 0, languageSwitches: 0,
    pasteShaped: 0, largestInsert: 0, typedChars: 0,
  };
  if (events.length === 0) return s;

  const end = (e: TelemetryEvent) => e.t + (isEdit(e) ? (e.dur ?? 0) : 0);
  s.spanMs = end(events[events.length - 1]) - events[0].t;

  let prevEnd: number | null = null;
  for (const e of events) {
    if (prevEnd !== null) {
      const gap = e.t - prevEnd;
      if (gap >= IDLE_GAP_MS) { s.idleCount++; s.idleMs += gap; }
      else if (gap > 0) s.activeMs += gap;
    }
    prevEnd = end(e);

    if (e.k === 'run') s.runs++;
    if (e.k === 'blur') s.blurs++;
    if (e.k === 'lang') s.languageSwitches++;
    if (isEdit(e)) {
      s.edits++;
      s.activeMs += e.dur ?? 0;
      if (e.text.length > s.largestInsert) s.largestInsert = e.text.length;
      if (isPasteShaped(e)) s.pasteShaped++;
      else s.typedChars += e.text.length;
    }
  }

  return s;
}

// ══════════════════════════════════════════════════════════════════
// §5 — WHEN IT RECORDS AT ALL
// ══════════════════════════════════════════════════════════════════

/**
 * Recording is a tier decision, and practice is never recorded.
 *
 * A candidate practising is rehearsing, not being assessed, and keeping a
 * keystroke record of that has no purpose any analysis would serve. At the
 * proctored tiers it is on by default and an institution may switch it off —
 * the reverse of paste, which is locked at high stake, because a recording is
 * evidence about a person rather than a restriction on them, and an
 * institution declining to collect it is a decision they are entitled to make.
 */
export function telemetryEnabled(
  tier: 'mock' | 'normal' | 'high_stake' | undefined,
  override?: boolean,
): boolean {
  if (tier === 'mock') return false;          // never, and not overridable
  if (tier === undefined) return false;       // legacy attempt: do not start recording one
  return override ?? true;
}
