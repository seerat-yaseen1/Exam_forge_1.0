import {
  collection,
  doc,
  documentId,
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
// Type-only in BOTH directions — codeVerdictView imports AttemptAnswer from
// here. Erased at compile, so there is no runtime cycle of the kind
// itemTypes.ts warns about.
import type { TelemetryEvent } from './codeTelemetry';
import type { CodeVerdictDoc } from './codeVerdictView';
import type { AnswerDiscriminant } from './itemTypes';
import { getDeviceFingerprint, type DeviceFingerprint } from './deviceFingerprint';
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
  // null means NOBODY HAS MARKED THIS YET — not "we don't know". A hand-marked
  // text answer carries a boolean like any other, which is what lets every
  // reader bucket it as correct / partial / wrong with no special case for
  // manual marking (see setManualMark, functions/src/index.ts).
  isCorrect: boolean | null;
  marksAwarded: number;
  correctIds?: string[];       // mcq
  correctPairs?: CorrectPair[]; // match
  modelAnswer?: string;        // text
  /** Grader's note. Present only when the review audience includes the reader. */
  feedback?: string;
  /** True when a human awarded this mark rather than the scorer. */
  manuallyMarked?: boolean;
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
  | 'devtools_open'    // devtools height heuristic / shortcut intercepted
  | 'reload_attempt'   // F5 / Ctrl+R
  | 'keyboard_block'   // blocked key combination
  | 'extension_detected' // a NAMED extension fingerprint matched in the DOM
  | 'viewport_narrowed'  // something took horizontal space — side panel or docked devtools
  | 'foreign_dom'        // unrecognised top-level DOM; deliberately unnamed, never freezes
  | 'focus_state_mismatch' // window has no focus but no blur event ever fired
  | 'render_throttled';  // rAF running at background rates while claiming to be focused

/**
 * WHERE the student was when a violation fired.
 *
 * Every detector reports through one handler in ExamShell, so this is attached
 * at that single choke point rather than being threaded through each detector.
 * That is what makes it uniform by construction: a detector added later cannot
 * forget to supply it, because it never supplies it in the first place.
 *
 * The reason it exists: a reviewer reading "tab_switch, 10:32" cannot act on
 * it. The same event against "question 4 of section B" is a fact about the
 * paper — it can be checked against the answer, the timing and the mark.
 *
 * Every field is optional and every field is client-supplied, so the server
 * validates the ids against the attempt's own paper before storing them; see
 * sanitiseViolationContext.
 */
export type ViolationContext = {
  questionId?: string;
  sectionId?: string;
  /** 1-based positions, stored because a reviewer reads "4 of 12", not an id. */
  questionNumber?: number;
  sectionNumber?: number;
};

export type ViolationEvent = {
  type: ViolationType;
  timestamp: string;
  detail?: string;            // human-readable context
  warningNumber?: number;     // which warning was shown (1, 2, 3)
} & ViolationContext;

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
  // 'code' answers are { language, source }, which the existing
  // Record<string, string> arm of AnswerValue already admits — the value union
  // does not widen and the stored shape does not change.
  //
  // AnswerDiscriminant, not a fourth hand-written copy of the same four
  // strings. It is an alias of QuestionEngine, and `answerTypeForEngine` is
  // the only sanctioned way to produce one — see the note beside it in
  // itemTypes.ts for what the hand-written version cost.
  type: AnswerDiscriminant;
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
  // G-02: null while the paper still awaits manual marking — a pass/fail
  // statement before every awardable mark is awarded is a verdict on
  // marking that has not happened. Render three states, never two.
  passed: boolean | null;          // met passingScore threshold (if defined)
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
  // Horizontal viewport loss that is NOT confidently DevTools — see the note
  // on viewport_narrowed in IntegrityEngine. Optional because attempts created
  // before this counter existed will not carry it; every reader defaults it.
  viewportEvents?: number;
  // Kept apart from extensionEvents on purpose: that counter means "a named
  // extension was identified", and folding heuristic hits into it would make
  // a reviewer read a guess as an identification.
  foreignDomEvents?: number;
  focusMismatchEvents?: number;
  renderThrottleEvents?: number;

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

// ── Materialised lock bounds ──────────────────────────────────────

/**
 * A lock bound, in every shape it can actually reach the client in (D-34).
 *
 * There are THREE sources, and the third is the one that bit us:
 *
 *   1. Firestore SDK read (getDoc / onSnapshot) — a real Timestamp INSTANCE,
 *      with .toMillis().
 *   2. An optimistic local copy — an ISO string.
 *   3. A CALLABLE RESPONSE. startExam returns the attempt it just built, and
 *      onCall serialises to JSON. Timestamp does not survive that: it arrives
 *      as a plain `{_seconds, _nanoseconds}` object with NO METHODS.
 *
 * The type declared only the first two, so every fresh sitting threw
 * `raw.toMillis is not a function` the moment expiredClock ran against the
 * attempt startExam had just returned. Reloading "fixed" it because the resume
 * path reads from Firestore, restoring shape 1 — which is why it looked
 * intermittent rather than deterministic, and why it cost a whole extra
 * startup cycle every time.
 *
 * Declared ONCE, here, and consumed only through lockToMillis. Two call sites
 * in ExamShell used to convert inline and had to be kept in lockstep by hand;
 * a single helper is what stops this recurring.
 */
export type AttemptLock =
  | { toMillis: () => number }                    // Firestore SDK instance
  | { _seconds: number; _nanoseconds?: number }   // callable JSON (admin SDK)
  | { seconds: number; nanoseconds?: number }     // callable JSON (alt casing)
  | string                                        // ISO — optimistic local copy
  | number                                        // epoch ms
  | Date
  | null;

/**
 * Any lock shape → epoch milliseconds, or null when there is no usable bound.
 *
 * UNRECOGNISED SHAPES RETURN NULL, AND THE DIRECTION IS DELIBERATE. Null means
 * "no bound", so the client believes the window is still OPEN. If that is
 * wrong, the student keeps working and the server rejects the write — visible
 * and recoverable. The opposite default would auto-submit a student who still
 * had time left, on nothing more than a shape we failed to parse. Fail towards
 * letting them keep writing; firestore.rules is the real gate.
 */
export function lockToMillis(raw: AttemptLock | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  if (raw instanceof Date) {
    const ms = raw.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof (raw as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (raw as { toMillis: () => number }).toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  // Callable wire shape. Both casings are accepted because the underscored
  // form is an admin-SDK internal field name, not a documented contract, and
  // is not something to depend on surviving an SDK upgrade.
  const o = raw as {
    _seconds?: number; seconds?: number;
    _nanoseconds?: number; nanoseconds?: number;
  };
  const secs = typeof o._seconds === 'number' ? o._seconds
             : typeof o.seconds === 'number' ? o.seconds
             : null;
  if (secs === null) return null;
  const nanos = typeof o._nanoseconds === 'number' ? o._nanoseconds
              : typeof o.nanoseconds === 'number' ? o.nanoseconds
              : 0;
  const ms = secs * 1000 + Math.floor(nanos / 1e6);
  return Number.isFinite(ms) ? ms : null;
}

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
  answersLockedAfter?: AttemptLock;
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
  sectionLockedAfter?: AttemptLock;
  overallLockedAfter?: AttemptLock;
  /**
   * Per-clock freeze credit in ms, materialised by the server (D-35).
   *
   * Replaces dividing `totalFrozenSeconds` — one flat total for the whole
   * attempt — across every clock. That was D-28's twin: fixed on the server in
   * Phase 4.0 and left standing here, so a pause during section 1 handed the
   * student a visibly generous section 2 the server had never granted. They
   * worked into time that did not exist, and the expiry sweep cut the section
   * off underneath them.
   *
   * Read, never computed. These are the same figures the write gate uses, so
   * the countdown on screen and the deadline in firestore.rules cannot
   * disagree about what a pause was worth.
   *
   * Absent on attempts that started before this shipped — callers fall back to
   * 0, which is the pre-freeze behaviour and drains within a sitting.
   */
  /**
   * The freeze ledger (Phase 4 / §8).
   *
   * One entry per pause, each judged on its own: no history, no running total.
   * An entry with no `endedAt` is the pause currently open.
   *
   * Read-only on the client. Every write goes through freezeAttempt or
   * unfreezeAttempt, which is what keeps grants attributable and makes INV-4a
   * and INV-11 (credit and penalty are append-only) enforceable at all.
   */
  freezes?: Array<{
    id: string;
    startedAt: string;
    endedAt?: string | null;
    reason: 'invigilator' | 'extension_check' | 'system';
    frozenBy?: string | null;
    /** The freezer's role AT THE TIME — authority attaches per freeze (§3). */
    frozenByRole?: 'webOwner' | 'institute' | 'faculty' | 'system' | null;
    elapsedMs?: number | null;
    /** Decided credit. The only figure deadlines consume. */
    grantedMs?: number | null;
    decidedBy?: string | null;
    decidedAt?: string | null;
    note?: string | null;
    /**
     * What each clock had left when the pause landed (§2).
     * null = that clock was not running; 0 = it had run out. A10 turns on the
     * difference — absent means the option is not offered, expired means it is
     * offered with a cap of zero.
     */
    clocksAtFreeze?: {
      questionMs: number | null;
      sectionMs: number | null;
      overallMs: number | null;
    } | null;
  }>;
  /** Deductions taken at resume (Phase 4.5). Append-only — INV-11. */
  penalties?: Array<{
    id: string;
    freezeId: string;
    clock: 'question' | 'section' | 'overall';
    amountMs: number;
    decidedAt: string;
    decidedBy?: string;
    decidedByRole?: string;
  }>;
  freezeCredits?: {
    overallMs: number;
    sectionMs: number;
    questionMs: number;
    breakMs: number;
  };
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

  /**
   * This paper owes at least one coding answer to the judge.
   *
   * Set by `gradeAttempt` at submission and DELETED by `scheduledJudgeCoding`
   * once every coding answer has settled — so its absence means judging is
   * finished, not that it never started.
   *
   * Read by the review surfaces to tell "still being marked" from "could not
   * be marked", which are identical in `gradedAnswers` (isCorrect null, zero
   * awarded) and must not read the same to a student. See codeVerdictView.ts.
   */
  codeJudgePending?: boolean;

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
  /**
   * Silences longer than the server's threshold, measured by examHeartbeat at
   * the moment each beat lands. lastHeartbeatAt alone cannot support this —
   * it is overwritten by every beat, so gaps DURING a sitting leave no trace
   * and only the final heartbeat→submit interval survives to grade time.
   *
   * Absent on attempts that predate the field, and on any sitting that never
   * fell silent. `recent` is bounded server-side; `count` and `maxSeconds`
   * stay exact.
   */
  heartbeatGaps?: {
    count: number;
    maxSeconds: number;
    recent: Array<{ at: string; seconds: number }>;
  } | null;

  /**
   * The machine reported at the START of the sitting. Written by startExam and
   * never rewritten, which is the point: the baseline is server-held, so a
   * client comparing against its own copy — trivially defeated — is not what
   * decides whether the hardware changed.
   */
  deviceFingerprint?: DeviceFingerprint | null;
  /**
   * Recorded when a heartbeat reports a machine that disagrees with the
   * baseline. A browser session cannot move between computers, so this is two
   * incompatible facts about one sitting. See src/lib/deviceFingerprint.ts for
   * what it can and cannot show.
   */
  fingerprintDrift?: {
    count: number;
    firstAt: string;
    changes: string[];
  } | null;

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
    /** Largest number of integrity events inside any one-minute window. */
    maxViolationsInMinute?: number;
    anomalyScore: number;
    /**
     * What the score is MADE OF. Stored rather than derived so a reviewer can
     * interrogate the number instead of deferring to it — a bare score says
     * be suspicious without saying of what. Absent on attempts graded before
     * this shipped; anomalyScore on those still means what it meant.
     */
    riskFactors?: Array<{ code: string; points: number; detail: string }>;
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
  viewport_narrowed:  'viewportEvents',
  foreign_dom:         'foreignDomEvents',
  focus_state_mismatch: 'focusMismatchEvents',
  render_throttled:    'renderThrottleEvents',
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
  /**
   * This browser's session id (D-33).
   *
   * startExam has always been able to stamp activeSessionId at creation —
   * `...(sessionId ? { activeSessionId: sessionId } : {})` — but the client had
   * no way to supply one. The only value it sent was the module-level
   * `activeSessionId`, which registerSession sets, and registerSession ran
   * AFTER startExam. Circular: the field was never populated at creation, so
   * every fresh sitting needed a second round trip to claim the session.
   *
   * Two things follow from passing it here:
   *
   *   1. The claim rides along, so registerSession leaves the fresh-start
   *      critical path entirely — one whole Cloud Run cold start removed from
   *      the window that is CHARGED TO THE STUDENT, because their section and
   *      first-question clocks are already running by then.
   *   2. The Phase 2 (INV-5a) comment on startExam claims "there is no
   *      unclaimed window in which a second device could slip in ahead of the
   *      real one". That was aspirational — the window existed precisely
   *      because this value never arrived. Now it doesn't.
   */
  sessionId?: string;
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
      fingerprint?: DeviceFingerprint;
      sebToken?: string;
      sessionId?: string;
    },
    { ok: true; attempt: Attempt }
  >(functions, 'startExam');

  // Adopt this browser's session BEFORE the request is built, so the
  // `...(activeSessionId ? { sessionId } : {})` spread below actually carries
  // it. Set even if startExam then fails: the id identifies this browser, not
  // any particular attempt, and a later call sending it is correct regardless.
  if (params.sessionId) activeSessionId = params.sessionId;

  // Spread the arrival before the request is made. onStaggerWait lets the
  // caller show "Preparing your exam…" so the wait reads as loading rather
  // than as an unexplained pause.
  //
  // DELIBERATELY BEFORE startExam, and that placement is what makes the
  // stagger free for the student. Every clock — section, question and overall
  // — is anchored to the `nowIso` inside startExam's transaction, so a student
  // held back 18s here simply starts 18s later with their full budget intact.
  // Waiting costs them nothing.
  //
  // The one exception is the assessment's absolute availability window, which
  // is wall-clock and does not move: a staggered student has up to
  // STAGGER_MAX_WINDOW_MS less room before it closes. Bounded at 20s and
  // unavoidable if arrivals are to be spread at all.
  //
  // What DOES cost the student is everything AFTER startExam returns, because
  // by then the clocks are running (D-33) — which is why the callers of this
  // function work to keep that stretch as close to zero as possible.
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
        // The baseline machine. Sent once, at the only moment it can be
        // established — every later report is compared against what the server
        // stored here, not against anything the client keeps.
        fingerprint: getDeviceFingerprint(),
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

// ── In-exam sample run ────────────────────────────────────────────
//
// Runs a coding answer against the question's VISIBLE tests only. The server
// strips the hidden suite before the submission is built, so the answer key
// never reaches the judge on this path, and redacts what comes back.
//
// Deliberately NOT wrapped in withSeb, matching the server: runCodeSample does
// not verify a SEB token today. Worth revisiting — the platform's posture is
// that SEB binds the exam-taker — but the exposure is small, since a run
// returns only sample results the candidate can already see inside SEB.
//
// This never throws for a refusal. Out of runs, cooling down, runs disabled and
// "no samples on this question" all come back as ok:false with a reason, because
// none of them is an error the candidate caused, and an exception mid-exam reads
// as "something broke". Only a genuine transport failure rejects.
export type SampleRunResult =
  | { ok: true; verdict: CandidateVerdictDTO; remaining: number; judgeAvailable: boolean }
  | {
      ok: false;
      reason: 'disabled' | 'quota_exhausted' | 'cooling_down' | 'no_samples';
      remaining: number;
      retryAfterMs: number;
    };

/** Mirrors CandidateVerdict in functions/src/judgeCore.ts — hidden tests already stripped. */
export interface CandidateVerdictDTO {
  status: 'completed' | 'compile_error' | 'judge_unavailable' | 'internal_error';
  compileMessage?: string;
  results: Array<{
    testId: string;
    status: 'passed' | 'wrong_answer' | 'timeout' | 'runtime_error'
          | 'memory_exceeded' | 'output_exceeded' | 'skipped';
    timeMs?: number;
    memoryKb?: number;
    stdout?: string;
    stderr?: string;
  }>;
  hiddenCount: number;
  judgedAt: string;
}

export async function runCodeSample(params: {
  attemptId: string;
  questionId: string;
  language: string;
  source: string;
}): Promise<SampleRunResult> {
  const call = httpsCallable<typeof params, SampleRunResult>(functions, 'runCodeSample');
  return (await call(params)).data;
}

// ── Code telemetry ────────────────────────────────────────────────
//
// Fire-and-forget. A failed flush must never surface to a candidate sitting an
// exam and must never block their typing: telemetry is a research and review
// artefact, and losing a chunk of it is a worse outcome for us than for them.
// The server decides whether anything is recorded at all.
export async function recordCodeTelemetry(params: {
  attemptId: string;
  questionId: string;
  seq: number;
  events: unknown[];
}): Promise<void> {
  try {
    const call = httpsCallable<typeof params, { ok: true; stored: number }>(
      functions, 'recordCodeTelemetry',
    );
    await call(params);
  } catch {
    // Deliberately swallowed. See above.
  }
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
  const call = httpsCallable<
    { attemptId: string; sebToken?: string; fingerprint?: DeviceFingerprint },
    { ok: true; ignored?: boolean }
  >(
    functions,
    'examHeartbeat',
  );
  try {
    // The heartbeat doubles as the SEB proof refresh: it runs every ~15s,
    // comfortably inside the ~90s token TTL.
    //
    // It also carries the machine fingerprint, for two reasons. It is the only
    // channel that already runs for the whole sitting on exactly the tiers
    // that want the check, and the value is computed once per page load and
    // cached, so riding this interval costs a few dozen bytes rather than a
    // WebGL context every fifteen seconds.
    await withSeb((sebToken) =>
      call({ attemptId, sebToken, fingerprint: getDeviceFingerprint() }).then(() => undefined));
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

// ── Phase 4.4: provisional grading of a paused attempt (A9) ───────

/**
 * A staff-only view of where a PAUSED student had got to.
 *
 * Deliberately not stored on the attempt. The student can read their own
 * attempt, and A9 is explicit that a frozen student must not see a result that
 * is not final — and that "a stale score sitting on a live attempt is exactly
 * the quiet wrongness this whole project has been about". Its own collection
 * makes both structural: students have no read access, and unfreezeAttempt
 * deletes the row in the same transaction as the release, so the mark cannot
 * outlive the pause.
 *
 * Not a submission. The attempt stays live, its status is untouched, and no
 * further attempt is consumed.
 */
export type ProvisionalGrade = {
  attemptId: string;
  assessmentId: string;
  instituteId: string | null;
  studentId: string | null;
  scores: AttemptScores;
  /** Which pause this describes — a grade from an earlier freeze is stale. */
  freezeId: string;
  answeredCount: number;
  gradedAt: string;
  gradedBy: string;
  gradedByRole: string;
};

/** Grade a paused attempt without ending it. Invigilator only. */
export async function gradeProvisional(attemptId: string): Promise<{
  ok: true; scores: AttemptScores; provisional: true; gradedAt: string;
}> {
  const call = httpsCallable<
    { attemptId: string },
    { ok: true; scores: AttemptScores; provisional: true; gradedAt: string }
  >(functions, 'gradeProvisional');
  return (await call({ attemptId })).data;
}

/**
 * Read the provisional grade for one attempt, or null.
 *
 * Read directly rather than through a callable: the rules already scope it to
 * the caller's tenant, and a roster showing many students would otherwise pay
 * a callable round trip per row.
 */
export async function getProvisionalGrade(attemptId: string): Promise<ProvisionalGrade | null> {
  try {
    const snap = await getDoc(doc(db, 'provisionalGrades', attemptId));
    return snap.exists() ? (snap.data() as ProvisionalGrade) : null;
  } catch {
    // A student hitting this is denied by rules, by design. Absence is the
    // right answer for them, and it must not break whatever called it.
    return null;
  }
}

// ── Phase 4.2: commit a sequential answer WITHOUT advancing ───────
/**
 * Persist the current question's answer and nothing else.
 *
 * The sibling of submitAnswerAndAdvance, and the distinction is the whole
 * point: that one saves, LOCKS the question and SERVES the next one. This one
 * only saves. No lock, no serve, no timing write.
 *
 * Why it had to exist: in linear/adaptive an answer's only route to the server
 * was submitAnswerAndAdvance, because firestore.rules reject a direct client
 * write. So the selection sitting in front of a student could not be persisted
 * without also moving them past it — which meant that when an invigilator
 * paused a sitting, the honest options were "lose their answer" or "advance
 * the student you just paused". ExamShell chose the first, deliberately, and
 * documented why. This removes the choice.
 *
 * Callers: the freeze flush, the Phase 4.1 durability layer, and anywhere else
 * that needs work committed without changing where the student is.
 *
 * Accepted while the attempt is `in_progress` OR `frozen` — the client only
 * learns of a freeze after it has landed, so refusing a frozen attempt would
 * fail exactly when this matters most.
 *
 * `answer: null` is a no-op that returns `saved: false`. It is not an error
 * and it is not reported as a success either.
 */
export async function saveAnswerNoAdvance(params: {
  attemptId: string;
  questionId: string;
  answer: { type: string; value: unknown } | null;
}): Promise<{
  ok: true;
  saved: boolean;
  /** Server timestamp of the write, or null when nothing was saved. */
  savedAt: string | null;
  lateAnswer: boolean;
}> {
  const call = httpsCallable<
    typeof params & { sebToken?: string; sessionId?: string },
    { ok: true; saved: boolean; savedAt: string | null; lateAnswer: boolean }
  >(functions, 'saveAnswerNoAdvance');
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
  opts?: { skipEventDetail?: boolean; context?: ViolationContext }
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
      context?: ViolationContext;
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
      ...(opts?.context && Object.keys(opts.context).length > 0
        ? { context: opts.context }
        : {}),
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
  _frozenBy: string,
  frozenReason?: string
): Promise<void> {
  // Phase 4: a freeze opens a LEDGER ENTRY, server-side.
  //
  // This used to be a direct updateDoc of four loose fields, and the time it
  // took was never given back — the display credited the pause and the write
  // gate did not (D-03). A freeze now records when it started; how much of it
  // the student gets back is decided at unfreeze, by a human, on the record.
  //
  // frozenBy is ignored: the server takes the actor from the caller's auth
  // token rather than trusting a name supplied by the browser.
  const call = httpsCallable<
    { attemptId: string; reason?: string },
    { ok: true; alreadyFrozen: boolean; entryId: string | null }
  >(functions, 'freezeAttempt');
  await call({ attemptId, ...(frozenReason ? { reason: frozenReason } : {}) });
}

// ── Unfreeze attempt ──────────────────────────────────────────────
// Resumes the exam and accumulates the frozen time so the timer is fair.

export async function unfreezeAttempt(
  attemptId: string,
  grantedMs: number,
  note?: string,
  /**
   * Deductions taken in the same decision (Phase 4.5 / §4).
   *
   * Positive milliseconds per clock; direction is carried by which clock, not
   * by a sign. Omitted or all-zero is the ordinary case and records nothing.
   *
   * Sent as asked and CLAMPED SERVER-SIDE against the post-credit clock. The
   * modal computes the same caps for display, so the two normally agree; if
   * they ever diverge the server wins and less is deducted than requested,
   * which is the only direction that cannot cost a student time nobody
   * authorised.
   */
  penalties?: { questionMs?: number; sectionMs?: number; overallMs?: number },
): Promise<{ elapsedMs: number; grantedMs: number; creditedFreezeMs: number }> {
  // Phase 4: resuming requires an explicit decision about the paused time.
  //
  // The old signature took the running total FROM THE CALLER
  // (`currentTotalFrozenSeconds`) and the server wrote `current + additional`.
  // A stale roster — or two invigilators on one attempt — therefore made
  // accumulated credit go DOWN, which is INV-4a. The total is now derived from
  // the ledger inside a transaction and cannot regress, whoever calls it.
  //
  // grantedMs is required and has no default: how much of a pause was the
  // student's own doing is a judgement, and the system silently choosing one
  // is how "the timer said one thing and the marking said another" happened in
  // the first place. Zero is a valid answer; it just has to be given.
  const call = httpsCallable<
    { attemptId: string; grantedMs: number; note?: string;
      penalties?: { questionMs?: number; sectionMs?: number; overallMs?: number } },
    { ok: true; elapsedMs: number; grantedMs: number; creditedFreezeMs: number }
  >(functions, 'unfreezeAttempt');
  // Only sent when something is actually being taken. An all-zero object would
  // be indistinguishable from a real decision in the request log, and the
  // server writes no ledger row for a zero anyway.
  const anyPenalty = !!penalties && (
    (penalties.questionMs ?? 0) > 0 ||
    (penalties.sectionMs ?? 0) > 0 ||
    (penalties.overallMs ?? 0) > 0
  );
  const res = await call({
    attemptId, grantedMs,
    ...(note ? { note } : {}),
    ...(anyPenalty ? { penalties } : {}),
  });
  return {
    elapsedMs: res.data.elapsedMs,
    grantedMs: res.data.grantedMs,
    creditedFreezeMs: res.data.creditedFreezeMs,
  };
}

// ── Register session ──────────────────────────────────────────────
// Called when ExamShell loads. Writes a unique sessionId to the attempt.
// Returns { conflict: true } if a DIFFERENT sessionId was already there.

/** Shared default — server twin is DEFAULT_QUESTION_GRACE_SECONDS. */
export const DEFAULT_QUESTION_GRACE_SECONDS = 5;

/** Verdict shape returned by the getExamVerdict callable (Phase 3c/3d). */
export type ExamVerdict =
  | { kind: 'not_started' }
  | { kind: 'ended'; reason: string }
  | { kind: 'break'; sectionId: string; nextSectionId: string; endsAt: number; mandatory: boolean }
  | { kind: 'choose'; remainingSectionIds: string[] }
  | { kind: 'section'; sectionId: string; started: boolean }
  | { kind: 'question'; sectionId: string; questionId: string; served: boolean };

/**
 * Ask the server where this student stands. (Master plan D1/D4.)
 *
 * The client detects the tick; the SERVER decides what it means. Until now the
 * shell reached its own verdict from its own copy of the rules, which is how
 * the client and server came to disagree about question grace (5s vs 0s) and
 * about what a section running out should do.
 *
 * JITTER (D-19). A cohort that started together hits section end together, so
 * every countdown reaching zero at the same instant would arrive here as one
 * synchronised burst — the same shape that makes gradeAttempt a scale risk.
 * A few hundred milliseconds of spread costs the student nothing (the verdict
 * is computed from server time, not arrival time) and turns a spike into a
 * slope. Deliberately NOT applied when the caller is already blocked waiting,
 * which is why the delay is opt-out.
 */
export async function getExamVerdict(
  attemptId: string,
  opts?: { jitter?: boolean }
): Promise<{ serverNow: number; verdict: ExamVerdict } | null> {
  if (opts?.jitter !== false) {
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 400)));
  }
  const call = httpsCallable<
    { attemptId: string; sessionId?: string; sebToken?: string },
    { ok: true; serverNow: number; verdict: ExamVerdict }
  >(functions, 'getExamVerdict');
  try {
    const res = await withSeb(async (sebToken) => (await call({
      attemptId,
      sebToken,
      ...(activeSessionId ? { sessionId: activeSessionId } : {}),
    })).data);
    return { serverNow: res.serverNow, verdict: res.verdict };
  } catch (e) {
    // Fail soft, same reasoning as registerSession: a verdict we cannot fetch
    // must never strand a student mid-exam. The caller falls back to its local
    // reading, which is what it used exclusively until this phase.
    console.warn('[submissionService] getExamVerdict failed', e);
    return null;
  }
}

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
  // 'frozen' counts as mid-break. A pause now sets status:'frozen' (F5), and a
  // paused student on a break is still on a break — the roster's "On break"
  // pill vanishing at exactly the moment an invigilator pauses them would hide
  // the state from the person who just changed it.
  if (attempt.status !== 'in_progress' && attempt.status !== 'frozen') return null;
  const cur = sections[attempt.currentSectionIdx];
  const next = sections[attempt.currentSectionIdx + 1];
  if (!cur || !next || !cur.breakAfter || cur.breakAfter.durationMinutes <= 0) return null;
  const curTiming = attempt.sectionTimings[cur.id];
  const nextTiming = attempt.sectionTimings[next.id];
  if (!curTiming?.submittedAt) return null;
  if (nextTiming?.startedAt) return null;
  // D-29: the break is a clock and it is credited, exactly as the resolver's
  // pendingBreak and the shell's own BreakScreen compute it. freezeCredits is
  // materialised by the server; nothing is derived here.
  const endsAt = new Date(curTiming.submittedAt).getTime()
    + cur.breakAfter.durationMinutes * 60 * 1000
    + (attempt.freezeCredits?.breakMs ?? 0);
  // While paused the countdown holds where it was, the same way SectionTimer
  // and BreakScreen pin their reference instant on frozenAt.
  const frozenMs = attempt.frozenAt ? Date.parse(attempt.frozenAt) : NaN;
  const refNow = Number.isFinite(frozenMs) ? Math.min(nowMs, frozenMs) : nowMs;
  const remainingMs = endsAt - refNow;
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
// ══════════════════════════════════════════════════════════════════
// CODING VERDICTS — staff only
// ══════════════════════════════════════════════════════════════════
//
// `attemptVerdicts` is the one collection a reviewer needs and a candidate may
// never see. firestore.rules allows webOwner, and institute/faculty scoped to
// their own institute; students are denied outright, because a verdict carries
// hidden-test output and even the bare pass/fail list reconstructs the suite
// by bisection.
//
// Until now NOTHING in the client read it. Every verdict the judge produced —
// compile diagnostics, which hidden test failed, why a run never completed —
// was written, stored, retained and shown to nobody. This is the reader.
//
// Doc ids are deterministic (`${attemptId}__${questionId}`, mirroring
// codeVerdictDocId in functions/src/index.ts), so this is a direct get per
// coding question rather than a query — no index, and no read cost on papers
// that have no coding questions at all.

/** Mirrors `codeVerdictDocId` in functions/src/index.ts — keep in EXACT sync. */
export function codeVerdictDocId(attemptId: string, questionId: string): string {
  return `${attemptId}__${questionId}`;
}

/**
 * Load the judge verdicts for one attempt's coding questions.
 *
 * A missing document is NOT an error and NOT a zero — it means the sweep has
 * not reached this submission yet. Callers get an absent map entry and are
 * expected to render the pending state rather than an empty verdict.
 *
 * Permission failures are swallowed per-document on purpose: a reviewer whose
 * scope does not cover this attempt should see the answer without the run
 * detail, not an error page where the answer used to be.
 */
export async function getCodeVerdicts(
  attemptId: string,
  questionIds: string[],
): Promise<Record<string, CodeVerdictDoc>> {
  if (questionIds.length === 0) return {};
  const out: Record<string, CodeVerdictDoc> = {};
  await Promise.all(questionIds.map(async (qid) => {
    try {
      const snap = await getDoc(doc(db, 'attemptVerdicts', codeVerdictDocId(attemptId, qid)));
      if (snap.exists()) out[qid] = snap.data() as CodeVerdictDoc;
    } catch {
      // Denied or offline — the answer still renders, without the run detail.
    }
  }));
  return out;
}

/**
 * Ask the platform to try judging a paper's stuck coding answers again.
 *
 * Staff only, and only for submissions that never produced a real verdict —
 * the server refuses to touch a `completed` or `compile_error` one, because
 * recomputing a mark a student may already have been shown is a re-grade
 * rather than a retry.
 *
 * Judges INLINE and returns the outcome, so the caller can say what happened
 * instead of "check back in five minutes". `settled: false` means at least one
 * submission still has no verdict — the runner is still unreachable.
 */
export async function rejudgeAttemptCoding(
  attemptId: string,
  questionId?: string,
): Promise<{ ok: true; rearmed: number; judged: number; settled: boolean }> {
  const call = httpsCallable<
    { attemptId: string; questionId?: string },
    { ok: true; rearmed: number; judged: number; settled: boolean }
  >(functions, 'rejudgeAttemptCoding');
  return (await call({ attemptId, ...(questionId ? { questionId } : {}) })).data;
}

// ══════════════════════════════════════════════════════════════════
// CODING TELEMETRY — staff only
// ══════════════════════════════════════════════════════════════════
//
// The record of HOW a candidate wrote their answer, withheld from students for
// a different reason than verdicts are: a verdict leaks the answer key, this
// is a keystroke-level recording of a person working under exam conditions.
// Staff of the owning institute may read it, because they are the only ones
// with cause to.
//
// Written as append-only chunks by recordCodeTelemetry — a growing document
// would hit the 1 MB ceiling and would let a later flush silently rewrite an
// earlier one, which matters for something that may end up being cited about
// a person. Chunk ids are `${attemptId}__${questionId}__NNNN`, zero-padded so
// they sort lexicographically in sequence order.
//
// THE QUERY SHAPE IS LOAD-BEARING. A documentId() range alone would be refused
// for institute and faculty callers: firestore.rules scopes reads by
// `resource.data.instituteId`, and Firestore rejects a query it cannot prove
// satisfies that for every document, whatever the documents happen to contain.
// Adding the instituteId equality makes it provable, and it is served by the
// automatic single-field index — single-field indexes are (value, __name__),
// which is exactly an equality plus a name range. No composite index, and one
// code path for every role rather than a branch on the caller's claims.

/**
 * Every telemetry chunk recorded for one coding answer, in sequence order.
 *
 * An empty array means nothing was recorded — practice tiers never record,
 * an institution may switch recording off at the proctored tiers, and a
 * candidate who never opened the question produced no events. None of those
 * is an error, and callers must not present them as one.
 */
export async function getCodeTelemetry(
  attemptId: string,
  questionId: string,
  instituteId: string | null,
): Promise<Array<{ seq: number; events: TelemetryEvent[] }>> {
  const prefix = `${attemptId}__${questionId}__`;
  const snap = await getDocs(query(
    collection(db, 'attemptTelemetry'),
    where('instituteId', '==', instituteId ?? null),
    where(documentId(), '>=', prefix),
    //  is the last character Firestore will sort, so this is "every id
    // beginning with the prefix" without needing to know how many chunks exist.
    where(documentId(), '<=', `${prefix}\uf8ff`),
  ));
  return snap.docs.map((d) => {
    const data = d.data() as { seq?: number; events?: TelemetryEvent[] };
    return { seq: typeof data.seq === 'number' ? data.seq : 0, events: data.events ?? [] };
  });
}
