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

  // ── Group membership (Phase 1) ────────────────────────────────────
  // Set when this question is a CHILD of a QuestionGroup — one of the
  // sub-questions hanging off a shared stimulus (DI table, RC passage,
  // caselet, puzzle, seating arrangement).
  //
  // The child stays an ordinary question document with an ordinary engine.
  // That is the entire point of the design: grading, answer-key storage in
  // questionAnswers, the rights model, the tenant fence, duplicate detection
  // and the bulk-upload path all keep working on children with no special
  // case. Only the stimulus is new, and it lives on the group.
  //
  // groupOrder is the child's position within its group. QuestionGroup.childIds
  // is the authoritative order; this field is the denormalized copy so a child
  // read on its own still knows where it sits.
  groupId?: string;
  groupOrder?: number;
};

// ══════════════════════════════════════════════════════════════════
// QUESTION GROUPS (Phase 1)
// ══════════════════════════════════════════════════════════════════
//
// A group is a shared STIMULUS plus its dependent child questions.
//
// Data Interpretation, Reading Comprehension, caselets, puzzles and seating
// arrangements are one model, not five. They are structurally identical —
// one stimulus, N sub-questions that are unanswerable without it — and differ
// only in what the stimulus CONTAINS. `kind` records which flavour it is, and
// is used for filtering, labelling and rule targeting; it changes no logic.

export type GroupKind =
  | 'di'        // Data Interpretation — table / chart / mixed
  | 'rc'        // Reading Comprehension — long passage
  | 'caselet'   // short prose case, often with embedded figures
  | 'puzzle'    // logical puzzle, sometimes with a diagram
  | 'seating'   // seating arrangement, sometimes with a diagram
  | 'generic';  // anything else sharing a stimulus

export const GROUP_KINDS: GroupKind[] = ['di', 'rc', 'caselet', 'puzzle', 'seating', 'generic'];

export const GROUP_KIND_LABEL: Record<GroupKind, string> = {
  di:      'Data Interpretation',
  rc:      'Reading Comprehension',
  caselet: 'Caselet',
  puzzle:  'Puzzle',
  seating: 'Seating Arrangement',
  generic: 'Grouped Set',
};

/**
 * The shared stimulus.
 *
 * `format` says which fields carry the content; the others may be present but
 * are ignored, so switching format in the authoring UI never destroys work.
 *
 * DI tables are STRUCTURAL (headers + rows), not an uploaded screenshot. An
 * image of a table cannot reflow on a phone, cannot be read by a screen
 * reader, and cannot be zoomed without losing the row a candidate was on —
 * and this platform already runs exams on mobile for the 'normal' tier.
 * `format: 'image'` remains available as the fallback for charts and diagrams
 * that genuinely are pictures.
 */
export type GroupStimulus = {
  format: 'richtext' | 'table' | 'image' | 'mixed';

  /** Passage / caselet / puzzle prose. Rich text; KaTeX already supported. */
  body?: string;

  /** Firebase Storage download URLs — charts, diagrams, scanned figures. */
  images?: string[];

  /**
   * Structural table for DI sets.
   *
   * Rows are `{ cells: [...] }` rather than the obvious `string[][]` because
   * FIRESTORE CANNOT STORE NESTED ARRAYS — a document containing an array of
   * arrays is rejected outright by the SDK ("Nested arrays are not
   * supported"), not silently flattened. Wrapping each row in an object is the
   * standard workaround and the only shape that persists.
   */
  table?: {
    caption?: string;
    headers: string[];
    rows: GroupTableRow[];
  };
};

export type GroupTableRow = { cells: string[] };

/** Convenience for callers that think in plain 2-D arrays. */
export function toTableRows(rows: string[][]): GroupTableRow[] {
  return rows.map((cells) => ({ cells }));
}

export function fromTableRows(rows: GroupTableRow[] | undefined): string[][] {
  return (rows ?? []).map((r) => r.cells ?? []);
}

export type QuestionGroup = {
  id: string;
  kind: GroupKind;
  title: string;              // internal label, e.g. "DI — Regional sales 2024"
  stimulus: GroupStimulus;

  // ── Metadata ──
  // Mirrors Question exactly so the same subject/topic pickers, taxonomy
  // canonicalisation and difficulty filters work on groups with no new UI.
  subject: string;
  topic: string;
  subjectId?: string;
  topicId?: string;
  tags: string[];
  // The GROUP's difficulty, which is what selection rules match on. Children
  // may individually differ (a DI set usually ramps), and that is deliberate:
  // matching on child difficulty would let a rule pull half a set.
  difficulty: Difficulty;

  /** Ordered child question ids. Authoritative — Question.groupOrder mirrors it. */
  childIds: string[];

  // ── Ownership ──
  // Identical stamp semantics to Question: ownerType/ownerId identify the
  // author, instituteId is the tenant stamp used by the read fence in
  // firestore.rules. A group and its children ALWAYS carry the same stamps —
  // a group readable by a tenant whose children are not would render a
  // passage with no questions under it.
  ownerType?: QuestionOwnerType;
  ownerId?: string;
  instituteId?: string;

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
  questionGroups:  'questionGroups',
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
/**
 * The stimulus half of the exam payload, as students receive it.
 *
 * A narrower type than QuestionGroup on purpose: it is the shape
 * sanitizeGroupForStudent actually returns. childIds, the internal title and
 * every ownership field are withheld server-side, so they are absent here too
 * — if this type claimed them, client code would compile against fields that
 * are always undefined at runtime.
 */
export type ExamQuestionGroup = {
  id: string;
  kind: GroupKind;
  stimulus: {
    format: GroupStimulus['format'];
    body: string;
    images: string[];
    table: { caption: string; headers: string[]; rows: GroupTableRow[] } | null;
  };
};

export async function getExamQuestionsForStudent(
  assessmentId: string,
  mode: 'exam' | 'review',
): Promise<{ questions: Question[]; groups: ExamQuestionGroup[] }> {
  const call = httpsCallable<
    { assessmentId: string; mode: 'exam' | 'review'; sebToken?: string },
    { ok: true; questions: Question[]; groups?: ExamQuestionGroup[] }
  >(functions, 'getExamQuestions');
  // Phase 3: the live exam fetch carries the SEB proof. Review mode does not
  // require it (the student has quit SEB by then) but passing it is harmless.
  const sebToken = await ensureSebToken();
  const res = await call({ assessmentId, mode, sebToken });
  // `groups` is optional in the response type so a client running against a
  // not-yet-deployed function still parses — it just gets no stimulus, which
  // degrades to the pre-Phase-1 rendering rather than throwing mid-exam.
  return { questions: res.data.questions, groups: res.data.groups ?? [] };
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
 * All questions authored INSIDE an institute — both the institute admin's own
 * (ownerType 'institute') and every faculty member's (ownerType 'faculty',
 * tenant-stamped with this institute). Powers the institute admin's Phase-1
 * institute-wide visibility.
 *
 * Keyed off the `instituteId` tenant stamp, so the read is provable under the
 * tenant-fence rules (institute branch: instituteId == mine). Always returns
 * PUBLIC questions — the institute admin sees faculty questions for oversight,
 * but answer keys stay owner-scoped (a faculty member's keys are theirs), so
 * this never fetches the answer sibling. Callers needing their OWN keys still
 * use getQuestionsByOwner.
 */
export async function getQuestionsByInstitute(
  instituteId: string,
): Promise<Question[]> {
  const snap = await getDocs(
    query(
      collection(db, COL.questions),
      where('isDeleted',  '==', false),
      where('instituteId', '==', instituteId)
    )
  );
  return snap.docs.map((d) => sanitizePublic(d.data() as Question));
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
// QUESTION GROUP CRUD (Phase 1)
// ══════════════════════════════════════════════════════════════════

/** A child question as supplied to createQuestionGroup — no id yet. */
export type GroupChildDraft = Omit<
  Question,
  'id' | 'isDeleted' | 'createdAt' | 'updatedAt' | 'groupId' | 'groupOrder'
>;

export function buildEmptyGroup(kind: GroupKind): Omit<
  QuestionGroup, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'
> {
  // Default the stimulus format to the one each flavour almost always wants,
  // so the author starts in the right editor instead of switching first.
  const format: GroupStimulus['format'] =
    kind === 'di' ? 'table' : 'richtext';
  return {
    kind,
    title: '',
    stimulus: {
      format,
      body: '',
      images: [],
      ...(format === 'table' ? { table: { headers: [''], rows: [{ cells: [''] }] } } : {}),
    },
    subject: '',
    topic: '',
    tags: [],
    difficulty: 'medium',
    childIds: [],
  };
}

/**
 * Create a group and its children in ONE batch.
 *
 * Atomicity is the requirement, not an optimisation: a group whose children
 * failed to write is a passage with no questions, and a child whose group
 * failed to write is an unanswerable orphan sitting in the bank waiting to be
 * drawn into an exam by an ordinary topic rule. Firestore batches are
 * all-or-nothing, so neither half can survive alone.
 *
 * Batch limit is 500 writes. Each child costs 2 (public + answer doc) and the
 * group costs 1, so the ceiling is 249 children — far past any real DI set,
 * but asserted rather than assumed.
 */
export async function createQuestionGroup(
  data: Omit<QuestionGroup, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt' | 'childIds'>,
  children: GroupChildDraft[],
  opts?: { skipCounterBump?: boolean },
): Promise<{ group: QuestionGroup; children: Question[] }> {
  if (children.length === 0) {
    throw new Error('A question group needs at least one child question.');
  }
  if (children.length > 249) {
    throw new Error(`A question group can hold at most 249 questions (got ${children.length}).`);
  }

  const groupId = newId('grp');
  const ts = now();
  const batch = writeBatch(db);

  // Stamps flow from the group to every child — see the QuestionGroup comment.
  const ownerType = data.ownerType ?? 'webOwner';
  const ownerId   = data.ownerId   ?? 'webOwner';

  const built: Question[] = children.map((child, idx) => ({
    ...child,
    id: newId('q'),
    ownerType,
    ownerId,
    instituteId: data.instituteId,
    groupId,
    groupOrder: idx,
    isDeleted: false,
    createdAt: ts,
    updatedAt: ts,
  }));

  for (const q of built) {
    batch.set(doc(db, COL.questions, q.id), removeUndefined({ ...sanitizePublic(q) } as any));
    batch.set(
      doc(db, COL.questionAnswers, q.id),
      removeUndefined({
        id: q.id,
        ownerType,
        ownerId,
        ...emptyAnswerDefaults(),
        ...pickAnswerFields(q),
        updatedAt: ts,
      } as any),
    );
  }

  const group: QuestionGroup = {
    ...data,
    id: groupId,
    ownerType,
    ownerId,
    childIds: built.map((q) => q.id),
    isDeleted: false,
    createdAt: ts,
    updatedAt: ts,
  };
  batch.set(doc(db, COL.questionGroups, groupId), removeUndefined(group as any));

  await batch.commit();

  // Children are ordinary questions and count toward the taxonomy totals the
  // same way standalone ones do — the builder's availability numbers would
  // under-report group content otherwise.
  if (!opts?.skipCounterBump) {
    for (const q of built) {
      await bumpTaxonomyCounts({ subjectId: q.subjectId, topicId: q.topicId }, +1);
    }
  }

  console.log(`✅ [QB] createQuestionGroup → ${groupId} (${built.length} children, ${ownerType}:${ownerId})`);
  return { group, children: built };
}

export async function getQuestionGroup(id: string): Promise<QuestionGroup | null> {
  const snap = await getDoc(doc(db, COL.questionGroups, id));
  if (!snap.exists()) return null;
  const g = snap.data() as QuestionGroup;
  return g.isDeleted ? null : g;
}

/** Batch-load groups by id (chunked at Firestore's 30-value `in` limit). */
export async function getQuestionGroupsByIds(ids: string[]): Promise<QuestionGroup[]> {
  if (ids.length === 0) return [];
  const out: QuestionGroup[] = [];
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const snap = await getDocs(query(collection(db, COL.questionGroups), where('id', 'in', chunk)));
    snap.docs.forEach((d) => {
      const g = d.data() as QuestionGroup;
      if (!g.isDeleted) out.push(g);
    });
  }
  return out;
}

/**
 * All groups, unfiltered.
 *
 * webOwner surfaces only, like getAllQuestions beside it: an unfiltered query
 * is only provable under the read fence in firestore.rules for the webOwner
 * branch, so institute/faculty callers must use getQuestionGroupsByOwner.
 *
 * CALLERS MUST FAIL SOFT. This read can be denied for reasons that have
 * nothing to do with the caller's own work — rules not yet deployed being the
 * plain case, since Firestore denies any collection with no matching rule.
 * Grouped sets are ADDITIVE content, so an unreadable /questionGroups must
 * never take down whatever is being loaded alongside it. Putting this bare
 * into a Promise.all with getAllQuestions/getAllAssessments is precisely the
 * bug that emptied the assignments page and the question bank; both call sites
 * now carry an explicit .catch(() => []) and any new one needs the same.
 */
export async function getAllQuestionGroups(): Promise<QuestionGroup[]> {
  const snap = await getDocs(collection(db, COL.questionGroups));
  return snap.docs.map((d) => d.data() as QuestionGroup).filter((g) => !g.isDeleted);
}

/**
 * Owner-scoped group listing.
 * The ownerType/ownerId equality filters are what make the query provable
 * under the read fence in firestore.rules — same contract as
 * getQuestionsByOwner. Dropping them turns this into an unfiltered scan,
 * which rules reject for anyone but the webOwner.
 */
export async function getQuestionGroupsByOwner(
  ownerType: QuestionOwnerType,
  ownerId: string,
): Promise<QuestionGroup[]> {
  const snap = await getDocs(query(
    collection(db, COL.questionGroups),
    where('ownerType', '==', ownerType),
    where('ownerId', '==', ownerId),
  ));
  return snap.docs.map((d) => d.data() as QuestionGroup).filter((g) => !g.isDeleted);
}

/** Load a group together with its child questions, in stored child order. */
export async function getQuestionGroupWithChildren(
  id: string,
  opts: QuestionReadOpts = { includeAnswer: true },
): Promise<{ group: QuestionGroup; children: Question[] } | null> {
  const group = await getQuestionGroup(id);
  if (!group) return null;
  const children = await getQuestionsByIds(group.childIds, opts);
  const byId = new Map(children.map((q) => [q.id, q]));
  // Order by childIds, not by whatever the batch read returned, and skip ids
  // that no longer resolve rather than rendering a hole.
  const ordered = group.childIds.map((cid) => byId.get(cid)).filter((q): q is Question => !!q);
  return { group, children: ordered };
}

export async function updateQuestionGroup(
  id: string,
  data: Partial<Omit<QuestionGroup, 'id' | 'createdAt'>>,
): Promise<void> {
  await updateDoc(doc(db, COL.questionGroups, id), removeUndefined({ ...data, updatedAt: now() } as any));
  console.log(`✅ [QB] updateQuestionGroup → ${id}`);
}

/**
 * Soft-delete a group AND its children.
 *
 * The cascade is mandatory, not a convenience. Children are ordinary question
 * documents, so a child left alive after its group is deleted stays eligible
 * for any ordinary topic rule — and would then be drawn into an exam with its
 * stimulus gone, as an unanswerable question. Deleting the container has to
 * delete what only made sense inside it.
 */
export async function softDeleteQuestionGroup(id: string): Promise<void> {
  const snap = await getDoc(doc(db, COL.questionGroups, id));
  if (!snap.exists()) return;
  const group = snap.data() as QuestionGroup;
  if (group.isDeleted) return;

  const children = await getQuestionsByIds(group.childIds, { includeAnswer: false });
  const ts = now();
  const batch = writeBatch(db);

  batch.update(doc(db, COL.questionGroups, id), { isDeleted: true, updatedAt: ts });
  for (const child of children) {
    batch.update(doc(db, COL.questions, child.id), { isDeleted: true, updatedAt: ts });
  }
  await batch.commit();

  for (const child of children) {
    if (!child.isDeleted) {
      await bumpTaxonomyCounts({ subjectId: child.subjectId, topicId: child.topicId }, -1);
    }
  }
  console.log(`✅ [QB] softDeleteQuestionGroup → ${id} (+${children.length} children)`);
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
  if (d === 'easy')   return { bg: '#F0FBF4', text: 'var(--ef-success)', border: '#C3E8CE' };
  if (d === 'hard')   return { bg: 'var(--ef-danger-bg)', text: 'var(--ef-danger)', border: 'var(--ef-danger-border)' };
  return                     { bg: '#FFFBF0', text: 'var(--ef-warning-strong)', border: '#F0DFA0' };
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
// ── Rights-enforced write path (permission-model Phase 2) ──────────
// Institute/faculty question authoring routes through Cloud Functions that
// enforce the caller's create/edit/delete RIGHT server-side (see
// createQuestionAsRole / editQuestionAsRole / deleteQuestionAsRole in
// functions/src/index.ts). Web Owner authoring keeps using the direct
// createQuestion/updateQuestion/softDeleteQuestion path (unrestricted owner).
// The server assigns owner + tenant stamp; client-sent owner fields are
// ignored, so these wrappers just forward the assembled question payload.

export async function createQuestionAsRole(
  question: Omit<Question, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'>,
): Promise<{ id: string }> {
  const call = httpsCallable<
    { question: typeof question; subjectId?: string | null; topicId?: string | null },
    { ok: boolean; id: string }
  >(functions, 'createQuestionAsRole');
  const res = await call({
    question,
    subjectId: question.subjectId ?? null,
    topicId:   question.topicId ?? null,
  });
  return { id: res.data.id };
}

/**
 * Bulk-create questions through the rights-gated callable, in chunks.
 *
 * Audit S-02: bulk upload used to write straight to Firestore, so it bypassed
 * the ceiling and per-faculty grants that single-create respects. Chunking
 * rather than one call per row is what keeps the fix from costing minutes on a
 * large import — see createQuestionsBulkAsRole for the sizing rationale.
 *
 * CHUNK_SIZE mirrors the server's BULK_CREATE_MAX_PER_CALL. If you raise one,
 * raise the other: the server rejects anything larger, so a client that sends
 * more just fails every call.
 *
 * onProgress reports questions completed, so the caller can drive a progress
 * bar over the whole import rather than per chunk.
 */
const BULK_CREATE_CHUNK_SIZE = 200;

export async function createQuestionsBulkAsRole(
  items: Array<{
    question: Omit<Question, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'>;
    subjectId?: string | null;
    topicId?: string | null;
  }>,
  onProgress?: (done: number, total: number) => void,
): Promise<{ ids: string[]; skipped: number }> {
  const call = httpsCallable<
    { items: typeof items },
    { ok: boolean; ids: string[]; skipped: number[] }
  >(functions, 'createQuestionsBulkAsRole');

  const ids: string[] = [];
  let skippedCount = 0;
  for (let i = 0; i < items.length; i += BULK_CREATE_CHUNK_SIZE) {
    const chunk = items.slice(i, i + BULK_CREATE_CHUNK_SIZE);
    const res = await call({ items: chunk });
    ids.push(...(res.data.ids ?? []));
    skippedCount += (res.data.skipped ?? []).length;
    onProgress?.(Math.min(i + chunk.length, items.length), items.length);
  }
  return { ids, skipped: skippedCount };
}

export async function editQuestionAsRole(
  id: string,
  patch: Partial<Question>,
  taxonomy?: { prevSubjectId?: string | null; prevTopicId?: string | null },
): Promise<void> {
  const call = httpsCallable<
    {
      id: string; question: Partial<Question>;
      subjectId?: string | null; topicId?: string | null;
      prevSubjectId?: string | null; prevTopicId?: string | null;
    },
    { ok: boolean }
  >(functions, 'editQuestionAsRole');
  await call({
    id, question: patch,
    subjectId: patch.subjectId ?? null,
    topicId:   patch.topicId ?? null,
    prevSubjectId: taxonomy?.prevSubjectId ?? null,
    prevTopicId:   taxonomy?.prevTopicId ?? null,
  });
}

export async function deleteQuestionAsRole(
  id: string,
  taxonomy?: { subjectId?: string | null; topicId?: string | null },
): Promise<void> {
  const call = httpsCallable<
    { id: string; subjectId?: string | null; topicId?: string | null },
    { ok: boolean }
  >(functions, 'deleteQuestionAsRole');
  await call({ id, subjectId: taxonomy?.subjectId ?? null, topicId: taxonomy?.topicId ?? null });
}

// ── Question groups as institute/faculty (Phase 1) ────────────────
// firestore.rules allows direct /questionGroups writes for the webOwner
// only, so institute and faculty go through these callables — which is where
// assertQuestionRight enforces the rights ceiling. They reuse the EXISTING
// create/edit/delete question rights: authoring a DI set is authoring
// questions, and a group-specific right would mean every ceiling already
// configured on the platform silently failed to cover the new content type.

export async function createQuestionGroupAsRole(
  group: Omit<QuestionGroup, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt' | 'childIds'>,
  children: GroupChildDraft[],
): Promise<{ id: string; childIds: string[] }> {
  const call = httpsCallable<
    { group: typeof group; children: GroupChildDraft[]; subjectId?: string | null; topicId?: string | null },
    { ok: boolean; id: string; childIds: string[] }
  >(functions, 'createQuestionGroupAsRole');
  const res = await call({
    group,
    children,
    subjectId: group.subjectId ?? null,
    topicId:   group.topicId ?? null,
  });
  return { id: res.data.id, childIds: res.data.childIds };
}

export async function editQuestionGroupAsRole(
  id: string,
  group: Partial<Omit<QuestionGroup, 'id' | 'createdAt' | 'childIds'>>,
): Promise<void> {
  const call = httpsCallable<{ id: string; group: typeof group }, { ok: boolean }>(
    functions, 'editQuestionGroupAsRole',
  );
  await call({ id, group });
}

export async function deleteQuestionGroupAsRole(
  id: string,
  taxonomy?: { subjectId?: string | null; topicId?: string | null },
): Promise<{ deletedChildren: number }> {
  const call = httpsCallable<
    { id: string; subjectId?: string | null; topicId?: string | null },
    { ok: boolean; deletedChildren: number }
  >(functions, 'deleteQuestionGroupAsRole');
  const res = await call({
    id,
    subjectId: taxonomy?.subjectId ?? null,
    topicId:   taxonomy?.topicId ?? null,
  });
  return { deletedChildren: res.data.deletedChildren };
}

/**
 * Create a group as whichever role the caller holds.
 *
 * The webOwner writes directly (rules permit it and there is no ceiling to
 * enforce against the platform owner — assertQuestionRight has no webOwner
 * branch by design); institute and faculty go through the callable. Same
 * split as the question path, kept here so callers do not each re-derive it.
 */
export async function saveQuestionGroupForRole(
  ownerType: QuestionOwnerType,
  group: Omit<QuestionGroup, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt' | 'childIds'>,
  children: GroupChildDraft[],
): Promise<{ id: string; childIds: string[] }> {
  if (ownerType === 'webOwner') {
    const res = await createQuestionGroup(group, children);
    return { id: res.group.id, childIds: res.children.map((c) => c.id) };
  }
  return createQuestionGroupAsRole(group, children);
}

export async function deleteQuestionGroupForRole(
  ownerType: QuestionOwnerType,
  id: string,
  taxonomy?: { subjectId?: string | null; topicId?: string | null },
): Promise<void> {
  if (ownerType === 'webOwner') {
    await softDeleteQuestionGroup(id);
    return;
  }
  await deleteQuestionGroupAsRole(id, taxonomy);
}

export async function updateQuestionGroupForRole(
  ownerType: QuestionOwnerType,
  id: string,
  group: Partial<Omit<QuestionGroup, 'id' | 'createdAt' | 'childIds'>>,
): Promise<void> {
  if (ownerType === 'webOwner') {
    await updateQuestionGroup(id, group);
    return;
  }
  await editQuestionGroupAsRole(id, group);
}

export async function shareQuestionsAsRole(
  questionIds: string[],
  recipients: Array<{ id: string; type: 'faculty' | 'institute' }>,
  note?: string,
): Promise<{ shareIds: string[] }> {
  const call = httpsCallable<
    { questionIds: string[]; recipients: Array<{ id: string; type: 'faculty' | 'institute' }>; note?: string },
    { ok: boolean; shareIds: string[] }
  >(functions, 'shareQuestionsAsRole');
  const res = await call({ questionIds, recipients, note });
  return { shareIds: res.data.shareIds };
}