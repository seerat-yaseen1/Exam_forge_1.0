import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  getDocs,
  query,
  where,
  arrayUnion,
  increment,
  onSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';
import type { Assessment } from './assessmentService';
import type { Question } from './questionBankService';

// ══════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ══════════════════════════════════════════════════════════════════

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function now(): string {
  return new Date().toISOString();
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
  cameraDeclined?: boolean;
  effectiveMaxAttempts?: number;  // undefined = unlimited
}): Promise<Attempt> {
  // ── Idempotency guard ──────────────────────────────────────────
  const existing = await getAttemptByStudentAndAssessment(
    params.studentId,
    params.assessmentId
  );
  if (existing && existing.status === 'in_progress') return existing;

  // ── Max-attempts pre-flight ────────────────────────────────────
  if (params.effectiveMaxAttempts !== undefined) {
    const all = await getAllAttemptsByStudentAndAssessment(
      params.studentId,
      params.assessmentId
    );
    const finishedCount = all.filter(
      (a) =>
        a.status === 'submitted' ||
        a.status === 'auto_submitted' ||
        a.status === 'terminated'
    ).length;
    if (finishedCount >= params.effectiveMaxAttempts) {
      throw new Error(
        `ATTEMPT_LIMIT_EXCEEDED:${finishedCount}:${params.effectiveMaxAttempts}`
      );
    }
  }

  // ── Build frozen state ─────────────────────────────────────────

  const id = newId('attempt');
  const sectionIds = params.sections.map((s) => s.id);

  // Question order per section (optionally shuffled via Fisher-Yates)
  const questionOrder: Record<string, string[]> = {};
  for (const sec of params.sections) {
    let qids = [...sec.questions]
      .sort((a, b) => a.order - b.order)
      .map((q) => q.questionId);

    if (params.shuffleQuestions) {
      for (let i = qids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [qids[i], qids[j]] = [qids[j], qids[i]];
      }
    }
    questionOrder[sec.id] = qids;
  }

  // Section timings — first section starts immediately; others start when advanced to
  const sectionTimings: Record<string, SectionTiming> = {};
  params.sections.forEach((sec, idx) => {
    sectionTimings[sec.id] = {
      startedAt: idx === 0 ? now() : '',
      timeUsedSeconds: 0,
    };
  });

  // ── Construct document ─────────────────────────────────────────

  const attempt: Attempt = {
    id,
    assessmentId: params.assessmentId,
    assessmentTitle: params.assessmentTitle,
    studentId: params.studentId,
    studentName: params.studentName,
    instituteId: params.instituteId,
    status: 'in_progress',
    startedAt: now(),
    currentSectionIdx: 0,
    sectionIds,
    sectionTimings,
    questionOrder,
    answers: {},
    integrityLog: {
      tabSwitches: 0,
      focusLosses: 0,
      fullscreenExits: 0,
      copyAttempts: 0,
      pasteAttempts: 0,
      rightClickAttempts: 0,
      multiPersonEvents: 0,
      faceAbsenceEvents: 0,
      devtoolsEvents: 0,
      keyboardBlockEvents: 0,
      extensionEvents: 0,
      totalViolations: 0,
      violations: [],
      autoTerminated: false,
    },
    cameraDeclined: params.cameraDeclined ?? false,
    totalFrozenSeconds: 0,
    createdAt: now(),
    updatedAt: now(),
  };

  await setDoc(doc(db, 'attempts', id), removeUndefined(attempt));
  return attempt;
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

// ── Submit section ────────────────────────────────────────────────
// Marks the current section as done, records time used, advances
// currentSectionIdx, and starts the next section's timer.

export async function submitSection(params: {
  attemptId: string;
  sectionId: string;           // section being submitted
  nextSectionId: string | null; // null if this was the last section
  nextSectionIdx: number;       // new currentSectionIdx (ignored if no next section)
  timeUsedSeconds: number;
  pauseBeforeNext?: boolean;    // if true, do not advance / start next-section timer
                                // (used when a break is configured before next section)
}): Promise<void> {
  const { attemptId, sectionId, nextSectionId, nextSectionIdx, timeUsedSeconds, pauseBeforeNext } = params;

  const updates: Record<string, any> = {
    [`sectionTimings.${sectionId}.submittedAt`]: now(),
    [`sectionTimings.${sectionId}.timeUsedSeconds`]: timeUsedSeconds,
    updatedAt: now(),
  };

  if (nextSectionId && !pauseBeforeNext) {
    updates.currentSectionIdx = nextSectionIdx;
    updates[`sectionTimings.${nextSectionId}.startedAt`] = now();
  }

  await updateDoc(doc(db, 'attempts', attemptId), updates);
}

// ── End break and start next section ──────────────────────────────
// Called when a configured break elapses (or the student skips a
// non-mandatory break). Advances currentSectionIdx and starts the
// next section's timer.

export async function endBreak(params: {
  attemptId: string;
  nextSectionId: string;
  nextSectionIdx: number;
}): Promise<void> {
  await updateDoc(doc(db, 'attempts', params.attemptId), {
    currentSectionIdx: params.nextSectionIdx,
    [`sectionTimings.${params.nextSectionId}.startedAt`]: now(),
    updatedAt: now(),
  });
}

// ── Submit attempt (final) ────────────────────────────────────────
// Finalises the attempt. Optionally accepts pre-calculated scores
// (computed client-side by the ExamShell which has all questions loaded).

export async function submitAttempt(params: {
  attemptId: string;
  reason: 'manual' | 'time_expired' | 'violation_limit' | 'window_closed';
  scores?: AttemptScores;
  lastSectionId?: string;
  lastSectionTimeUsed?: number;
}): Promise<void> {
  const { attemptId, reason, scores, lastSectionId, lastSectionTimeUsed } = params;

  const status: AttemptStatus =
    reason === 'manual' ? 'submitted' : 'auto_submitted';

  const updates: Record<string, any> = {
    status,
    submittedAt: now(),
    updatedAt: now(),
  };

  if (scores) {
    updates.scores = scores;
  }

  // Mark the last section as submitted if passed in
  if (lastSectionId && lastSectionTimeUsed !== undefined) {
    updates[`sectionTimings.${lastSectionId}.submittedAt`] = now();
    updates[`sectionTimings.${lastSectionId}.timeUsedSeconds`] = lastSectionTimeUsed;
  }

  await updateDoc(doc(db, 'attempts', attemptId), updates);
}

// ── Auto-terminate ────────────────────────────────────────────────
// Force-submits with 'terminated' status after max violations reached.

export async function autoTerminate(
  attemptId: string,
  reason: string,
  scores?: AttemptScores,
): Promise<void> {
  const updates: Record<string, any> = {
    status: 'terminated' as AttemptStatus,
    submittedAt: now(),
    'integrityLog.autoTerminated': true,
    'integrityLog.terminatedReason': reason,
    updatedAt: now(),
  };
  if (scores) updates.scores = scores;
  await updateDoc(doc(db, 'attempts', attemptId), updates);
}

// ── Log violation ─────────────────────────────────────────────────
// Atomically appends to the violations log and increments counters.
// Returns the new totalViolations count (read from local increment —
// caller should track this locally to avoid an extra read).

export async function logViolation(
  attemptId: string,
  type: ViolationType,
  detail?: string,
  warningNumber?: number
): Promise<void> {
  const event: ViolationEvent = {
    type,
    timestamp: now(),
    ...(detail ? { detail } : {}),
    ...(warningNumber !== undefined ? { warningNumber } : {}),
  };

  const counterField = `integrityLog.${VIOLATION_COUNTER[type]}`;

  await updateDoc(doc(db, 'attempts', attemptId), {
    'integrityLog.violations': arrayUnion(event),
    [counterField]: increment(1),
    'integrityLog.totalViolations': increment(1),
    updatedAt: now(),
  });
}

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
// invalidates a question. Re-runs calculateScores on every finished
// attempt for the assessment using the (possibly updated) Question
// docs the caller supplies. If `invalidatedQuestionIds` is provided,
// those questions award full marks to every attempt that included them.
//
// Returns the number of attempts whose score field was rewritten.

export async function regradeAssessmentAttempts(params: {
  assessment: Assessment;
  questions: Question[];               // current Question docs (post-edit)
  invalidatedQuestionIds?: string[];   // award full marks for these
}): Promise<number> {
  const invalid = new Set(params.invalidatedQuestionIds ?? []);
  const allAttempts = await getAttemptsByAssessment(params.assessment.id);

  // Only regrade finished attempts (have a recorded score)
  const finished = allAttempts.filter(
    (a) => a.status === 'submitted' || a.status === 'auto_submitted' || a.status === 'terminated'
  );

  let updated = 0;
  for (const att of finished) {
    // Compute fresh scores for this attempt
    const fresh = calculateScores(att, params.assessment, params.questions);

    // Apply invalidation bonus: any invalidated question that exists in
    // this attempt's section list awards its full marks.
    if (invalid.size > 0) {
      let bonus = 0;
      for (const sec of params.assessment.sections ?? []) {
        for (const aq of sec.questions) {
          if (invalid.has(aq.questionId)) bonus += aq.marks;
        }
      }
      // Only credit each attempt with the bonus once (above already
      // includes 0 for invalidated questions because they failed scoring).
      fresh.total = Math.min(fresh.total + bonus, fresh.available);
      fresh.percentage = fresh.available > 0
        ? Math.round((fresh.total / fresh.available) * 100 * 10) / 10
        : 0;
      fresh.passed = params.assessment.passingScore !== undefined
        ? fresh.percentage >= params.assessment.passingScore
        : true;
    }

    await updateDoc(doc(db, 'attempts', att.id), {
      scores: fresh,
      updatedAt: now(),
    });
    updated++;
  }
  return updated;
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

export async function getAttemptsByAssessment(
  assessmentId: string
): Promise<Attempt[]> {
  const q = query(
    collection(db, 'attempts'),
    where('assessmentId', '==', assessmentId)
  );
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
// CLIENT-SIDE SCORE CALCULATION
// ══════════════════════════════════════════════════════════════════
// Called by ExamShell after submission, before calling submitAttempt.
// Requires the full Question[] objects (already loaded in ExamShell).

export function calculateScores(
  attempt: Attempt,
  assessment: Assessment,
  questions: Question[]
): AttemptScores {
  const questionMap = new Map<string, Question>(questions.map((q) => [q.id, q]));
  let requiresManualReview = false;
  let totalAwarded = 0;
  let totalAvailable = 0;

  const bySection: SectionScore[] = [];

  const sections = assessment.sections ?? [];

  for (const sec of sections) {
    let sectionAwarded = 0;
    let sectionAvailable = 0;
    let answered = 0;

    for (const aq of sec.questions) {
      sectionAvailable += aq.marks;
      totalAvailable += aq.marks;

      const studentAnswer = attempt.answers[aq.questionId];
      if (!studentAnswer) continue;
      answered++;

      const q = questionMap.get(aq.questionId);
      if (!q) continue;

      if (q.engine === 'mcq') {
        const marks = scoreMCQ(q, studentAnswer.value);
        sectionAwarded += marks * aq.marks;
        totalAwarded += marks * aq.marks;
      } else if (q.engine === 'match') {
        const marks = scoreMatch(q, studentAnswer.value);
        sectionAwarded += marks * aq.marks;
        totalAwarded += marks * aq.marks;
      } else {
        // text engine — needs manual review
        requiresManualReview = true;
      }
    }

    bySection.push({
      sectionId: sec.id,
      sectionName: sec.name,
      totalQuestions: sec.questions.length,
      answeredQuestions: answered,
      marksAwarded: sectionAwarded,
      marksAvailable: sectionAvailable,
    });
  }

  const percentage =
    totalAvailable > 0
      ? Math.round((totalAwarded / totalAvailable) * 100 * 10) / 10
      : 0;

  const passed =
    assessment.passingScore !== undefined
      ? percentage >= assessment.passingScore
      : true;

  return {
    total: totalAwarded,
    available: totalAvailable,
    percentage,
    passed,
    bySection,
    requiresManualReview,
  };
}

// ── MCQ scoring ───────────────────────────────────────────────────
// Returns a multiplier in [0, 1]:
// - single / truefalse / fillblank: 1 if exact match, else 0
// - multi: partial credit — (correct selections − wrong selections) / total correct
//          clamped to [0, 1]

function scoreMCQ(q: Question, value: AnswerValue): number {
  if (q.variant === 'single' || q.variant === 'truefalse' || q.variant === 'fillblank') {
    const selected = typeof value === 'string' ? value : '';
    return q.correctIds.includes(selected) ? 1 : 0;
  }

  if (q.variant === 'multi') {
    const selected = Array.isArray(value) ? value : [];
    const correct = new Set(q.correctIds);
    let hits = 0, wrongs = 0;
    for (const id of selected) {
      if (correct.has(id)) hits++;
      else wrongs++;
    }
    const raw = (hits - wrongs) / correct.size;
    return Math.max(0, raw);
  }

  return 0;
}

// ── Match scoring ─────────────────────────────────────────────────
// Returns a multiplier in [0, 1] based on how many pairs are correct.

function scoreMatch(q: Question, value: AnswerValue): number {
  if (typeof value !== 'object' || Array.isArray(value)) return 0;
  const studentMap = value as Record<string, string>;
  if (q.correctPairs.length === 0) return 0;

  let correct = 0;
  for (const pair of q.correctPairs) {
    if (studentMap[pair.leftId] === pair.rightId) correct++;
  }
  return correct / q.correctPairs.length;
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
  cb: (attempts: Attempt[]) => void
): Unsubscribe {
  const q = query(
    collection(db, 'attempts'),
    where('assessmentId', '==', assessmentId)
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => d.data() as Attempt));
  });
}