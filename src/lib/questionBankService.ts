import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  getDocs,
  query,
  where,
  writeBatch,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { ensureSebToken } from './assessmentService';
import { db, functions } from './firebase';
import { bumpTaxonomyCounts } from './subjectService';
import { getFlatReceivedQuestions } from './questionShareService';

// ══════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ══════════════════════════════════════════════════════════════════

function removeUndefined<T extends Record<string, any>>(obj: T): T {
  const out: any = {};
  for (const key in obj) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out as T;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function now(): string {
  return new Date().toISOString();
}

// ══════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ══════════════════════════════════════════════════════════════════

// ── MCQ option ────────────────────────────────────────────────────

export type MCQOption = {
  id: string;   // short uid, e.g. "opt_1"
  text: string;
  image?: string;  // Firebase Storage download URL (optional)
};

// ── Match pair ────────────────────────────────────────────────────

export type MatchPair = {
  leftId: string;
  leftText: string;
  leftImage?: string;   // optional image for left column item
  rightId: string;
  rightText: string;
  rightImage?: string;  // optional image for right column item
};

export type CorrectPair = {
  leftId: string;
  rightId: string;
};

// ── Question engines & variants ───────────────────────────────────
//
//  engine  │  variant
//  ────────┼───────────────────────────────────────────────────────
//  mcq     │  'single'    — exactly one correct option
//          │  'multi'     — one or more correct options
//          │  'truefalse' — options locked to ["True","False"]
//          │  'fillblank' — stem has ___ marker; options are candidates
//  ────────┼──────────────────────────────────────────────────────
//  text    │  'short'     — expected short response
//          │  'long'      — extended / essay response
//  ────────┼───────────────────────────────────────────────────────
//  match   │  null        — left ↔ right column pairs

export type QuestionEngine = 'mcq' | 'text' | 'match';

export type MCQVariant     = 'single' | 'multi' | 'truefalse' | 'fillblank';
export type TextVariant    = 'short' | 'long';
export type QuestionVariant = MCQVariant | TextVariant | null;

// ── Difficulty & shared metadata ──────────────────────────────────

export type Difficulty = 'easy' | 'medium' | 'hard';

// ── Ownership ─────────────────────────────────────────────────────
// Tracks which role and which specific actor created the question.
// 'webOwner' questions are visible only to the Web Owner.
// 'institute' questions are visible only to that institute admin.
// 'faculty' questions are visible only to that faculty member.
// Omitted / undefined → treated as 'webOwner' for backward compatibility.

export type QuestionOwnerType = 'webOwner' | 'institute' | 'faculty';

// ── Question document ─────────────────────────────────────────────

export type Question = {
  id: string;

  // Engine + variant determine which fields are populated
  engine: QuestionEngine;
  variant: QuestionVariant;

  // Common to all engines
  stem: string;
  stemImage?: string;   // Firebase Storage download URL (optional)

  // ── MCQ fields (engine === 'mcq') ──
  options: MCQOption[];       // always an array; [] for non-MCQ
  correctIds: string[];       // option ids that are correct; [] for non-MCQ

  // ── Text fields (engine === 'text') ──
  modelAnswer: string;        // optional expected answer / rubric hint

  // ── Match fields (engine === 'match') ──
  pairs: MatchPair[];         // left ↔ right definitions; [] for non-match
  correctPairs: CorrectPair[];// which left maps to which right; [] for non-match

  // ── Metadata ──
  subject: string;            // canonical name (kept for back-compat)
  topic: string;              // canonical name (kept for back-compat)
  subjectId?: string;         // slug ID (e.g. "math-0001") — preferred
  topicId?: string;           // slug ID (e.g. "prob-0001") — preferred
  tags: string[];
  difficulty: Difficulty;
  explanation: string;        // optional solution explanation

  // ── Ownership (Phase 1 addition) ──
  // ownerType missing / undefined → treated as 'webOwner' (backward compat)
  ownerType?: QuestionOwnerType;
  ownerId?: string;            // instituteId, facultyId, or 'webOwner'
  // Tenant stamp (permission-model Phase 0): the institute this question was
  // authored INSIDE. Present on institute- and faculty-authored questions
  // (faculty stamps carry their institute, not themselves); ABSENT on
  // webOwner content. Rules use it for the cross-tenant read fence and
  // validate it on create/update; the backfill script stamps legacy docs.
  instituteId?: string;

  // ── System ──
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
};

// ── Question Bank document ────────────────────────────────────────
// A bank is a named curated collection of question references.
// Questions exist independently; bankId is NOT stored on the question.

export type QuestionBank = {
  id: string;
  name: string;
  description: string;
  questionIds: string[];   // soft references — questions can belong to many banks
  subject: string;
  tags: string[];
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
};

// ── Bank Grant (Web Owner → Institute) ───────────────────────────
//
//  grantMode = 'bank'      → entire bank granted; snapshot taken at grant time
//  grantMode = 'questions' → cherry-picked questions granted directly

export type GrantMode = 'bank' | 'questions';

export type BankGrant = {
  id: string;
  instituteId: string;

  grantMode: GrantMode;

  // Populated when grantMode === 'bank'
  bankId: string;

  // Always populated — frozen snapshot of question IDs at grant time.
  // For 'bank' grants: snapshot of bank.questionIds at the moment of granting.
  // For 'questions' grants: same as questionIds below.
  snapshotQuestionIds: string[];

  // Populated when grantMode === 'questions'
  questionIds: string[];

  // Optional label / note for internal reference
  note: string;

  grantedBy: string;   // Web Owner identifier (email or uid)
  isRevoked: boolean;
  grantedAt: string;
  updatedAt: string;
};

// ── Institute Grant (Institute Admin → Faculty) ───────────────────
//
//  questionIds must be a subset of the resolved parent BankGrant's
//  snapshotQuestionIds. Enforced in the UI; not enforced by Firestore rules
//  (custom auth project — no security rules in play).

export type InstituteGrant = {
  id: string;
  parentGrantId: string;   // references bankGrants/{id}
  instituteId: string;
  facultyId: string;

  // Subset of parentGrant.snapshotQuestionIds
  questionIds: string[];

  grantedBy: string;       // Institute Admin identifier (instituteId or email)
  isRevoked: boolean;
  grantedAt: string;
  updatedAt: string;
};

// ── Resolved view (convenience, not stored) ───────────────────────

export type ResolvedInstituteAccess = {
  grant: BankGrant;
  questions: Question[];
};

export type ResolvedFacultyAccess = {
  grant: InstituteGrant;
  parentGrant: BankGrant;
  questions: Question[];
};

// ══════════════════════════════════════════════════════════════════
// COLLECTION NAMES
// ══════════════════════════════════════════════════════════════════

const COL = {
  questions:       'questions',
  questionAnswers: 'questionAnswers',
  questionBanks:   'questionBanks',
  bankGrants:      'bankGrants',
  instituteGrants: 'instituteGrants',
  questionShares:  'questionShares',
} as const;

// ── Answer-key storage ────────────────────────────────────────────
// correctIds / correctPairs / modelAnswer are written to a sibling
// collection (questionAnswers) so Firestore rules can block students
// from reading them during an exam. Public Question reads always
// return these as empty defaults; admin reads merge them back in.

export type QuestionAnswer = {
  id: string;
  correctIds: string[];
  correctPairs: CorrectPair[];
  modelAnswer: string;
  ownerType?: QuestionOwnerType;
  ownerId?: string;
  updatedAt: string;
};

const ANSWER_KEYS = ['correctIds', 'correctPairs', 'modelAnswer'] as const;

function pickAnswerFields(q: Partial<Question>): Partial<QuestionAnswer> {
  const out: Partial<QuestionAnswer> = {};
  if (q.correctIds   !== undefined) out.correctIds   = q.correctIds;
  if (q.correctPairs !== undefined) out.correctPairs = q.correctPairs;
  if (q.modelAnswer  !== undefined) out.modelAnswer  = q.modelAnswer;
  return out;
}

function stripAnswerFields<T extends Partial<Question>>(q: T): T {
  const out: any = { ...q };
  for (const k of ANSWER_KEYS) delete out[k];
  return out;
}

function emptyAnswerDefaults(): Pick<Question, 'correctIds' | 'correctPairs' | 'modelAnswer'> {
  return { correctIds: [], correctPairs: [], modelAnswer: '' };
}

/**
 * Batch-load answer docs for a set of question ids.
 *
 * RULES ALIGNMENT: questionAnswers reads are owner-scoped (webOwner sees
 * all; institute/faculty see only their own). Firestore rejects a query
 * wholesale unless the rule is provable for every possible result, so:
 *
 *   • owner provided  → the `in` batches also carry ownerType/ownerId
 *     equality filters, making the owner clause provable. Use this from
 *     any getter that already knows whose questions these are.
 *   • owner omitted   → try the unfiltered batch (works for webOwner);
 *     if the rules reject it, fall back to per-document gets, which are
 *     evaluated doc-by-doc — owned docs resolve, non-owned are skipped.
 *     (Callers therefore degrade gracefully to "no key available" for
 *     questions the signed-in user doesn't own.)
 */
async function mergeAnswers(
  ids: string[],
  owner?: { ownerType: QuestionOwnerType; ownerId: string },
): Promise<Map<string, QuestionAnswer>> {
  const map = new Map<string, QuestionAnswer>();
  if (ids.length === 0) return map;

  const runBatched = async (withOwnerFilters: boolean) => {
    for (let i = 0; i < ids.length; i += 30) {
      const chunk = ids.slice(i, i + 30);
      const constraints = [where('id', 'in', chunk)];
      if (withOwnerFilters && owner) {
        constraints.push(where('ownerType', '==', owner.ownerType));
        constraints.push(where('ownerId', '==', owner.ownerId));
      }
      const q = query(collection(db, COL.questionAnswers), ...constraints);
      const snap = await getDocs(q);
      snap.docs.forEach((d) => {
        const ans = d.data() as QuestionAnswer;
        map.set(ans.id, ans);
      });
    }
  };

  try {
    await runBatched(!!owner);
    return map;
  } catch {
    // Batched query rejected by rules (caller isn't webOwner and no owner
    // filter matched) — fall back to per-document gets so the caller still
    // receives keys for every doc they CAN read.
    map.clear();
  }

  await Promise.all(ids.map(async (id) => {
    try {
      const snap = await getDoc(doc(db, COL.questionAnswers, id));
      if (snap.exists()) map.set(id, snap.data() as QuestionAnswer);
    } catch {
      /* not readable by this caller — skip */
    }
  }));
  return map;
}

function applyAnswer(q: Question, ans?: QuestionAnswer | null): Question {
  if (ans) {
    return {
      ...q,
      correctIds:   ans.correctIds   ?? [],
      correctPairs: ans.correctPairs ?? [],
      modelAnswer:  ans.modelAnswer  ?? '',
    };
  }
  // Backwards-compat: pre-migration questions still carry answers inline.
  // Leave the embedded values untouched so admin paths keep working until
  // the migration script runs.
  return {
    ...q,
    correctIds:   q.correctIds   ?? [],
    correctPairs: q.correctPairs ?? [],
    modelAnswer:  q.modelAnswer  ?? '',
  };
}

function sanitizePublic(q: Question): Question {
  // Always wipe answer fields from the public payload — defense in depth
  // for pre-migration docs still carrying them inline.
  return { ...q, ...emptyAnswerDefaults() };
}

// ══════════════════════════════════════════════════════════════════
// QUESTION CRUD
// ══════════════════════════════════════════════════════════════════

/**
 * Read options for question getters.
 *
 *   includeAnswer: true  (default) — admin path; merges correctIds/correctPairs/
 *                                    modelAnswer from the questionAnswers sibling.
 *   includeAnswer: false           — student exam path; never merges, returns
 *                                    empty defaults for answer fields.
 *
 * Defense in depth: Firestore rules separately block students from reading
 * the questionAnswers collection, so even hostile clients can't pull answers.
 */
export type QuestionReadOpts = { includeAnswer?: boolean };

/** Create a new question. Defaults ownerType/ownerId to 'webOwner' if omitted. */
export async function createQuestion(
  data: Omit<Question, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'>,
  opts?: { skipCounterBump?: boolean }
): Promise<Question> {
  const id = newId('q');
  const question: Question = {
    ...data,
    id,
    ownerType: data.ownerType ?? 'webOwner',
    ownerId:   data.ownerId   ?? 'webOwner',
    isDeleted: false,
    createdAt: now(),
    updatedAt: now(),
  };

  const batch = writeBatch(db);

  // Public doc: answer fields wiped
  batch.set(
    doc(db, COL.questions, id),
    removeUndefined({ ...sanitizePublic(question) } as any),
  );

  // Sibling answer doc
  const answer: QuestionAnswer = {
    id,
    ownerType: question.ownerType,
    ownerId:   question.ownerId,
    ...emptyAnswerDefaults(),
    ...pickAnswerFields(question),
    updatedAt: now(),
  };
  batch.set(doc(db, COL.questionAnswers, id), removeUndefined(answer as any));

  await batch.commit();

  // Keep denormalized taxonomy counts live (best-effort; reconcilable via Recount).
  if (!opts?.skipCounterBump) {
    await bumpTaxonomyCounts({ subjectId: question.subjectId, topicId: question.topicId }, +1);
  }
  console.log(`✅ [QB] createQuestion → ${id} (${question.ownerType}:${question.ownerId})`);
  return question;
}

/**
 * Fetch a single question by id (returns null if not found or deleted).
 * By default merges answer fields from the questionAnswers sibling.
 * Pass `{ includeAnswer: false }` from student exam paths.
 */
export async function getQuestion(
  id: string,
  opts: QuestionReadOpts = { includeAnswer: true },
): Promise<Question | null> {
  const snap = await getDoc(doc(db, COL.questions, id));
  if (!snap.exists()) return null;
  const data = snap.data() as Question;
  if (data.isDeleted) return null;

  if (opts.includeAnswer) {
    // Owner-scoped rules: this get succeeds for the caller's own questions
    // (and everything, for webOwner). For a question the caller doesn't own
    // the read is denied — degrade to the question without its key instead
    // of throwing, so preview/report surfaces keep rendering.
    try {
      const aSnap = await getDoc(doc(db, COL.questionAnswers, id));
      return applyAnswer(data, aSnap.exists() ? (aSnap.data() as QuestionAnswer) : null);
    } catch {
      return applyAnswer(data, null);
    }
  }
  return sanitizePublic(data);
}

/**
 * Batch-fetch questions by an array of IDs.
 * Firestore `in` operator cap is 30 — automatically chunks the request.
 * Deleted questions are excluded from the result.
 */
export async function getQuestionsByIds(
  ids: string[],
  opts: QuestionReadOpts = { includeAnswer: true },
  // Tenant-fence query provability (permission-model Phase 0): under the
  // scoped read rules an `in` batch with no owner constraint is unprovable
  // and fails outright for institute/faculty callers. Callers therefore
  // declare what they're fetching:
  //   { ownerType: 'webOwner' }   — grant + review paths (platform content)
  //   { instituteId }             — peer-share paths (content inside my institute)
  // webOwner-role surfaces stay unscoped (their reads are unrestricted).
  scope?: { ownerType: 'webOwner' } | { instituteId: string },
): Promise<Question[]> {
  if (ids.length === 0) return [];
  const results: Question[] = [];
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const constraints = [where('id', 'in', chunk)];
    if (scope && 'ownerType' in scope) constraints.push(where('ownerType', '==', scope.ownerType));
    if (scope && 'instituteId' in scope) constraints.push(where('instituteId', '==', scope.instituteId));
    const q = query(collection(db, COL.questions), ...constraints);
    const snap = await getDocs(q);
    snap.docs.forEach((d) => {
      const data = d.data() as Question;
      if (!data.isDeleted) results.push(data);
    });
  }

  if (!opts.includeAnswer) {
    return results.map(sanitizePublic);
  }

  const answerMap = await mergeAnswers(results.map((q) => q.id));
  return results.map((q) => applyAnswer(q, answerMap.get(q.id) ?? null));
}

/**
 * Fetch answer keys for questions IN a specific assessment via the
 * getAnswerKeysForReview Cloud Function — the only sanctioned key-read
 * path for graders reviewing questions they don't own (e.g. an institute
 * reviewer triaging reports on a webOwner-owned paper). The server
 * enforces that the assessment is visible to the caller and only ever
 * returns keys for questions inside that assessment.
 */
export async function getAnswerKeysForReview(
  assessmentId: string,
  questionIds?: string[],
): Promise<Map<string, QuestionAnswer>> {
  const call = httpsCallable<
    { assessmentId: string; questionIds?: string[] },
    { ok: true; keys: Record<string, { correctIds: string[]; correctPairs: CorrectPair[]; modelAnswer: string }> }
  >(functions, 'getAnswerKeysForReview');
  const res = await call({ assessmentId, questionIds });
  const map = new Map<string, QuestionAnswer>();
  for (const [id, k] of Object.entries(res.data.keys)) {
    map.set(id, {
      id,
      correctIds:   k.correctIds,
      correctPairs: k.correctPairs,
      modelAnswer:  k.modelAnswer,
      updatedAt: new Date().toISOString(), // fetch time; attribution fields not returned
    });
  }
  return map;
}

/**
 * Batch-fetch questions WITH answer keys for grader review surfaces
 * (report triage, attempt drill-in), scoped to one assessment. Questions
 * are fetched key-less, then keys are merged from the review callable —
 * works for reviewers regardless of who owns the underlying questions.
 */
export async function getQuestionsByIdsForReview(
  assessmentId: string,
  ids: string[],
): Promise<Question[]> {
  if (ids.length === 0) return [];
  const [questions, keyMap] = await Promise.all([
    // Exams are webOwner-built today, so every paper's questions are
    // webOwner-owned — declared for tenant-fence provability. When exam
    // building mirrors to institutes/faculty, derive this scope from the
    // assessment's owner instead.
    getQuestionsByIds(ids, { includeAnswer: false }, { ownerType: 'webOwner' }),
    getAnswerKeysForReview(assessmentId, ids).catch(() => new Map<string, QuestionAnswer>()),
  ]);
  return questions.map((q) => applyAnswer(q, keyMap.get(q.id) ?? null));
}

/**
 * Fetch an assessment's question CONTENT for a student, via the
 * getExamQuestions Cloud Function — the only path students receive
 * question docs, since the `questions` collection read rule denies them
 * (direct reads let any student dump the whole bank from the console).
 * Server whitelists fields; keys never arrive. mode 'review' additionally
 * returns explanations when the assessment allows review and the student
 * has a finished attempt. One call for the whole paper (previously one
 * read per question).
 */
export async function getExamQuestionsForStudent(
  assessmentId: string,
  mode: 'exam' | 'review',
): Promise<Question[]> {
  const call = httpsCallable<
    { assessmentId: string; mode: 'exam' | 'review'; sebToken?: string },
    { ok: true; questions: Question[] }
  >(functions, 'getExamQuestions');
  // Phase 3: the live exam fetch carries the SEB proof. Review mode does not
  // require it (the student has quit SEB by then) but passing it is harmless.
  const sebToken = await ensureSebToken();
  const res = await call({ assessmentId, mode, sebToken });
  return res.data.questions;
}

/**
 * Filter a question pool to candidates that share the draft's subject + topic.
 * Used by duplicate detection — scope is intentionally narrow (only same
 * subjectId AND same topicId, both required) to avoid false positives across
 * unrelated subjects.
 *
 * Pure function, no Firestore. Pass in the already-loaded `getAllQuestions()` result.
 */
export function findDuplicateCandidates(
  draft: { subjectId?: string; topicId?: string; id?: string },
  pool:  Question[],
): Question[] {
  if (!draft.subjectId || !draft.topicId) return [];
  return pool.filter(
    (q) =>
      !q.isDeleted &&
      q.id        !== draft.id &&
      q.subjectId === draft.subjectId &&
      q.topicId   === draft.topicId,
  );
}

/**
 * Fetch ALL non-deleted Web Owner questions (global pool).
 * Returns questions where ownerType === 'webOwner' OR ownerType is absent
 * (backward compat for questions created before Phase 1).
 */
export async function getAllQuestions(
  opts: QuestionReadOpts = { includeAnswer: true },
): Promise<Question[]> {
  const snap = await getDocs(
    query(collection(db, COL.questions), where('isDeleted', '==', false))
  );
  const filtered = snap.docs
    .map((d) => d.data() as Question)
    .filter((q) => !q.ownerType || q.ownerType === 'webOwner');

  if (!opts.includeAnswer) return filtered.map(sanitizePublic);

  const answerMap = await mergeAnswers(filtered.map((q) => q.id));
  return filtered.map((q) => applyAnswer(q, answerMap.get(q.id) ?? null));
}

/**
 * Fetch all non-deleted questions for a specific owner.
 * Used by Institute Admin and Faculty question pages.
 */
export async function getQuestionsByOwner(
  ownerType: QuestionOwnerType,
  ownerId: string,
  opts: QuestionReadOpts = { includeAnswer: true },
): Promise<Question[]> {
  const snap = await getDocs(
    query(
      collection(db, COL.questions),
      where('isDeleted',  '==', false),
      where('ownerType',  '==', ownerType),
      where('ownerId',    '==', ownerId)
    )
  );
  const list = snap.docs.map((d) => d.data() as Question);

  if (!opts.includeAnswer) return list.map(sanitizePublic);

  // Owner filters keep the batched answer query provable under the
  // owner-scoped questionAnswers rules.
  const answerMap = await mergeAnswers(list.map((q) => q.id), { ownerType, ownerId });
  return list.map((q) => applyAnswer(q, answerMap.get(q.id) ?? null));
}

/**
 * Update question metadata or content. Always bumps updatedAt.
 * Routes answer-key fields to the questionAnswers sibling collection.
 */
export async function updateQuestion(
  id: string,
  data: Partial<Omit<Question, 'id' | 'createdAt'>>
): Promise<void> {
  const answerPart = pickAnswerFields(data);
  const publicPart = stripAnswerFields(data);

  // If this edit reassigns the question's subject/topic, read the previous
  // values so we can shift the denormalized counts after the write.
  const touchesTaxonomy = 'subjectId' in data || 'topicId' in data;
  let prev: Question | null = null;
  if (touchesTaxonomy) {
    const snap = await getDoc(doc(db, COL.questions, id));
    prev = snap.exists() ? (snap.data() as Question) : null;
  }

  const batch = writeBatch(db);
  const ts = now();

  if (Object.keys(publicPart).length > 0) {
    batch.update(
      doc(db, COL.questions, id),
      removeUndefined({ ...publicPart, updatedAt: ts } as any),
    );
  }

  if (Object.keys(answerPart).length > 0) {
    // setDoc with merge ensures we create the sibling if it doesn't exist
    // (the case for pre-migration questions whose first edit happens post-cutover).
    batch.set(
      doc(db, COL.questionAnswers, id),
      removeUndefined({
        id,
        ownerType: data.ownerType,
        ownerId:   data.ownerId,
        ...answerPart,
        updatedAt: ts,
      } as any),
      { merge: true },
    );
  }

  await batch.commit();

  // Shift denormalized counts off the old taxonomy and onto the new one.
  if (prev && !prev.isDeleted) {
    if ('subjectId' in data && data.subjectId !== prev.subjectId) {
      await bumpTaxonomyCounts({ subjectId: prev.subjectId }, -1);
      await bumpTaxonomyCounts({ subjectId: data.subjectId }, +1);
    }
    if ('topicId' in data && data.topicId !== prev.topicId) {
      await bumpTaxonomyCounts({ topicId: prev.topicId }, -1);
      await bumpTaxonomyCounts({ topicId: data.topicId }, +1);
    }
  }

  console.log(`✅ [QB] updateQuestion → ${id}`);
}

/**
 * Soft-delete a question.
 * NOTE: existing grants that reference this question are NOT automatically updated.
 * Downstream consumers should filter out isDeleted === true when resolving grants.
 */
export async function softDeleteQuestion(id: string): Promise<void> {
  // Read first so we know which taxonomy counts to decrement, and so we don't
  // double-decrement a question that was already deleted.
  const snap = await getDoc(doc(db, COL.questions, id));
  const prev = snap.exists() ? (snap.data() as Question) : null;

  await updateDoc(doc(db, COL.questions, id), {
    isDeleted: true,
    updatedAt: now(),
  });

  if (prev && !prev.isDeleted) {
    await bumpTaxonomyCounts({ subjectId: prev.subjectId, topicId: prev.topicId }, -1);
  }
  console.log(`✅ [QB] softDeleteQuestion → ${id}`);
}

// ══════════════════════════════════════════════════════════════════
// QUESTION BANK CRUD
// ══════════════════════════════════════════════════════════════════

/** Create a new question bank. Returns the saved QuestionBank. */
export async function createQuestionBank(
  data: Omit<QuestionBank, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'>
): Promise<QuestionBank> {
  const id = newId('bank');
  const bank: QuestionBank = {
    ...data,
    id,
    questionIds: data.questionIds ?? [],
    isDeleted: false,
    createdAt: now(),
    updatedAt: now(),
  };
  await setDoc(doc(db, COL.questionBanks, id), removeUndefined(bank as any));
  console.log(`✅ [QB] createQuestionBank → ${id}`);
  return bank;
}

/** Fetch a single bank by id. */
export async function getQuestionBank(id: string): Promise<QuestionBank | null> {
  const snap = await getDoc(doc(db, COL.questionBanks, id));
  if (!snap.exists()) return null;
  const data = snap.data() as QuestionBank;
  return data.isDeleted ? null : data;
}

/** Fetch all non-deleted banks. */
export async function getAllQuestionBanks(): Promise<QuestionBank[]> {
  const snap = await getDocs(
    query(collection(db, COL.questionBanks), where('isDeleted', '==', false))
  );
  return snap.docs.map((d) => d.data() as QuestionBank);
}

/** Update bank name / description / tags / subject. */
export async function updateQuestionBank(
  id: string,
  data: Partial<Omit<QuestionBank, 'id' | 'createdAt'>>
): Promise<void> {
  await updateDoc(
    doc(db, COL.questionBanks, id),
    removeUndefined({ ...data, updatedAt: now() } as any)
  );
  console.log(`✅ [QB] updateQuestionBank → ${id}`);
}

/** Soft-delete a bank (does NOT affect questions or grants). */
export async function softDeleteQuestionBank(id: string): Promise<void> {
  await updateDoc(doc(db, COL.questionBanks, id), {
    isDeleted: true,
    updatedAt: now(),
  });
  console.log(`✅ [QB] softDeleteQuestionBank → ${id}`);
}

/** Add a question reference to a bank (idempotent). */
export async function addQuestionToBank(
  bankId: string,
  questionId: string
): Promise<void> {
  const bank = await getQuestionBank(bankId);
  if (!bank) throw new Error(`Bank ${bankId} not found.`);
  if (bank.questionIds.includes(questionId)) return; // already in bank
  await updateDoc(doc(db, COL.questionBanks, bankId), {
    questionIds: [...bank.questionIds, questionId],
    updatedAt: now(),
  });
  console.log(`✅ [QB] addQuestionToBank → bank:${bankId} q:${questionId}`);
}

/** Remove a question reference from a bank. */
export async function removeQuestionFromBank(
  bankId: string,
  questionId: string
): Promise<void> {
  const bank = await getQuestionBank(bankId);
  if (!bank) throw new Error(`Bank ${bankId} not found.`);
  await updateDoc(doc(db, COL.questionBanks, bankId), {
    questionIds: bank.questionIds.filter((id) => id !== questionId),
    updatedAt: now(),
  });
  console.log(`✅ [QB] removeQuestionFromBank → bank:${bankId} q:${questionId}`);
}

// ══════════════════════════════════════════════════════════════════
// BANK GRANTS — WEB OWNER → INSTITUTE
// ══════════════════════════════════════════════════════════════════

/**
 * Grant access to an institute.
 *
 * grantMode = 'bank'      → pass bankId; snapshotQuestionIds taken from the
 *                           bank's current questionIds at grant time (frozen).
 * grantMode = 'questions' → pass questionIds directly; snapshotQuestionIds
 *                           mirrors that list.
 */
export async function createBankGrant(
  data: {
    instituteId: string;
    grantMode: GrantMode;
    bankId?: string;
    questionIds?: string[];
    note?: string;
    grantedBy: string;
  }
): Promise<BankGrant> {
  const { instituteId, grantMode, bankId, questionIds, note, grantedBy } = data;

  let snapshotQuestionIds: string[] = [];

  if (grantMode === 'bank') {
    if (!bankId) throw new Error('bankId is required when grantMode is "bank".');
    const bank = await getQuestionBank(bankId);
    if (!bank) throw new Error(`Bank ${bankId} not found.`);
    // Frozen snapshot of the bank's questions at this moment in time
    snapshotQuestionIds = [...bank.questionIds];
  } else {
    if (!questionIds || questionIds.length === 0)
      throw new Error('questionIds is required when grantMode is "questions".');
    snapshotQuestionIds = [...questionIds];
  }

  const id = newId('bg');
  const grant: BankGrant = {
    id,
    instituteId,
    grantMode,
    bankId: bankId ?? '',
    snapshotQuestionIds,
    questionIds: questionIds ?? [],
    note: note ?? '',
    grantedBy,
    isRevoked: false,
    grantedAt: now(),
    updatedAt: now(),
  };

  await setDoc(doc(db, COL.bankGrants, id), removeUndefined(grant as any));
  console.log(`✅ [QB] createBankGrant → ${id} (${grantMode}) → institute:${instituteId}`);
  return grant;
}

/** Fetch all bank grants for a specific institute (active + revoked). */
export async function getBankGrantsByInstitute(
  instituteId: string
): Promise<BankGrant[]> {
  const snap = await getDocs(
    query(collection(db, COL.bankGrants), where('instituteId', '==', instituteId))
  );
  return snap.docs.map((d) => d.data() as BankGrant);
}

/** Fetch all bank grants (Web Owner view — all institutes). */
export async function getAllBankGrants(): Promise<BankGrant[]> {
  const snap = await getDocs(collection(db, COL.bankGrants));
  return snap.docs.map((d) => d.data() as BankGrant);
}

/** Fetch all active (non-revoked) bank grants for an institute. */
export async function getActiveBankGrantsByInstitute(
  instituteId: string
): Promise<BankGrant[]> {
  const all = await getBankGrantsByInstitute(instituteId);
  return all.filter((g) => !g.isRevoked);
}

/** Revoke a bank grant. Downstream institute grants are NOT auto-revoked. */
export async function revokeBankGrant(grantId: string): Promise<void> {
  await updateDoc(doc(db, COL.bankGrants, grantId), {
    isRevoked: true,
    updatedAt: now(),
  });
  console.log(`✅ [QB] revokeBankGrant → ${grantId}`);
}

/** Restore a previously revoked bank grant. */
export async function restoreBankGrant(grantId: string): Promise<void> {
  await updateDoc(doc(db, COL.bankGrants, grantId), {
    isRevoked: false,
    updatedAt: now(),
  });
  console.log(`✅ [QB] restoreBankGrant → ${grantId}`);
}

/** Update note or other non-structural fields on a bank grant. */
export async function updateBankGrant(
  grantId: string,
  data: Partial<Pick<BankGrant, 'note'>>
): Promise<void> {
  await updateDoc(doc(db, COL.bankGrants, grantId), {
    ...data,
    updatedAt: now(),
  });
}

// ══════════════════════════════════════════════════════════════════
// INSTITUTE GRANTS — INSTITUTE ADMIN → FACULTY
// ══════════════════════════════════════════════════════════════════

/**
 * Grant a subset of questions to a faculty member.
 * questionIds must be a subset of parentGrant.snapshotQuestionIds —
 * validated here before writing.
 */
export async function createInstituteGrant(
  data: {
    parentGrantId: string;
    instituteId: string;
    facultyId: string;
    questionIds: string[];
    grantedBy: string;
  }
): Promise<InstituteGrant> {
  const { parentGrantId, instituteId, facultyId, questionIds, grantedBy } = data;

  // Validate parent grant exists and is not revoked
  const parentSnap = await getDoc(doc(db, COL.bankGrants, parentGrantId));
  if (!parentSnap.exists()) throw new Error(`Parent grant ${parentGrantId} not found.`);
  const parentGrant = parentSnap.data() as BankGrant;
  if (parentGrant.isRevoked)
    throw new Error('Cannot create institute grant from a revoked bank grant.');

  // Validate subset constraint
  const allowed = new Set(parentGrant.snapshotQuestionIds);
  const invalid = questionIds.filter((qId) => !allowed.has(qId));
  if (invalid.length > 0)
    throw new Error(
      `The following question IDs are not in the parent grant: ${invalid.join(', ')}`
    );

  const id = newId('ig');
  const grant: InstituteGrant = {
    id,
    parentGrantId,
    instituteId,
    facultyId,
    questionIds,
    grantedBy,
    isRevoked: false,
    grantedAt: now(),
    updatedAt: now(),
  };

  await setDoc(doc(db, COL.instituteGrants, id), removeUndefined(grant as any));
  console.log(`✅ [QB] createInstituteGrant → ${id} → faculty:${facultyId}`);
  return grant;
}

/** Fetch all institute grants for a specific faculty member. */
export async function getInstituteGrantsByFaculty(
  facultyId: string
): Promise<InstituteGrant[]> {
  const snap = await getDocs(
    query(collection(db, COL.instituteGrants), where('facultyId', '==', facultyId))
  );
  return snap.docs.map((d) => d.data() as InstituteGrant);
}

/** Fetch all institute grants issued by an institute (admin view). */
export async function getInstituteGrantsByInstitute(
  instituteId: string
): Promise<InstituteGrant[]> {
  const snap = await getDocs(
    query(collection(db, COL.instituteGrants), where('instituteId', '==', instituteId))
  );
  return snap.docs.map((d) => d.data() as InstituteGrant);
}

/** Revoke an institute → faculty grant. */
export async function revokeInstituteGrant(grantId: string): Promise<void> {
  await updateDoc(doc(db, COL.instituteGrants, grantId), {
    isRevoked: true,
    updatedAt: now(),
  });
  console.log(`✅ [QB] revokeInstituteGrant → ${grantId}`);
}

/** Restore a previously revoked institute grant. */
export async function restoreInstituteGrant(grantId: string): Promise<void> {
  await updateDoc(doc(db, COL.instituteGrants, grantId), {
    isRevoked: false,
    updatedAt: now(),
  });
  console.log(`✅ [QB] restoreInstituteGrant → ${grantId}`);
}

/** Update the question subset on an existing institute grant. */
export async function updateInstituteGrant(
  grantId: string,
  questionIds: string[]
): Promise<void> {
  // Re-validate subset against parent grant
  const snap = await getDoc(doc(db, COL.instituteGrants, grantId));
  if (!snap.exists()) throw new Error(`Institute grant ${grantId} not found.`);
  const grant = snap.data() as InstituteGrant;

  const parentSnap = await getDoc(doc(db, COL.bankGrants, grant.parentGrantId));
  if (!parentSnap.exists()) throw new Error('Parent bank grant no longer exists.');
  const parentGrant = parentSnap.data() as BankGrant;

  const allowed = new Set(parentGrant.snapshotQuestionIds);
  const invalid = questionIds.filter((qId) => !allowed.has(qId));
  if (invalid.length > 0)
    throw new Error(`Question IDs not in parent grant: ${invalid.join(', ')}`);

  await updateDoc(doc(db, COL.instituteGrants, grantId), {
    questionIds,
    updatedAt: now(),
  });
  console.log(`✅ [QB] updateInstituteGrant → ${grantId}`);
}

// ══════════════════════════════════════════════════════════════════
// GRANT RESOLUTION UTILITIES
// ══════════════════════════════════════════════════════════════════

/**
 * Resolve all active bank grants for an institute into a deduplicated
 * list of non-deleted questions, grouped by grant.
 *
 * Usage: Institute Admin's question browser.
 */
export async function getQuestionsForInstitute(
  instituteId: string
): Promise<ResolvedInstituteAccess[]> {
  const grants = await getActiveBankGrantsByInstitute(instituteId);
  const resolved: ResolvedInstituteAccess[] = [];

  for (const grant of grants) {
    // Bank grants only ever snapshot webOwner banks — declare it so the
    // batch is provable under the tenant-fence read rules.
    const questions = await getQuestionsByIds(grant.snapshotQuestionIds, undefined, { ownerType: 'webOwner' });
    resolved.push({ grant, questions });
  }

  return resolved;
}

/**
 * Return a flat, deduplicated list of question IDs accessible to an institute
 * across all active grants. Useful for subset-validation when building
 * institute → faculty grants.
 */
export async function getAccessibleQuestionIdsForInstitute(
  instituteId: string
): Promise<string[]> {
  const grants = await getActiveBankGrantsByInstitute(instituteId);
  const idSet = new Set<string>();
  grants.forEach((g) => g.snapshotQuestionIds.forEach((id) => idSet.add(id)));
  return Array.from(idSet);
}

/**
 * Resolve all active institute grants for a faculty member into questions,
 * grouped by grant. Skips grants whose parent bank grant has been revoked.
 *
 * Usage: Faculty question browser.
 */
export async function getQuestionsForFaculty(
  facultyId: string
): Promise<ResolvedFacultyAccess[]> {
  const instituteGrants = await getInstituteGrantsByFaculty(facultyId);
  const activeGrants = instituteGrants.filter((g) => !g.isRevoked);
  const resolved: ResolvedFacultyAccess[] = [];

  for (const grant of activeGrants) {
    // Verify parent bank grant is still active
    const parentSnap = await getDoc(doc(db, COL.bankGrants, grant.parentGrantId));
    if (!parentSnap.exists()) continue;
    const parentGrant = parentSnap.data() as BankGrant;
    if (parentGrant.isRevoked) continue;

    // Institute grants are subsets of a webOwner bank grant — same scope.
    const questions = await getQuestionsByIds(grant.questionIds, undefined, { ownerType: 'webOwner' });
    resolved.push({ grant, parentGrant, questions });
  }

  return resolved;
}

/**
 * Return a flat, deduplicated list of questions accessible to a faculty member.
 * Convenience wrapper over getQuestionsForFaculty.
 */
export async function getFlatQuestionsForFaculty(
  facultyId: string
): Promise<Question[]> {
  const resolved = await getQuestionsForFaculty(facultyId);
  const seen = new Set<string>();
  const out: Question[] = [];
  for (const { questions } of resolved) {
    for (const q of questions) {
      if (!seen.has(q.id)) {
        seen.add(q.id);
        out.push(q);
      }
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
// DISPLAY HELPERS
// ══════════════════════════════════════════════════════════════════

/** Human-readable label for a question engine + variant combination. */
export function questionTypeLabel(engine: QuestionEngine, variant: QuestionVariant): string {
  if (engine === 'mcq') {
    if (variant === 'single')    return 'MCQ — Single Correct';
    if (variant === 'multi')     return 'MCQ — Multi Correct';
    if (variant === 'truefalse') return 'True / False';
    if (variant === 'fillblank') return 'Fill in the Blank';
  }
  if (engine === 'text') {
    if (variant === 'short') return 'Short Answer';
    if (variant === 'long')  return 'Long / Essay';
  }
  if (engine === 'match') return 'Match the Following';
  return 'Unknown';
}

/** Short badge label (for chips / pills). */
export function questionTypeBadge(engine: QuestionEngine, variant: QuestionVariant): string {
  if (engine === 'mcq') {
    if (variant === 'single')    return 'MCQ';
    if (variant === 'multi')     return 'Multi';
    if (variant === 'truefalse') return 'T/F';
    if (variant === 'fillblank') return 'Fill';
  }
  if (engine === 'text') {
    if (variant === 'short') return 'Short';
    if (variant === 'long')  return 'Essay';
  }
  if (engine === 'match') return 'Match';
  return '—';
}

/** Colour token for difficulty badge. */
export function difficultyColor(d: Difficulty): { bg: string; text: string; border: string } {
  if (d === 'easy')   return { bg: '#F0FBF4', text: '#2A6B3A', border: '#C3E8CE' };
  if (d === 'hard')   return { bg: '#FDF5F5', text: '#9B2828', border: '#F2CECE' };
  return                     { bg: '#FFFBF0', text: '#8B5E1A', border: '#F0DFA0' };
}

// ══════════════════════════════════════════════════════════════════
// FACTORY HELPERS — build empty skeletons for each question type
// ══════════════════════════════════════════════════════════════════

const emptyBase = {
  subject: '',
  topic: '',
  tags: [],
  difficulty: 'medium' as Difficulty,
  explanation: '',
};

export function buildEmptyMCQ(variant: MCQVariant): Omit<Question, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'> {
  const isTF = variant === 'truefalse';
  return {
    ...emptyBase,
    engine: 'mcq',
    variant,
    stem: '',
    options: isTF
      ? [{ id: 'opt_1', text: 'True' }, { id: 'opt_2', text: 'False' }]
      : [
          { id: 'opt_1', text: '' },
          { id: 'opt_2', text: '' },
          { id: 'opt_3', text: '' },
          { id: 'opt_4', text: '' },
        ],
    correctIds: [],
    modelAnswer: '',
    pairs: [],
    correctPairs: [],
  };
}

export function buildEmptyText(variant: TextVariant): Omit<Question, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'> {
  return {
    ...emptyBase,
    engine: 'text',
    variant,
    stem: '',
    options: [],
    correctIds: [],
    modelAnswer: '',
    pairs: [],
    correctPairs: [],
  };
}

export function buildEmptyMatch(): Omit<Question, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'> {
  return {
    ...emptyBase,
    engine: 'match',
    variant: null,
    stem: '',
    options: [],
    correctIds: [],
    modelAnswer: '',
    pairs: [
      { leftId: 'l1', leftText: '', rightId: 'r1', rightText: '' },
      { leftId: 'l2', leftText: '', rightId: 'r2', rightText: '' },
      { leftId: 'l3', leftText: '', rightId: 'r3', rightText: '' },
    ],
    correctPairs: [
      { leftId: 'l1', rightId: 'r1' },
      { leftId: 'l2', rightId: 'r2' },
      { leftId: 'l3', rightId: 'r3' },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════
// DUPLICATE-CHECK POOL
// ══════════════════════════════════════════════════════════════════

/**
 * Returns the set of questions a given user should be duplicate-checked
 * against: everything they OWN plus everything explicitly SHARED/GRANTED
 * to them. No cross-tenant content — an institute/faculty never sees
 * another tenant's ungranted questions here.
 *
 *   webOwner  → all web-owner questions (draft / private / global — all theirs)
 *   institute → own questions + questions from banks granted to the institute
 *   faculty   → own questions + institute-granted questions + questions
 *               shared directly to them (incl. from other faculty)
 *
 * Deduplicated by question id. Safe to call from any question surface.
 */
export async function getDuplicateCheckPool(
  ownerType?: QuestionOwnerType,
  ownerId?: string,
  // Caller's institute — needed so the received-shares bucket can run a
  // provable same-institute batch under the tenant-fence rules.
  instituteId?: string,
): Promise<Question[]> {
  // Web owner (or unknown context) → the global/owner bank, as before.
  if (!ownerType || !ownerId || ownerType === 'webOwner') {
    return getAllQuestions();
  }

  const buckets: Question[][] = [];

  try {
    if (ownerType === 'institute') {
      buckets.push(await getQuestionsByOwner('institute', ownerId));
      const granted = await getQuestionsForInstitute(ownerId);
      buckets.push(granted.flatMap((g) => g.questions));
    } else if (ownerType === 'faculty') {
      buckets.push(await getQuestionsByOwner('faculty', ownerId));
      buckets.push(await getFlatQuestionsForFaculty(ownerId));
      const received = await getFlatReceivedQuestions(ownerId, instituteId);
      buckets.push(received.questions);
    }
  } catch (err) {
    console.warn('[getDuplicateCheckPool] partial pool — some sources failed:', err);
  }

  // Deduplicate by id.
  const seen = new Set<string>();
  const out: Question[] = [];
  for (const bucket of buckets) {
    for (const q of bucket) {
      if (q?.id && !seen.has(q.id)) {
        seen.add(q.id);
        out.push(q);
      }
    }
  }
  return out;
}