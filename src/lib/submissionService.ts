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
}): Promise<Attempt> {
  // Server-authoritative: the startExam Cloud Function owns schedule
  // enforcement (startDate/endDate), the attempt-limit check, and all
  // timestamps. Identity + schedule + limits are re-derived server-side from
  // auth claims + the assessment doc, so the client-supplied values here are
  // advisory only. We still pass sections / shuffle / order so the server can
  // freeze the same play order the shell expects. Throws
  // ATTEMPT_LIMIT_EXCEEDED:<used>:<max> when the student is out of attempts.
  const call = httpsCallable<
    {
      assessmentId: string;
      sections: typeof params.sections;
      shuffleQuestions: boolean;
      sectionStartOrder?: 'sequential' | 'random' | 'student_choice';
      cameraDeclined?: boolean;
      deviceClass?: 'desktop' | 'mobile' | 'tablet';
      sebToken?: string;
    },
    { ok: true; attempt: Attempt }
  >(functions, 'startExam');

  try {
    const res = await call({
      assessmentId: params.assessmentId,
      sections: params.sections,
      shuffleQuestions: params.shuffleQuestions,
      sectionStartOrder: params.sectionStartOrder,
      cameraDeclined: params.cameraDeclined,
      deviceClass: detectDeviceClass(),
      sebToken: params.sebToken,
    });
    return res.data.attempt;
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? '';
    if (msg.includes('ATTEMPT_LIMIT_EXCEEDED')) {
      const m = msg.match(/ATTEMPT_LIMIT_EXCEEDED:\d+:\d+/);
      throw new Error(m ? m[0] : 'ATTEMPT_LIMIT_EXCEEDED');
    }
    throw e;
  }
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
    },
    { ok: true; timeUsedSeconds: number; question: Question | null }
  >(functions, 'submitSection');

  const res = await call({
    attemptId: params.attemptId,
    sectionId: params.sectionId,
    nextSectionId: params.nextSectionId,
    nextSectionIdx: params.nextSectionIdx,
    pauseBeforeNext: params.pauseBeforeNext,
  });
  // Sequential delivery: when advancing straight into the next section (no
  // break), the server serves and returns that section's first question.
  return { question: res.data.question ?? null };
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
    { attemptId: string; sectionId: string; reorderedSectionIds: string[] },
    { ok: true; startedAt: string; sectionIds: string[]; question: Question | null }
  >(functions, 'startSection');

  const res = await call({ attemptId, sectionId: pickedSectionId, reorderedSectionIds: reordered });
  // In sequential delivery the server serves (and returns) the section's first
  // question; the client cannot fetch it any other way.
  return { sectionIds: res.data.sectionIds, question: res.data.question ?? null };
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
    { attemptId: string; sectionId: string },
    { ok: true; startedAt: string; sectionIds: string[]; question: Question | null }
  >(functions, 'startSection');
  const res = await call({ attemptId: params.attemptId, sectionId: params.nextSectionId });
  // Sequential delivery: the next section's first question comes back here.
  return { question: res.data.question ?? null };
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
  const call = httpsCallable<typeof params, { ok: true; scores: AttemptScores }>(
    functions,
    'gradeAttempt',
  );
  const res = await call(params);
  return res.data;
}

// ── Phase 1 client wrappers ───────────────────────────────────────
// Thin callable wrappers. The server owns all the logic; these just relay.

/** Heartbeat — call on an interval (~15s) while an attempt is in progress. */
export async function sendHeartbeat(attemptId: string): Promise<void> {
  const call = httpsCallable<{ attemptId: string }, { ok: true; ignored?: boolean }>(
    functions,
    'examHeartbeat',
  );
  try {
    await call({ attemptId });
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
  const call = httpsCallable<typeof params, { ok: true; frozen: boolean }>(
    functions,
    'reportExtensionCheck',
  );
  const res = await call(params);
  return res.data;
}

/** Attempt to clear a freeze and resume (auto for eligible tiers, else invigilator). */
export async function verifyAndResume(
  attemptId: string,
): Promise<{ ok: true; resumed: boolean; note?: string }> {
  const call = httpsCallable<{ attemptId: string }, { ok: true; resumed: boolean; note?: string }>(
    functions,
    'verifyAndResume',
  );
  const res = await call({ attemptId });
  return res.data;
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
    typeof params,
    { ok: true; question: Question | null; sectionComplete: boolean; lateAnswer: boolean }
  >(functions, 'submitAnswerAndAdvance');
  const res = await call(params);
  return res.data;
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
): Promise<void> {
  const counterField = `integrityLog.${VIOLATION_COUNTER[type]}`;

  // Detail cap: the violations array grows without bound via arrayUnion; a
  // hostile client spamming violation events could balloon the attempt doc
  // toward Firestore's 1 MiB limit and break every subsequent write
  // (including submission). Past the shell's cap, keep incrementing the
  // counters (termination logic depends on them) but stop appending event
  // objects.
  if (opts?.skipEventDetail) {
    await updateDoc(doc(db, 'attempts', attemptId), {
      [counterField]: increment(1),
      'integrityLog.totalViolations': increment(1),
      updatedAt: now(),
    });
    return;
  }

  const event: ViolationEvent = {
    type,
    timestamp: now(),
    ...(detail ? { detail } : {}),
    ...(warningNumber !== undefined ? { warningNumber } : {}),
  };

  await updateDoc(doc(db, 'attempts', attemptId), {
    'integrityLog.violations': arrayUnion(event),
    [counterField]: increment(1),
    'integrityLog.totalViolations': increment(1),
    updatedAt: now(),
  });
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
  const snap = await getDoc(doc(db, 'attempts', attemptId));
  if (!snap.exists()) return { conflict: false };

  const data = snap.data() as Attempt;
  const existing = data.activeSessionId;

  // No conflict — first registration or same session resuming
  if (!existing || existing === sessionId) {
    await updateDoc(doc(db, 'attempts', attemptId), {
      activeSessionId: sessionId,
      updatedAt: now(),
    });
    return { conflict: false };
  }

  // Conflict: another session is active — log it, then take over
  await updateDoc(doc(db, 'attempts', attemptId), {
    activeSessionId: sessionId,
    sessionConflictAt: now(),
    updatedAt: now(),
  });
  return { conflict: true, existingSessionId: existing };
}

// ── Soft-delete an attempt ────────────────────────────────────────
// Sets isDeleted = true. The attempt is filtered from the live roster
// but remains visible in the student's attempt history drawer.

export async function softDeleteAttempt(attemptId: string): Promise<void> {
  await updateDoc(doc(db, 'attempts', attemptId), {
    isDeleted: true,
    updatedAt: now(),
  });
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