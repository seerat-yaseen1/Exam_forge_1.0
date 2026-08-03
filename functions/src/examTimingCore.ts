// ═══════════════════════════════════════════════════════════════════════════
// EXAM TIMING CORE — the single source of truth for "where does this student
// stand right now?"  (Master plan Phase 3a, 2026-08-01)
//
// PURE. No Firestore, no admin SDK, no wall clock, no I/O of any kind. `nowMs`
// is always passed in. That is not stylistic: it is what makes the whole state
// space reachable from a test, and the reason timing.sweep.cjs can assert
// properties across tens of thousands of generated cases in a second.
//
// NOTHING CALLS THIS YET. Phase 3a ships it inert, with its sweep, so the
// logic can be proven before anything depends on it. Phase 3b points
// startSection / submitSection / submitAnswerAndAdvance at it, and 3c exposes
// it as a callable.
//
// WHY IT EXISTS (doctrine D2/D3)
// Expiry logic currently lives in at least four places — ExamShell's
// expiredClock, startSection, submitSection and submitAnswerAndAdvance — each
// with its own idea of precedence. Every one of the shipped timing bugs came
// from two of those disagreeing:
//   D-01  submitSection advanced without recomputing the lock
//   D-14  the question clock switched itself off on the last question
//   #9    5s question grace on the server, 0s on the client
// One function, one verdict, and that class of bug stops being possible.
// ═══════════════════════════════════════════════════════════════════════════

// ── Time normalisation ─────────────────────────────────────────────
// Timestamps reach us in three shapes: Firestore Timestamps from a live doc,
// ISO strings from the legacy fields, and raw millis from tests. Callers should
// not have to care, and — critically — an UNREADABLE timestamp must never be
// silently treated as zero. Epoch 0 is "expired forever ago", which would end a
// student's exam on a parse failure.
export type TimeInput =
  | string | number | Date
  | { toMillis: () => number }
  | { toDate: () => Date }
  | null | undefined;

export function toMs(v: TimeInput): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? null : t;
  }
  const m = v as { toMillis?: () => number; toDate?: () => Date };
  if (typeof m.toMillis === 'function') {
    const t = m.toMillis();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof m.toDate === 'function') {
    const t = m.toDate().getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

// ── Inputs ─────────────────────────────────────────────────────────

export type SectionStartOrder = 'sequential' | 'random' | 'student_choice';
export type DeliveryMode = 'standard' | 'linear' | 'adaptive';

/**
 * A break configured after a section.
 *
 * MATCHES THE STORED SHAPE EXACTLY: `type BreakCfg = { durationMinutes:
 * number; mandatory: boolean }`. There is no `enabled` flag — a break exists
 * when `breakAfter` is PRESENT with a positive duration, and that is the only
 * test.
 *
 * An earlier version of this file invented `enabled` and gated on it, so the
 * resolver was blind to every break in the system and reported "advance to the
 * next section" where the callable correctly said "break". Caught by the Phase
 * 3b shadow on a real sitting, not by 13,446 generated states — because the
 * generator was building the invented shape too. A test fixture that agrees
 * with the bug proves nothing.
 */
export interface CoreBreak {
  durationMinutes?: number;
  mandatory?: boolean;
}

/**
 * Is a break actually configured here? Presence + positive duration.
 * A type predicate, so callers get `durationMinutes` narrowed to a number and
 * nobody has to reach for a non-null assertion.
 */
export function hasBreak(
  b: CoreBreak | undefined,
): b is CoreBreak & { durationMinutes: number } {
  return !!b && typeof b.durationMinutes === 'number' && b.durationMinutes > 0;
}

export interface CoreSection {
  id: string;
  /** Minutes. 0/undefined = untimed — the section has no bound of its own. */
  timeLimit?: number;
  /** Seconds per question. Sequential delivery only. */
  questionTimeLimit?: number;
  breakAfter?: CoreBreak;
  questionIds: string[];
}

export interface CoreAssessment {
  startDate?: TimeInput;
  endDate?: TimeInput;
  /** Minutes. 0/undefined = no overall bound. */
  overallTimeLimit?: number;
  overallGraceSeconds?: number;
  sectionGraceSeconds?: number;
  /** D-14: one number, consumed by BOTH sides. Server used 5, client used 0. */
  questionGraceSeconds?: number;
  sectionStartOrder?: SectionStartOrder;
  deliveryMode?: DeliveryMode;
  sections: CoreSection[];
}

export interface CoreSectionTiming {
  startedAt?: TimeInput;
  submittedAt?: TimeInput;
}

export interface CoreServedQuestion {
  questionId: string;
  sectionId: string;
  servedAt?: TimeInput;
  locked?: boolean;
}

/** One entry in the Phase 4 freeze ledger. Tolerated as absent until then. */
export interface CoreFreeze {
  id?: string;
  startedAt?: TimeInput;
  endedAt?: TimeInput;
  /** Measured duration of the freeze. */
  elapsedMs?: number;
  /** Decided credit, 0..elapsedMs. Only this is consumed by deadlines. */
  grantedMs?: number;
}

export interface CoreAttempt {
  status: string;
  startedAt?: TimeInput;
  sectionIds: string[];
  currentSectionIdx?: number;
  sectionTimings: Record<string, CoreSectionTiming>;
  servedQuestions?: CoreServedQuestion[];
  answers?: Record<string, unknown>;
  /** Σ grantedMs. Phase 4 writes it; until then legacy totalFrozenSeconds. */
  creditedFreezeMs?: number;
  totalFrozenSeconds?: number;
  freezes?: CoreFreeze[];
  penalties?: CorePenalty[];
  scores?: unknown;
  gradedAnswers?: unknown;
  answersLockedAfter?: TimeInput;
  sectionLockedAfter?: TimeInput;
  overallLockedAfter?: TimeInput;
  activeSessionId?: string | null;
}

// ── Penalties (Phase 4.5 / A4-A6) ──────────────────────────────────

/** The clocks a penalty can be taken from. */
export type PenaltyClock = 'question' | 'section' | 'overall';

/**
 * One deduction, decided by a named human at one unfreeze.
 *
 * SEPARATE FROM THE FREEZE LEDGER, DELIBERATELY. A deduction cannot be
 * expressed as reduced `grantedMs`: a single unfreeze may take time from the
 * question AND the section AND the total (A4), and one scalar cannot hold
 * three decisions. Netting would also destroy INV-4a — credit would appear to
 * fall — and would leave a student unable to be told who took what.
 *
 * Penalties are the FIRST thing in this module that moves a deadline
 * backwards. Everything else is built to fail in the student's favour. That is
 * why each one is a row with an actor and an instant, and why INV-3a and
 * INV-3c now permit a backward move only as far as a row like this justifies:
 * an unexplained one still fails.
 */
export type CorePenalty = {
  id: string;
  /** The freeze whose resume decision produced this. */
  freezeId: string;
  clock: PenaltyClock;
  /** Always positive. The direction is carried by `clock`, not by a sign. */
  amountMs: number;
  decidedAt: TimeInput;
  decidedBy?: string;
};

/**
 * Which clocks a deduction lands on. A5: DEDUCTION TRAVELS OUTWARD.
 *
 * Take five seconds from the question and the section and the total each lose
 * five seconds too — the time is gone from the sitting, not just from the
 * innermost box. It never travels inward: shortening a section leaves the
 * question in front of the student untouched (A5 row 4, the one to hold onto).
 */
const PENALTY_REACHES: Record<PenaltyClock, PenaltyClock[]> = {
  // Read as: a penalty on THIS clock is felt by THESE clocks.
  question: ['question', 'section', 'overall'],  // outward, all the way up
  section:  ['section', 'overall'],
  overall:  ['overall'],                          // nothing contains the total
};

/**
 * Total deduction applying to one clock instance.
 *
 * Anchored exactly as credit is (A6: penalties attach to the CLOCK, not the
 * student). Only penalties decided after this clock started count — so
 * penalise section B and section C begins on its full limit, because C's
 * anchor is later than the decision.
 */
export function penaltyForClock(
  a: CoreAttempt,
  clock: PenaltyClock,
  anchor: TimeInput,
): number {
  if (!Array.isArray(a.penalties)) return 0;
  const anchorMs = toMs(anchor);
  if (anchorMs === null) return 0;
  let total = 0;
  for (const p of a.penalties) {
    if (!PENALTY_REACHES[p.clock]?.includes(clock)) continue;
    const at = toMs(p.decidedAt);
    // An unreadable instant is not counted. A deduction must be provable —
    // the same standard creditForAnchor applies, pointed the other way.
    if (at === null || at < anchorMs) continue;
    if (typeof p.amountMs !== 'number' || !Number.isFinite(p.amountMs)) continue;
    total += Math.max(0, p.amountMs);
  }
  return total;
}

/** Every penalty on the attempt, for monotonicity checks. */
export function totalPenaltyMs(a: CoreAttempt): number {
  if (!Array.isArray(a.penalties)) return 0;
  return a.penalties.reduce(
    (sum, p) => sum + (typeof p.amountMs === 'number' && Number.isFinite(p.amountMs)
      ? Math.max(0, p.amountMs) : 0),
    0,
  );
}

// ── Output ─────────────────────────────────────────────────────────

export interface Deadlines {
  /** The assessment's availability window. Null when unbounded. */
  windowEndsAt: number | null;
  /** attempt.startedAt + overallTimeLimit + grace + freeze credit. */
  overallEndsAt: number | null;
  /**
   * Current section's own bound. NULL when the section has not started yet —
   * a deadline anchored on a start instant cannot exist before that instant,
   * and inventing one is how D-01 happened.
   */
  sectionEndsAt: number | null;
  /** Sequential delivery only; null in standard mode. */
  questionEndsAt: number | null;
  /** min() of the above. This is what the materialised lock caches. */
  effectiveEndsAt: number | null;
}

export type EndReason =
  | 'already_final'
  | 'not_open_yet'
  | 'window_closed'
  | 'overall_expired'
  | 'last_section_expired'
  | 'last_question_expired';

export type Verdict =
  | { kind: 'not_started'; deadlines: Deadlines }
  | { kind: 'ended'; reason: EndReason; deadlines: Deadlines }
  | {
      kind: 'break'; sectionId: string; nextSectionId: string;
      endsAt: number; mandatory: boolean; deadlines: Deadlines;
    }
  | { kind: 'choose'; remainingSectionIds: string[]; deadlines: Deadlines }
  | { kind: 'section'; sectionId: string; started: boolean; deadlines: Deadlines }
  | {
      kind: 'question'; sectionId: string; questionId: string;
      served: boolean; deadlines: Deadlines;
    };

// ── Constants ──────────────────────────────────────────────────────

export const DEFAULT_SECTION_GRACE_SECONDS = 30;
export const DEFAULT_OVERALL_GRACE_SECONDS = 30;
/**
 * D-14: the server allowed `qLimit + 5`, the client allowed `qLimit + 0`, so
 * the client auto-advanced five seconds before the server would even flag the
 * answer. One number now, and it is configurable per assessment.
 */
export const DEFAULT_QUESTION_GRACE_SECONDS = 5;

export const TERMINAL_STATUSES = ['submitted', 'auto_submitted', 'terminated'] as const;
export function isTerminal(status: string | undefined): boolean {
  return !!status && (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Does freeze credit extend the AVAILABILITY WINDOW as well as the student's
 * own clocks?  ← OPEN DECISION, see master plan R2/R3.
 *
 * `false` today, which matches the timing spec's "the window is a hard outer
 * wall" (already agreed as R2). The cost is real though: a student frozen for
 * ten minutes near the end of the window loses that credit entirely, because
 * the wall arrives before their extended clock does — which sits awkwardly
 * beside "a student must not suffer for being paused".
 *
 * Flip this one constant to change the policy; nothing else needs touching.
 */
export const FREEZE_CREDIT_EXTENDS_WINDOW = false;

/**
 * Does a legacy `totalFrozenSeconds` count as CREDITED time?  ← false until
 * Phase 4, deliberately.
 *
 * Phase 1 made verifyAndResume increment totalFrozenSeconds so that freezes
 * occurring before the ledger exists are measurable later. That field is a
 * MEASUREMENT, not a decision. Consuming it here would hand every previously
 * frozen student extra time silently — generous, but still a deadline moving
 * for a reason nobody authorised and nobody told them about, which is the
 * broken promise R4 exists to prevent, just in the pleasant direction.
 *
 * Phase 4 introduces the ledger, the invigilator's explicit grant, and the
 * student-facing notice. It flips this constant as the last step, at which
 * point the credit is a decision rather than an accident.
 *
 * Consequence for Phase 3b: with this false and no attempt yet carrying
 * `creditedFreezeMs` or `freezes`, credit is always 0 — so the resolver's
 * arithmetic is bit-identical to the computeAttemptLocks it replaces.
 */
export const CONSUME_LEGACY_FROZEN_SECONDS = true;   // flipped in Phase 4.3

/*
 * FLIPPED, and here is the reasoning, because the block above argues the other
 * way and was right at the time.
 *
 * The objection was that consuming totalFrozenSeconds would hand previously
 * frozen students extra time "for a reason nobody authorised and nobody told
 * them about". That objection assumed the field was a raw MEASUREMENT of
 * elapsed pause. It no longer is: unfreezeAttempt writes
 * `totalFrozenSeconds = creditedFreezeMs / 1000`, so on every Phase 4 attempt
 * it mirrors GRANTED time — an invigilator's explicit decision, recorded in
 * the ledger with an actor and a timestamp. Exactly what the block asked for.
 *
 * BLAST RADIUS IS BOUNDED AND SMALL. Look at the order in creditedFreezeMs:
 * this fallback is reached only when an attempt has neither `creditedFreezeMs`
 * nor a `freezes` array — that is, one frozen before the ledger existed. Those
 * attempts drain within a single sitting, and for them the flip does not
 * invent time: it honours the credit their own screen already showed them
 * while the write gate refused it. That contradiction is D-03. Leaving the
 * flag false would preserve it for exactly the students who already
 * experienced it.
 */

// ── Helpers ────────────────────────────────────────────────────────

/**
 * A section's own deadline. THE single implementation of this arithmetic.
 *
 * index.ts's computeAttemptLocks delegates here, so the number the write gate
 * enforces and the number the resolver reasons about cannot drift apart. They
 * were separate expressions until Phase 3b, which is the shape every timing
 * defect in this module has taken.
 *
 * Returns null — meaning UNBOUNDED — when the section is untimed or the anchor
 * is unreadable. Never epoch 0: "expired in 1970" would end an exam on a parse
 * failure.
 */
export function sectionDeadlineMs(
  sectionStartedAt: TimeInput,
  sectionTimeLimitMin: number | undefined,
  graceSeconds: number | undefined,
  creditMs = 0,
  /** Deduction taken from this section (A4). Positive; subtracted here. */
  penaltyMs = 0,
): number | null {
  const start = toMs(sectionStartedAt);
  if (start === null) return null;
  if (!sectionTimeLimitMin || sectionTimeLimitMin <= 0) return null;
  return start
    + sectionTimeLimitMin * 60_000
    + (graceSeconds ?? DEFAULT_SECTION_GRACE_SECONDS) * 1000
    + creditMs
    - Math.max(0, penaltyMs);
}

/** The overall deadline, anchored on the attempt's own start. */
export function overallDeadlineMs(
  attemptStartedAt: TimeInput,
  overallTimeLimitMin: number | undefined,
  graceSeconds: number | undefined,
  creditMs = 0,
  /** Deduction taken from the total, INCLUDING those that travelled outward. */
  penaltyMs = 0,
): number | null {
  const start = toMs(attemptStartedAt);
  if (start === null) return null;
  if (!overallTimeLimitMin || overallTimeLimitMin <= 0) return null;
  return start
    + overallTimeLimitMin * 60_000
    + (graceSeconds ?? DEFAULT_OVERALL_GRACE_SECONDS) * 1000
    + creditMs
    - Math.max(0, penaltyMs);
}

function minNonNull(...xs: Array<number | null>): number | null {
  const vals = xs.filter((x): x is number => x !== null);
  return vals.length === 0 ? null : Math.min(...vals);
}

/** Total credited freeze, in ms, from whichever field the attempt carries. */
/**
 * Freeze credit that applies to a clock anchored at `anchorMs`.
 *
 * THE UNIFORM VERSION OF THIS WAS WRONG, and obviously so once stated aloud:
 * a ten-minute pause during section 1 was added to EVERY deadline, including a
 * section that began twenty minutes later and a fifteen-second question served
 * inside it. That question ended up with ten minutes and fifteen seconds.
 *
 * A pause only costs a clock time if that clock was RUNNING when it happened.
 * The overall clock is anchored at attempt start, so every freeze counts
 * against it. A section is anchored when it starts; a question when it is
 * served. Freezes that began before those instants are irrelevant to them.
 *
 * Granting the full elapsed pause then restores each clock to exactly the
 * remaining time it had — no more, which is the ceiling an invigilator should
 * never be able to exceed.
 *
 * Falls back to the flat total when the ledger is absent (pre-Phase-4
 * attempts), which is the old behaviour and the best available answer without
 * per-freeze timestamps.
 */
export function creditForAnchor(a: CoreAttempt, anchor: TimeInput): number {
  const anchorMs = toMs(anchor);
  if (!Array.isArray(a.freezes) || a.freezes.length === 0) {
    return creditedFreezeMs(a);
  }
  if (anchorMs === null) return 0;
  return a.freezes.reduce((sum, f) => {
    const startedMs = toMs(f.startedAt);
    // Unreadable start: cannot prove the freeze overlapped this clock, so it
    // does not count. Credit must be justified, not assumed.
    if (startedMs === null) return sum;
    return startedMs >= anchorMs ? sum + Math.max(0, f.grantedMs ?? 0) : sum;
  }, 0);
}

/**
 * The instant an OPEN freeze began, or null when the attempt is running.
 *
 * "Open" means a ledger entry with no `endedAt`. Such an entry has no
 * `grantedMs` yet — the grant is the invigilator's decision at unfreeze — so
 * creditForAnchor contributes exactly 0 for it. That is correct for CREDIT and
 * useless for PAUSING: it is why, before Phase 4.3, a frozen student's
 * deadlines went on running server-side while their screen showed a stopped
 * clock. D-03, one layer down.
 */
export function openFreezeStartedMs(a: CoreAttempt): number | null {
  if (!Array.isArray(a.freezes)) return null;
  for (const f of a.freezes) {
    if (f.endedAt) continue;
    const ms = toMs(f.startedAt);
    if (ms !== null) return ms;
  }
  return null;
}

/**
 * The instant the resolver should reason from (Phase 4.3).
 *
 * While a freeze is open, time stops at the moment it began. Every clock the
 * student is racing is compared against this rather than the wall clock, so a
 * pause is a pause rather than a promise.
 *
 * min(nowMs, openStart) — never later than real time. A freeze whose
 * `startedAt` is in the future (clock skew, a bad write) must not push
 * deadlines outward; the worst it can do is nothing.
 *
 * An unreadable `startedAt` yields null and therefore real time. Credit must
 * be justified, not assumed — the same rule creditForAnchor applies.
 *
 * NOT used for the availability window, deliberately. A10 decided that a
 * window closing while a student is frozen still finalises the attempt: the
 * window is the institution's outer wall, not one of the student's clocks.
 */
export function effectiveNowMs(a: CoreAttempt, nowMs: number): number {
  const open = openFreezeStartedMs(a);
  return open === null ? nowMs : Math.min(nowMs, open);
}

export function creditedFreezeMs(a: CoreAttempt): number {
  if (typeof a.creditedFreezeMs === 'number' && Number.isFinite(a.creditedFreezeMs)) {
    return Math.max(0, a.creditedFreezeMs);
  }
  if (Array.isArray(a.freezes) && a.freezes.length > 0) {
    return a.freezes.reduce((sum, f) => sum + Math.max(0, f.grantedMs ?? 0), 0);
  }
  // Legacy field, pre-Phase-4. Recorded but never consumed — which IS D-03:
  // the display credited it and the write gate did not. Consuming it is a
  // Phase 4 decision, not a side effect of adopting the resolver.
  if (CONSUME_LEGACY_FROZEN_SECONDS
      && typeof a.totalFrozenSeconds === 'number'
      && Number.isFinite(a.totalFrozenSeconds)) {
    return Math.max(0, a.totalFrozenSeconds) * 1000;
  }
  return 0;
}

export function sectionById(asmt: CoreAssessment, id: string): CoreSection | undefined {
  return asmt.sections.find((s) => s.id === id);
}

/**
 * The section the student is IN: started and not submitted.
 *
 * Derived from sectionTimings, not from currentSectionIdx. The index is a
 * convenience field the client also writes; the timings are the record of what
 * actually happened, and when the two disagree the timings are right.
 *
 * Returns null when nothing is open — between sections, on a break, or before
 * the first section starts.
 *
 * "Started" means a PARSEABLE timestamp, not merely a present field: startExam
 * seeds unstarted sections with `startedAt: ''`.
 */
export function hasStarted(t: CoreSectionTiming | undefined): boolean {
  return toMs(t?.startedAt) !== null;
}
export function hasSubmitted(t: CoreSectionTiming | undefined): boolean {
  return toMs(t?.submittedAt) !== null;
}

export function openSectionId(a: CoreAttempt): string | null {
  for (const id of a.sectionIds) {
    const t = a.sectionTimings?.[id];
    if (hasStarted(t) && !hasSubmitted(t)) return id;
  }
  return null;
}

/** Sections in play order that have not been submitted. */
export function remainingSectionIds(a: CoreAttempt): string[] {
  return a.sectionIds.filter((id) => !hasSubmitted(a.sectionTimings?.[id]));
}

/** The last section the student submitted, by submit time. */
export function lastSubmitted(a: CoreAttempt): { id: string; at: number } | null {
  let best: { id: string; at: number } | null = null;
  for (const id of a.sectionIds) {
    const at = toMs(a.sectionTimings?.[id]?.submittedAt);
    if (at === null) continue;
    if (!best || at > best.at) best = { id, at };
  }
  return best;
}

/** The current unlocked served question, if any. INV-2 says there is ≤ 1. */
export function currentServed(a: CoreAttempt): CoreServedQuestion | null {
  const served = a.servedQuestions ?? [];
  for (let i = served.length - 1; i >= 0; i--) {
    if (served[i].locked !== true) return served[i];
  }
  return null;
}

function isSequential(asmt: CoreAssessment): boolean {
  const m = asmt.deliveryMode ?? 'standard';
  return m === 'linear' || m === 'adaptive';
}

// ── Deadlines ──────────────────────────────────────────────────────

/**
 * Every bound that applies to this attempt right now.
 *
 * Grace is part of the deadline, not a separate allowance checked afterwards
 * (master plan R1) — that is what makes a deadline survive a resume unchanged.
 * Freeze credit is added once, uniformly, to each of the student's own clocks.
 */
export function computeDeadlines(
  a: CoreAttempt,
  asmt: CoreAssessment,
): Deadlines {
  // Each clock gets credit for the pauses IT experienced — see creditForAnchor.
  const overallCredit = creditForAnchor(a, a.startedAt);

  const windowRaw = toMs(asmt.endDate);
  const windowEndsAt = windowRaw === null
    ? null
    : windowRaw + (FREEZE_CREDIT_EXTENDS_WINDOW ? overallCredit : 0);

  // A5: penalties reach outward, so the total absorbs deductions taken from
  // the section and the question as well as its own.
  const overallEndsAt = overallDeadlineMs(
    a.startedAt, asmt.overallTimeLimit, asmt.overallGraceSeconds, overallCredit,
    penaltyForClock(a, 'overall', a.startedAt),
  );

  // Section bound — only for a section that has actually started.
  const openId = openSectionId(a);
  let sectionEndsAt: number | null = null;
  if (openId) {
    const secStart = a.sectionTimings?.[openId]?.startedAt;
    sectionEndsAt = sectionDeadlineMs(
      secStart,
      sectionById(asmt, openId)?.timeLimit,
      asmt.sectionGraceSeconds,
      creditForAnchor(a, secStart),
      // Section deductions plus any taken from a question inside it. NOT
      // deductions taken from the total — those never travel inward (A5).
      penaltyForClock(a, 'section', secStart),
    );
  }

  // Question bound — sequential delivery only, and only while one is served.
  let questionEndsAt: number | null = null;
  if (isSequential(asmt)) {
    const cur = currentServed(a);
    if (cur && cur.locked !== true) {
      const sec = sectionById(asmt, cur.sectionId);
      const qLimit = sec?.questionTimeLimit ?? 0;
      const servedAt = toMs(cur.servedAt);
      if (servedAt !== null && qLimit > 0) {
        questionEndsAt = servedAt
          + qLimit * 1000
          + (asmt.questionGraceSeconds ?? DEFAULT_QUESTION_GRACE_SECONDS) * 1000
          + creditForAnchor(a, cur.servedAt)
          // Only deductions taken from the QUESTION itself. Shortening a
          // section leaves the question in front of the student untouched —
          // A5 row 4, and the one most likely to be got wrong.
          - penaltyForClock(a, 'question', cur.servedAt);
      }
    }
  }

  return {
    windowEndsAt,
    overallEndsAt,
    sectionEndsAt,
    questionEndsAt,
    effectiveEndsAt: minNonNull(windowEndsAt, overallEndsAt, sectionEndsAt, questionEndsAt),
  };
}

// ── The resolver ───────────────────────────────────────────────────

/**
 * Where does this student stand at `nowMs`?
 *
 * PRECEDENCE IS OUTSIDE-IN, FIRST MATCH WINS. The order is the whole design:
 * an outer bound always beats an inner one, so a student whose overall clock
 * has run out is finished regardless of how much section time is left.
 *
 *   1. already finalised?    → ended
 *   2. window closed?        → ended
 *   3. overall expired?      → ended
 *   4. section expired?      → last section   → ended
 *                              break due      → break
 *                              student_choice → choose
 *                              otherwise      → next section
 *   5. question expired?     → last in section → apply rule 4
 *                              otherwise       → next question
 *   6. nothing expired       → exactly where they were
 *
 * A deadline that cannot be computed is NOT an expired deadline. Missing
 * inputs mean "unbounded", never "over" — the failure direction always favours
 * the student.
 */
export function resolve(
  a: CoreAttempt,
  asmt: CoreAssessment,
  nowMs: number,
): Verdict {
  const deadlines = computeDeadlines(a, asmt);

  // ── Phase 4.3: an OPEN freeze stops the student's clocks ────────
  //
  // Every comparison below that races the STUDENT against a deadline uses
  // evalNow. While a freeze is open that instant is pinned at the moment the
  // freeze began, so section, question, overall and break clocks all hold
  // where they were.
  //
  // Before this, freeze paused the DISPLAY and nothing else: the shell froze
  // its countdown while the server went on advancing toward the same
  // deadlines, so a student released after ten minutes found their section
  // already over. That is D-03 — the display crediting what the gate does not.
  //
  // The AVAILABILITY WINDOW below deliberately keeps using nowMs. A10 decided
  // that a window closing during a freeze still finalises the attempt: it is
  // the institution's outer wall, not one of the student's clocks, and
  // FREEZE_CREDIT_EXTENDS_WINDOW says the same thing about credit.
  const evalNow = effectiveNowMs(a, nowMs);

  // 1. Terminal attempts are terminal. Nothing below can change that.
  if (isTerminal(a.status)) {
    return { kind: 'ended', reason: 'already_final', deadlines };
  }

  // Not begun yet.
  if (toMs(a.startedAt) === null) {
    const opens = toMs(asmt.startDate);
    if (opens !== null && nowMs < opens) {
      return { kind: 'ended', reason: 'not_open_yet', deadlines };
    }
    return { kind: 'not_started', deadlines };
  }

  // 2. Availability window — the hard outer wall (R2).
  if (deadlines.windowEndsAt !== null && nowMs >= deadlines.windowEndsAt) {
    return { kind: 'ended', reason: 'window_closed', deadlines };
  }

  // 3. Overall clock.
  if (deadlines.overallEndsAt !== null && evalNow >= deadlines.overallEndsAt) {
    return { kind: 'ended', reason: 'overall_expired', deadlines };
  }

  const openId = openSectionId(a);

  // On a break: the student is between sections, and the break has its own
  // clock anchored on the PREVIOUS section's submit instant.
  if (!openId) {
    const brk = pendingBreak(a, asmt, evalNow);
    if (brk) return { ...brk, deadlines };
  }

  // 4. Section clock.
  const sectionExpired =
    openId !== null
    && deadlines.sectionEndsAt !== null
    && evalNow >= deadlines.sectionEndsAt;

  if (sectionExpired) {
    return afterSection(a, asmt, openId!, evalNow, deadlines);
  }

  // 5. Question clock (sequential delivery only).
  if (isSequential(asmt) && openId) {
    const qExpired =
      deadlines.questionEndsAt !== null && evalNow >= deadlines.questionEndsAt;
    if (qExpired) {
      const sec = sectionById(asmt, openId);
      const cur = currentServed(a);
      const idx = sec && cur ? sec.questionIds.indexOf(cur.questionId) : -1;
      const isLastInSection = sec ? idx >= 0 && idx === sec.questionIds.length - 1 : true;

      // D-14: the last question of a section is treated exactly like the
      // section running out. The old client simply switched the clock off
      // there — `if (... || isLastQuestion) { setQSecondsLeft(null); return; }`
      // — so the final question of every section was untimed.
      if (isLastInSection) return afterSection(a, asmt, openId, evalNow, deadlines);

      const nextQid = sec!.questionIds[idx + 1];
      return {
        kind: 'question', sectionId: openId, questionId: nextQid,
        served: false, deadlines,
      };
    }
  }

  // 6. Nothing expired — resume exactly where they were.
  if (openId) {
    if (isSequential(asmt)) {
      const cur = currentServed(a);
      if (cur) {
        return {
          kind: 'question', sectionId: openId, questionId: cur.questionId,
          served: true, deadlines,
        };
      }
      const sec = sectionById(asmt, openId);
      const firstQ = sec?.questionIds[0];
      if (firstQ) {
        return {
          kind: 'question', sectionId: openId, questionId: firstQ,
          served: false, deadlines,
        };
      }
    }
    return { kind: 'section', sectionId: openId, started: true, deadlines };
  }

  // Nothing open and no break running: they are between sections.
  const remaining = remainingSectionIds(a);
  if (remaining.length === 0) {
    return { kind: 'ended', reason: 'last_section_expired', deadlines };
  }
  if ((asmt.sectionStartOrder ?? 'sequential') === 'student_choice') {
    return { kind: 'choose', remainingSectionIds: remaining, deadlines };
  }
  return { kind: 'section', sectionId: remaining[0], started: false, deadlines };
}

/**
 * What happens once the section the student is in is over.
 *
 * Shared by the section-expiry path and the last-question path so the two can
 * never disagree — which is exactly the disagreement D-14 was made of.
 */
function afterSection(
  a: CoreAttempt,
  asmt: CoreAssessment,
  sectionId: string,
  nowMs: number,
  deadlines: Deadlines,
): Verdict {
  const idx = a.sectionIds.indexOf(sectionId);
  const nextId = idx >= 0 ? a.sectionIds[idx + 1] : undefined;

  if (!nextId) {
    return { kind: 'ended', reason: 'last_section_expired', deadlines };
  }

  const sec = sectionById(asmt, sectionId);
  const brk = sec?.breakAfter;
  if (hasBreak(brk)) {
    // Break anchors on the section's submit instant when there is one; when
    // the section expired rather than being submitted, on the deadline itself.
    // Using `now` instead would hand a student extra break time for arriving
    // late, which is the bug the submitSection clamp already guards against.
    const anchor = toMs(a.sectionTimings?.[sectionId]?.submittedAt)
      ?? deadlines.sectionEndsAt
      ?? nowMs;
    const endsAt = anchor + brk.durationMinutes * 60_000;
    if (nowMs < endsAt) {
      return {
        kind: 'break', sectionId, nextSectionId: nextId,
        endsAt, mandatory: brk.mandatory === true, deadlines,
      };
    }
  }

  if ((asmt.sectionStartOrder ?? 'sequential') === 'student_choice') {
    const remaining = remainingSectionIds(a).filter((id) => id !== sectionId);
    if (remaining.length > 0) {
      return { kind: 'choose', remainingSectionIds: remaining, deadlines };
    }
    return { kind: 'ended', reason: 'last_section_expired', deadlines };
  }

  return { kind: 'section', sectionId: nextId, started: false, deadlines };
}

/** A break running between two sections, if one is. */
function pendingBreak(
  a: CoreAttempt,
  asmt: CoreAssessment,
  nowMs: number,
): Omit<Extract<Verdict, { kind: 'break' }>, 'deadlines'> | null {
  const last = lastSubmitted(a);
  if (!last) return null;
  const idx = a.sectionIds.indexOf(last.id);
  const nextId = idx >= 0 ? a.sectionIds[idx + 1] : undefined;
  if (!nextId) return null;
  if (hasStarted(a.sectionTimings?.[nextId])) return null;

  const brk = sectionById(asmt, last.id)?.breakAfter;
  if (!hasBreak(brk)) return null;

  // ── D-29: a break is a clock, and it gets credited too ──────────
  //
  // This was `last.at + duration`, full stop — the only deadline in the module
  // with no credit term. Freeze a student during a ten-minute break and the
  // break was simply gone when they were released: paused time taken from the
  // one part of a sitting that exists to be rest.
  //
  // Anchored on the section submit instant, which is when the break began, so
  // only pauses that started after it count — the same per-clock rule D-28
  // established for every other deadline.
  const endsAt = last.at + brk.durationMinutes * 60_000 + creditForAnchor(a, last.at);
  if (nowMs >= endsAt) return null;

  return {
    kind: 'break', sectionId: last.id, nextSectionId: nextId,
    endsAt, mandatory: brk.mandatory === true,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// INVARIANTS  (master plan Part IV)
//
// Two functions, because the fifteen split cleanly in two:
//   checkInvariants  — properties of a SINGLE state
//   checkTransition  — properties of a CHANGE between two states
//
// Both are pure, so the sweep gets them free across the whole state space, and
// a read-only production sweep can run them over live data unchanged.
// ═══════════════════════════════════════════════════════════════════════════

export interface Violation {
  id: string;          // INV-1, INV-3c, …
  message: string;
  severity: 'error' | 'warning';
}

const err = (id: string, message: string): Violation => ({ id, message, severity: 'error' });
const warn = (id: string, message: string): Violation => ({ id, message, severity: 'warning' });

export function checkInvariants(a: CoreAttempt, asmt: CoreAssessment): Violation[] {
  const v: Violation[] = [];
  const terminal = isTerminal(a.status);

  // ── INV-1 · exactly one section open ────────────────────────────
  const open = a.sectionIds.filter((id) => {
    const t = a.sectionTimings?.[id];
    return hasStarted(t) && !hasSubmitted(t);
  });
  if (open.length > 1) {
    v.push(err('INV-1', `${open.length} sections open at once: ${open.join(', ')}`));
  } else if (terminal && open.length === 1) {
    // Cosmetic: gradeAttempt only stamps submittedAt on the section the client
    // names, and the termination path names none. No write can reach a
    // terminal attempt, so this is untidy rather than unsafe.
    v.push(warn('INV-1', `section ${open[0]} left open on a ${a.status} attempt`));
  }

  // ── INV-2 · at most one unlocked served question ────────────────
  //
  // SEQUENTIAL DELIVERY ONLY (scoped 2026-08-03). Standard mode writes the
  // whole paper unlocked at startExam — "all unlocked = free nav" is the
  // design, stated in as many words at the serve site. Checking it
  // unconditionally meant the Phase 3b shadow reported INV-2 on every
  // standard-mode sitting from its first instant: hundreds of false
  // violations burying the one real one this check exists to catch, which is
  // a stranded unlocked question in a delivery mode where locking IS the
  // navigation rule.
  if (isSequential(asmt)) {
    const unlocked = (a.servedQuestions ?? []).filter((s) => s.locked !== true);
    if (unlocked.length > 1) {
      v.push(err('INV-2', `${unlocked.length} unlocked served questions: ` +
        unlocked.map((s) => s.questionId).join(', ')));
    }
  }

  // ── INV-3 (state form) · the lock cache agrees with itself ──────
  //
  // A-07 widened what `combined` is a minimum OVER. It used to be
  // min(section, overall); the availability window is now folded in too,
  // because that is the field firestore.rules enforces and the window was the
  // one wall the write gate could not see.
  //
  // So the combined lock may legitimately sit EARLIER than either split bound.
  // The split pair keeps its exact meaning — it answers "which of the
  // student's own clocks ran out", and a window closure is neither of them —
  // which is why the window is not expected to appear in `section` or
  // `overall`.
  const sec = toMs(a.sectionLockedAfter);
  const ovr = toMs(a.overallLockedAfter);
  const comb = toMs(a.answersLockedAfter);
  const win = toMs(asmt.endDate);
  const bounds = [sec, ovr].filter((x): x is number => x !== null);
  if (bounds.length > 0) {
    const expect = Math.min(...bounds, ...(win === null ? [] : [win]));
    if (comb === null) {
      v.push(err('INV-3', 'answersLockedAfter is null while a split bound exists'));
    } else if (Math.abs(comb - expect) > 1500) {
      v.push(err('INV-3', 'answersLockedAfter is not min(section, overall, window)'));
    }
  }
  // The D-01 signature: the section lock anchored to a section the student
  // already left.
  const openId = openSectionId(a);
  if (openId && sec !== null) {
    const startedAt = toMs(a.sectionTimings?.[openId]?.startedAt);
    const limit = sectionById(asmt, openId)?.timeLimit ?? 0;
    if (startedAt !== null && limit > 0) {
      const expected = startedAt + limit * 60_000;
      // Generous window: grace and freeze credit both legitimately move it
      // LATER. Phase 4.5 adds the one thing that legitimately moves it EARLIER
      // — a recorded penalty — so the allowance is exactly that and no more.
      //
      // The property this protects is unchanged and is the reason for the
      // narrow allowance: a section lock earlier than its own deadline with no
      // ledger row behind it still fails, which is the D-01 signature (a lock
      // anchored to a section the student already left).
      const allowed = penaltyForClock(a, 'section', startedAt);
      if (sec < expected - allowed - 1000) {
        v.push(err('INV-3c',
          `sectionLockedAfter precedes the open section's own deadline by more ` +
          `than the recorded penalty — anchored to an earlier section (D-01 signature)`));
      }
    }
  }

  // ── INV-4 · freeze credit is coherent ───────────────────────────
  if (Array.isArray(a.freezes)) {
    let sum = 0;
    for (const f of a.freezes) {
      const g = f.grantedMs ?? 0;
      const e = f.elapsedMs ?? 0;
      if (g < 0) v.push(err('INV-4c', `negative grantedMs on freeze ${f.id ?? '?'}`));
      if (g > e + 1000) {
        v.push(err('INV-4c', `grantedMs (${g}) exceeds elapsedMs (${e}) on freeze ${f.id ?? '?'}`));
      }
      sum += Math.max(0, g);
    }
    const spans = a.freezes
      .map((f) => [toMs(f.startedAt), toMs(f.endedAt)] as const)
      .filter((s): s is readonly [number, number] => s[0] !== null && s[1] !== null)
      .sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i][0] < spans[i - 1][1]) {
        v.push(err('INV-4c', 'overlapping freeze ledger entries'));
        break;
      }
    }
    if (typeof a.creditedFreezeMs === 'number' && Math.abs(a.creditedFreezeMs - sum) > 1) {
      v.push(err('INV-4b',
        `creditedFreezeMs (${a.creditedFreezeMs}) != sum of grantedMs (${sum})`));
    }
  }

  // ── INV-7 / INV-8 · nothing outside the document's question set ─
  const known = new Set<string>();
  for (const s of asmt.sections) for (const q of s.questionIds) known.add(q);
  if (known.size > 0) {
    for (const qid of Object.keys(a.answers ?? {})) {
      if (!known.has(qid)) {
        v.push(err('INV-8', `answer for ${qid}, which is not in this assessment`));
      }
    }
    for (const s of a.servedQuestions ?? []) {
      if (!known.has(s.questionId)) {
        v.push(err('INV-7', `served question ${s.questionId} is not in this assessment`));
      }
    }
  }

  // ── INV-9 · timing monotonicity ─────────────────────────────────
  for (const id of a.sectionIds) {
    const t = a.sectionTimings?.[id];
    const st = toMs(t?.startedAt);
    const sub = toMs(t?.submittedAt);
    if (st !== null && sub !== null && sub < st) {
      v.push(err('INV-9', `section ${id} submitted before it started`));
    }
    if (st === null && sub !== null) {
      v.push(err('INV-9', `section ${id} has submittedAt but no startedAt`));
    }
    // NOTE on the '' sentinel: startExam seeds every section with
    // `startedAt: ''` and overwrites it on entry, so "not started" arrives as
    // an EMPTY STRING, not as an absent field. `'' != null` is true, so a
    // naive null check counts every section as open from the first instant —
    // which made openSectionId return section one for the whole exam and
    // would have re-anchored every deadline to it. That is D-01 rebuilt inside
    // the resolver written to prevent it. Every started/submitted test in this
    // module goes through hasStarted/hasSubmitted, which parse rather than
    // null-check, so the sentinel can only ever mean "not started".
    // Caught by the Phase 3b shadow on the first real sitting.
  }
  // Sequential only, for the same reason as INV-2: standard mode serves the
  // ENTIRE paper at attempt start, so every question in a later section is
  // "served" long before that section starts — by design, not by defect.
  if (isSequential(asmt)) {
    for (const s of a.servedQuestions ?? []) {
      const served = toMs(s.servedAt);
      const secStart = toMs(a.sectionTimings?.[s.sectionId]?.startedAt);
      if (served !== null && secStart !== null && served < secStart - 1000) {
        v.push(err('INV-9', `question ${s.questionId} served before its section started`));
      }
    }
  }

  // ── INV-10 · a terminal attempt is graded ───────────────────────
  if (terminal && (a.scores === undefined || a.scores === null)) {
    v.push(err('INV-10', `${a.status} attempt carries no scores`));
  }

  return v;
}

/**
 * Properties of a CHANGE. `before` and `after` are the same attempt at two
 * points in time.
 *
 * These cannot be checked from one state — monotonicity and terminality are
 * statements about history — which is why Part IV separates them.
 */
export function checkTransition(before: CoreAttempt, after: CoreAttempt): Violation[] {
  const v: Violation[] = [];

  // ── INV-3a · the overall bound never moves earlier ──────────────
  // NOTE there is deliberately NO equivalent for answersLockedAfter. That is a
  // minimum over a CHANGING active section, so it legitimately moves earlier
  // when a long section is followed by a short one (60m section submitted at
  // minute 2, next section 10m → 60:30 becomes 12:30). A monotonicity test on
  // the combined lock would fail on a correct system.
  //
  // Phase 4.5: a penalty on the total moves this bound earlier on purpose. The
  // allowance is exactly the penalty RECORDED BETWEEN the two states, so a
  // deduction is permitted only to the extent someone signed for it. Moving
  // the bound earlier without a matching row still fails, which is the whole
  // point of keeping the check rather than deleting it.
  const ovrB = toMs(before.overallLockedAfter);
  const ovrA = toMs(after.overallLockedAfter);
  const newPenalty = Math.max(0,
    penaltyForClock(after, 'overall', after.startedAt)
    - penaltyForClock(before, 'overall', before.startedAt));
  if (ovrB !== null && ovrA !== null && ovrA < ovrB - newPenalty - 1000) {
    v.push(err('INV-3a',
      `overallLockedAfter moved earlier by ${ovrB - ovrA}ms, ` +
      `only ${newPenalty}ms of which is a recorded penalty`));
  }

  // ── INV-4a · credit never decreases ─────────────────────────────
  const cB = creditedFreezeMs(before);
  const cA = creditedFreezeMs(after);
  if (cA < cB - 1) {
    v.push(err('INV-4a', `credited freeze fell from ${cB}ms to ${cA}ms`));
  }

  // ── INV-11 · penalties are append-only ──────────────────────────
  //
  // The mirror of INV-4a. Credit may never fall and penalty may never fall:
  // both are records of decisions someone made about a student's exam, and a
  // record that can quietly shrink is not a record. Reversing a penalty means
  // adding a compensating CREDIT row, which is visible; silently editing the
  // deduction away is not.
  const pB = totalPenaltyMs(before);
  const pA = totalPenaltyMs(after);
  if (pA < pB - 1) {
    v.push(err('INV-11', `recorded penalty fell from ${pB}ms to ${pA}ms`));
  }

  // ── INV-6 · nothing leaves a terminal state ─────────────────────
  if (isTerminal(before.status) && !isTerminal(after.status)) {
    v.push(err('INV-6', `left terminal state: ${before.status} → ${after.status}`));
  }

  // ── INV-9 · a section's start instant never moves ───────────────
  for (const id of before.sectionIds) {
    const sB = toMs(before.sectionTimings?.[id]?.startedAt);
    const sA = toMs(after.sectionTimings?.[id]?.startedAt);
    if (sB !== null && sA !== null && Math.abs(sA - sB) > 1000) {
      v.push(err('INV-9', `section ${id} startedAt was rewritten`));
    }
  }

  // ── INV-8 · answers are never silently dropped ──────────────────
  // A student's answer disappearing between two reads is the D-01 failure in
  // its observable form.
  const kB = Object.keys(before.answers ?? {});
  const kA = new Set(Object.keys(after.answers ?? {}));
  const lost = kB.filter((k) => !kA.has(k));
  if (lost.length > 0) {
    v.push(err('INV-8', `${lost.length} answer(s) disappeared: ${lost.slice(0, 5).join(', ')}`));
  }

  return v;
}

// ── Materialised freeze credit, per clock (Phase 4.3b / D-35) ─────

export type FreezeCredits = {
  overallMs: number;
  sectionMs: number;
  questionMs: number;
  breakMs: number;
};

/**
 * Every clock's credit, computed together from the ledger.
 *
 * WHY MATERIALISE RATHER THAN LET THE CLIENT COMPUTE
 * The client had `totalFrozenSeconds` — one flat number for the whole attempt
 * — and subtracted it from the section clock, the overall clock and the
 * question clock alike. That is precisely D-28, which was fixed on the server
 * and never on the client, so the two agreed only when the pause happened
 * inside the clock currently running. A freeze in section 1 handed the student
 * a visibly generous section 2 that the server had never granted; they worked
 * into time that did not exist and the expiry sweep cut the section off.
 *
 * Porting creditForAnchor to the client would have made a twelfth declared
 * twin — of the exact rule that already broke once. Materialising four numbers
 * instead means the client does no credit arithmetic at all, and the figures
 * it draws are the ones the write gate enforces.
 *
 * Recomputed wherever the locks are, for the same reason (doctrine D5): these
 * are a CACHE of a ledger that changes.
 */
export function computeFreezeCredits(
  a: CoreAttempt,
  /**
   * Anchors for clocks that are about to change, when this runs in the same
   * write that changes them.
   *
   * A section advance materialises credit for the section being ENTERED, not
   * the one being left — and reading the stored attempt would give the latter,
   * because the write has not landed yet. Passing the new anchor is what keeps
   * this honest.
   *
   * It also needs no special case: a clock anchored at `now` has no freeze
   * that began after it, so creditForAnchor returns 0 on its own. Correct by
   * arithmetic rather than by remembering to zero a field.
   */
  anchors?: {
    sectionStartedAt?: TimeInput;
    questionServedAt?: TimeInput;
    breakAnchor?: TimeInput;
  },
): FreezeCredits {
  const openId = openSectionId(a);
  const storedSec = openId ? a.sectionTimings?.[openId]?.startedAt : undefined;
  const cur = currentServed(a);
  const last = lastSubmitted(a);

  const secAnchor = anchors?.sectionStartedAt ?? storedSec;
  const qAnchor   = anchors?.questionServedAt ?? cur?.servedAt;
  const brkAnchor = anchors?.breakAnchor ?? (last ? last.at : undefined);

  return {
    overallMs: creditForAnchor(a, a.startedAt),
    // 0 when the clock does not exist right now — between sections there is no
    // open section, and outside sequential delivery there is no question. Zero
    // is right: a clock that is not running cannot have been paused.
    sectionMs: secAnchor === undefined ? 0 : creditForAnchor(a, secAnchor),
    questionMs: qAnchor === undefined ? 0 : creditForAnchor(a, qAnchor),
    breakMs: brkAnchor === undefined ? 0 : creditForAnchor(a, brkAnchor),
  };
}