/**
 * STRATUM Cloud Functions
 *
 * createAuthUser — admin-only callable that provisions a Firebase Auth user
 * and writes the matching profile document into the role's Firestore
 * collection.
 *
 * Caller authorisation:
 *   • Web Owner   → can create any role.
 *   • Institute   → can create faculty or student in own institute only.
 *   • Faculty     → can create student in own institute only.
 *   • Student     → cannot call this endpoint.
 *
 * Custom claims set on the new user:
 *   webOwner  → { role }
 *   institute → { role, instituteId: uid }
 *   faculty   → { role, instituteId, facultyId: uid }
 *   student   → { role, instituteId, studentId: uid }
 *
 * The doc id of the new profile document equals the Firebase Auth uid.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp();

type Role = 'webOwner' | 'institute' | 'faculty' | 'student';

const COLLECTION_BY_ROLE: Record<Role, string> = {
  webOwner: 'webowners',
  institute: 'institutes',
  faculty: 'faculty',
  student: 'students',
};

interface CreateAuthUserData {
  role: Role;
  password: string;
  profile: Record<string, unknown> & { email: string; name: string };
  // Required when role === 'faculty' | 'student'.
  // For role === 'institute' the new institute's id IS the uid; ignored.
  // For role === 'webOwner'  ignored.
  instituteId?: string;
}

function authorizeCaller(
  callerRole: Role | undefined,
  callerInstituteId: string | undefined,
  targetRole: Role,
  targetInstituteId: string | undefined
): void {
  if (callerRole === 'webOwner') return;

  if (callerRole === 'institute') {
    if (targetRole !== 'faculty' && targetRole !== 'student') {
      throw new HttpsError('permission-denied', 'Institute admins may only create faculty or students.');
    }
    if (!callerInstituteId || callerInstituteId !== targetInstituteId) {
      throw new HttpsError('permission-denied', 'instituteId must match caller.');
    }
    return;
  }

  if (callerRole === 'faculty') {
    if (targetRole !== 'student') {
      throw new HttpsError('permission-denied', 'Faculty may only create students.');
    }
    if (!callerInstituteId || callerInstituteId !== targetInstituteId) {
      throw new HttpsError('permission-denied', 'instituteId must match caller.');
    }
    return;
  }

  throw new HttpsError('permission-denied', 'Insufficient permissions.');
}

export const createAuthUser = onCall<CreateAuthUserData>(
  { region: 'us-central1' },
  async (request) => {
    // ── 1. AuthN
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign-in required.');
    }
    const callerRole         = request.auth.token.role         as Role   | undefined;
    const callerInstituteId  = request.auth.token.instituteId  as string | undefined;

    // ── 2. Validate input
    const { role, password, profile, instituteId: providedInstituteId } =
      request.data || ({} as CreateAuthUserData);

    if (!role || !COLLECTION_BY_ROLE[role]) {
      throw new HttpsError('invalid-argument', 'Invalid role.');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new HttpsError('invalid-argument', 'Password must be at least 8 characters.');
    }
    if (!profile?.email || !profile?.name) {
      throw new HttpsError('invalid-argument', 'Profile must include email and name.');
    }

    // For faculty / student, instituteId must be supplied explicitly.
    if ((role === 'faculty' || role === 'student') && !providedInstituteId) {
      throw new HttpsError('invalid-argument', 'instituteId is required for faculty / student creation.');
    }

    // ── 3. AuthZ
    const targetInstituteId =
      role === 'institute'
        ? undefined // resolved to uid after creation
        : role === 'webOwner'
          ? undefined
          : providedInstituteId;

    authorizeCaller(callerRole, callerInstituteId, role, targetInstituteId);

    const email = String(profile.email).toLowerCase().trim();

    // ── 4. Create Firebase Auth user
    const auth = getAuth();
    let uid: string;
    try {
      const userRecord = await auth.createUser({
        email,
        password,
        displayName: String(profile.name),
        emailVerified: false,
        disabled: false,
      });
      uid = userRecord.uid;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/email-already-exists') {
        throw new HttpsError('already-exists', 'An account with this email already exists.');
      }
      throw new HttpsError('internal', 'Failed to create auth user.', code);
    }

    // ── 5. Set custom claims
    const claims: Record<string, unknown> = { role };
    if (role === 'institute') {
      claims.instituteId = uid;
    } else if (role === 'faculty') {
      claims.instituteId = providedInstituteId;
      claims.facultyId   = uid;
    } else if (role === 'student') {
      claims.instituteId = providedInstituteId;
      claims.studentId   = uid;
    }
    await auth.setCustomUserClaims(uid, claims);

    // ── 6. Write profile doc (never store plaintext password)
    const db = getFirestore();
    const collection = COLLECTION_BY_ROLE[role];
    const { password: _ignored, ...profileSansPassword } = profile as Record<string, unknown>;

    const docData: Record<string, unknown> = {
      ...profileSansPassword,
      email,
      uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    // Stamp the canonical id field expected by the rest of the app.
    if (role === 'institute') {
      docData.id = uid;
    } else if (role === 'faculty' || role === 'student') {
      docData.id          = uid;
      docData.instituteId = providedInstituteId;
    }

    await db.collection(collection).doc(uid).set(docData);

    return { ok: true, uid };
  }
);

interface DeleteAuthUserData {
  role: Role;
  uid: string;
}

const CREDENTIALS_BY_ROLE: Partial<Record<Role, string>> = {
  institute: 'instituteCredentials',
  faculty: 'facultyCredentials',
  student: 'studentCredentials',
};

export const deleteAuthUser = onCall<DeleteAuthUserData>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const callerRole = request.auth.token.role as Role | undefined;
    const callerInstituteId = request.auth.token.instituteId as string | undefined;

    const { role, uid } = request.data || ({} as DeleteAuthUserData);
    if (!role || !COLLECTION_BY_ROLE[role]) throw new HttpsError('invalid-argument', 'Invalid role.');
    if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');

    const db = getFirestore();
    const profileRef = db.collection(COLLECTION_BY_ROLE[role]).doc(uid);
    const profileSnap = await profileRef.get();
    if (!profileSnap.exists) {
      throw new HttpsError('not-found', 'Profile document not found.');
    }
    const profile = profileSnap.data() as Record<string, unknown>;
    const targetInstituteId =
      role === 'institute' ? uid : (profile.instituteId as string | undefined);

    if (callerRole !== 'webOwner') {
      if (callerRole === 'institute') {
        if (role !== 'faculty' && role !== 'student') {
          throw new HttpsError('permission-denied', 'Institute admins may only delete faculty or students.');
        }
        if (!callerInstituteId || callerInstituteId !== targetInstituteId) {
          throw new HttpsError('permission-denied', 'instituteId must match caller.');
        }
      } else if (callerRole === 'faculty') {
        if (role !== 'student') {
          throw new HttpsError('permission-denied', 'Faculty may only delete students.');
        }
        if (!callerInstituteId || callerInstituteId !== targetInstituteId) {
          throw new HttpsError('permission-denied', 'instituteId must match caller.');
        }
      } else {
        throw new HttpsError('permission-denied', 'Insufficient permissions.');
      }
    }

    try {
      await getAuth().deleteUser(uid);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code !== 'auth/user-not-found') {
        console.error('Failed to delete auth user', uid, err);
        throw new HttpsError('internal', 'Failed to delete auth user.', code);
      }
    }

    await profileRef.delete();
    const credCol = CREDENTIALS_BY_ROLE[role];
    if (credCol) await db.collection(credCol).doc(uid).delete().catch(() => undefined);
    if (role === 'institute') {
      await db.collection('instituteLogos').doc(uid).delete().catch(() => undefined);
    }

    return { ok: true };
  }
);

// ═══════════════════════════════════════════════════════════════════
// gradeAttempt — server-side scoring
//
// Replaces the previous client-side calculateScores + submitAttempt /
// autoTerminate path. Reads answer-key fields from questionAnswers
// (which students cannot read directly), computes scores, and writes
// status + scores + per-question gradedAnswers back to the attempt doc.
//
// reason maps to status:
//   manual          → submitted
//   time_expired    → auto_submitted
//   window_closed   → auto_submitted
//   violation_limit → auto_submitted
//   terminated      → terminated  (also stamps integrityLog fields)
// ═══════════════════════════════════════════════════════════════════

type GradeReason =
  | 'manual'
  | 'time_expired'
  | 'window_closed'
  | 'violation_limit'
  | 'terminated';

interface GradeAttemptData {
  attemptId: string;
  reason: GradeReason;
  terminateReason?: string;
  lastSectionId?: string;
  lastSectionTimeUsed?: number;
}

type CorrectPair = { leftId: string; rightId: string };
type MCQOption   = { id: string; text: string };

interface QuestionDoc {
  id: string;
  engine: 'mcq' | 'text' | 'match';
  variant: string | null;
  options: MCQOption[];
}

interface QuestionAnswerDoc {
  id: string;
  correctIds: string[];
  correctPairs: CorrectPair[];
  modelAnswer: string;
}

interface AttemptAnswerDoc {
  type: 'mcq' | 'text' | 'match';
  value: string | string[] | Record<string, string>;
}

function scoreMCQMultiplier(
  q: QuestionDoc,
  ans: QuestionAnswerDoc,
  value: AttemptAnswerDoc['value'],
): { multiplier: number; isCorrect: boolean } {
  if (q.variant === 'single' || q.variant === 'truefalse' || q.variant === 'fillblank') {
    const selected = typeof value === 'string' ? value : '';
    const isCorrect = ans.correctIds.includes(selected);
    return { multiplier: isCorrect ? 1 : 0, isCorrect };
  }
  if (q.variant === 'multi') {
    const selected = Array.isArray(value) ? value : [];
    const correct = new Set(ans.correctIds);
    let hits = 0;
    let wrongs = 0;
    for (const id of selected) {
      if (correct.has(id)) hits++;
      else wrongs++;
    }
    const raw = correct.size > 0 ? (hits - wrongs) / correct.size : 0;
    const mult = Math.max(0, raw);
    return { multiplier: mult, isCorrect: mult === 1 };
  }
  return { multiplier: 0, isCorrect: false };
}

function scoreMatchMultiplier(
  ans: QuestionAnswerDoc,
  value: AttemptAnswerDoc['value'],
): { multiplier: number; isCorrect: boolean } {
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { multiplier: 0, isCorrect: false };
  }
  const m = value as Record<string, string>;
  if (ans.correctPairs.length === 0) return { multiplier: 0, isCorrect: false };
  let correct = 0;
  for (const pair of ans.correctPairs) {
    if (m[pair.leftId] === pair.rightId) correct++;
  }
  const mult = correct / ans.correctPairs.length;
  return { multiplier: mult, isCorrect: mult === 1 };
}

export const gradeAttempt = onCall<GradeAttemptData>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

    const callerRole        = request.auth.token.role        as Role   | undefined;
    const callerStudentId   = request.auth.token.studentId   as string | undefined;
    const callerInstituteId = request.auth.token.instituteId as string | undefined;

    const { attemptId, reason, terminateReason, lastSectionId, lastSectionTimeUsed } =
      request.data || ({} as GradeAttemptData);

    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');
    const validReasons: GradeReason[] = [
      'manual', 'time_expired', 'window_closed', 'violation_limit', 'terminated',
    ];
    if (!validReasons.includes(reason)) {
      throw new HttpsError('invalid-argument', 'Invalid reason.');
    }

    const db = getFirestore();

    const attemptRef = db.collection('attempts').doc(attemptId);
    const attemptSnap = await attemptRef.get();
    if (!attemptSnap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const attempt = attemptSnap.data() as {
      assessmentId: string;
      studentId: string;
      instituteId: string;
      status: string;
      answers: Record<string, AttemptAnswerDoc>;
    };

    // AuthZ — student owner OR grader in same institute OR web owner
    const isStudentOwner =
      callerRole === 'student' && callerStudentId === attempt.studentId;
    const isGrader =
      callerRole === 'webOwner'
      || ((callerRole === 'institute' || callerRole === 'faculty')
          && callerInstituteId === attempt.instituteId);
    if (!isStudentOwner && !isGrader) {
      throw new HttpsError('permission-denied', 'Not authorized to grade this attempt.');
    }

    // Idempotency — refuse to re-grade a non-in_progress attempt unless caller
    // is a grader (manual regrade) or this is a terminate flow.
    if (attempt.status !== 'in_progress' && !isGrader && reason !== 'terminated') {
      throw new HttpsError('failed-precondition', 'Attempt already finalised.');
    }

    const assessmentSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    if (!assessmentSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    const assessment = assessmentSnap.data() as {
      sections?: Array<{
        id: string;
        name: string;
        questions: Array<{ questionId: string; marks: number }>;
      }>;
      passingScore?: number;
    };
    const sections = assessment.sections ?? [];

    // Collect all question IDs referenced by the assessment
    const qIds = Array.from(new Set(
      sections.flatMap((s) => s.questions.map((q) => q.questionId))
    ));

    // Batch-load questions and answer docs (Firestore getAll caps at 500)
    const questionRefs = qIds.map((id) => db.collection('questions').doc(id));
    const answerRefs   = qIds.map((id) => db.collection('questionAnswers').doc(id));
    const [questionSnaps, answerSnaps] = await Promise.all([
      qIds.length > 0 ? db.getAll(...questionRefs) : Promise.resolve([]),
      qIds.length > 0 ? db.getAll(...answerRefs)   : Promise.resolve([]),
    ]);

    const questionMap = new Map<string, QuestionDoc>();
    questionSnaps.forEach((snap) => {
      if (snap.exists) {
        const d = snap.data() as QuestionDoc;
        questionMap.set(snap.id, d);
      }
    });
    const answerMap = new Map<string, QuestionAnswerDoc>();
    answerSnaps.forEach((snap) => {
      if (snap.exists) {
        const d = snap.data() as QuestionAnswerDoc;
        answerMap.set(snap.id, d);
      } else {
        // Backwards-compat: pre-migration questions still carry answers inline
        const q = questionMap.get(snap.id) as unknown as QuestionAnswerDoc & QuestionDoc;
        if (q) {
          answerMap.set(snap.id, {
            id: snap.id,
            correctIds:   (q as any).correctIds   ?? [],
            correctPairs: (q as any).correctPairs ?? [],
            modelAnswer:  (q as any).modelAnswer  ?? '',
          });
        }
      }
    });

    let totalAwarded   = 0;
    let totalAvailable = 0;
    let requiresManualReview = false;
    const bySection: Array<{
      sectionId: string;
      sectionName: string;
      totalQuestions: number;
      answeredQuestions: number;
      marksAwarded: number;
      marksAvailable: number;
    }> = [];

    const gradedAnswers: Record<string, {
      isCorrect: boolean | null;
      marksAwarded: number;
      correctIds?: string[];
      correctPairs?: CorrectPair[];
      modelAnswer?: string;
    }> = {};

    for (const sec of sections) {
      let sectionAwarded = 0;
      let sectionAvailable = 0;
      let answered = 0;

      for (const aq of sec.questions) {
        sectionAvailable += aq.marks;
        totalAvailable   += aq.marks;

        const q   = questionMap.get(aq.questionId);
        const ans = answerMap.get(aq.questionId);
        const studentAnswer = attempt.answers?.[aq.questionId];

        // Always expose correct-answer data so the results page can render it
        // without students ever being able to read questionAnswers directly.
        const exposed: typeof gradedAnswers[string] = {
          isCorrect: null,
          marksAwarded: 0,
        };
        if (q && ans) {
          if (q.engine === 'mcq')   exposed.correctIds   = ans.correctIds   ?? [];
          if (q.engine === 'match') exposed.correctPairs = ans.correctPairs ?? [];
          if (q.engine === 'text')  exposed.modelAnswer  = ans.modelAnswer  ?? '';
        }

        if (studentAnswer && q && ans) {
          answered++;
          if (q.engine === 'mcq') {
            const { multiplier, isCorrect } = scoreMCQMultiplier(q, ans, studentAnswer.value);
            const award = multiplier * aq.marks;
            sectionAwarded += award;
            totalAwarded   += award;
            exposed.marksAwarded = award;
            exposed.isCorrect    = isCorrect;
          } else if (q.engine === 'match') {
            const { multiplier, isCorrect } = scoreMatchMultiplier(ans, studentAnswer.value);
            const award = multiplier * aq.marks;
            sectionAwarded += award;
            totalAwarded   += award;
            exposed.marksAwarded = award;
            exposed.isCorrect    = isCorrect;
          } else {
            // text engine — needs human grading
            requiresManualReview = true;
          }
        }

        gradedAnswers[aq.questionId] = exposed;
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

    const percentage = totalAvailable > 0
      ? Math.round((totalAwarded / totalAvailable) * 100 * 10) / 10
      : 0;
    const passed = assessment.passingScore !== undefined
      ? percentage >= assessment.passingScore
      : true;

    const scores = {
      total: totalAwarded,
      available: totalAvailable,
      percentage,
      passed,
      bySection,
      requiresManualReview,
    };

    const nowIso = new Date().toISOString();
    const status =
      reason === 'manual'     ? 'submitted'
      : reason === 'terminated' ? 'terminated'
      : 'auto_submitted';

    const updates: Record<string, unknown> = {
      status,
      submittedAt: nowIso,
      updatedAt: nowIso,
      scores,
      gradedAnswers,
    };
    if (reason === 'terminated') {
      updates['integrityLog.autoTerminated'] = true;
      if (terminateReason) updates['integrityLog.terminatedReason'] = terminateReason;
    }
    if (lastSectionId && typeof lastSectionTimeUsed === 'number') {
      updates[`sectionTimings.${lastSectionId}.submittedAt`]     = nowIso;
      updates[`sectionTimings.${lastSectionId}.timeUsedSeconds`] = lastSectionTimeUsed;
    }

    await attemptRef.update(updates);

    return { ok: true, scores };
  }
);

// ══════════════════════════════════════════════════════════════════
// SERVER-AUTHORITATIVE TIME TRANSITIONS
// ══════════════════════════════════════════════════════════════════
// The exam clock must not be spoofable via the student's local system
// time. These callables own every time transition: exam start, section
// start, and section submit. `new Date()` inside a Cloud Function is the
// SERVER clock, and the schema already stores ISO strings, so we write
// `new Date().toISOString()` directly (no serverTimestamp() sentinel,
// which would break the client's `new Date(startedAt)` parsing).

const DEFAULT_SECTION_GRACE_SECONDS = 30;

interface AttemptSectionTiming {
  startedAt: string;
  submittedAt?: string;
  timeUsedSeconds: number;
}

// ── getServerTime ─────────────────────────────────────────────────
// Client calls this once on exam load to compute skew = serverNow -
// clientNow, so the countdown display stays accurate even if the local
// clock is later tampered with.
export const getServerTime = onCall(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    return { serverTime: Date.now() };
  },
);

interface StartExamData {
  assessmentId: string;
  sections: Array<{
    id: string;
    name: string;
    questions: Array<{ questionId: string; marks: number; order: number }>;
  }>;
  shuffleQuestions?: boolean;
  sectionStartOrder?: 'sequential' | 'random' | 'student_choice';
  cameraDeclined?: boolean;
}

// ── startExam ─────────────────────────────────────────────────────
// Server-authoritative attempt creation. Enforces the schedule window
// (startDate/endDate) and the attempt limit against the SERVER clock and
// the assessment doc (not client-supplied values), then writes the
// attempt with server-set timestamps. Idempotent: returns an existing
// in_progress/frozen attempt if one is present.
export const startExam = onCall<StartExamData>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role = request.auth.token.role as string | undefined;
    const studentId = request.auth.token.studentId as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    if (role !== 'student' || !studentId || !instituteId) {
      throw new HttpsError('permission-denied', 'Only students may start an exam.');
    }

    const { assessmentId, sections, shuffleQuestions, sectionStartOrder, cameraDeclined } =
      request.data || ({} as StartExamData);
    if (!assessmentId || !Array.isArray(sections) || sections.length === 0) {
      throw new HttpsError('invalid-argument', 'assessmentId and sections are required.');
    }

    const db = getFirestore();

    // Resolve the student's display name from their profile doc (the token's
    // name claim may be unset).
    const stuSnap = await db.collection('students').doc(studentId).get();
    const studentName = stuSnap.exists
      ? String((stuSnap.data() as { name?: string }).name ?? '')
      : '';

    // Read the assessment — schedule + limits are authoritative from here.
    const aSnap = await db.collection('assessments').doc(assessmentId).get();
    if (!aSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    const a = aSnap.data() as {
      status?: string;
      startDate?: string;
      endDate?: string;
      maxAttempts?: number;
      attemptOverrides?: Record<string, number>;
      blockedStudents?: string[];
      title?: string;
    };

    if (a.status === 'draft') {
      throw new HttpsError('failed-precondition', 'This assessment is not published.');
    }
    if (a.blockedStudents?.includes(studentId)) {
      throw new HttpsError('permission-denied', 'You are blocked from this exam.');
    }

    const serverNow = Date.now();
    if (a.startDate && serverNow < new Date(a.startDate).getTime()) {
      throw new HttpsError('failed-precondition', 'This exam has not opened yet.');
    }
    if (a.endDate && serverNow > new Date(a.endDate).getTime()) {
      throw new HttpsError('failed-precondition', 'This exam has closed.');
    }

    // Idempotency + attempt-limit — read attempts server-side (trusted).
    const attemptsSnap = await db.collection('attempts')
      .where('studentId', '==', studentId)
      .where('assessmentId', '==', assessmentId)
      .get();
    const attempts = attemptsSnap.docs.map((d) => d.data() as { status: string });
    const live = attemptsSnap.docs.find(
      (d) => (d.data() as { status: string }).status === 'in_progress'
        || (d.data() as { status: string }).status === 'frozen',
    );
    if (live) return { ok: true, attempt: live.data() };

    const effectiveMax = a.attemptOverrides?.[studentId] ?? a.maxAttempts ?? 1;
    const finished = attempts.filter(
      (t) => t.status === 'submitted' || t.status === 'auto_submitted' || t.status === 'terminated',
    ).length;
    if (finished >= effectiveMax) {
      throw new HttpsError('resource-exhausted', `ATTEMPT_LIMIT_EXCEEDED:${finished}:${effectiveMax}`);
    }

    // ── Build frozen state (mirrors legacy startAttempt) ──────────
    const nowIso = new Date().toISOString();
    let ordered = sections;
    if (sectionStartOrder === 'random' || sectionStartOrder === 'student_choice') {
      ordered = [...sections];
      for (let i = ordered.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
      }
    }
    const sectionIds = ordered.map((s) => s.id);

    const questionOrder: Record<string, string[]> = {};
    for (const sec of ordered) {
      const qids = [...sec.questions].sort((x, y) => x.order - y.order).map((q) => q.questionId);
      if (shuffleQuestions) {
        for (let i = qids.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [qids[i], qids[j]] = [qids[j], qids[i]];
        }
      }
      questionOrder[sec.id] = qids;
    }

    const sectionTimings: Record<string, AttemptSectionTiming> = {};
    const autoStartFirst = sectionStartOrder !== 'student_choice';
    ordered.forEach((sec, idx) => {
      sectionTimings[sec.id] = {
        startedAt: autoStartFirst && idx === 0 ? nowIso : '',
        timeUsedSeconds: 0,
      };
    });

    const id = `attempt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const attempt = {
      id,
      assessmentId,
      assessmentTitle: a.title ?? '',
      studentId,
      studentName,
      instituteId,
      status: 'in_progress' as const,
      startedAt: nowIso,
      currentSectionIdx: 0,
      sectionIds,
      sectionTimings,
      questionOrder,
      answers: {},
      integrityLog: {
        tabSwitches: 0, focusLosses: 0, fullscreenExits: 0, copyAttempts: 0,
        pasteAttempts: 0, rightClickAttempts: 0, multiPersonEvents: 0,
        faceAbsenceEvents: 0, devtoolsEvents: 0, keyboardBlockEvents: 0,
        extensionEvents: 0, totalViolations: 0, violations: [], autoTerminated: false,
      },
      cameraDeclined: cameraDeclined ?? false,
      totalFrozenSeconds: 0,
      serverAnchored: true, // marks this attempt as using server-owned timestamps
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await db.collection('attempts').doc(id).set(attempt);
    return { ok: true, attempt };
  },
);

interface StartSectionData {
  attemptId: string;
  sectionId: string;
  reorderedSectionIds?: string[]; // student_choice only — new play order
}

// ── startSection ──────────────────────────────────────────────────
// Server-set startedAt for the section the student is entering. Covers
// sequential advance, student_choice pick (with reordering), and post-
// break resume. Refuses to start a section whose preceding MANDATORY
// break has not yet elapsed.
export const startSection = onCall<StartSectionData>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role = request.auth.token.role as string | undefined;
    const studentId = request.auth.token.studentId as string | undefined;
    if (role !== 'student' || !studentId) {
      throw new HttpsError('permission-denied', 'Only students may start a section.');
    }
    const { attemptId, sectionId, reorderedSectionIds } = request.data || ({} as StartSectionData);
    if (!attemptId || !sectionId) {
      throw new HttpsError('invalid-argument', 'attemptId and sectionId are required.');
    }

    const db = getFirestore();
    const attemptRef = db.collection('attempts').doc(attemptId);
    const attemptSnap = await attemptRef.get();
    if (!attemptSnap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const attempt = attemptSnap.data() as {
      studentId: string;
      status: string;
      assessmentId: string;
      sectionIds: string[];
      sectionTimings: Record<string, AttemptSectionTiming>;
    };
    if (attempt.studentId !== studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    if (attempt.status !== 'in_progress') {
      throw new HttpsError('failed-precondition', 'Attempt is not in progress.');
    }
    if (attempt.sectionTimings[sectionId]?.startedAt) {
      throw new HttpsError('failed-precondition', 'Section already started.');
    }

    // Validate reorder (student_choice) is a permutation of the frozen ids.
    let sectionIds = attempt.sectionIds;
    if (reorderedSectionIds) {
      const same = reorderedSectionIds.length === sectionIds.length
        && [...reorderedSectionIds].sort().join('|') === [...sectionIds].sort().join('|');
      if (!same) throw new HttpsError('invalid-argument', 'Invalid section reorder.');
      sectionIds = reorderedSectionIds;
    }

    // Mandatory-break gate: find the section submitted immediately before this
    // one in play order; if it has a mandatory break that hasn't elapsed, deny.
    const idx = sectionIds.indexOf(sectionId);
    if (idx > 0) {
      const prevId = sectionIds[idx - 1];
      const prevTiming = attempt.sectionTimings[prevId];
      if (prevTiming?.submittedAt) {
        const aSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
        const a = aSnap.data() as {
          sections?: Array<{ id: string; breakAfter?: { durationMinutes: number; mandatory: boolean } }>;
        } | undefined;
        const prevSec = a?.sections?.find((s) => s.id === prevId);
        const brk = prevSec?.breakAfter;
        if (brk && brk.mandatory && brk.durationMinutes > 0) {
          const breakEndsAt = new Date(prevTiming.submittedAt).getTime() + brk.durationMinutes * 60_000;
          if (Date.now() < breakEndsAt) {
            throw new HttpsError('failed-precondition', 'Mandatory break has not ended yet.');
          }
        }
      }
    }

    const nowIso = new Date().toISOString();
    const updates: Record<string, unknown> = {
      currentSectionIdx: idx,
      [`sectionTimings.${sectionId}.startedAt`]: nowIso,
      [`sectionTimings.${sectionId}.timeUsedSeconds`]: 0,
      updatedAt: nowIso,
    };
    if (reorderedSectionIds) updates.sectionIds = sectionIds;
    await attemptRef.update(updates);
    return { ok: true, startedAt: nowIso, sectionIds };
  },
);

interface SubmitSectionData {
  attemptId: string;
  sectionId: string;
  nextSectionId?: string | null;
  nextSectionIdx?: number;
  pauseBeforeNext?: boolean;
}

// ── submitSection ─────────────────────────────────────────────────
// Server-authoritative section close. Rejects submits arriving past
// startedAt + timeLimit + grace (per-assessment sectionGraceSeconds,
// default 30 s). timeUsedSeconds is computed server-side. When advancing
// with no break/pick, starts the next section's timer atomically.
export const submitSection = onCall<SubmitSectionData>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role = request.auth.token.role as string | undefined;
    const studentId = request.auth.token.studentId as string | undefined;
    if (role !== 'student' || !studentId) {
      throw new HttpsError('permission-denied', 'Only students may submit a section.');
    }
    const { attemptId, sectionId, nextSectionId, nextSectionIdx, pauseBeforeNext } =
      request.data || ({} as SubmitSectionData);
    if (!attemptId || !sectionId) {
      throw new HttpsError('invalid-argument', 'attemptId and sectionId are required.');
    }

    const db = getFirestore();
    const attemptRef = db.collection('attempts').doc(attemptId);
    const attemptSnap = await attemptRef.get();
    if (!attemptSnap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const attempt = attemptSnap.data() as {
      studentId: string;
      status: string;
      assessmentId: string;
      sectionTimings: Record<string, AttemptSectionTiming>;
    };
    if (attempt.studentId !== studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    if (attempt.status !== 'in_progress') {
      throw new HttpsError('failed-precondition', 'Attempt is not in progress.');
    }

    const timing = attempt.sectionTimings[sectionId];
    if (!timing?.startedAt) {
      throw new HttpsError('failed-precondition', 'Section was never started.');
    }

    const aSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    if (!aSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    const a = aSnap.data() as {
      sectionGraceSeconds?: number;
      sections?: Array<{ id: string; timeLimit?: number }>;
    };

    const startedMs = new Date(timing.startedAt).getTime();
    const serverNow = Date.now();
    const timeUsedSeconds = Math.max(0, Math.floor((serverNow - startedMs) / 1000));

    const sec = a.sections?.find((s) => s.id === sectionId);
    const graceSec = a.sectionGraceSeconds ?? DEFAULT_SECTION_GRACE_SECONDS;
    if (sec?.timeLimit && sec.timeLimit > 0) {
      const deadlineMs = startedMs + sec.timeLimit * 60_000 + graceSec * 1000;
      if (serverNow > deadlineMs) {
        // Strict: close the section at its true deadline (no extra credit) and
        // signal the client the submit was late. The section is finalised
        // regardless so the student cannot get stuck or gain time.
        const clampedIso = new Date(deadlineMs).toISOString();
        const cappedUsed = Math.floor((deadlineMs - startedMs) / 1000);
        const lateUpdates: Record<string, unknown> = {
          [`sectionTimings.${sectionId}.submittedAt`]: clampedIso,
          [`sectionTimings.${sectionId}.timeUsedSeconds`]: cappedUsed,
          updatedAt: new Date().toISOString(),
        };
        if (nextSectionId && !pauseBeforeNext) {
          lateUpdates.currentSectionIdx = nextSectionIdx;
          lateUpdates[`sectionTimings.${nextSectionId}.startedAt`] = new Date().toISOString();
          lateUpdates[`sectionTimings.${nextSectionId}.timeUsedSeconds`] = 0;
        }
        await attemptRef.update(lateUpdates);
        throw new HttpsError('deadline-exceeded', 'SECTION_DEADLINE_EXCEEDED');
      }
    }

    const nowIso = new Date().toISOString();
    const updates: Record<string, unknown> = {
      [`sectionTimings.${sectionId}.submittedAt`]: nowIso,
      [`sectionTimings.${sectionId}.timeUsedSeconds`]: timeUsedSeconds,
      updatedAt: nowIso,
    };
    if (nextSectionId && !pauseBeforeNext) {
      updates.currentSectionIdx = nextSectionIdx;
      updates[`sectionTimings.${nextSectionId}.startedAt`] = nowIso;
      updates[`sectionTimings.${nextSectionId}.timeUsedSeconds`] = 0;
    }
    await attemptRef.update(updates);
    return { ok: true, timeUsedSeconds };
  },
);
