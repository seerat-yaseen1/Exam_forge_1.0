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
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { defineSecret } from 'firebase-functions/params';

// Phase 3 — shared with Vercel's /api/seb-verify. Declared at module top so
// every callable that lists it in `secrets` can reference it (const, not hoisted).
const SEB_SIGNING_SECRET = defineSecret('SEB_SIGNING_SECRET');
import { initializeApp } from 'firebase-admin/app';
import {
  ANCESTOR_FIELD,
  AUDIT_DELTA_ID_CAP,
  COLLECTION_OF,
  chunk,
  resolveCore,
  typesBelow,
  type AllocNodeType,
  type CoreDescendant,
  type CoreInput,
  type CoreMapping,
  type CoreSelectedNode,
  type SubNodeType,
} from './allocationCore';
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

    // ── 3b. Faculty per-member gate (Audit 2026-07-17, N4) ────────
    // canCreateStudents was previously enforced only in the UI, which made
    // the institute admin's toggle decorative — any faculty account could
    // call this endpoint directly. The flag on the caller's own faculty doc
    // is now the server-side source of truth. Institute admins and the Web
    // Owner are not gated by it.
    if (callerRole === 'faculty') {
      const callerFacultyId = request.auth.token.facultyId as string | undefined;
      const facultySnap = callerFacultyId
        ? await getFirestore().collection('faculty').doc(callerFacultyId).get()
        : null;
      if (!facultySnap?.exists || facultySnap.get('canCreateStudents') !== true) {
        throw new HttpsError(
          'permission-denied',
          'Student creation is not enabled for your account. Ask your institute admin to enable it.',
        );
      }
    }

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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
    if (role === 'student') {
      // Cascade: academic-hierarchy mappings for a deleted student are pure
      // orphans — remove them so node rosters don't render ghosts. Attempts
      // and questionReports are DELIBERATELY kept: they are the institute's
      // exam records / audit trail.
      try {
        const mapSnap = await db.collection('academicMappings')
          .where('studentId', '==', uid).get();
        let batch = db.batch();
        let n = 0;
        for (const d of mapSnap.docs) {
          batch.delete(d.ref);
          if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
        }
        if (n > 0) await batch.commit();
      } catch (err) {
        console.error('deleteAuthUser: mapping cascade failed for', uid, err);
      }
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
  sebToken?: string;
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

// ══════════════════════════════════════════════════════════════════
// SHARED GRADING HELPERS — single source of truth for scoring.
// Used by gradeAttempt (finalise) AND regradeAttempts (post-fix regrade)
// so the two paths can never drift apart.
// ══════════════════════════════════════════════════════════════════

interface GradingAssessmentDoc {
  sections?: Array<{
    id: string;
    name: string;
    questions?: Array<{ questionId: string; marks: number }>;
    // Phase 2.5 Stage 3 — seconds per question (linear/adaptive); undefined = off
    questionTimeLimit?: number;
  }>;
  questions?: Array<{ questionId: string; marks: number }>;
  passingScore?: number;
  allowReview?: boolean;
}

type EffectiveSection = {
  id: string;
  name: string;
  questions: Array<{ questionId: string; marks: number }>;
  questionTimeLimit?: number;
};

// Effective sections — MUST mirror buildEffectiveSections in ExamShell.tsx
// exactly, or grading diverges from what the student saw.
//   Case 1: at least one section carries resolved questions → use those
//           sections (dropping empty ones).
//   Case 2: sections exist but none has questions (legacy / flat shape) →
//           distribute the flat assessment.questions list across the named
//           sections equally (Math.ceil chunks), same as the shell.
//   Case 3: no sections at all → one synthetic 'main_section' wrapping the
//           flat list (same id the shell uses, so bySection keys line up
//           with attempt.questionOrder).
function normalizeSections(assessment: GradingAssessmentDoc): EffectiveSection[] {
  const rawSections = assessment.sections ?? [];
  const hasResolved = rawSections.some((s) => (s.questions?.length ?? 0) > 0);
  if (hasResolved) {
    return rawSections
      .filter((s) => (s.questions?.length ?? 0) > 0)
      .map((s) => ({
        id: s.id,
        name: s.name,
        questions: s.questions!,
        questionTimeLimit: s.questionTimeLimit,
      }));
  }
  if ((assessment.questions?.length ?? 0) > 0) {
    const flat = assessment.questions!;
    if (rawSections.length > 0) {
      const perSection = Math.ceil(flat.length / rawSections.length);
      return rawSections
        .map((sec, i) => ({
          id: sec.id,
          name: sec.name,
          questions: flat.slice(i * perSection, (i + 1) * perSection),
          questionTimeLimit: sec.questionTimeLimit,
        }))
        .filter((s) => s.questions.length > 0);
    }
    return [{ id: 'main_section', name: 'Questions', questions: flat }];
  }
  return [];
}

// Batch-load question + answer docs, chunked at 300 refs per getAll call so
// very large papers can't blow a single BatchGetDocuments RPC. Pre-migration
// questions still carrying inline answer fields are honoured as a fallback.
async function loadQuestionAndAnswerMaps(
  db: FirebaseFirestore.Firestore,
  qIds: string[],
): Promise<{ questionMap: Map<string, QuestionDoc>; answerMap: Map<string, QuestionAnswerDoc> }> {
  const chunkedGetAll = async (col: string, ids: string[]) => {
    const out: FirebaseFirestore.DocumentSnapshot[] = [];
    for (let i = 0; i < ids.length; i += 300) {
      const refs = ids.slice(i, i + 300).map((id) => db.collection(col).doc(id));
      out.push(...await db.getAll(...refs));
    }
    return out;
  };
  const [questionSnaps, answerSnaps] = await Promise.all([
    chunkedGetAll('questions', qIds),
    chunkedGetAll('questionAnswers', qIds),
  ]);

  const questionMap = new Map<string, QuestionDoc>();
  questionSnaps.forEach((snap) => {
    if (snap.exists) {
      questionMap.set(snap.id, snap.data() as QuestionDoc);
    }
  });
  const answerMap = new Map<string, QuestionAnswerDoc>();
  answerSnaps.forEach((snap) => {
    if (snap.exists) {
      answerMap.set(snap.id, snap.data() as QuestionAnswerDoc);
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
  return { questionMap, answerMap };
}

interface GradedAnswerOut {
  isCorrect: boolean | null;
  marksAwarded: number;
  correctIds?: string[];
  correctPairs?: CorrectPair[];
  modelAnswer?: string;
}

interface ScoresOut {
  total: number;
  available: number;
  percentage: number;
  passed: boolean;
  bySection: Array<{
    sectionId: string;
    sectionName: string;
    totalQuestions: number;
    answeredQuestions: number;
    marksAwarded: number;
    marksAvailable: number;
  }>;
  requiresManualReview: boolean;
}

// Core scoring pass over one attempt's answers.
//   • Answer-key fields are exposed in gradedAnswers ONLY when the assessment
//     allows review — gradedAnswers is written into the attempt doc, which
//     the student can read directly, so unconditional exposure leaks the key
//     regardless of showResults/allowReview (and enables key-harvesting on
//     multi-attempt exams, since the paper is frozen at publish time).
//   • invalidatedQuestionIds (regrade flow): those questions award FULL marks
//     to every attempt, isCorrect stays null ("correctness" is undefined for
//     an invalidated question). This replaces the old client-side flat bonus
//     — same totals, but bySection now stays consistent with the total.
function scoreAttemptAnswers(params: {
  sections: EffectiveSection[];
  questionMap: Map<string, QuestionDoc>;
  answerMap: Map<string, QuestionAnswerDoc>;
  answers: Record<string, AttemptAnswerDoc> | undefined;
  passingScore: number | undefined;
  allowReview: boolean | undefined;
  invalidatedQuestionIds?: Set<string>;
}): { scores: ScoresOut; gradedAnswers: Record<string, GradedAnswerOut> } {
  const { sections, questionMap, answerMap, answers, passingScore, allowReview } = params;
  const invalidated = params.invalidatedQuestionIds ?? new Set<string>();

  let totalAwarded   = 0;
  let totalAvailable = 0;
  let requiresManualReview = false;
  const bySection: ScoresOut['bySection'] = [];
  const gradedAnswers: Record<string, GradedAnswerOut> = {};

  const exposeKeys = allowReview === true;

  for (const sec of sections) {
    let sectionAwarded = 0;
    let sectionAvailable = 0;
    let answered = 0;

    for (const aq of sec.questions) {
      sectionAvailable += aq.marks;
      totalAvailable   += aq.marks;

      const q   = questionMap.get(aq.questionId);
      const ans = answerMap.get(aq.questionId);
      const studentAnswer = answers?.[aq.questionId];

      const exposed: GradedAnswerOut = {
        isCorrect: null,
        marksAwarded: 0,
      };
      if (exposeKeys && q && ans) {
        if (q.engine === 'mcq')   exposed.correctIds   = ans.correctIds   ?? [];
        if (q.engine === 'match') exposed.correctPairs = ans.correctPairs ?? [];
        if (q.engine === 'text')  exposed.modelAnswer  = ans.modelAnswer  ?? '';
      }

      if (invalidated.has(aq.questionId)) {
        // Invalidated question — full marks for everyone, regardless of
        // whether it was answered (matches the old flat-bonus semantics).
        if (studentAnswer) answered++;
        sectionAwarded += aq.marks;
        totalAwarded   += aq.marks;
        exposed.marksAwarded = aq.marks;
        exposed.isCorrect    = null;
      } else if (studentAnswer && q && ans) {
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
  const passed = passingScore !== undefined
    ? percentage >= passingScore
    : true;

  return {
    scores: {
      total: totalAwarded,
      available: totalAvailable,
      percentage,
      passed,
      bySection,
      requiresManualReview,
    },
    gradedAnswers,
  };
}

export const gradeAttempt = onCall<GradeAttemptData>(
  { region: 'us-central1', secrets: [SEB_SIGNING_SECRET] },
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
      answers: Record<string, AttemptAnswerDoc & { answeredAt?: string }>;
      lastHeartbeatAt?: string | null;
      createdAt?: string;
      freezeState?: { frozen?: boolean } | null;
      securityConfig?: { tier?: string; requireSEB?: boolean } | null;
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

    // Phase 3 — SEB binds the EXAM-TAKER, not staff. A grader finalising or
    // re-grading an attempt works from a normal browser; requiring SEB of them
    // would make submitted high-stake attempts ungradeable.
    if (isStudentOwner) {
      assertSEB(request.data?.sebToken, request.auth.uid, attempt.securityConfig?.requireSEB, attempt.assessmentId);
    }

    // Idempotency — a non-grader may never re-finalise a finished attempt.
    // (Audit 2026-07-17, N9: the previous `reason !== 'terminated'` exception
    // let a student flip their own SUBMITTED attempt to 'terminated' with
    // attacker-chosen reason text. The exception existed for the race where
    // the shell's terminate call lands after an auto-submit already graded
    // the attempt — that race is now an idempotent no-op instead of a
    // status rewrite. Graders keep manual regrade rights.)
    if (attempt.status !== 'in_progress' && !isGrader) {
      if (reason === 'terminated') {
        return { ok: true, alreadyFinalized: true, status: attempt.status };
      }
      throw new HttpsError('failed-precondition', 'Attempt already finalised.');
    }

    const assessmentSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    if (!assessmentSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    const assessment = assessmentSnap.data() as GradingAssessmentDoc;

    const sections = normalizeSections(assessment);

    // Collect all question IDs referenced by the assessment
    const qIds = Array.from(new Set(
      sections.flatMap((s) => s.questions.map((q) => q.questionId))
    ));

    const { questionMap, answerMap } = await loadQuestionAndAnswerMaps(db, qIds);

    const { scores, gradedAnswers } = scoreAttemptAnswers({
      sections,
      questionMap,
      answerMap,
      answers: attempt.answers,
      passingScore: assessment.passingScore,
      allowReview: assessment.allowReview,
    });

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

    // ── Freeze flag (Phase 1c) ────────────────────────────────────
    // Record if this attempt was finalized while still frozen (unresolved
    // extension freeze). Detective flag for the reviewer — not blocking.
    if (attempt.freezeState?.frozen === true) {
      updates['integrityLog.finalizedWhileFrozen'] = true;
    }

    // ── Timing analytics (Phase 1b) ───────────────────────────────
    // Detective signal only — recorded for the reviewer, never auto-actioned.
    // Uses answeredAt (already stored per answer) + lastHeartbeatAt (Phase 1a).
    const answerTimes = Object.values(attempt.answers ?? {})
      .map((ans) => (ans.answeredAt ? Date.parse(ans.answeredAt) : NaN))
      .filter((t) => !isNaN(t))
      .sort((x, y) => x - y);
    const submitMs = Date.parse(nowIso);
    const totalAnswers = answerTimes.length;
    const burstLast30s = answerTimes.filter((t) => submitMs - t <= 30_000).length;
    let minGapSeconds: number | null = null;
    for (let i = 1; i < answerTimes.length; i++) {
      const gap = (answerTimes[i] - answerTimes[i - 1]) / 1000;
      if (minGapSeconds === null || gap < minGapSeconds) minGapSeconds = gap;
    }
    let heartbeatGaps = 0;
    let maxHeartbeatGapSeconds = 0;
    if (attempt.lastHeartbeatAt) {
      const gapToSubmit = (submitMs - Date.parse(attempt.lastHeartbeatAt)) / 1000;
      if (gapToSubmit > 60) {
        heartbeatGaps = 1;
        maxHeartbeatGapSeconds = Math.round(gapToSubmit);
      }
    }
    let anomalyScore = 0;
    if (totalAnswers > 0 && burstLast30s / totalAnswers > 0.5) anomalyScore += 40;
    if (minGapSeconds !== null && minGapSeconds < 1.5 && totalAnswers > 3) anomalyScore += 30;
    if (heartbeatGaps > 0) anomalyScore += 30;
    updates.timingAnalysis = {
      totalAnswers,
      burstLast30s,
      minGapSeconds,
      heartbeatGaps,
      maxHeartbeatGapSeconds,
      anomalyScore,
      computedAt: nowIso,
    };

    await attemptRef.update(updates);

    return { ok: true, scores };
  }
);

// ══════════════════════════════════════════════════════════════════
// regradeAttempts — server-side bulk regrade
//
// Replaces the client-side regradeAssessmentAttempts path. Runs after a
// reviewer fixes or invalidates a question: re-scores every FINISHED
// attempt of the assessment against the CURRENT answer keys, using the
// exact same scoring code as gradeAttempt (no client duplicate to drift).
//
// Reading answer keys moved server-side here is what allows the
// questionAnswers rules to be locked down to owners only.
//
// AuthZ: webOwner regrades everything; institute/faculty regrade only
// attempts in their own institute (attempts query is scoped by claim).
// Status, submittedAt, and integrity fields are preserved — only scores,
// gradedAnswers, and updatedAt change.
// ══════════════════════════════════════════════════════════════════

interface RegradeAttemptsData {
  assessmentId: string;
  invalidatedQuestionIds?: string[];
}

export const regradeAttempts = onCall<RegradeAttemptsData>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

    const callerRole        = request.auth.token.role        as Role   | undefined;
    const callerInstituteId = request.auth.token.instituteId as string | undefined;

    const isWebOwnerCaller = callerRole === 'webOwner';
    const isInstituteScoped =
      (callerRole === 'institute' || callerRole === 'faculty') && !!callerInstituteId;
    if (!isWebOwnerCaller && !isInstituteScoped) {
      throw new HttpsError('permission-denied', 'Only graders may regrade attempts.');
    }

    const { assessmentId, invalidatedQuestionIds } = request.data || ({} as RegradeAttemptsData);
    if (!assessmentId) throw new HttpsError('invalid-argument', 'assessmentId is required.');
    if (invalidatedQuestionIds !== undefined
        && (!Array.isArray(invalidatedQuestionIds)
            || invalidatedQuestionIds.some((id) => typeof id !== 'string'))) {
      throw new HttpsError('invalid-argument', 'invalidatedQuestionIds must be an array of strings.');
    }

    const db = getFirestore();

    const aSnap = await db.collection('assessments').doc(assessmentId).get();
    if (!aSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    const assessment = aSnap.data() as GradingAssessmentDoc;

    const sections = normalizeSections(assessment);
    const qIds = Array.from(new Set(
      sections.flatMap((s) => s.questions.map((q) => q.questionId))
    ));
    const { questionMap, answerMap } = await loadQuestionAndAnswerMaps(db, qIds);

    const invalidated = new Set(invalidatedQuestionIds ?? []);

    // Attempts to regrade — institute/faculty callers are hard-scoped to
    // their own institute regardless of what they ask for.
    let attemptsQuery: FirebaseFirestore.Query = db
      .collection('attempts')
      .where('assessmentId', '==', assessmentId);
    if (!isWebOwnerCaller) {
      attemptsQuery = attemptsQuery.where('instituteId', '==', callerInstituteId);
    }
    const attemptsSnap = await attemptsQuery.get();

    const FINISHED = new Set(['submitted', 'auto_submitted', 'terminated']);
    const nowIso = new Date().toISOString();

    let updated = 0;
    let batch = db.batch();
    let batchSize = 0;

    for (const docSnap of attemptsSnap.docs) {
      const att = docSnap.data() as {
        status?: string;
        isDeleted?: boolean;
        answers?: Record<string, AttemptAnswerDoc>;
      };
      if (!att.status || !FINISHED.has(att.status)) continue;
      if (att.isDeleted) continue;

      const { scores, gradedAnswers } = scoreAttemptAnswers({
        sections,
        questionMap,
        answerMap,
        answers: att.answers,
        passingScore: assessment.passingScore,
        allowReview: assessment.allowReview,
        invalidatedQuestionIds: invalidated,
      });

      batch.update(docSnap.ref, { scores, gradedAnswers, updatedAt: nowIso });
      updated++;
      batchSize++;
      if (batchSize >= 400) { // Firestore batch cap is 500 writes
        await batch.commit();
        batch = db.batch();
        batchSize = 0;
      }
    }
    if (batchSize > 0) await batch.commit();

    return { ok: true, updated };
  }
);

// ══════════════════════════════════════════════════════════════════
// getAnswerKeysForReview — scoped answer-key reads for graders
//
// With questionAnswers locked to owners in the Firestore rules, reviewer
// surfaces (report triage, attempt drill-in) can no longer read keys of
// questions they don't own — e.g. an institute reviewer judging an
// "answer is wrong" report on a webOwner-owned question. This callable is
// the ONLY sanctioned path for those reads, and it is assessment-scoped:
//
//   • caller must be webOwner, OR an institute/faculty grader for whom the
//     assessment is legitimately visible — they own it, or it is published
//     and assigned to their institute (type 'all' or instituteIds match) —
//     the exact mirror of the assessments read rule;
//   • only keys for questions that actually appear IN that assessment are
//     returned (requested ids are intersected with the paper), so this can
//     never be used to dump the bank at large;
//   • students are always denied.
// ══════════════════════════════════════════════════════════════════

interface GetAnswerKeysData {
  assessmentId: string;
  questionIds?: string[]; // optional subset; defaults to the whole paper
}

export const getAnswerKeysForReview = onCall<GetAnswerKeysData>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

    const callerRole        = request.auth.token.role        as Role   | undefined;
    const callerInstituteId = request.auth.token.instituteId as string | undefined;
    const callerFacultyId   = request.auth.token.facultyId   as string | undefined;

    if (callerRole !== 'webOwner' && callerRole !== 'institute' && callerRole !== 'faculty') {
      throw new HttpsError('permission-denied', 'Only graders may read answer keys.');
    }

    const { assessmentId, questionIds } = request.data || ({} as GetAnswerKeysData);
    if (!assessmentId) throw new HttpsError('invalid-argument', 'assessmentId is required.');
    if (questionIds !== undefined
        && (!Array.isArray(questionIds) || questionIds.some((id) => typeof id !== 'string'))) {
      throw new HttpsError('invalid-argument', 'questionIds must be an array of strings.');
    }

    const db = getFirestore();
    const aSnap = await db.collection('assessments').doc(assessmentId).get();
    if (!aSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    const assessment = aSnap.data() as GradingAssessmentDoc & {
      ownerType?: string;
      ownerId?: string;
      status?: string;
      assignedTo?: { type: string; instituteIds?: string[] };
    };

    if (callerRole !== 'webOwner') {
      const ownsIt =
        (callerRole === 'institute'
          && assessment.ownerType === 'institute'
          && assessment.ownerId === callerInstituteId)
        || (callerRole === 'faculty'
          && assessment.ownerType === 'faculty'
          && assessment.ownerId === callerFacultyId);
      const published = assessment.status === 'active' || assessment.status === 'closed';
      const target = assessment.assignedTo;
      const assignedToCaller = published && !!target
        && (target.type === 'all'
            || (target.type === 'institutes'
                && !!callerInstituteId
                && (target.instituteIds ?? []).includes(callerInstituteId)));
      if (!ownsIt && !assignedToCaller) {
        throw new HttpsError('permission-denied', 'This assessment is not visible to you.');
      }
    }

    // Intersect requested ids with the paper — never leak keys beyond it.
    const paperIds = new Set(
      normalizeSections(assessment).flatMap((s) => s.questions.map((q) => q.questionId))
    );
    const wanted = (questionIds && questionIds.length > 0)
      ? questionIds.filter((id) => paperIds.has(id))
      : Array.from(paperIds);

    const { answerMap } = await loadQuestionAndAnswerMaps(db, wanted);

    const keys: Record<string, { correctIds: string[]; correctPairs: CorrectPair[]; modelAnswer: string }> = {};
    for (const id of wanted) {
      const ans = answerMap.get(id);
      if (ans) {
        keys[id] = {
          correctIds:   ans.correctIds   ?? [],
          correctPairs: ans.correctPairs ?? [],
          modelAnswer:  ans.modelAnswer  ?? '',
        };
      }
    }
    return { ok: true, keys };
  }
);

// ══════════════════════════════════════════════════════════════════
// getExamQuestions — the ONLY path students receive question content
//
// The `questions` collection read rule denies students entirely: with
// direct reads, any signed-in student could fetch ANY question document
// by id from the browser console — the whole bank's stems and options,
// across every owner — since assessments (readable when published)
// expose the question ids. This callable closes that leak:
//
//   • students only, and only for assessments they can legitimately sit
//     (published + assigned to them / their institute / everyone) or have
//     already attempted (so results review keeps working after an exam
//     closes or is reassigned);
//   • field WHITELIST — never returns correctIds / correctPairs /
//     modelAnswer; `explanation` is included only in review mode, and
//     review mode requires a FINISHED attempt + allowReview on the
//     assessment (mirrors the results page's own gate);
//   • only questions inside that assessment's paper are ever returned.
//
// Side benefit: the exam shell previously issued one read per question
// (N roundtrips); this is a single call for the whole paper.
// ══════════════════════════════════════════════════════════════════

interface GetExamQuestionsData {
  assessmentId: string;
  sebToken?: string;
  mode?: 'exam' | 'review';
}

// ── Shared student-facing question sanitizer ──────────────────────
// Single source of truth for the field whitelist. Used by getExamQuestions
// AND submitAnswerAndAdvance (Phase 2.5) so the two can never drift and a
// leaky field can never reach a student through either path.
// Answer keys NEVER leave through these endpoints.
function sanitizeQuestionForStudent(q: Record<string, unknown>, includeExplanation: boolean) {
  return {
    id:          q.id,
    engine:      q.engine,
    variant:     q.variant ?? null,
    stem:        q.stem ?? '',
    stemImage:   q.stemImage ?? null,
    options:     Array.isArray(q.options) ? q.options : [],
    pairs:       Array.isArray(q.pairs)   ? q.pairs   : [],
    subject:     q.subject ?? '',
    topic:       q.topic ?? '',
    subjectId:   q.subjectId ?? null,
    topicId:     q.topicId ?? null,
    tags:        Array.isArray(q.tags) ? q.tags : [],
    difficulty:  q.difficulty ?? 'medium',
    explanation: includeExplanation ? (q.explanation ?? '') : '',
    correctIds:   [] as string[],
    correctPairs: [] as CorrectPair[],
    modelAnswer:  '',
    isDeleted:   false,
    createdAt:   q.createdAt ?? '',
    updatedAt:   q.updatedAt ?? '',
  };
}

export const getExamQuestions = onCall<GetExamQuestionsData>(
  { region: 'us-central1', secrets: [SEB_SIGNING_SECRET] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role        = request.auth.token.role        as string | undefined;
    const studentId   = request.auth.token.studentId   as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    if (role !== 'student' || !studentId || !instituteId) {
      throw new HttpsError('permission-denied', 'Only students may fetch exam questions here.');
    }

    const { assessmentId, mode } = request.data || ({} as GetExamQuestionsData);
    if (!assessmentId) throw new HttpsError('invalid-argument', 'assessmentId is required.');

    const db = getFirestore();
    const aSnap = await db.collection('assessments').doc(assessmentId).get();
    if (!aSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    const assessment = aSnap.data() as GradingAssessmentDoc & {
      status?: string;
      assignedTo?: { type: string; instituteIds?: string[]; studentIds?: string[] };
    };

    // AuthZ — assigned & published, OR the student already has an attempt
    // (covers review after close / unassignment; an attempt is proof they
    // legitimately sat the paper).
    //
    // Phase C / Audit 2026-07-17, N2 — mirror startExam's two-path gate:
    //   'rules' → the materialized assessmentMembers list is authoritative.
    //             resolveAllocation stamps allocationMode but does NOT clear
    //             the stale assignedTo left on the doc, so checking only
    //             assignedTo here leaked the full paper content of a
    //             rules-allocated exam (commonly assignedTo.type 'all') to
    //             every student on the platform while it was active.
    //   else    → legacy assignedTo gate, byte-for-byte unchanged.
    const published = assessment.status === 'active' || assessment.status === 'closed';
    let assigned: boolean;
    if ((assessment as { allocationMode?: string }).allocationMode === 'rules') {
      const memberSnap = await db.collection('assessmentMembers')
        .doc(`${assessmentId}_${studentId}`)
        .get();
      assigned = memberSnap.exists && memberSnap.get('active') === true;
    } else {
      const target = assessment.assignedTo;
      assigned = !target
        || target.type === 'all'
        || (target.type === 'institutes' && (target.instituteIds ?? []).includes(instituteId))
        || (target.type === 'students'   && (target.studentIds   ?? []).includes(studentId));
    }

    const attemptsSnap = await db.collection('attempts')
      .where('studentId', '==', studentId)
      .where('assessmentId', '==', assessmentId)
      .get();
    const hasAttempt = !attemptsSnap.empty;
    const hasFinishedAttempt = attemptsSnap.docs.some((d) => {
      const s = (d.data() as { status?: string }).status;
      return s === 'submitted' || s === 'auto_submitted' || s === 'terminated';
    });

    if (!(published && assigned) && !hasAttempt) {
      throw new HttpsError('permission-denied', 'This exam is not available to you.');
    }

    // Explanation only for post-exam review, and only when the assessment
    // permits review — same gate the results page applies client-side.
    const includeExplanation =
      mode === 'review'
      && hasFinishedAttempt
      && (assessment as { allowReview?: boolean }).allowReview === true;

    // ── Delivery-mode scoping (Phase 2.5) ─────────────────────────
    // In linear/adaptive the client must NEVER hold the paper. Only the
    // questions the server has actually served are returned. Standard mode is
    // unchanged (whole paper, one call). Legacy attempts (no securityConfig)
    // fall through to standard behaviour.
    const liveAttempt = attemptsSnap.docs
      .map((d) => d.data() as {
        status?: string;
        securityConfig?: { deliveryMode?: string; requireSEB?: boolean } | null;
        servedQuestions?: Array<{ questionId: string }>;
        createdAt?: string;
      })
      .sort((x, y) => (y.createdAt ?? '').localeCompare(x.createdAt ?? ''))[0];
    // Phase 3 — gate the LIVE exam fetch only. 'review' runs after submission,
    // when the student has quit SEB; requiring SEB there would make results
    // permanently unviewable.
    if (mode !== 'review' && liveAttempt?.status === 'in_progress') {
      assertSEB(request.data?.sebToken, request.auth.uid, liveAttempt?.securityConfig?.requireSEB, assessmentId);
    }

    const attemptDeliveryMode = liveAttempt?.securityConfig?.deliveryMode ?? 'standard';
    const isSequentialDelivery =
      attemptDeliveryMode === 'linear' || attemptDeliveryMode === 'adaptive';

    const qIds = isSequentialDelivery
      ? Array.from(new Set((liveAttempt?.servedQuestions ?? []).map((s) => s.questionId)))
      : Array.from(new Set(
          normalizeSections(assessment).flatMap((s) => s.questions.map((q) => q.questionId))
        ));

    const chunkedGetAll = async (ids: string[]) => {
      const out: FirebaseFirestore.DocumentSnapshot[] = [];
      for (let i = 0; i < ids.length; i += 300) {
        const refs = ids.slice(i, i + 300).map((id) => db.collection('questions').doc(id));
        out.push(...await db.getAll(...refs));
      }
      return out;
    };
    const snaps = await chunkedGetAll(qIds);

    // Field WHITELIST — anything not listed here never reaches a student,
    // including any leaky field added to question docs in the future.
    const questions = snaps
      .filter((s) => s.exists)
      .map((s) => s.data() as Record<string, unknown>)
      .filter((q) => q.isDeleted !== true)
      .map((q) => sanitizeQuestionForStudent(q, includeExplanation));

    return { ok: true, questions };
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

// ══════════════════════════════════════════════════════════════════
// PHASE 1 — Server-authoritative enforcement
// examHeartbeat / reportExtensionCheck / verifyAndResume
//
// These give the security tiers real teeth. The client DETECTS and
// REPORTS; the server DECIDES and RECORDS. None of these trust the
// browser. App Check enforcement is deferred to a dedicated hardening
// pass (Option 1) — added later across all callables at once.
// ══════════════════════════════════════════════════════════════════

// ── examHeartbeat ─────────────────────────────────────────────────
// Client pings every ~15s while an attempt is in progress. The server
// stamps lastHeartbeatAt. A gap (heartbeat→submit) is later flagged by
// gradeAttempt: a student who blocks Firestore to hide violations also
// stops heartbeating, so the gap becomes a server-visible signal.
interface HeartbeatData { attemptId: string;   sebToken?: string;
}

export const examHeartbeat = onCall<HeartbeatData>(
  { region: 'us-central1', secrets: [SEB_SIGNING_SECRET] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const callerStudentId = request.auth.token.studentId as string | undefined;
    const { attemptId, sebToken } = request.data || ({} as HeartbeatData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const a = snap.data() as {
      studentId: string; status: string; assessmentId: string;
      securityConfig?: { requireSEB?: boolean } | null;
    };
    // Phase 3 Stage 2b — the proof must hold for the WHOLE exam, not just the
    // door. A student who starts in SEB and switches to Chrome fails here
    // within the token's TTL, because Chrome cannot mint a new proof.
    assertSEB(sebToken, request.auth.uid, a.securityConfig?.requireSEB, a.assessmentId);
    if (a.studentId !== callerStudentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    if (a.status !== 'in_progress') {
      // Ignore heartbeats on finished/frozen attempts — not an error.
      return { ok: true, ignored: true };
    }
    await ref.update({ lastHeartbeatAt: new Date().toISOString() });
    return { ok: true };
  },
);

// ── reportExtensionCheck ──────────────────────────────────────────
// The client reports the result of an extension scan. The SERVER decides
// whether to freeze: if a check FAILS during an active attempt on a tier
// that requires the extension check, the attempt is frozen server-side
// and resume requires verification (see verifyAndResume).
interface ReportExtensionCheckData {
  attemptId: string;
  sebToken?: string;
  passed: boolean;
  found?: string[];
}

export const reportExtensionCheck = onCall<ReportExtensionCheckData>(
  { region: 'us-central1', secrets: [SEB_SIGNING_SECRET] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const callerStudentId = request.auth.token.studentId as string | undefined;
    const { attemptId, passed, found } = request.data || ({} as ReportExtensionCheckData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const a = snap.data() as {
      studentId: string;
      status: string;
      assessmentId: string;
      securityConfig?: { tier?: string; requireExtensionCheck?: boolean; requireSEB?: boolean } | null;
    };
    if (a.studentId !== callerStudentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }

    const nowIso = new Date().toISOString();
    const updates: Record<string, unknown> = {
      lastExtensionCheck: { at: nowIso, passed: !!passed, found: found ?? [] },
      updatedAt: nowIso,
    };

    assertSEB(request.data?.sebToken, request.auth.uid, a.securityConfig?.requireSEB, a.assessmentId);
    const tierRequiresCheck = a.securityConfig?.requireExtensionCheck === true;
    const shouldFreeze = !passed && a.status === 'in_progress' && tierRequiresCheck;
    if (shouldFreeze) {
      updates.freezeState = { frozen: true, reason: 'extension_detected', since: nowIso };
      updates.resumeRequiresVerification = true;
      updates.status = 'frozen';
    }
    await ref.update(updates);
    return { ok: true, frozen: shouldFreeze };
  },
);

// ── verifyAndResume ───────────────────────────────────────────────
// Clears an extension freeze and resumes the attempt, per the auto-resume
// policy. Student may self-resume ONLY if the tier is auto-resume AND the
// latest reported check passed. An invigilator (institute/faculty in the
// same institute, or webOwner) may always clear.
interface VerifyAndResumeData { attemptId: string; sebToken?: string; }

export const verifyAndResume = onCall<VerifyAndResumeData>(
  { region: 'us-central1', secrets: [SEB_SIGNING_SECRET] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const callerRole        = request.auth.token.role        as Role   | undefined;
    const callerStudentId   = request.auth.token.studentId   as string | undefined;
    const callerInstituteId = request.auth.token.instituteId as string | undefined;
    const { attemptId } = request.data || ({} as VerifyAndResumeData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const a = snap.data() as {
      studentId: string;
      instituteId: string;
      status: string;
      assessmentId: string;
      lastExtensionCheck?: { passed?: boolean } | null;
      securityConfig?: { autoResume?: boolean; requireSEB?: boolean } | null;
    };

    const isStudentOwner = callerRole === 'student' && callerStudentId === a.studentId;
    const isInvigilator =
      callerRole === 'webOwner'
      || ((callerRole === 'institute' || callerRole === 'faculty')
          && callerInstituteId === a.instituteId);
    if (!isStudentOwner && !isInvigilator) {
      throw new HttpsError('permission-denied', 'Not authorized.');
    }
    if (a.status !== 'frozen') {
      return { ok: true, resumed: false, note: 'not frozen' };
    }

    // Phase 3 — SEB applies to the EXAM-TAKER only. An invigilator clearing a
    // freeze does so from their own (normal) browser; requiring SEB of staff
    // would lock the student out of their exam permanently.
    if (isStudentOwner) {
      assertSEB(request.data?.sebToken, request.auth.uid, a.securityConfig?.requireSEB, a.assessmentId);
    }
    const autoResume   = a.securityConfig?.autoResume === true;
    const latestPassed = a.lastExtensionCheck?.passed === true;
    const mayResume = isInvigilator || (isStudentOwner && autoResume && latestPassed);
    if (!mayResume) {
      throw new HttpsError('failed-precondition',
        'RESUME_BLOCKED: verification not satisfied; an invigilator must clear this.');
    }

    const nowIso = new Date().toISOString();
    await ref.update({
      status: 'in_progress',
      freezeState: { frozen: false, clearedBy: isInvigilator ? 'invigilator' : 'auto', since: nowIso },
      resumeRequiresVerification: false,
      updatedAt: nowIso,
    });
    return { ok: true, resumed: true };
  },
);

// ══════════════════════════════════════════════════════════════════
// PHASE 2.5 — Sequential delivery (linear; adaptive shares this machinery)
//
// submitAnswerAndAdvance: the ONE atomic operation that makes linear real.
// Answering and advancing happen together, server-side:
//   validate → write answer → lock it → serve the next question
// The client never holds the paper (getExamQuestions is scoped to
// servedQuestions) and cannot answer a locked or unserved question.
// ══════════════════════════════════════════════════════════════════

interface SubmitAnswerAndAdvanceData {
  attemptId: string;
  sebToken?: string;
  questionId: string;
  // null = no answer (e.g. per-question timer expired). We deliberately do NOT
  // write a blank answer: an unanswered served question already scores 0, and
  // writing a null value would pollute the timing analytics with a fake
  // answeredAt. Skipping the write keeps grading unambiguous.
  answer: { type: string; value: unknown } | null;
}

export const submitAnswerAndAdvance = onCall<SubmitAnswerAndAdvanceData>(
  { region: 'us-central1', secrets: [SEB_SIGNING_SECRET] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role      = request.auth.token.role      as string | undefined;
    const studentId = request.auth.token.studentId as string | undefined;
    if (role !== 'student' || !studentId) {
      throw new HttpsError('permission-denied', 'Only students may answer.');
    }
    const { attemptId, questionId, answer, sebToken } = request.data || ({} as SubmitAnswerAndAdvanceData);
    if (!attemptId || !questionId) {
      throw new HttpsError('invalid-argument', 'attemptId and questionId are required.');
    }

    const db = getFirestore();
    const attemptRef = db.collection('attempts').doc(attemptId);
    const attemptSnap = await attemptRef.get();
    if (!attemptSnap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const attempt = attemptSnap.data() as {
      studentId: string;
      status: string;
      assessmentId: string;
      questionOrder?: Record<string, string[]>;
      servedQuestions?: Array<{
        questionId: string; sectionId: string; difficulty: string;
        servedAt: string; locked: boolean;
      }>;
      securityConfig?: { deliveryMode?: string; requireSEB?: boolean } | null;
    };

    if (attempt.studentId !== studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    if (attempt.status !== 'in_progress') {
      throw new HttpsError('failed-precondition', 'Attempt is not in progress.');
    }
    assertSEB(sebToken, request.auth.uid, attempt.securityConfig?.requireSEB, attempt.assessmentId);
    const dMode = attempt.securityConfig?.deliveryMode ?? 'standard';
    if (dMode !== 'linear' && dMode !== 'adaptive') {
      throw new HttpsError('failed-precondition',
        'This exam uses standard delivery; answers are saved directly.');
    }

    // The question being answered MUST be the current served, unlocked one.
    // This is what enforces strict-linear: a locked question can never be
    // revisited, and an unserved question is unknown to the client anyway.
    const served = attempt.servedQuestions ?? [];
    const current = served.length > 0 ? served[served.length - 1] : undefined;
    if (!current || current.questionId !== questionId || current.locked === true) {
      throw new HttpsError('failed-precondition',
        'QUESTION_LOCKED: you cannot answer this question.');
    }

    const nowIso = new Date().toISOString();

    // Per-question timing (authority toggle: section.questionTimeLimit in
    // seconds; undefined = off). A late answer is RECORDED and FLAGGED, never
    // rejected — a lag spike must not cost a student their work. The server's
    // servedAt is the only clock that counts.
    const aSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    const assessment = aSnap.exists ? (aSnap.data() as GradingAssessmentDoc) : undefined;
    const sectionsNorm = assessment ? normalizeSections(assessment) : [];
    const secDef = sectionsNorm.find((s) => s.id === current.sectionId);
    const qLimit = secDef?.questionTimeLimit;
    let lateAnswer = false;
    if (typeof qLimit === 'number' && qLimit > 0) {
      const elapsedSec = (Date.parse(nowIso) - Date.parse(current.servedAt)) / 1000;
      if (elapsedSec > qLimit + 5) lateAnswer = true; // 5s grace for latency
    }

    const updates: Record<string, unknown> = { updatedAt: nowIso };

    // Write the answer server-side (Admin SDK bypasses rules — and the rules
    // forbid the client from writing answers in sequential delivery).
    // Firestore rejects `undefined`, so a missing value is normalised to null.
    if (answer && typeof answer.type === 'string') {
      updates[`answers.${questionId}`] = {
        type: answer.type,
        value: answer.value === undefined ? null : answer.value,
        sectionId: current.sectionId,
        answeredAt: nowIso,
        ...(lateAnswer ? { lateAnswer: true } : {}),
      };
    }

    // Lock the answered question, then pick the next one in this section.
    const nextServed = served.map((s, i) =>
      i === served.length - 1 ? { ...s, locked: true } : s);

    const orderForSection = attempt.questionOrder?.[current.sectionId] ?? [];
    const servedIdsInSection = new Set(
      served.filter((s) => s.sectionId === current.sectionId).map((s) => s.questionId));
    const nextQid = orderForSection.find((qid) => !servedIdsInSection.has(qid));

    let nextQuestion: ReturnType<typeof sanitizeQuestionForStudent> | null = null;
    if (nextQid) {
      const qSnap = await db.collection('questions').doc(nextQid).get();
      if (qSnap.exists) {
        const qData = qSnap.data() as Record<string, unknown>;
        nextServed.push({
          questionId: nextQid,
          sectionId: current.sectionId,
          difficulty: (qData.difficulty as string) ?? 'medium',
          servedAt: nowIso,
          locked: false,
        });
        nextQuestion = sanitizeQuestionForStudent(qData, false);
      }
    }

    updates.servedQuestions = nextServed;
    await attemptRef.update(updates);

    return {
      ok: true,
      question: nextQuestion,          // null when the section is finished
      sectionComplete: !nextQid,
      lateAnswer,
    };
  },
);

// ══════════════════════════════════════════════════════════════════
// PHASE 3 — SEB DIAGNOSTIC (Stage 1; temporary, webOwner-only)
//
// Enforcement is NOT written yet, on purpose. Two things cannot be settled
// from documentation and, if guessed wrong, would reject every candidate:
//   1. Does SEB inject X-SafeExamBrowser-ConfigKeyHash into CROSS-ORIGIN XHR
//      (our callables live on cloudfunctions.net, the app on Vercel)?
//   2. What exact absolute URL does SEB use as the hash salt, and can we
//      reconstruct it byte-for-byte behind Cloud Run's proxy?
//
// SEB computes: SHA256(absoluteRequestURL + ConfigKey), URL first, fragment
// stripped, hex-encoded. A single character of URL drift changes the hash
// completely. So: run this once inside real SEB, read the truth, then write
// the verification against it.
//
// Returns every plausible URL reconstruction plus the raw SEB headers, and —
// if a candidate key is supplied — which reconstruction (if any) reproduces
// the received hash. That last part is what pins Stage 2.
// ══════════════════════════════════════════════════════════════════

interface SebDiagnosticsData {
  candidateConfigKey?: string; // optional: test a key against every URL form
}

export const sebDiagnostics = onCall<SebDiagnosticsData>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    if (request.auth.token.role !== 'webOwner') {
      throw new HttpsError('permission-denied', 'webOwner only.');
    }

    const req = request.rawRequest as unknown as {
      headers: Record<string, string | string[] | undefined>;
      originalUrl?: string;
      url?: string;
      method?: string;
    };
    const headers = req.headers ?? {};
    const hdr = (n: string): string | undefined => {
      const v = headers[n];
      return Array.isArray(v) ? v[0] : v;
    };

    // Every SEB header we received, verbatim.
    const sebHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase().startsWith('x-safeexambrowser')) {
        sebHeaders[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
      }
    }

    const host           = hdr('host');
    const xForwardedHost = hdr('x-forwarded-host');
    const proto          = hdr('x-forwarded-proto') ?? 'https';
    const path           = req.originalUrl ?? req.url ?? '';
    const origin         = hdr('origin');
    const referer        = hdr('referer');

    // Candidate absolute URLs SEB might have hashed.
    //
    // IMPORTANT (learned from the Chrome control run): Cloud Run strips the
    // function name from originalUrl — `path` arrives as "/" — so
    // `${host}${path}` reconstructs to ".../" and MISSES the function name.
    // The browser, however, requested ".../sebDiagnostics". So the reliable
    // reconstruction is `https://{host}/{functionName}`, which also
    // generalises to every other callable in Stage 2.
    const pathNoQuery = path.split('?')[0];
    const fnName = process.env.K_SERVICE ?? 'sebDiagnostics'; // Cloud Run service = function name
    const urlCandidates: Record<string, string> = {
      // The two that the control run proved are WRONG (kept to show the drift):
      host_full:            `${proto}://${host}${path}`,
      host_noQuery:         `${proto}://${host}${pathNoQuery}`,
      // The generalisable forms — these are what Stage 2 will use:
      host_fnName:          `${proto}://${host}/${fnName}`,
      host_fnName_httpsFixed: `https://${host}/${fnName}`,
      xfwdHost_fnName:      xForwardedHost ? `${proto}://${xForwardedHost}/${fnName}` : '',
      cloudfunctions_guess: `https://us-central1-${process.env.GCLOUD_PROJECT ?? ''}.cloudfunctions.net/${fnName}`,
      // Trailing-slash variant, in case SEB normalised it that way:
      host_fnName_slash:    `${proto}://${host}/${fnName}/`,
    };

    // If a candidate key was supplied, show which URL form reproduces the
    // received ConfigKeyHash. Whichever matches is the one Stage 2 must use.
    const received = (sebHeaders['x-safeexambrowser-configkeyhash']
      ?? sebHeaders['X-SafeExamBrowser-ConfigKeyHash'] ?? '').toLowerCase();
    const matches: Record<string, boolean> = {};
    if (request.data?.candidateConfigKey && received) {
      const key = request.data.candidateConfigKey.trim();
      for (const [name, url] of Object.entries(urlCandidates)) {
        if (!url) continue;
        const h = createHash('sha256').update(url + key, 'utf8').digest('hex');
        matches[name] = h.toLowerCase() === received;
      }
    }

    return {
      ok: true,
      sawAnySebHeader: Object.keys(sebHeaders).length > 0,
      sebHeaders,
      receivedConfigKeyHash: received || null,
      urlCandidates,
      matches,               // {} unless candidateConfigKey supplied
      raw: {
        host, xForwardedHost, proto, path, origin, referer, method: req.method,
        // Confirms how we derive the function name for URL reconstruction.
        K_SERVICE: process.env.K_SERVICE ?? null,
        GCLOUD_PROJECT: process.env.GCLOUD_PROJECT ?? null,
      },
      userAgent: hdr('user-agent') ?? null,
    };
  },
);

// ══════════════════════════════════════════════════════════════════
// PHASE 3 — SEB proof verification (Stage 2)
//
// The SEB header never reaches these functions: SEB injects its keys only on
// same-origin requests to the app's domain (measured, Stage 1). So the app
// calls /api/seb-verify on Vercel, which checks the ConfigKeyHash and mints a
// short-lived HMAC token bound to the AUTHENTICATED uid. We verify that token
// here.
//
// Token format: v1.<base64url(JSON{uid,exp,v})>.<hex hmac-sha256 of the b64 part>
// The signing secret is shared with Vercel and must match exactly.
//
// Short TTL is the point: a student who verifies in SEB and then switches to
// Chrome cannot mint a new token (Chrome sends no SEB header), so access dies
// within a minute or so.
// ══════════════════════════════════════════════════════════════════


function verifySebToken(token: string, uid: string, secret: string, assessmentId: string): void {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new HttpsError('permission-denied', 'SEB_REQUIRED: malformed proof.');
  }
  const [, b64, sig] = parts;

  const expected = createHmac('sha256', secret).update(b64).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpsError('permission-denied', 'SEB_REQUIRED: proof signature invalid.');
  }

  let body: { uid?: string; aid?: string; exp?: number };
  try {
    body = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    throw new HttpsError('permission-denied', 'SEB_REQUIRED: proof unreadable.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof body.exp !== 'number' || body.exp <= now) {
    throw new HttpsError('permission-denied', 'SEB_EXPIRED: re-verify Safe Exam Browser.');
  }
  // Binding to the caller is what stops one student in SEB minting proofs for
  // classmates sitting in Chrome.
  if (!body.uid || body.uid !== uid) {
    throw new HttpsError('permission-denied', 'SEB_REQUIRED: proof belongs to another user.');
  }
  // Stage 4: binding to the ASSESSMENT is what makes per-exam Config Keys
  // real — without it, a session verified under the platform config could be
  // replayed against an exam that demands its own config.
  // A token without aid is a stale mint from the pre-Stage-4 endpoint (≤90s
  // window during deploy): SEB_EXPIRED makes the client force-refresh, and the
  // fresh token carries aid. A token with the WRONG aid is a replay: rejected
  // outright.
  if (typeof body.aid !== 'string' || !body.aid) {
    throw new HttpsError('permission-denied', 'SEB_EXPIRED: re-verify Safe Exam Browser.');
  }
  if (body.aid !== assessmentId) {
    throw new HttpsError('permission-denied', 'SEB_REQUIRED: proof was issued for a different exam.');
  }
}

/**
 * No-op unless the attempt's frozen securityConfig requires SEB. Legacy and
 * mock/normal attempts are entirely unaffected.
 */
function assertSEB(
  sebToken: string | undefined,
  uid: string,
  requireSEB: boolean | undefined,
  assessmentId: string,
): void {
  if (requireSEB !== true) return;
  const secret = SEB_SIGNING_SECRET.value();
  if (!secret) {
    // Fail closed. A missing secret must never read as "SEB satisfied".
    throw new HttpsError('failed-precondition', 'SEB_NOT_CONFIGURED');
  }
  if (!sebToken) {
    throw new HttpsError('permission-denied', 'SEB_REQUIRED: this exam must be taken in Safe Exam Browser.');
  }
  verifySebToken(sebToken, uid, secret, assessmentId);
}

interface StartExamData {
  assessmentId: string;
  // Phase 3 — short-lived proof minted by /api/seb-verify on our own origin.
  sebToken?: string;
  sections: Array<{
    id: string;
    name: string;
    questions: Array<{ questionId: string; marks: number; order: number }>;
  }>;
  shuffleQuestions?: boolean;
  sectionStartOrder?: 'sequential' | 'random' | 'student_choice';
  cameraDeclined?: boolean;
  deviceClass?: 'desktop' | 'mobile' | 'tablet';
}

// ── startExam ─────────────────────────────────────────────────────
// Server-authoritative attempt creation. Enforces the schedule window
// (startDate/endDate) and the attempt limit against the SERVER clock and
// the assessment doc (not client-supplied values), then writes the
// attempt with server-set timestamps. Idempotent: returns an existing
// in_progress/frozen attempt if one is present.
export const startExam = onCall<StartExamData>(
  // Phase 3: the secret must be declared here or SEB_SIGNING_SECRET.value()
  // is empty at runtime and assertSEB would fail closed on every call.
  { region: 'us-central1', secrets: [SEB_SIGNING_SECRET] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role = request.auth.token.role as string | undefined;
    const studentId = request.auth.token.studentId as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    if (role !== 'student' || !studentId || !instituteId) {
      throw new HttpsError('permission-denied', 'Only students may start an exam.');
    }

    const { assessmentId, sections, shuffleQuestions, sectionStartOrder, cameraDeclined, sebToken } =
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
      assignedTo?: { type: string; instituteIds?: string[]; studentIds?: string[] };
      // Phase C — when 'rules', targeting is enforced by the materialized
      // assessmentMembers list instead of assignedTo (both paths coexist).
      allocationMode?: string;
      securityTier?: 'mock' | 'normal' | 'high_stake';
      deliveryMode?: 'standard' | 'linear' | 'adaptive';
      requireCamera?: boolean;
      allowMobile?: boolean;
      autoResume?: boolean;
      requireExtensionCheck?: boolean;
      requireSEB?: boolean;
      sebConfigKeys?: string[];
      securityLockedAt?: string;
    };

    // ── Effective security config, re-derived SERVER-SIDE (Phase 0) ──
    // Never trust client-supplied security values. Legacy docs (no
    // securityTier) behave exactly as today: no camera gate, no extension
    // gate, mobile left open. High-stake locks camera on / mobile off /
    // extension on regardless of stored overrides.
    const isLegacy = a.securityTier === undefined;
    const tier: 'mock' | 'normal' | 'high_stake' = a.securityTier ?? 'normal';
    const requireCamera = isLegacy
      ? false
      : tier === 'high_stake'
        ? true
        : (a.requireCamera ?? (tier === 'mock' ? false : true));
    const allowMobile = isLegacy
      ? true
      : tier === 'high_stake'
        ? false
        : (a.allowMobile ?? false);
    const requireExtensionCheck = isLegacy
      ? false
      : tier === 'high_stake'
        ? true
        : (a.requireExtensionCheck ?? true);
    // Phase 3 — SEB requirement, re-derived server-side (never trusted raw).
    // Legacy assessments (no tier) never require SEB. high_stake defaults to
    // true but may be disabled by the authority; other tiers are opt-in.
    const requireSEB = isLegacy
      ? false
      : (a.requireSEB ?? (tier === 'high_stake'));

    // Phase 3 gate. Uses the SERVER-derived requireSEB, never the client's
    // claim, and binds the proof to this caller's uid. Placed before any
    // attempt is created so a non-SEB student never gets an attempt document.
    assertSEB(sebToken, request.auth.uid, requireSEB, assessmentId);

    const effectiveAutoResume = isLegacy
      ? false
      : tier === 'high_stake'
        ? false
        : (a.autoResume ?? false);

    if (a.status === 'draft') {
      throw new HttpsError('failed-precondition', 'This assessment is not published.');
    }
    if (a.blockedStudents?.includes(studentId)) {
      throw new HttpsError('permission-denied', 'You are blocked from this exam.');
    }

    // ── Device policy gate (Phase 0) ──────────────────────────────
    // Runs before the idempotency check, so a resuming student re-passes it
    // (safe: same device on resume). allowMobile is re-derived server-side;
    // high-stake and any allowMobile=false exam refuses non-desktop.
    const deviceClass = request.data?.deviceClass ?? 'desktop';
    if (!allowMobile && deviceClass !== 'desktop') {
      throw new HttpsError(
        'failed-precondition',
        'DEVICE_NOT_ALLOWED: this exam must be taken on a desktop or laptop.',
      );
    }
    // ── Camera-required gate (Phase 0) ────────────────────────────
    if (requireCamera && cameraDeclined === true) {
      throw new HttpsError(
        'failed-precondition',
        'CAMERA_REQUIRED: this exam requires your camera to be enabled.',
      );
    }

    // Targeting gate — the client briefing filters targeting, but nothing
    // stopped a student from calling startExam directly with any active
    // assessment id. Enforce server-side.
    //
    // Phase C — two paths, chosen per-assessment by allocationMode:
    //   'rules' → the materialized assessmentMembers list is authoritative
    //             (O(1) doc-id lookup; the resolveAllocation / addManualMember
    //             callables are its only writers).
    //   else   → legacy assignedTo gate, byte-for-byte unchanged. Legacy docs
    //            without assignedTo are treated as webOwner-global ('all').
    // Enumeration hardening: a not-assigned student gets the SAME uniform
    // denial as not-found / not-open, so probing reveals nothing.
    let admittedAllocationVersion: number | null = null;
    let admittedAllocationSource: string | null = null;
    if (a.allocationMode === 'rules') {
      const memberSnap = await db.collection('assessmentMembers')
        .doc(`${assessmentId}_${studentId}`)
        .get();
      if (!memberSnap.exists || memberSnap.get('active') !== true) {
        throw new HttpsError('permission-denied', 'This exam is not assigned to you.');
      }
      admittedAllocationVersion = Number(memberSnap.get('admittedByVersion') ?? 0);
      admittedAllocationSource = String(memberSnap.get('source') ?? 'rules');
    } else {
      const target = a.assignedTo;
      if (target && target.type !== 'all') {
        const assigned =
          target.type === 'institutes'
            ? (target.instituteIds ?? []).includes(instituteId)
            : target.type === 'students'
              ? (target.studentIds ?? []).includes(studentId)
              : false;
        if (!assigned) {
          throw new HttpsError('permission-denied', 'This exam is not assigned to you.');
        }
      }
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

    // ── Freeze the security config on the FIRST attempt (Phase 0) ──
    // Idempotent: only writes if not already locked. Written via the Admin
    // SDK, which bypasses firestore.rules — so the function can always stamp
    // even though clients are forbidden from editing a locked doc's security
    // fields. Reached only after the idempotency return above, i.e. only when
    // a brand-new attempt is actually being created.
    if (!a.securityLockedAt) {
      await db.collection('assessments').doc(assessmentId)
        .set({ securityLockedAt: nowIso, updatedAt: nowIso }, { merge: true });
    }

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

    // ── Served-question sequence (Phase 0) ────────────────────────
    // Append-only source of truth for what the student was actually shown.
    // Standard mode writes the whole paper now (all unlocked = free nav);
    // linear/adaptive will append one at a time in Phase 2.5. Grading will
    // iterate this. Client-supplied sections carry no difficulty field, so
    // difficulty defaults to 'medium' (display metadata only, non-security).
    // ── Served-question sequence (Phase 0 shape; Phase 2.5 behaviour) ──
    // Append-only source of truth for what the student was actually shown.
    // standard  : the whole paper is written now (all unlocked = free nav).
    // linear    : ONLY the first question of the auto-started section. The rest
    //             are served one at a time by submitAnswerAndAdvance, so the
    //             client never holds the paper.
    // adaptive  : same as linear (ladder picks the next) — Phase 2.5 Stage 4.
    // Difficulty is display metadata; client-supplied sections carry none, so
    // it defaults to 'medium' here and is corrected when the server serves.
    const deliveryMode = a.deliveryMode ?? 'standard';
    const isSequential = deliveryMode === 'linear' || deliveryMode === 'adaptive';
    const servedQuestions: Array<{
      questionId: string;
      sectionId: string;
      difficulty: string;
      servedAt: string;
      locked: boolean;
    }> = [];
    if (isSequential) {
      // Only the first question of the section that auto-starts. If the student
      // chooses their own section order, nothing is served until startSection.
      const autoStarts = sectionStartOrder !== 'student_choice';
      const firstSec = ordered[0];
      const firstQid = firstSec ? questionOrder[firstSec.id]?.[0] : undefined;
      if (autoStarts && firstSec && firstQid) {
        servedQuestions.push({
          questionId: firstQid,
          sectionId: firstSec.id,
          difficulty: 'medium',
          servedAt: nowIso,
          locked: false,
        });
      }
    } else {
      for (const sec of ordered) {
        for (const qid of questionOrder[sec.id]) {
          servedQuestions.push({
            questionId: qid,
            sectionId: sec.id,
            difficulty: 'medium',
            servedAt: nowIso,
            locked: false,
          });
        }
      }
    }

    const sectionTimings: Record<string, AttemptSectionTiming> = {};
    const autoStartFirst = sectionStartOrder !== 'student_choice';
    ordered.forEach((sec, idx) => {
      sectionTimings[sec.id] = {
        startedAt: autoStartFirst && idx === 0 ? nowIso : '',
        timeUsedSeconds: 0,
      };
    });

    // Random component FIRST — monotonically increasing document IDs cluster
    // index writes and hotspot above ~500 creates/sec. Random prefix spreads
    // them. Timestamp kept (after) for human readability in the console.
    const id = `attempt_${Math.random().toString(36).slice(2, 9)}_${Date.now()}`;
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
      servedQuestions,
      answers: {},
      integrityLog: {
        tabSwitches: 0, focusLosses: 0, fullscreenExits: 0, copyAttempts: 0,
        pasteAttempts: 0, rightClickAttempts: 0, multiPersonEvents: 0,
        faceAbsenceEvents: 0, devtoolsEvents: 0, keyboardBlockEvents: 0,
        extensionEvents: 0, totalViolations: 0, violations: [], autoTerminated: false,
      },
      cameraDeclined: cameraDeclined ?? false,
      deviceClass,
      // Frozen security snapshot — the contract this student actually sits
      // under, independent of any later edit to the assessment (Phase 0).
      securityConfig: {
        tier,
        deliveryMode: a.deliveryMode ?? 'standard',
        requireCamera,
        requireExtensionCheck,
        allowMobile,
        autoResume: effectiveAutoResume,
        // Phase 3 — frozen with the rest of the contract, so toggling the
        // assessment mid-exam cannot change what this attempt must satisfy.
        requireSEB,
      },
      totalFrozenSeconds: 0,
      serverAnchored: true, // marks this attempt as using server-owned timestamps
      // Phase C — allocation provenance: which materialization admitted this
      // student, and whether via rules or a manual roster add. null on the
      // legacy assignedTo path. Answers "why could X sit this exam?" forever.
      allocationVersion: admittedAllocationVersion,
      allocationSource: admittedAllocationSource,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await db.collection('attempts').doc(id).set(attempt);
    return { ok: true, attempt };
  },
);

interface StartSectionData {
  attemptId: string;
  sebToken?: string;
  sectionId: string;
  reorderedSectionIds?: string[]; // student_choice only — new play order
}

// ── startSection ──────────────────────────────────────────────────
// Server-set startedAt for the section the student is entering. Covers
// sequential advance, student_choice pick (with reordering), and post-
// break resume. Refuses to start a section whose preceding MANDATORY
// break has not yet elapsed.
export const startSection = onCall<StartSectionData>(
  { region: 'us-central1', secrets: [SEB_SIGNING_SECRET] },
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
      // Phase 2.5 — needed to serve the section's first question in linear mode
      questionOrder?: Record<string, string[]>;
      servedQuestions?: Array<{
        questionId: string; sectionId: string; difficulty: string;
        servedAt: string; locked: boolean;
      }>;
      securityConfig?: { deliveryMode?: string; requireSEB?: boolean } | null;
    };
    if (attempt.studentId !== studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    assertSEB(request.data?.sebToken, request.auth.uid, attempt.securityConfig?.requireSEB, attempt.assessmentId);
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

    // ── Serve the section's first question (Phase 2.5, linear/adaptive) ──
    // In sequential delivery the client holds nothing until the server serves.
    // The question CONTENT is returned in the response — the client cannot
    // fetch it any other way (getExamQuestions is scoped to servedQuestions,
    // and it was already called before this section existed).
    // Idempotent: if a question from this section was already served (e.g. a
    // retried call), don't append a duplicate.
    const dMode = attempt.securityConfig?.deliveryMode ?? 'standard';
    let servedQuestion: ReturnType<typeof sanitizeQuestionForStudent> | null = null;
    if (dMode === 'linear' || dMode === 'adaptive') {
      const served = attempt.servedQuestions ?? [];
      const existingHere = served.find((s) => s.sectionId === sectionId);
      const firstQid = existingHere?.questionId ?? attempt.questionOrder?.[sectionId]?.[0];
      if (firstQid) {
        const qSnap = await db.collection('questions').doc(firstQid).get();
        if (qSnap.exists) {
          const qData = qSnap.data() as Record<string, unknown>;
          servedQuestion = sanitizeQuestionForStudent(qData, false);
          if (!existingHere) {
            updates.servedQuestions = [
              ...served,
              {
                questionId: firstQid,
                sectionId,
                difficulty: (qData.difficulty as string) ?? 'medium',
                servedAt: nowIso,
                locked: false,
              },
            ];
          }
        }
      }
    }

    if (reorderedSectionIds) updates.sectionIds = sectionIds;
    await attemptRef.update(updates);
    return { ok: true, startedAt: nowIso, sectionIds, question: servedQuestion };
  },
);

interface SubmitSectionData {
  attemptId: string;
  sectionId: string;
  nextSectionId?: string | null;
  nextSectionIdx?: number;
  pauseBeforeNext?: boolean;
  sebToken?: string;
}

// ── submitSection ─────────────────────────────────────────────────
// Server-authoritative section close. Rejects submits arriving past
// startedAt + timeLimit + grace (per-assessment sectionGraceSeconds,
// default 30 s). timeUsedSeconds is computed server-side. When advancing
// with no break/pick, starts the next section's timer atomically.
export const submitSection = onCall<SubmitSectionData>(
  { region: 'us-central1', secrets: [SEB_SIGNING_SECRET] },
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
      // Phase 2.5 — serve the next section's first question on advance
      questionOrder?: Record<string, string[]>;
      servedQuestions?: Array<{
        questionId: string; sectionId: string; difficulty: string;
        servedAt: string; locked: boolean;
      }>;
      securityConfig?: { deliveryMode?: string; requireSEB?: boolean } | null;
    };
    if (attempt.studentId !== studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    if (attempt.status !== 'in_progress') {
      throw new HttpsError('failed-precondition', 'Attempt is not in progress.');
    }
    assertSEB(request.data?.sebToken, request.auth.uid, attempt.securityConfig?.requireSEB, attempt.assessmentId);

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
    let nextQuestion: ReturnType<typeof sanitizeQuestionForStudent> | null = null;
    if (nextSectionId && !pauseBeforeNext) {
      updates.currentSectionIdx = nextSectionIdx;
      updates[`sectionTimings.${nextSectionId}.startedAt`] = nowIso;
      updates[`sectionTimings.${nextSectionId}.timeUsedSeconds`] = 0;

      // ── Serve the next section's first question (Phase 2.5) ──────
      // This is the no-break advance path: the client goes straight from one
      // section to the next without startSection, so the question must be
      // served (and its CONTENT returned) here — the client has no other way
      // to obtain it, since getExamQuestions is scoped to servedQuestions.
      const dMode = attempt.securityConfig?.deliveryMode ?? 'standard';
      if (dMode === 'linear' || dMode === 'adaptive') {
        const served = attempt.servedQuestions ?? [];
        const existingHere = served.find((s) => s.sectionId === nextSectionId);
        const firstQid = existingHere?.questionId ?? attempt.questionOrder?.[nextSectionId]?.[0];
        if (firstQid) {
          const qSnap = await db.collection('questions').doc(firstQid).get();
          if (qSnap.exists) {
            const qData = qSnap.data() as Record<string, unknown>;
            nextQuestion = sanitizeQuestionForStudent(qData, false);
            if (!existingHere) {
              updates.servedQuestions = [
                ...served,
                {
                  questionId: firstQid,
                  sectionId: nextSectionId,
                  difficulty: (qData.difficulty as string) ?? 'medium',
                  servedAt: nowIso,
                  locked: false,
                },
              ];
            }
          }
        }
      }
    }
    await attemptRef.update(updates);
    return { ok: true, timeUsedSeconds, question: nextQuestion };
  },
);
// ═══════════════════════════════════════════════════════════════════════════
// ALLOCATION SYSTEM — Phase B (plans/ALLOCATION_SYSTEM_PLAN.md)
//
// Three callables, webOwner-only in v1:
//   resolveAllocation      — dry-run preview AND transactional commit; ONE
//                            code path (invariant 3), version-preconditioned
//                            (the concurrent-admins race, handled here once).
//   addManualMember        — the roster "Add student" flow; idempotent.
//   getAllocationPreviewPage — paged member reads with student-name join.
//
// Writers: these functions are the ONLY writers of allocations/,
// assessmentMembers/, allocationAudit/ and assessments.allocationMode —
// firestore.rules denies every client write to all four (invariant 9).
// Pure resolution semantics live in ./allocationCore (swept headlessly).
// ═══════════════════════════════════════════════════════════════════════════

const ALLOC_TXN_MEMBER_WRITE_CAP = 380; // headroom under the 500-op transaction limit

function requireWebOwner(request: { auth?: { token?: Record<string, unknown> } | null }): void {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
  if ((request.auth.token as { role?: string } | undefined)?.role !== 'webOwner') {
    throw new HttpsError('permission-denied', 'Only the Web Owner may manage allocation.');
  }
}

/** Fetch selected node docs + expansion inputs and hand them to the pure core. */
async function fetchCoreInput(
  db: FirebaseFirestore.Firestore,
  assessmentId: string,
  nodeType: AllocNodeType,
  nodeIds: string[],
): Promise<{ core: CoreInput; selectedDocs: Map<string, FirebaseFirestore.DocumentData> }> {
  const selectedDocs = new Map<string, FirebaseFirestore.DocumentData>();
  const selected: CoreSelectedNode[] = [];

  const col = nodeType === 'institute' ? 'institutes' : COLLECTION_OF[nodeType as SubNodeType];
  const refs = nodeIds.map((id) => db.collection(col).doc(id));
  const snaps = refs.length > 0 ? await db.getAll(...refs) : [];
  snaps.forEach((snap) => {
    if (!snap.exists) return;
    const d = snap.data() as Record<string, unknown>;
    selectedDocs.set(snap.id, d);
    selected.push({
      id: snap.id,
      name: String(d.name ?? snap.id),
      // Institutes carry no status field — treat them as active.
      status: nodeType === 'institute' ? 'active' : String(d.status ?? 'active'),
      instituteId: nodeType === 'institute' ? snap.id : String(d.instituteId ?? ''),
    });
  });

  const descendants: CoreDescendant[] = [];
  const mappings: CoreMapping[] = [];
  let instituteStudents: { id: string; instituteId: string }[] | undefined;

  if (nodeType === 'institute') {
    instituteStudents = [];
    for (const instId of nodeIds) {
      const stuSnap = await db.collection('students').where('instituteId', '==', instId).get();
      stuSnap.docs.forEach((doc) => instituteStudents!.push({ id: doc.id, instituteId: instId }));
    }
  } else if (nodeType === 'course') {
    // B-2: course left the spine. A course is an OFFERING that resolves SIDEWAYS
    // to the section(s) it's attached to, then normally down to students:
    //   section-level course (has sectionId) → that one section
    //   whole-semester course (semesterId set) → all sections of that semester
    //   whole-year course (semesterId null)   → all sections directly under the year
    // We treat those resolved sections as the descendants, plus their groups.
    const sectionIds = new Set<string>();
    for (const [, d] of selectedDocs) {
      const secId = d.sectionId as string | undefined;
      const semId = d.semesterId as string | null | undefined;
      const yrId = d.yearId as string | undefined;
      if (secId) {
        sectionIds.add(secId);
      } else if (semId) {
        const secs = await db.collection('sections').where('semesterId', '==', semId).get();
        secs.docs.forEach((s) => sectionIds.add(s.id));
      } else if (yrId) {
        const secs = await db.collection('sections').where('yearId', '==', yrId).get();
        secs.docs.forEach((s) => { if (s.get('semesterId') == null) sectionIds.add(s.id); });
      }
    }
    // The resolved sections + their groups become the descendants, each
    // attributed to the selected course that reaches it (via-attribution credits
    // the course). A student under multiple selected courses dedupes in the core.
    const sectionDocs = sectionIds.size > 0
      ? await db.getAll(...[...sectionIds].map((sid) => db.collection('sections').doc(sid)))
      : [];
    const activeSectionIds: string[] = [];
    sectionDocs.forEach((s) => {
      if (!s.exists) return;
      const active = String(s.get('status') ?? 'active') === 'active';
      // Attribute this section to the course(s) that reach it.
      let owner = '';
      for (const [cid, d] of selectedDocs) {
        const secId = d.sectionId as string | undefined;
        const semId = d.semesterId as string | null | undefined;
        const yrId = d.yearId as string | undefined;
        if (secId === s.id) { owner = cid; break; }
        if (!secId && semId && s.get('semesterId') === semId) { owner = cid; break; }
        if (!secId && !semId && yrId && s.get('yearId') === yrId && s.get('semesterId') == null) { owner = cid; break; }
      }
      descendants.push({ id: s.id, status: active ? 'active' : 'archived', parentSelectedId: owner || nodeIds[0] });
      if (active) activeSectionIds.push(s.id);
    });
    // Groups under those sections.
    for (const ids of chunk(activeSectionIds)) {
      const gsnap = await db.collection('groups').where('sectionId', 'in', ids).get();
      gsnap.docs.forEach((g) => {
        const active = String(g.get('status') ?? 'active') === 'active';
        descendants.push({ id: g.id, status: active ? 'active' : 'archived', parentSelectedId: g.get('sectionId') as string });
      });
    }
    // Mappings at the resolved sections + groups (the course node itself holds
    // no direct student mappings in the new model).
    const activeDescIds = descendants.filter((d) => d.status === 'active').map((d) => d.id);
    for (const ids of chunk(activeDescIds)) {
      if (ids.length === 0) continue;
      const snap = await db.collection('academicMappings').where('nodeId', 'in', ids).get();
      snap.docs.forEach((doc) => {
        const d = doc.data() as Record<string, unknown>;
        mappings.push({
          studentId: String(d.studentId ?? ''),
          nodeId: String(d.nodeId ?? ''),
          instituteId: String(d.instituteId ?? ''),
        });
      });
    }
  } else {
    // Expansion: every collection BELOW nodeType, keyed by our ancestor field.
    const field = ANCESTOR_FIELD[nodeType as SubNodeType];
    for (const belowType of typesBelow(nodeType)) {
      for (const ids of chunk(nodeIds)) {
        const snap = await db.collection(COLLECTION_OF[belowType]).where(field, 'in', ids).get();
        snap.docs.forEach((doc) => {
          const d = doc.data() as Record<string, unknown>;
          descendants.push({
            id: doc.id,
            status: String(d.status ?? 'active'),
            parentSelectedId: String(d[field] ?? ''),
          });
        });
      }
    }
    const activeDescIds = descendants.filter((d) => d.status === 'active').map((d) => d.id);
    const allMappingNodeIds = [...nodeIds, ...activeDescIds];
    for (const ids of chunk(allMappingNodeIds)) {
      const snap = await db.collection('academicMappings').where('nodeId', 'in', ids).get();
      snap.docs.forEach((doc) => {
        const d = doc.data() as Record<string, unknown>;
        mappings.push({
          studentId: String(d.studentId ?? ''),
          nodeId: String(d.nodeId ?? ''),
          instituteId: String(d.instituteId ?? ''),
        });
      });
    }
  }

  // Delta base: existing RULES-sourced members only. Manual members never
  // enter the core, so sync cannot touch them (invariant 2).
  const currentSnap = await db.collection('assessmentMembers')
    .where('assessmentId', '==', assessmentId)
    .where('source', '==', 'rules')
    .get();
  const currentRulesMemberIds = currentSnap.docs.map((d) => String(d.get('studentId')));

  return {
    core: {
      nodeType,
      requestedIds: nodeIds,
      selected,
      descendants,
      mappings,
      instituteStudents,
      currentRulesMemberIds,
    },
    selectedDocs,
  };
}

/** Denormalize name + breadcrumb for each selected node (audit survives renames). */
async function buildNodeSummaries(
  db: FirebaseFirestore.Firestore,
  nodeType: AllocNodeType,
  nodeIds: string[],
  selectedDocs: Map<string, FirebaseFirestore.DocumentData>,
): Promise<{ nodeId: string; nodeName: string; breadcrumb: string; instituteId: string }[]> {
  if (nodeType === 'institute') {
    return nodeIds.map((id) => ({
      nodeId: id,
      nodeName: String(selectedDocs.get(id)?.name ?? id),
      breadcrumb: '',
      instituteId: id,
    }));
  }
  // Collect unique ancestor ids (in hierarchy order) across all selected nodes.
  const ancestorOrder: { field: string; col: string }[] = [
    { field: 'schoolId', col: 'schools' },
    { field: 'levelId', col: 'academicLevels' },
    { field: 'programId', col: 'programs' },
    { field: 'sessionId', col: 'academicSessions' },
    { field: 'yearId', col: 'academicYears' },
    { field: 'semesterId', col: 'semesters' },
    { field: 'courseId', col: 'courses' },
    { field: 'sectionId', col: 'sections' },
  ];
  const wanted = new Map<string, string>(); // ancestorId → collection
  selectedDocs.forEach((d) => {
    ancestorOrder.forEach(({ field, col }) => {
      const id = d[field];
      if (typeof id === 'string' && id) wanted.set(id, col);
    });
  });
  const nameOf = new Map<string, string>();
  const entries = [...wanted.entries()];
  for (const batch of chunk(entries, 100)) {
    const snaps = await db.getAll(...batch.map(([id, col]) => db.collection(col).doc(id)));
    snaps.forEach((s) => { if (s.exists) nameOf.set(s.id, String(s.get('name') ?? s.id)); });
  }
  return nodeIds.map((id) => {
    const d = selectedDocs.get(id) ?? {};
    const parts: string[] = [];
    ancestorOrder.forEach(({ field }) => {
      const aid = (d as Record<string, unknown>)[field];
      if (typeof aid === 'string' && aid && nameOf.has(aid)) parts.push(nameOf.get(aid)!);
    });
    return {
      nodeId: id,
      nodeName: String((d as Record<string, unknown>).name ?? id),
      breadcrumb: parts.join(' › '),
      instituteId: String((d as Record<string, unknown>).instituteId ?? ''),
    };
  });
}

interface ResolveAllocationData {
  assessmentId: string;
  nodeType: AllocNodeType;
  nodeIds: string[];
  expectedVersion: number;
  dryRun: boolean;
}

export const resolveAllocation = onCall<ResolveAllocationData>(
  { region: 'us-central1' },
  async (request) => {
    requireWebOwner(request);
    const { assessmentId, nodeType, nodeIds, expectedVersion, dryRun } =
      request.data || ({} as ResolveAllocationData);

    if (!assessmentId || typeof assessmentId !== 'string') {
      throw new HttpsError('invalid-argument', 'assessmentId is required.');
    }
    if (!Array.isArray(nodeIds) || nodeIds.some((id) => typeof id !== 'string')) {
      throw new HttpsError('invalid-argument', 'nodeIds must be an array of ids.');
    }
    if (typeof expectedVersion !== 'number' || expectedVersion < 0) {
      throw new HttpsError('invalid-argument', 'expectedVersion is required (0 for a first materialization).');
    }

    const db = getFirestore();
    const assessmentRef = db.collection('assessments').doc(assessmentId);
    const aSnap = await assessmentRef.get();
    if (!aSnap.exists || aSnap.get('isDeleted') === true) {
      throw new HttpsError('not-found', 'Assessment not found.');
    }

    const { core, selectedDocs } = await fetchCoreInput(db, assessmentId, nodeType, nodeIds);
    const result = resolveCore(core);

    // Live-shrink guard (system plan D7): while an exam is ACTIVE the list may
    // only grow. Draft/closed assessments may shrink freely — that's editing.
    const isActive = aSnap.get('status') === 'active';
    const liveShrink = isActive && result.delta.removed.length > 0;

    if (dryRun) {
      // Sample of the ADDED students with display names (capped — never the
      // whole list in one response; getAllocationPreviewPage pages the rest).
      const sampleIds = result.delta.added.slice(0, 50);
      const sampleStudents: { id: string; name: string; email: string }[] = [];
      for (const ids of chunk(sampleIds, 100)) {
        const snaps = await db.getAll(...ids.map((id) => db.collection('students').doc(id)));
        snaps.forEach((s) => {
          if (s.exists) sampleStudents.push({
            id: s.id,
            name: String(s.get('name') ?? s.id),
            email: String(s.get('email') ?? ''),
          });
        });
      }
      return {
        valid: result.errors.length === 0,
        errors: result.errors,
        commitBlockers: liveShrink
          ? [...result.commitBlockers,
             `This exam is LIVE — the new selection would remove ${result.delta.removed.length} student(s). Removals while live aren't supported.`]
          : result.commitBlockers,
        warnings: result.warnings,
        resolvedCount: result.members.length,
        byNode: result.byNode,
        deltaCounts: { added: result.delta.added.length, removed: result.delta.removed.length },
        sampleStudents,
        isLive: isActive,
      };
    }

    // ── COMMIT ──────────────────────────────────────────────────────
    if (result.errors.length > 0) {
      throw new HttpsError('failed-precondition', result.errors.join(' '));
    }
    if (result.commitBlockers.length > 0) {
      throw new HttpsError('failed-precondition', result.commitBlockers.join(' '));
    }
    if (liveShrink) {
      throw new HttpsError(
        'failed-precondition',
        'This exam is LIVE — the new selection would remove students. Removals while live are not supported.',
      );
    }

    const nodes = await buildNodeSummaries(db, nodeType, nodeIds, selectedDocs);
    const memberByStudent = new Map(result.members.map((m) => [m.studentId, m]));
    const nowIso = new Date().toISOString();
    const callerUid = request.auth!.uid;
    const allocationRef = db.collection('allocations').doc(assessmentId);
    const auditRef = db.collection('allocationAudit').doc();
    const instituteIds = [...new Set(result.members.map((m) => m.instituteId).filter(Boolean))].sort();
    const smallDelta =
      result.delta.added.length + result.delta.removed.length <= ALLOC_TXN_MEMBER_WRITE_CAP;

    const newVersion = await db.runTransaction(async (txn) => {
      const [allocSnap, freshA] = await Promise.all([txn.get(allocationRef), txn.get(assessmentRef)]);
      const currentVersion = allocSnap.exists ? Number(allocSnap.get('version') ?? 0) : 0;
      if (currentVersion !== expectedVersion) {
        throw new HttpsError('aborted', 'ALLOCATION_CHANGED — the allocation was modified elsewhere. Re-preview and try again.');
      }
      // Re-check liveness INSIDE the transaction (it may have flipped since the read above).
      if (freshA.get('status') === 'active' && result.delta.removed.length > 0) {
        throw new HttpsError('failed-precondition', 'This exam is LIVE — removals are not supported.');
      }

      const version = currentVersion + 1;
      txn.set(allocationRef, {
        assessmentId,
        ownerType: 'webOwner',
        version,
        status: 'confirmed',
        nodeType,
        nodeIds,
        nodes,
        instituteId: nodeType === 'institute' ? '*' : (nodes[0]?.instituteId ?? ''),
        resolvedCount: result.members.length,
        resolvedInstituteIds: instituteIds,
        lastMaterializedAt: nowIso,
        lastMaterializedBy: callerUid,
        ...(allocSnap.exists ? {} : { createdAt: nowIso }),
        updatedAt: nowIso,
        materializing: !smallDelta,
      }, { merge: true });

      if (freshA.get('allocationMode') !== 'rules') {
        txn.set(assessmentRef, { allocationMode: 'rules' }, { merge: true });
      }

      if (smallDelta) {
        result.delta.added.forEach((sid) => {
          const m = memberByStudent.get(sid)!;
          txn.set(db.collection('assessmentMembers').doc(`${assessmentId}_${sid}`), {
            assessmentId,
            studentId: sid,
            instituteId: m.instituteId,
            source: 'rules',
            active: true,
            viaNodeIds: m.viaNodeIds,
            admittedByVersion: version,
            addedBy: callerUid,
            createdAt: nowIso,
          });
        });
        result.delta.removed.forEach((sid) => {
          txn.delete(db.collection('assessmentMembers').doc(`${assessmentId}_${sid}`));
        });
      }

      txn.set(auditRef, {
        assessmentId,
        version,
        actorUid: callerUid,
        actorRole: 'webOwner',
        action: allocSnap.exists ? (result.delta.removed.length > 0 || result.delta.added.length > 0 ? 'sync' : 'materialize') : 'create',
        delta: {
          addedStudentIds: result.delta.added.slice(0, AUDIT_DELTA_ID_CAP),
          removedStudentIds: result.delta.removed.slice(0, AUDIT_DELTA_ID_CAP),
        },
        deltaCounts: { added: result.delta.added.length, removed: result.delta.removed.length },
        truncated:
          result.delta.added.length > AUDIT_DELTA_ID_CAP ||
          result.delta.removed.length > AUDIT_DELTA_ID_CAP,
        allocationSnapshot: { nodeType, nodeIds, nodes },
        manualStudent: null,
        isLive: freshA.get('status') === 'active',
        at: nowIso,
      });

      return version;
    });

    // Large-delta overflow: member docs land via BulkWriter AFTER the txn.
    // Safe because a partially-written window only means "not admitted YET" —
    // a member doc either exists or it doesn't (additions), and removals only
    // occur on non-active assessments (guarded above).
    if (!smallDelta) {
      const writer = db.bulkWriter();
      result.delta.added.forEach((sid) => {
        const m = memberByStudent.get(sid)!;
        writer.set(db.collection('assessmentMembers').doc(`${assessmentId}_${sid}`), {
          assessmentId,
          studentId: sid,
          instituteId: m.instituteId,
          source: 'rules',
          active: true,
          viaNodeIds: m.viaNodeIds,
          admittedByVersion: newVersion,
          addedBy: callerUid,
          createdAt: nowIso,
        });
      });
      result.delta.removed.forEach((sid) => {
        writer.delete(db.collection('assessmentMembers').doc(`${assessmentId}_${sid}`));
      });
      await writer.close();
      await allocationRef.update({ materializing: false });
    }

    return {
      version: newVersion,
      resolvedCount: result.members.length,
      deltaCounts: { added: result.delta.added.length, removed: result.delta.removed.length },
    };
  },
);

interface AddManualMemberData {
  assessmentId: string;
  studentId: string;
}

export const addManualMember = onCall<AddManualMemberData>(
  { region: 'us-central1' },
  async (request) => {
    requireWebOwner(request);
    const { assessmentId, studentId } = request.data || ({} as AddManualMemberData);
    if (!assessmentId || !studentId) {
      throw new HttpsError('invalid-argument', 'assessmentId and studentId are required.');
    }

    const db = getFirestore();
    const aSnap = await db.collection('assessments').doc(assessmentId).get();
    if (!aSnap.exists || aSnap.get('isDeleted') === true) {
      throw new HttpsError('not-found', 'Assessment not found.');
    }
    if (aSnap.get('allocationMode') !== 'rules') {
      throw new HttpsError('failed-precondition', 'Manual members apply to rule-allocated assessments only. Use the legacy targeting controls otherwise.');
    }
    // Deliberately NO same-institute requirement: this is the external/retest
    // escape hatch (system plan D8), and it is webOwner-only by construction.
    const sSnap = await db.collection('students').doc(studentId).get();
    if (!sSnap.exists) throw new HttpsError('not-found', 'Student not found.');

    const memberRef = db.collection('assessmentMembers').doc(`${assessmentId}_${studentId}`);
    const existing = await memberRef.get();
    if (existing.exists) {
      // Idempotent: already a member (via rules or a previous manual add) —
      // no duplicate doc, no duplicate audit entry.
      return { ok: true, alreadyMember: true, source: existing.get('source') };
    }

    const nowIso = new Date().toISOString();
    const allocSnap = await db.collection('allocations').doc(assessmentId).get();
    const version = allocSnap.exists ? Number(allocSnap.get('version') ?? 0) : 0;

    const batch = db.batch();
    batch.set(memberRef, {
      assessmentId,
      studentId,
      instituteId: String(sSnap.get('instituteId') ?? ''),
      source: 'manual',
      active: true,
      viaNodeIds: [],
      admittedByVersion: version,
      addedBy: request.auth!.uid,
      createdAt: nowIso,
    });
    batch.set(db.collection('allocationAudit').doc(), {
      assessmentId,
      version,
      actorUid: request.auth!.uid,
      actorRole: 'webOwner',
      action: 'manual_add',
      delta: { addedStudentIds: [studentId], removedStudentIds: [] },
      deltaCounts: { added: 1, removed: 0 },
      truncated: false,
      allocationSnapshot: null,
      manualStudent: { studentId, name: String(sSnap.get('name') ?? studentId) },
      isLive: aSnap.get('status') === 'active',
      at: nowIso,
    });
    batch.update(db.collection('allocations').doc(assessmentId),
      allocSnap.exists ? { manualCount: FieldValue.increment(1), updatedAt: nowIso } : {});
    if (!allocSnap.exists) {
      // Rule-path assessment without an allocation doc shouldn't happen
      // (allocationMode is set by resolveAllocation), but never fail the add
      // over a missing summary counter.
      batch.set(db.collection('allocations').doc(assessmentId), {
        assessmentId, manualCount: 1, updatedAt: nowIso,
      }, { merge: true });
    }
    await batch.commit();

    return { ok: true, alreadyMember: false };
  },
);

interface GetAllocationPreviewPageData {
  assessmentId: string;
  limit?: number;
  cursor?: string;          // last member doc id from the previous page
  source?: 'rules' | 'manual';
}

export const getAllocationPreviewPage = onCall<GetAllocationPreviewPageData>(
  { region: 'us-central1' },
  async (request) => {
    requireWebOwner(request);
    const { assessmentId, limit, cursor, source } = request.data || ({} as GetAllocationPreviewPageData);
    if (!assessmentId) throw new HttpsError('invalid-argument', 'assessmentId is required.');
    const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 200);

    const db = getFirestore();
    let q = db.collection('assessmentMembers')
      .where('assessmentId', '==', assessmentId) as FirebaseFirestore.Query;
    if (source === 'rules' || source === 'manual') q = q.where('source', '==', source);
    q = q.orderBy('__name__').limit(pageSize);
    if (cursor && typeof cursor === 'string') {
      q = q.startAfter(db.collection('assessmentMembers').doc(cursor));
    }
    const snap = await q.get();

    // Join display names for exactly this page (never the whole list).
    const rowsRaw = snap.docs.map((d) => ({
      docId: d.id,
      studentId: String(d.get('studentId')),
      instituteId: String(d.get('instituteId') ?? ''),
      source: String(d.get('source')),
      viaNodeIds: (d.get('viaNodeIds') as string[] | undefined) ?? [],
      addedBy: String(d.get('addedBy') ?? ''),
      createdAt: String(d.get('createdAt') ?? ''),
    }));
    const nameOf = new Map<string, { name: string; email: string }>();
    for (const ids of chunk(rowsRaw.map((r) => r.studentId), 100)) {
      const snaps = await db.getAll(...ids.map((id) => db.collection('students').doc(id)));
      snaps.forEach((s) => {
        if (s.exists) nameOf.set(s.id, {
          name: String(s.get('name') ?? s.id),
          email: String(s.get('email') ?? ''),
        });
      });
    }
    const rows = rowsRaw.map((r) => ({
      ...r,
      name: nameOf.get(r.studentId)?.name ?? r.studentId,
      email: nameOf.get(r.studentId)?.email ?? '',
    }));

    return {
      rows,
      nextCursor: snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1].id : null,
    };
  },
);

// ══════════════════════════════════════════════════════════════════
// SESSION REVOCATION (Remediation plan Batch A, issue #12)
// ══════════════════════════════════════════════════════════════════
// revokeSessions — invalidates every refresh token for the CALLER's own
// account, signing out all other devices. Wired to the "Sign out of all
// other devices" action on the Security pages, and intended to be called
// after a successful password change so a stolen session doesn't outlive
// the credential that created it.
//
// Self-only by design: no admin variant here. Revoking OTHER users'
// sessions (e.g. webOwner force-logout of a compromised account) should be
// added as a separate, explicitly-authorised callable when needed.
//
// Note: ID tokens already minted stay valid up to 1h (Firebase constant);
// revocation bites at the next token refresh. The caller's CURRENT session
// also gets revoked — the client should re-authenticate or treat its own
// session as ending, which is acceptable for both trigger paths (password
// change re-prompts; explicit "sign out everywhere" expects it).

export const revokeSessions = onCall(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    await getAuth().revokeRefreshTokens(request.auth.uid);
    return { ok: true, revokedAt: new Date().toISOString() };
  },
);