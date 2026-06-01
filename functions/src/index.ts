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
