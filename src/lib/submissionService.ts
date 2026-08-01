import {
  collection,
  doc,
  getDoc,
  updateDoc,
  getDocs,
  query,
  where,
  arrayUnion,
  increment,
  onSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db } from './firebase';
import { functions } from './firebase';
import type { CorrectPair, Question } from './questionBankService';
import { ensureSebToken, forceRefreshSebToken } from './assessmentService';

// ── Phase 3 (Stage 2b): attach a SEB proof to every exam callable ──
// The proof is short-lived, so a call can race its expiry. On SEB_EXPIRED we
// mint a fresh one and retry ONCE — the student never sees it. Any other error
// propagates untouched. When SEB isn't required, ensureSebToken() returns
// undefined and this is a transparent pass-through.
async function withSeb<T>(fn: (sebToken?: string) => Promise<T>): Promise<T> {
  const token = await ensureSebToken();
  try {
    return await fn(token);
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? '';
    if (msg.includes('SEB_EXPIRED')) {
      return fn(await forceRefreshSebToken());
    }
    throw e;
  }
}

// ── Active browser session (Phase 2, INV-5a) ──────────────────────
// registerSession sets this; every exam callable below attaches it so the
// server can refuse a device that no longer owns the sitting (D-08).
//
// Held module-side rather than threaded through ExamShell on purpose: the
// shell already owns a sessionId and passes it to registerSession, so routing
// it through every call site would mean touching a dozen signatures to carry
// a value that never varies within a sitting. Same shape as the SEB token
// manager above.
let activeSessionId: string | null = null;

/** The session id this tab claimed, if it has claimed one. */
export function currentSessionId(): string | null {
  return activeSessionId;
}

// ── Per-question grading data populated server-side by gradeAttempt ─
// Students can never read questionAnswers directly; this map is the
// channel through which the results page learns the correct answers
// (only after submission).

export type GradedAnswer = {
  isCorrect: boolean | null;   // null for ungraded (text) questions
  marksAwarded: number;
  correctIds?: string[];       // mcq
  correctPairs?: CorrectPair[]; // match
  modelAnswer?: string;        // text
};

// ══════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ══════════════════════════════════════════════════════════════════

function now(): string {
  return new Date().toISOString();
}

// ── Device-class heuristic (Phase 0) ──────────────────────────────
// Honest-majority signal only — NOT spoof-proof. Real high-stake device
// assurance comes from Safe Exam Browser's header check in Phase 3. Used by
// startAttempt to report the client's device class; the server enforces the
// device policy against it.
function detectDeviceClass(): 'desktop' | 'mobile' | 'tablet' {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent || '';
  const touch =
    typeof window !== 'undefined' &&
    ('ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0);
  const minSide =
    typeof window !== 'undefined' && window.screen
      ? Math.min(window.screen.width ?? 0, window.screen.height ?? 0)
      : 0;
  const isTablet =
    /iPad|Tablet|PlayBook|Silk/i.test(ua) ||
    (touch && minSide >= 600 && /Android/i.test(ua) && !/Mobile/i.test(ua));
  const isMobile =
    /Mobi|Android.*Mobile|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) ||
    (touch && minSide > 0 && minSide < 600);
  if (isTablet) return 'tablet';
  if (isMobile) return 'mobile';
  return 'desktop';
}

function removeUndefined<T extends Record<string, any>>(obj: T): T {
  const out: any = {};
  for (const key in obj) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out as T;
}

// ═════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ══════════════════════════════════════════════════════════════════

// ── Violation types ───────────────────────────────────────────────

export type ViolationType =
  | 'tab_switch'       // document.visibilitychange → hidden
  | 'focus_loss'       // window blur
  | 'fullscreen_exit'  // user left fullscreen
  | 'copy_attempt'     // Ctrl+C / Ctrl+X
  | 'paste_attempt'    // Ctrl+V
  | 'right_click'      // contextmenu
  | 'multi_person'     // 2+ faces detected by camera
  | 'face_absent'      // 0 faces detected for > threshold
  | 'devtools_open'    // devtools width heuristic
  | 'reload_attempt'   // F5 / Ctrl+R
  | 'keyboard_block'   // blocked key combination
  | 'extension_detected'; // browser extension UI detected in DOM

export type ViolationEvent = {
  type: ViolationType;
  timestamp: string;
  detail?: string;            // human-readable context
  warningNumber?: number;     // which warning was shown (1, 2, 3)
};

// ── Attempt status ────────────────────────────────────────────────

export type AttemptStatus =
  | 'in_progress'    // actively being taken
  | 'submitted'      // student clicked "Submit"
  | 'auto_submitted' // time expired or window closed
  | 'terminated'     // terminated due to integrity violations
  | 'frozen';        // paused by faculty invigilator

// ── Section timing ────────────────────────────────────────────────

export type SectionTiming = {
  startedAt: string;       // ISO; set when section begins
  submittedAt?: string;    // ISO; set when section ends
  timeUsedSeconds: number; // wall-clock seconds the section was active
};

// ── Answer value ──────────────────────────────────────────────────

// MCQ single/truefalse → string (one option id)
// MCQ multi            → string[] (selected option ids)
// MCQ fillblank        → string (one option id)
// Text short/long      → string (typed answer)
// Match                → Record<leftId, rightId> (student's mapping)

export type AnswerValue = string | string[] | Record<string, string>;

export type AttemptAnswer = {
  type: 'mcq' | 'text' | 'match';
  value: AnswerValue;
  answeredAt: string;  // ISO; time of last edit
  sectionId: string;
  // Phase 2.5 Stage 3 — set by submitAnswerAndAdvance when the per-question
  // timer had expired (beyond grace) at submit time. Advisory reviewer signal.
  lateAnswer?: boolean;
};

// ── Score breakdown ───────────────────────────────────────────────

export type SectionScore = {
  sectionId: string;
  sectionName: string;
  totalQuestions: number;
  answeredQuestions: number;
  marksAwarded: number;
  marksAvailable: number;
};

export type AttemptScores = {
  total: number;                   // sum of awarded marks
  available: number;               // maximum possible marks
  percentage: number;              // (total / available) * 100
  passed: boolean;                 // met passingScore threshold (if defined)
  bySection: SectionScore[];
  requiresManualReview: boolean;   // true if any textual questions need human grading
};

// ── Integrity log ─────────────────────────────────────────────────

export type IntegrityLog = {
  // Counters — incremented atomically on each event
  tabSwitches: number;
  focusLosses: number;
  fullscreenExits: number;
  copyAttempts: number;
  pasteAttempts: number;
  rightClickAttempts: number;
  multiPersonEvents: number;
  faceAbsenceEvents: number;
  devtoolsEvents: number;
  keyboardBlockEvents: number;
  extensionEvents: number;

  // Total violation count driving the warning system
  totalViolations: number;

  // Ordered event log (appended via arrayUnion)
  violations: ViolationEvent[];

  // Terminal fields
  autoTerminated: boolean;
  terminatedReason?: string;
  // Phase 1c — set by gradeAttempt if the attempt was finalized while still
  // frozen (unresolved extension freeze). Reviewer flag.
  finalizedWhileFrozen?: boolean;
};

// ── Main attempt document ─────────────────────────────────────────

export type Attempt = {
  /**
   * Absolute instant after which firestore.rules refuses answer writes for
   * this attempt — the earlier of the current section's deadline and the whole
   * exam's, grace included. Written by startExam and recomputed by
   * startSection (audit 2026-07-28).
   *
   * Present so the CLIENT can make the same decision the rules already
   * enforce, without waiting for a timer callback to fire. Null or absent
   * means no time bound: an untimed exam, or an attempt that predates the
   * field. A Firestore Timestamp over the wire, hence the loose shape.
   */
  answersLockedAfter?: { toMillis: () => number } | string | null;
  /**
   * The two bounds that `answersLockedAfter` is the minimum of (Phase 0 of the
   * timer plan, 2026-07-31).
   *
   * The combined field above is the correct WRITE gate but cannot say which
   * clock ran out, and the two need different outcomes: an expired SECTION
   * advances to the next section, an expired OVERALL ends the sitting. Reading
   * only the minimum is why a student who stepped away during section 2 of 4
   * used to lose sections 3 and 4.
   *
   * Absent on attempts that started before this shipped — the client falls
   * back to the previous behaviour for those, which drains within one sitting.
   */
  sectionLockedAfter?: { toMillis: () => number } | string | null;
  overallLockedAfter?: { toMillis: () => number } | string | null;
  id: string;
  assessmentId: string;
  assessmentTitle: string;
  studentId: string;
  studentName: string;
  instituteId: string;

  status: AttemptStatus;
  startedAt: string;
  submittedAt?: string;

  // Section navigation state
  currentSectionIdx: number;     // 0-based index of section currently being taken
  sectionIds: string[];          // ordered list of section IDs (frozen at startAttempt)

  // Per-section timings
  sectionTimings: Record<string, SectionTiming>;  // keyed by sectionId

  // Question order per section (possibly shuffled; frozen at startAttempt)
  questionOrder: Record<string, string[]>;  // sectionId → ordered questionIds

  // Student's answers
  answers: Record<string, AttemptAnswer>;  // keyed by questionId

  // Populated on submission
  scores?: AttemptScores;

  // Populated server-side by gradeAttempt — per-question correctness +
  // the correct-answer payload (which students can never read from
  // questionAnswers directly). Empty on legacy / pre-migration attempts.
  gradedAnswers?: Record<string, GradedAnswer>;

  // Anti-cheat
  integrityLog: IntegrityLog;
  cameraDeclined: boolean;   // student declined webcam at briefing

  // ── Freeze / invigilator control ──────────────────────────────
  frozenAt?: string;           // ISO; set when frozen by faculty
  frozenBy?: string;           // facultyId or 'system'
  frozenReason?: string;       // human-readable reason (optional)
  totalFrozenSeconds: number;  // accumulated frozen time for timer offset

  // ── Session management (dual-device detection) ────────────────
  activeSessionId?: string;    // UUID of the active browser session
  sessionConflictAt?: string;  // ISO; when a second device attempted to join

  // ── Device class (Phase 0) ────────────────────────────────────
  // Reported by the client at start, validated server-side in startExam.
  // High-stake (and any exam with allowMobile=false) refuses non-desktop.
  deviceClass?: 'desktop' | 'mobile' | 'tablet';

  // ── Frozen security snapshot (Phase 0) ────────────────────────
  // The effective security config copied from the assessment AT START, so
  // this attempt's integrity behavior + grading use the contract the
  // student actually sat under, even if the assessment is later re-edited
  // for a future window.
  securityConfig?: {
    tier: 'mock' | 'normal' | 'high_stake';
    deliveryMode: 'standard' | 'linear' | 'adaptive';
    requireCamera: boolean;
    requireExtensionCheck: boolean;
    allowMobile: boolean;
    autoResume: boolean;
  };

  // ── Served-question sequence (Phase 0 shape; behavior later) ───
  // Append-only source of truth for what the student was actually shown.
  // standard: written in full at start. linear/adaptive (Phase 2.5):
  // appended one at a time. Grading iterates THIS, not the frozen paper.
  servedQuestions?: Array<{
    questionId: string;
    sectionId: string;
    difficulty: string;
    servedAt: string;   // ISO
    locked: boolean;    // true once the next question is served (one-way modes)
  }>;

  // ── Reserved for Phase 1 (extension freeze / heartbeat) ───────
  lastExtensionCheck?: { at: string; passed: boolean; found?: string[] } | null;
  resumeRequiresVerification?: boolean;
  lastHeartbeatAt?: string | null;

  // ── Phase 1 (freeze state + timing analytics) ─────────────────
  freezeState?: {
    frozen: boolean;
    reason?: string;
    since?: string;
    clearedBy?: string;
  } | null;
  timingAnalysis?: {
    totalAnswers: number;
    burstLast30s: number;
    minGapSeconds: number | null;
    heartbeatGaps: number;
    maxHeartbeatGapSeconds: number;
    anomalyScore: number;
    computedAt: string;
  } | null;

  // ── Soft delete ───────────────────────────────────────────────
  isDeleted?: boolean;         // true = hidden from roster; shown in drawer history

  createdAt: string;
  updatedAt: string;
};

// ══════════════════════════════════════════════════════════════════
// VIOLATION COUNTER MAP
// Maps ViolationType → the IntegrityLog counter field name
// ══════════════════════════════════════════════════════════════════

const VIOLATION_COUNTER: Record<ViolationType, keyof IntegrityLog> = {
  tab_switch:      'tabSwitches',
  focus_loss:      'focusLosses',
  fullscreen_exit: 'fullscreenExits',
  copy_attempt:    'copyAttempts',
  paste_attempt:   'pasteAttempts',
  right_click:     'rightClickAttempts',
  multi_person:    'multiPersonEvents',
  face_absent:     'faceAbsenceEvents',
  devtools_open:   'devtoolsEvents',
  reload_attempt:  'tabSwitches',
  keyboard_block:  'keyboardBlockEvents',
  extension_detected: 'extensionEvents',
};

// ══════════════════════════════════════════════════════════════════
// WRITE OPERATIONS
// ══════════════════════════════════════════════════════════════════

// ── Start attempt (idempotent) ────────────────────────────────────
// If a valid in_progress attempt already exists, returns it.
// Otherwise creates a new attempt with frozen question order.
// Throws 'ATTEMPT_LIMIT_EXCEEDED:<used>:<max>' if the student has
// exhausted their allowed attempts.

// ── Staggered exam start ──────────────────────────────────────────
// A cohort does not converge on the start button naturally — the briefing
// page runs a countdown to the window opening, so students sitting and waiting
// are all released at the same instant. That synchronisation is manufactured
// by our own UI, and it is what turns 10,000 students into a single spike
// instead of an arrival curve.
//
// Rather than absorb the spike with more instances, spread it. Each client
// waits a random moment inside a window sized to the cohort, so the load
// arrives at a rate we choose instead of all at once.
//
// This costs students NOTHING, which is what makes it worth doing. Every timer
// in the system anchors on attempt.startedAt — written server-side when the
// attempt is actually created — not on when the exam window opened. A student
// held back eight seconds starts eight seconds later and still receives their
// full duration. Staggering would be unacceptable in a system where the clock
// ran from the window opening; here it is free.

/** Students admitted per second. 10,000 spread over ~10s at this rate. */
const STAGGER_RATE_PER_SECOND = 1000;

/**
 * Below this cohort size, no delay at all. A 30-student quiz has no thundering
 * herd to smooth, and making it feel sluggish to solve a problem it does not
 * have would be a bad trade.
 */
const STAGGER_MIN_COHORT = 200;

/** Ceiling on the spread, so a very large cohort cannot delay anyone absurdly. */
const STAGGER_MAX_WINDOW_MS = 20_000;

/**
 * How long THIS client should wait before calling startExam.
 *
 * Exported for testing — the distribution is the whole point, so it needs to
 * be checkable without mounting the shell.
 */
export function staggerDelayMs(
  cohortSize: number | undefined,
  rand: () => number = Math.random,
): number {
  if (!cohortSize || cohortSize < STAGGER_MIN_COHORT) return 0;
  const windowMs = Math.min(
    (cohortSize / STAGGER_RATE_PER_SECOND) * 1000,
    STAGGER_MAX_WINDOW_MS,
  );
  return Math.floor(rand() * windowMs);
}

/**
 * Firebase error codes worth retrying.
 *
 * DELIBERATELY NARROW. Every error startExam itself raises is a real verdict —
 * permission-denied, failed-precondition, not-found, invalid-argument,
 * unauthenticated — and retrying those would make a student out of attempts
 * sit through several pointless waits before seeing the same refusal. Only
 * infrastructure-level failures, where the request never got a real answer,
 * are retried.
 */
const RETRYABLE_CODES = new Set([
  'unavailable',
  'deadline-exceeded',
  'internal',
  'resource-exhausted',
  'aborted',
]);

function isRetryable(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? '';
  return RETRYABLE_CODES.has(code.replace(/^functions\//, ''));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startAttempt(params: {
  assessmentId: string;
  assessmentTitle: string;
  studentId: string;
  studentName: string;
  instituteId: string;
  sections: Array<{
    id: string;
    name: string;
    questions: Array<{ questionId: string; marks: number; order: number }>;
  }>;
  shuffleQuestions: boolean;
  sectionStartOrder?: 'sequential' | 'random' | 'student_choice';
  cameraDeclined?: boolean;
  effectiveMaxAttempts?: number;  // undefined = unlimited
  // Phase 3 — short-lived SEB proof from /api/seb-verify. Required only when
  // the assessment demands SEB; the server re-derives that requirement, so an
  // omitted token on a SEB exam is rejected regardless of what the client says.
  sebToken?: string;
  /**
   * Cohort size, used to size the stagger window. Comes from
   * assessment.allocatedCount — the denormalized head-count already on the
   * doc, so this costs no extra read. Undefined or small means no delay.
   */
  cohortSize?: number;
  /** Called once if this client is going to wait, with the delay in ms. */
  onStaggerWait?: (delayMs: number) => void;
  /** Called before each backoff, so the UI can say it is still trying. */
  onRetry?: (attemptNo: number, backoffMs: number) => void;
}): Promise<Attempt> {
  // Server-authoritative: the startExam Cloud Function owns schedule
  // enforcement (startDate/endDate), the attempt-limit check, and all
  // timestamps. Throws ATTEMPT_LIMIT_EXCEEDED:<used>:<max> when the student is
  // out of attempts.
  //
  // Phase 2 (D-07): the server no longer READS sections / shuffleQuestions /
  // sectionStartOrder from this payload — it derives all three from the
  // assessment document, because a caller who supplied a section id absent
  // from that document used to end up with no section deadline at all.
  //
  // They are still SENT, deliberately, for one release: a server rollback
  // restores a build that requires them, and a start call that fails because
  // the client stopped sending a field is a student who cannot sit their exam.
  // Drop them once Phase 2 is confirmed stable.
  const call = httpsCallable<
    {
      assessmentId: string;
      sections: typeof params.sections;
      shuffleQuestions: boolean;
      sectionStartOrder?: 'sequential' | 'random' | 'student_choice';
      cameraDeclined?: boolean;
      deviceClass?: 'desktop' | 'mobile' | 'tablet';
      sebToken?: string;
      sessionId?: string;
    },
    { ok: true; attempt: Attempt }
  >(functions, 'startExam');

  // Spread the arrival before the request is made. onStaggerWait lets the
  // caller show "Preparing your exam…" so the wait reads as loading rather
  // than as an unexplained pause.
  const delay = staggerDelayMs(params.cohortSize);
  if (delay > 0) {
    params.onStaggerWait?.(delay);
    await sleep(delay);
  }

  // Retry only infrastructure failures, and only a few times. startExam is
  // IDEMPOTENT — it returns any existing in_progress or frozen attempt rather
  // than creating a second one — so a retry after an ambiguous failure cannot
  // produce a duplicate attempt. That property is what makes retrying safe
  // here; without it, a timed-out-but-actually-succeeded call would be
  // dangerous to repeat.
  const MAX_TRIES = 4;
  let lastErr: unknown;

  for (let attemptNo = 1; attemptNo <= MAX_TRIES; attemptNo++) {
    try {
      const res = await call({
        assessmentId: params.assessmentId,
        sections: params.sections,
        shuffleQuestions: params.shuffleQuestions,
        sectionStartOrder: params.sectionStartOrder,
        cameraDeclined: params.cameraDeclined,
        deviceClass: detectDeviceClass(),
        sebToken: params.sebToken,
      ...(activeSessionId ? { sessionId: activeSessionId } : {}),
      });
      return res.data.attempt;
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? '';
      if (msg.includes('ATTEMPT_LIMIT_EXCEEDED')) {
        const m = msg.match(/ATTEMPT_LIMIT_EXCEEDED:\d+:\d+/);
        throw new Error(m ? m[0] : 'ATTEMPT_LIMIT_EXCEEDED');
      }
      lastErr = e;
      if (!isRetryable(e) || attemptNo === MAX_TRIES) throw e;

      // Exponential backoff with FULL jitter (random across the whole window,
      // not a fixed delay plus a wobble). Fixed backoff would re-synchronise
      // everyone who failed together into a second spike at the same instant —
      // the exact problem the stagger above exists to prevent.
      const backoffMs = Math.floor(Math.random() * (250 * 2 ** (attemptNo - 1)));
      params.onRetry?.(attemptNo, backoffMs);
      await sleep(backoffMs);
    }
  }

  throw lastErr;
}

// ── Save answer ───────────────────────────────────────────────────
// Writes a single answer. Should be called debounced (~1.5s) on every
// answer change to enable refresh recovery.

export async function saveAnswer(
  attemptId: string,
  questionId: string,
  answer: AttemptAnswer
): Promise<void> {
  await updateDoc(doc(db, 'attempts', attemptId), {
    [`answers.${questionId}`]: removeUndefined(answer as Record<string, any>),
    updatedAt: now(),
  });
}

// ── Save many answers in ONE write ────────────────────────────────
// Used by the shell's flush-before-submit. The previous implementation
// issued one updateDoc per answer in parallel against the SAME document —
// heavy write contention (aborted/retried commits) right at submit time.
// All `answers.*` dot-paths land under the whitelisted `answers` key, so
// this passes studentAttemptUpdateFieldsAllowed the same as saveAnswer.

export async function saveAnswers(
  attemptId: string,
  answers: Record<string, AttemptAnswer>
): Promise<void> {
  const entries = Object.entries(answers);
  if (entries.length === 0) return;
  const updates: Record<string, any> = { updatedAt: now() };
  for (const [questionId, answer] of entries) {
    updates[`answers.${questionId}`] = removeUndefined(answer as Record<string, any>);
  }
  await updateDoc(doc(db, 'attempts', attemptId), updates);
}

// ── Submit section ────────────────────────────────────────────────
// Marks the current section as done, records time used, advances
// currentSectionIdx, and starts the next section's timer.

export async function submitSection(params: {
  attemptId: string;
  sectionId: string;           // section being submitted
  nextSectionId: string | null; // null if this was the last section
  nextSectionIdx: number;       // new currentSectionIdx (ignored if no next section)
  timeUsedSeconds: number;      // advisory only — server recomputes from its clock
  pauseBeforeNext?: boolean;    // if true, do not advance / start next-section timer
                                // (used when a break is configured before next section)
}): Promise<{ question: Question | null }> {
  // Server-authoritative: the submitSection Cloud Function computes
  // timeUsedSeconds from the server clock and rejects submits past the section
  // deadline + configured grace. Throws SECTION_DEADLINE_EXCEEDED when late
  // (the server still finalises the section at its true deadline).
  const call = httpsCallable<
    {
      attemptId: string;
      sectionId: string;
      nextSectionId: string | null;
      nextSectionIdx: number;
      pauseBeforeNext?: boolean;
      sebToken?: string;
      sessionId?: string;
    },
    { ok: true; timeUsedSeconds: number; question: Question | null }
  >(functions, 'submitSection');

  const data = await withSeb(async (sebToken) => (await call({
    attemptId: params.attemptId,
    sectionId: params.sectionId,
    nextSectionId: params.nextSectionId,
    nextSectionIdx: params.nextSectionIdx,
    pauseBeforeNext: params.pauseBeforeNext,
    sebToken,
    ...(activeSessionId ? { sessionId: activeSessionId } : {}),
  })).data);
  // Sequential delivery: when advancing straight into the next section (no
  // break), the server serves and returns that section's first question.
  return { question: data.question ?? null };
}

// ── Pick next section (student_choice mode) ───────────────────────
// Reorders the attempt's frozen sectionIds so the picked section sits
// at `newIdx`, then bumps currentSectionIdx and stamps startedAt on the
// chosen section. Used at the start of the exam and between sections
// when the assessment's sectionStartOrder is 'student_choice'.

export async function pickSection(params: {
  attemptId: string;
  pickedSectionId: string;
  currentSectionIds: string[];
  newIdx: number;
}): Promise<{ sectionIds: string[]; question: Question | null }> {
  const { attemptId, pickedSectionId, currentSectionIds, newIdx } = params;
  // Compute the desired order client-side; the server validates it's a
  // permutation and stamps the picked section's startedAt with server time.
  const without = currentSectionIds.filter((id) => id !== pickedSectionId);
  const reordered = [...without.slice(0, newIdx), pickedSectionId, ...without.slice(newIdx)];

  const call = httpsCallable<
    {
      attemptId: string; sectionId: string; reorderedSectionIds: string[];
      sebToken?: string; sessionId?: string;
    },
    { ok: true; startedAt: string; sectionIds: string[]; question: Question | null }
  >(functions, 'startSection');

  const data = await withSeb(async (sebToken) => (await call({
    attemptId, sectionId: pickedSectionId, reorderedSectionIds: reordered, sebToken,
    ...(activeSessionId ? { sessionId: activeSessionId } : {}),
  })).data);
  // In sequential delivery the server serves (and returns) the section's first
  // question; the client cannot fetch it any other way.
  return { sectionIds: data.sectionIds, question: data.question ?? null };
}

// ── End break and start next section ──────────────────────────────
// Called when a configured break elapses (or the student skips a
// non-mandatory break). Advances currentSectionIdx and starts the
// next section's timer.

export async function endBreak(params: {
  attemptId: string;
  nextSectionId: string;
  nextSectionIdx: number;
}): Promise<{ question: Question | null }> {
  // Server stamps the next section's startedAt and refuses if a mandatory
  // break hasn't elapsed. nextSectionIdx is re-derived server-side.
  const call = httpsCallable<
    { attemptId: string; sectionId: string; sebToken?: string; sessionId?: string },
    { ok: true; startedAt: string; sectionIds: string[]; question: Question | null }
  >(functions, 'startSection');
  const data = await withSeb(async (sebToken) => (await call({
    attemptId: params.attemptId, sectionId: params.nextSectionId, sebToken,
    ...(activeSessionId ? { sessionId: activeSessionId } : {}),
  })).data);
  // Sequential delivery: the next section's first question comes back here.
  return { question: data.question ?? null };
}

// ── Server clock skew ─────────────────────────────────────────────
// Returns (serverNow - clientNow) in ms, captured once on exam load. The
// SectionTimer adds this offset to Date.now() so the countdown display stays
// accurate even if the local clock is later tampered with. Falls back to 0
// (trust local clock) if the call fails — enforcement is still server-side.
export async function getServerSkew(): Promise<number> {
  try {
    const call = httpsCallable<Record<string, never>, { serverTime: number }>(
      functions,
      'getServerTime',
    );
    const clientBefore = Date.now();
    const res = await call({});
    const clientAfter = Date.now();
    // Compensate for round-trip: assume the server timestamp was taken at the
    // midpoint of the request.
    const rtt = clientAfter - clientBefore;
    const clientMid = clientBefore + rtt / 2;
    return res.data.serverTime - clientMid;
  } catch {
    return 0;
  }
}

// ── Grade attempt (server-side) ───────────────────────────────────
// Calls the gradeAttempt Cloud Function which holds the only legitimate
// read path for answer keys (questionAnswers is denied to students).
// All scoring is server-side (gradeAttempt / regradeAttempts).

export type GradeReason =
  | 'manual'
  | 'time_expired'
  | 'window_closed'
  | 'violation_limit'
  | 'terminated';

export async function gradeAttempt(params: {
  attemptId: string;
  reason: GradeReason;
  terminateReason?: string;
  lastSectionId?: string;
  lastSectionTimeUsed?: number;
}): Promise<{ ok: true; scores: AttemptScores }> {
  const call = httpsCallable<typeof params & { sebToken?: string }, { ok: true; scores: AttemptScores }>(
    functions,
    'gradeAttempt',
  );
  return withSeb(async (sebToken) => (await call({ ...params, sebToken })).data);
}

// ── Phase 1 client wrappers ───────────────────────────────────────
// Thin callable wrappers. The server owns all the logic; these just relay.

/** Heartbeat — call on an interval (~15s) while an attempt is in progress. */
export async function sendHeartbeat(attemptId: string): Promise<void> {
  const call = httpsCallable<{ attemptId: string; sebToken?: string }, { ok: true; ignored?: boolean }>(
    functions,
    'examHeartbeat',
  );
  try {
    // The heartbeat doubles as the SEB proof refresh: it runs every ~15s,
    // comfortably inside the ~90s token TTL.
    await withSeb((sebToken) => call({ attemptId, sebToken }).then(() => undefined));
  } catch {
    // Heartbeat failures are non-fatal to the exam UX — a missed beat simply
    // shows up server-side as a gap, which is the intended signal.
  }
}

/** Report an extension-scan result. Server decides whether to freeze. */
export async function reportExtensionCheck(params: {
  attemptId: string;
  passed: boolean;
  found?: string[];
}): Promise<{ ok: true; frozen: boolean }> {
  const call = httpsCallable<typeof params & { sebToken?: string }, { ok: true; frozen: boolean }>(
    functions,
    'reportExtensionCheck',
  );
  return withSeb(async (sebToken) => (await call({ ...params, sebToken })).data);
}

/** Attempt to clear a freeze and resume (auto for eligible tiers, else invigilator). */
export async function verifyAndResume(
  attemptId: string,
): Promise<{ ok: true; resumed: boolean; note?: string }> {
  const call = httpsCallable<
    { attemptId: string; sebToken?: string },
    { ok: true; resumed: boolean; note?: string }
  >(functions, 'verifyAndResume');
  // Invigilators call this from a normal browser; sebRequired is false for
  // them, so ensureSebToken() yields undefined and the server skips the check.
  return withSeb(async (sebToken) => (await call({ attemptId, sebToken })).data);
}

// ── Phase 2.5: sequential delivery (linear / adaptive) ────────────
/**
 * Submit the current question's answer and receive the next question.
 * ONE atomic server operation: validate → write answer → lock → serve next.
 * Only for linear/adaptive attempts; standard mode uses saveAnswer().
 *
 * `answer: null` means "no answer" (e.g. the per-question timer expired).
 * The server records nothing for that question — it simply scores 0 — rather
 * than writing a fake blank that would pollute the timing analytics.
 *
 * Returns the next question, or `question: null` with `sectionComplete: true`
 * when the section has no questions left.
 */
export async function submitAnswerAndAdvance(params: {
  attemptId: string;
  questionId: string;
  answer: { type: string; value: unknown } | null;
}): Promise<{
  ok: true;
  question: Question | null;
  sectionComplete: boolean;
  lateAnswer: boolean;
}> {
  const call = httpsCallable<
    typeof params & { sebToken?: string; sessionId?: string },
    { ok: true; question: Question | null; sectionComplete: boolean; lateAnswer: boolean }
  >(functions, 'submitAnswerAndAdvance');
  return withSeb(async (sebToken) => (await call({
    ...params,
    sebToken,
    ...(activeSessionId ? { sessionId: activeSessionId } : {}),
  })).data);
}

// ── Auto-terminate ────────────────────────────────────────────────
// Force-submits with 'terminated' status after max violations reached.

/**
 * Maximum number of WARNING-type integrity violations (tab_switch, focus_loss,
 * fullscreen_exit) before an attempt is auto-terminated. Kept here so the
 * resume guard and the in-shell counter agree on one source of truth.
 */
export const MAX_INTEGRITY_WARNINGS = 3;

/**
 * Resume-time defensive check. If an attempt that's still flagged in_progress
 * has accumulated ≥ MAX_INTEGRITY_WARNINGS warning-type violations (e.g. the
 * student killed the tab during the 30-second final-warning countdown to dodge
 * termination), finalize it as terminated before the shell can re-enter it.
 *
 * Returns true if the attempt was just terminated, so callers can refuse to
 * resume and route the student to results instead.
 */
export async function enforceIntegrityThreshold(attempt: Attempt): Promise<boolean> {
  if (attempt.status !== 'in_progress') return false;
  const log = attempt.integrityLog;
  if (!log) return false;
  const warningCount =
    (log.tabSwitches ?? 0) +
    (log.focusLosses ?? 0) +
    (log.fullscreenExits ?? 0);
  if (warningCount < MAX_INTEGRITY_WARNINGS) return false;
  // Route termination through the Cloud Function so it runs server-side (admin
  // SDK bypasses the tight student-update rules on attempts/{id}). Direct
  // client writes to `status` are — correctly — no longer permitted.
  await gradeAttempt({
    attemptId: attempt.id,
    reason: 'terminated',
    terminateReason: 'Exam terminated due to repeated integrity violations.',
  });
  return true;
}

// ── Log violation ─────────────────────────────────────────────────
// Atomically appends to the violations log and increments counters.
// Returns the new totalViolations count (read from local increment —
// caller should track this locally to avoid an extra read).

export async function logViolation(
  attemptId: string,
  type: ViolationType,
  detail?: string,
  warningNumber?: number,
  opts?: { skipEventDetail?: boolean }
): Promise<{ warnings?: number; thresholdReached?: boolean }> {
  // Phase 2 (D-09): the integrity log is no longer a client-writable field.
  //
  // It used to sit on the student rules whitelist, and although this function
  // only ever incremented, nothing stopped a plain updateDoc resetting the
  // whole object to zeros — a student could erase their own violation record
  // mid-exam, counters included. The write now happens server-side, so the
  // log is append-only and a reported violation cannot be un-reported.
  //
  // Detail cap (unchanged reasoning): the violations array grows via
  // arrayUnion, so a hostile client spamming events could balloon the attempt
  // doc toward Firestore's 1 MiB limit and break every later write, including
  // submission. Past the shell's cap the server keeps counting and stops
  // appending event objects.
  const call = httpsCallable<
    {
      attemptId: string; type: ViolationType; detail?: string;
      warningNumber?: number; skipEventDetail?: boolean; sessionId?: string;
    },
    { ok: true; ignored?: boolean; warnings?: number; thresholdReached?: boolean }
  >(functions, 'logViolation');

  // Fail soft, same reasoning as registerSession above: during the deploy
  // window this callable does not exist yet, and a thrown error from a
  // violation report must never surface as an exam failure. A lost violation
  // report is a lost detection signal; a thrown error mid-sitting is a lost
  // exam. The call site in ExamShell also catches, so this is belt and braces.
  try {
    const res = await call({
      attemptId,
      type,
      ...(detail ? { detail } : {}),
      ...(warningNumber !== undefined ? { warningNumber } : {}),
      ...(opts?.skipEventDetail ? { skipEventDetail: true } : {}),
      ...(activeSessionId ? { sessionId: activeSessionId } : {}),
    });
    return {
      warnings: res.data.warnings,
      thresholdReached: res.data.thresholdReached,
    };
  } catch (e) {
    console.warn('[submissionService] logViolation failed', e);
    return {};
  }
}

/** Above this many logged events, violation DETAILS stop being appended to
 *  the attempt doc (counters keep incrementing). Guards the 1 MiB doc cap. */
export const MAX_LOGGED_VIOLATION_EVENTS = 300;

// ── Freeze attempt ────────────────────────────────────────────────
// Faculty invigilator pauses a student's exam session.

export async function freezeAttempt(
  attemptId: string,
  frozenBy: string,
  frozenReason?: string
): Promise<void> {
  const updates: Record<string, any> = {
    frozenAt: now(),
    frozenBy,
    updatedAt: now(),
  };
  if (frozenReason) updates.frozenReason = frozenReason;
  await updateDoc(doc(db, 'attempts', attemptId), updates);
}

// ── Unfreeze attempt ──────────────────────────────────────────────
// Resumes the exam and accumulates the frozen time so the timer is fair.

export async function unfreezeAttempt(
  attemptId: string,
  currentTotalFrozenSeconds: number,
  frozenAtISO: string
): Promise<void> {
  const additionalFrozenSeconds = Math.floor(
    (Date.now() - new Date(frozenAtISO).getTime()) / 1000
  );
  const newTotal = currentTotalFrozenSeconds + additionalFrozenSeconds;

  await updateDoc(doc(db, 'attempts', attemptId), {
    frozenAt: null,
    frozenBy: null,
    frozenReason: null,
    totalFrozenSeconds: newTotal,
    updatedAt: now(),
  });
}

// ── Register session ──────────────────────────────────────────────
// Called when ExamShell loads. Writes a unique sessionId to the attempt.
// Returns { conflict: true } if a DIFFERENT sessionId was already there.

export async function registerSession(
  attemptId: string,
  sessionId: string
): Promise<{ conflict: boolean; existingSessionId?: string }> {
  // Phase 2 (INV-5a / INV-5b, D-08): claiming a sitting is now an atomic
  // server-side transaction.
  //
  // The previous implementation was a getDoc followed by an updateDoc from the
  // browser. Two devices arriving together could both read "unclaimed" and
  // both believe they were first, and no conflict was recorded at all — so the
  // takeover overlay was decoration over a field nothing enforced.
  //
  // Takeover semantics are unchanged and deliberate: the joining device wins.
  // "First device wins" would strand a student whose browser crashed behind a
  // session they can no longer produce, which is far more common than a
  // cheater with two laptops. What changes is that the swap is atomic, the
  // conflict is recorded where the student cannot suppress it, and the
  // superseded device can no longer advance or submit the exam.
  activeSessionId = sessionId;

  const call = httpsCallable<
    { attemptId: string; sessionId: string },
    { ok: true; conflict: boolean; existingSessionId?: string }
  >(functions, 'registerSession');

  // ── FAIL SOFT. This must never stop a student sitting an exam. ──
  //
  // ExamShell awaits this inside the exam-load try block, whose catch sets
  // shellStatus 'error'. A throw here therefore does not degrade session
  // tracking — it locks the student out of the exam entirely.
  //
  // Two ways that happens in practice:
  //   1. DEPLOY WINDOW. Vercel auto-deploys the frontend the moment the repo
  //      is pushed, while Cloud Functions are deployed by hand from Cloud
  //      Shell afterwards. Between the two, this callable does not exist and
  //      returns functions/not-found. Every exam entry would fail.
  //   2. Any transient network failure at load time.
  //
  // Degrading to "unclaimed" is the correct failure mode. The server treats a
  // missing activeSessionId as "nobody has claimed this yet" and allows the
  // call, which is exactly the pre-Phase-2 behaviour — so a failure here loses
  // dual-device DETECTION for that sitting and nothing else. Session tracking
  // is a detection mechanism, never a gate on entry: locking an honest student
  // out of their exam to enforce it would be a far worse outcome than the
  // thing it protects against.
  try {
    const res = await call({ attemptId, sessionId });
    return {
      conflict: res.data.conflict === true,
      ...(res.data.existingSessionId ? { existingSessionId: res.data.existingSessionId } : {}),
    };
  } catch (e) {
    console.warn('[submissionService] registerSession failed; continuing unclaimed', e);
    return { conflict: false };
  }
}

// ── Soft-delete an attempt ────────────────────────────────────────
// Sets isDeleted = true. The attempt is filtered from the live roster
// but remains visible in the student's attempt history drawer.

/**
 * Soft-delete an exam attempt. webOwner only, enforced server-side.
 *
 * Audit 2026-07-26 S-03. This was a bare updateDoc writing `isDeleted`, which
 * firestore.rules permitted for any institute or faculty in the owning tenant
 * — contradicting the deletion rights model, where WEBOWNER_ONLY_RESOURCES
 * lists 'attempt' precisely because attempts are the audit trail of an exam.
 * It also wrote no deletionAudit row, so an attempt could vanish with no
 * record of who removed it.
 *
 * The softDeleteAttempt callable is now the only path: it checks the role,
 * and it commits the state change and the audit row in one transaction. The
 * rules no longer accept `isDeleted` from staff at all, so this cannot be
 * bypassed by writing to Firestore directly.
 *
 * Idempotent server-side — deleting an already-deleted attempt is a no-op and
 * does not produce a second audit row.
 */
export async function softDeleteAttempt(
  attemptId: string,
  reason?: string,
): Promise<void> {
  const call = httpsCallable<
    { attemptId: string; reason?: string },
    { ok: true }
  >(functions, 'softDeleteAttempt');
  await call({ attemptId, reason });
}

// ── Regrade attempts after a question fix ────────────────────────
// Used by the Reports flow when a reviewer changes the answer key or
// invalidates a question. Server-authoritative: the regradeAttempts
// Cloud Function re-scores every finished attempt of the assessment
// against the CURRENT answer keys, using the exact same scoring code
// as gradeAttempt. (Replaces the old client-side loop, which needed
// direct answer-key reads — those are now denied to non-owners by the
// questionAnswers rules — and duplicated the scoring logic.)
// Institute/faculty callers are scoped server-side to attempts in
// their own institute via their auth claims.
//
// Returns the number of attempts whose scores were rewritten.

export async function regradeAssessmentAttempts(params: {
  assessmentId: string;
  invalidatedQuestionIds?: string[];   // award full marks for these
}): Promise<number> {
  const call = httpsCallable<
    { assessmentId: string; invalidatedQuestionIds?: string[] },
    { ok: true; updated: number }
  >(functions, 'regradeAttempts');
  const res = await call({
    assessmentId: params.assessmentId,
    invalidatedQuestionIds: params.invalidatedQuestionIds,
  });
  return res.data.updated;
}

// ═════════════════════════════════════════════════════════════════
// READ OPERATIONS
// ══════════════════════════════════════════════════════════════════

// ── Fetch single attempt ──────────────────────────────────────────

export async function getAttempt(attemptId: string): Promise<Attempt | null> {
  const snap = await getDoc(doc(db, 'attempts', attemptId));
  if (!snap.exists()) return null;
  return snap.data() as Attempt;
}

// ── Fetch attempt by student + assessment (idempotency / resume) ──

export async function getAttemptByStudentAndAssessment(
  studentId: string,
  assessmentId: string
): Promise<Attempt | null> {
  const q = query(
    collection(db, 'attempts'),
    where('studentId', '==', studentId),
    where('assessmentId', '==', assessmentId)
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  // Return the most recent if somehow multiple exist (shouldn't happen)
  const docs = snap.docs.map((d) => d.data() as Attempt);
  docs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return docs[0];
}

// ── Fetch ALL attempts by student + assessment ────────────────────
// Returns every attempt in chronological order (oldest first).
// Used for attempt-count checks and roster history.

export async function getAllAttemptsByStudentAndAssessment(
  studentId: string,
  assessmentId: string
): Promise<Attempt[]> {
  const q = query(
    collection(db, 'attempts'),
    where('studentId', '==', studentId),
    where('assessmentId', '==', assessmentId)
  );
  const snap = await getDocs(q);
  const docs = snap.docs.map((d) => d.data() as Attempt);
  docs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return docs;
}

// ── Fetch all attempts for a student ─────────────────────────────
// Used by the student's assessment list to show per-assessment status.

export async function getAttemptsByStudent(
  studentId: string
): Promise<Attempt[]> {
  const q = query(
    collection(db, 'attempts'),
    where('studentId', '==', studentId)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as Attempt);
}

// ── Fetch all attempts for an assessment (admin roster) ───────────

// NOTE ON SCOPING: the attempts read rule only grants institute/faculty
// access to docs whose instituteId matches their claim. A query without an
// instituteId filter is unprovable and Firestore rejects it WHOLESALE with
// permission-denied. Pass instituteId for institute/faculty callers; pass
// null/undefined only for webOwner.
export async function getAttemptsByAssessment(
  assessmentId: string,
  instituteId?: string | null
): Promise<Attempt[]> {
  const constraints = [where('assessmentId', '==', assessmentId)];
  if (instituteId) constraints.push(where('instituteId', '==', instituteId));
  const q = query(collection(db, 'attempts'), ...constraints);
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as Attempt);
}

// ── Fetch all attempts for an institute (aggregate admin view) ────

export async function getAttemptsByInstitute(
  instituteId: string
): Promise<Attempt[]> {
  const q = query(
    collection(db, 'attempts'),
    where('instituteId', '==', instituteId)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as Attempt);
}

// ══════════════════════════════════════════════════════════════════
// BREAK-STATE DETECTION
// ══════════════════════════════════════════════════════════════════
// Returns non-null when the attempt is mid-break: the current section
// has a configured breakAfter, the current section is submitted, and
// the next section's timer hasn't started yet. Used by both the exam
// shell (for resume) and the faculty roster (for the "On break" pill).

export function getBreakState(
  attempt: Attempt,
  sections: Array<{ id: string; name: string; breakAfter?: { durationMinutes: number; mandatory: boolean } }>,
  nowMs: number = Date.now(),
): { sectionName: string; nextSectionName: string; secondsRemaining: number; expired: boolean; mandatory: boolean } | null {
  if (attempt.status !== 'in_progress') return null;
  const cur = sections[attempt.currentSectionIdx];
  const next = sections[attempt.currentSectionIdx + 1];
  if (!cur || !next || !cur.breakAfter || cur.breakAfter.durationMinutes <= 0) return null;
  const curTiming = attempt.sectionTimings[cur.id];
  const nextTiming = attempt.sectionTimings[next.id];
  if (!curTiming?.submittedAt) return null;
  if (nextTiming?.startedAt) return null;
  const endsAt = new Date(curTiming.submittedAt).getTime() + cur.breakAfter.durationMinutes * 60 * 1000;
  const remainingMs = endsAt - nowMs;
  return {
    sectionName: cur.name,
    nextSectionName: next.name,
    secondsRemaining: Math.max(0, Math.ceil(remainingMs / 1000)),
    expired: remainingMs <= 0,
    mandatory: cur.breakAfter.mandatory,
  };
}

// ══════════════════════════════════════════════════════════════════
// REALTIME SUBSCRIPTIONS (onSnapshot)
// ══════════════════════════════════════════════════════════════════

// ── Subscribe to a single attempt ─────────────────────────────────
// Used by ExamShell to watch for freeze/unfreeze and session conflicts.

export function subscribeToAttempt(
  attemptId: string,
  cb: (attempt: Attempt | null) => void
): Unsubscribe {
  return onSnapshot(doc(db, 'attempts', attemptId), (snap) => {
    cb(snap.exists() ? (snap.data() as Attempt) : null);
  });
}

// ── Subscribe to all attempts for an assessment ───────────────────
// Used by the faculty Roster page for live student status.

export function subscribeToAttemptsByAssessment(
  assessmentId: string,
  cb: (attempts: Attempt[]) => void,
  instituteId?: string | null
): Unsubscribe {
  // instituteId REQUIRED for institute/faculty callers (see scoping note
  // above) — without it the rules reject the whole subscription.
  const constraints = [where('assessmentId', '==', assessmentId)];
  if (instituteId) constraints.push(where('instituteId', '==', instituteId));
  const q = query(collection(db, 'attempts'), ...constraints);
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => d.data() as Attempt));
  });
}