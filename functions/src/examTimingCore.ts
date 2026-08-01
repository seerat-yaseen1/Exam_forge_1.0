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

export interface CoreBreak {
  enabled?: boolean;
  durationMinutes?: number;
  mandatory?: boolean;
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
  scores?: unknown;
  gradedAnswers?: unknown;
  answersLockedAfter?: TimeInput;
  sectionLockedAfter?: TimeInput;
  overallLockedAfter?: TimeInput;
  activeSessionId?: string | null;
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
export const CONSUME_LEGACY_FROZEN_SECONDS = false;

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
): number | null {
  const start = toMs(sectionStartedAt);
  if (start === null) return null;
  if (!sectionTimeLimitMin || sectionTimeLimitMin <= 0) return null;
  return start
    + sectionTimeLimitMin * 60_000
    + (graceSeconds ?? DEFAULT_SECTION_GRACE_SECONDS) * 1000
    + creditMs;
}

/** The overall deadline, anchored on the attempt's own start. */
export function overallDeadlineMs(
  attemptStartedAt: TimeInput,
  overallTimeLimitMin: number | undefined,
  graceSeconds: number | undefined,
  creditMs = 0,
): number | null {
  const start = toMs(attemptStartedAt);
  if (start === null) return null;
  if (!overallTimeLimitMin || overallTimeLimitMin <= 0) return null;
  return start
    + overallTimeLimitMin * 60_000
    + (graceSeconds ?? DEFAULT_OVERALL_GRACE_SECONDS) * 1000
    + creditMs;
}

function minNonNull(...xs: Array<number | null>): number | null {
  const vals = xs.filter((x): x is number => x !== null);
  return vals.length === 0 ? null : Math.min(...vals);
}

/** Total credited freeze, in ms, from whichever field the attempt carries. */
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
 */
export function openSectionId(a: CoreAttempt): string | null {
  for (const id of a.sectionIds) {
    const t = a.sectionTimings?.[id];
    if (t?.startedAt != null && t?.submittedAt == null) return id;
  }
  return null;
}

/** Sections in play order that have not been submitted. */
export function remainingSectionIds(a: CoreAttempt): string[] {
  return a.sectionIds.filter((id) => a.sectionTimings?.[id]?.submittedAt == null);
}

/** The last section the student submitted, by submit time. */
function lastSubmitted(a: CoreAttempt): { id: string; at: number } | null {
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
  const credit = creditedFreezeMs(a);

  const windowRaw = toMs(asmt.endDate);
  const windowEndsAt = windowRaw === null
    ? null
    : windowRaw + (FREEZE_CREDIT_EXTENDS_WINDOW ? credit : 0);

  const overallEndsAt = overallDeadlineMs(
    a.startedAt, asmt.overallTimeLimit, asmt.overallGraceSeconds, credit,
  );

  // Section bound — only for a section that has actually started.
  const openId = openSectionId(a);
  let sectionEndsAt: number | null = null;
  if (openId) {
    sectionEndsAt = sectionDeadlineMs(
      a.sectionTimings?.[openId]?.startedAt,
      sectionById(asmt, openId)?.timeLimit,
      asmt.sectionGraceSeconds,
      credit,
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
          + credit;
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
  if (deadlines.overallEndsAt !== null && nowMs >= deadlines.overallEndsAt) {
    return { kind: 'ended', reason: 'overall_expired', deadlines };
  }

  const openId = openSectionId(a);

  // On a break: the student is between sections, and the break has its own
  // clock anchored on the PREVIOUS section's submit instant.
  if (!openId) {
    const brk = pendingBreak(a, asmt, nowMs);
    if (brk) return { ...brk, deadlines };
  }

  // 4. Section clock.
  const sectionExpired =
    openId !== null
    && deadlines.sectionEndsAt !== null
    && nowMs >= deadlines.sectionEndsAt;

  if (sectionExpired) {
    return afterSection(a, asmt, openId!, nowMs, deadlines);
  }

  // 5. Question clock (sequential delivery only).
  if (isSequential(asmt) && openId) {
    const qExpired =
      deadlines.questionEndsAt !== null && nowMs >= deadlines.questionEndsAt;
    if (qExpired) {
      const sec = sectionById(asmt, openId);
      const cur = currentServed(a);
      const idx = sec && cur ? sec.questionIds.indexOf(cur.questionId) : -1;
      const isLastInSection = sec ? idx >= 0 && idx === sec.questionIds.length - 1 : true;

      // D-14: the last question of a section is treated exactly like the
      // section running out. The old client simply switched the clock off
      // there — `if (... || isLastQuestion) { setQSecondsLeft(null); return; }`
      // — so the final question of every section was untimed.
      if (isLastInSection) return afterSection(a, asmt, openId, nowMs, deadlines);

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
  if (brk?.enabled && (brk.durationMinutes ?? 0) > 0) {
    // Break anchors on the section's submit instant when there is one; when
    // the section expired rather than being submitted, on the deadline itself.
    // Using `now` instead would hand a student extra break time for arriving
    // late, which is the bug the submitSection clamp already guards against.
    const anchor = toMs(a.sectionTimings?.[sectionId]?.submittedAt)
      ?? deadlines.sectionEndsAt
      ?? nowMs;
    const endsAt = anchor + (brk.durationMinutes ?? 0) * 60_000;
    if (nowMs < endsAt) {
      return {
        kind: 'break', sectionId, nextSectionId: nextId,
        endsAt, mandatory: brk.mandatory !== false, deadlines,
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
  if (a.sectionTimings?.[nextId]?.startedAt != null) return null;

  const brk = sectionById(asmt, last.id)?.breakAfter;
  if (!brk?.enabled || (brk.durationMinutes ?? 0) <= 0) return null;

  const endsAt = last.at + (brk.durationMinutes ?? 0) * 60_000;
  if (nowMs >= endsAt) return null;

  return {
    kind: 'break', sectionId: last.id, nextSectionId: nextId,
    endsAt, mandatory: brk.mandatory !== false,
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
    return t?.startedAt != null && t?.submittedAt == null;
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
  const unlocked = (a.servedQuestions ?? []).filter((s) => s.locked !== true);
  if (unlocked.length > 1) {
    v.push(err('INV-2', `${unlocked.length} unlocked served questions: ` +
      unlocked.map((s) => s.questionId).join(', ')));
  }

  // ── INV-3 (state form) · the lock cache agrees with itself ──────
  const sec = toMs(a.sectionLockedAfter);
  const ovr = toMs(a.overallLockedAfter);
  const comb = toMs(a.answersLockedAfter);
  const bounds = [sec, ovr].filter((x): x is number => x !== null);
  if (bounds.length > 0) {
    const expect = Math.min(...bounds);
    if (comb === null) {
      v.push(err('INV-3', 'answersLockedAfter is null while a split bound exists'));
    } else if (Math.abs(comb - expect) > 1500) {
      v.push(err('INV-3', 'answersLockedAfter is not min(section, overall)'));
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
      // Generous window: grace and freeze credit both legitimately move it.
      if (sec < expected - 1000) {
        v.push(err('INV-3c',
          `sectionLockedAfter precedes the open section's own deadline — ` +
          `anchored to an earlier section (D-01 signature)`));
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
  }
  for (const s of a.servedQuestions ?? []) {
    const served = toMs(s.servedAt);
    const secStart = toMs(a.sectionTimings?.[s.sectionId]?.startedAt);
    if (served !== null && secStart !== null && served < secStart - 1000) {
      v.push(err('INV-9', `question ${s.questionId} served before its section started`));
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
  const ovrB = toMs(before.overallLockedAfter);
  const ovrA = toMs(after.overallLockedAfter);
  if (ovrB !== null && ovrA !== null && ovrA < ovrB - 1000) {
    v.push(err('INV-3a', `overallLockedAfter moved earlier by ${ovrB - ovrA}ms`));
  }

  // ── INV-4a · credit never decreases ─────────────────────────────
  const cB = creditedFreezeMs(before);
  const cA = creditedFreezeMs(after);
  if (cA < cB - 1) {
    v.push(err('INV-4a', `credited freeze fell from ${cB}ms to ${cA}ms`));
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