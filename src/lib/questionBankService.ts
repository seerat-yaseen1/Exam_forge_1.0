import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  getDocs,
  query,
  where,
} from 'firebase/firestore';
import { db } from './firebase';

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
  subject: string;
  topic: string;
  tags: string[];
  difficulty: Difficulty;
  explanation: string;        // optional solution explanation

  // ── Ownership (Phase 1 addition) ──
  // ownerType missing / undefined → treated as 'webOwner' (backward compat)
  ownerType?: QuestionOwnerType;
  ownerId?: string;            // instituteId, facultyId, or 'webOwner'

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
  questionBanks:   'questionBanks',
  bankGrants:      'bankGrants',
  instituteGrants: 'instituteGrants',
  questionShares:  'questionShares',
} as const;

// ══════════════════════════════════════════════════════════════════
// QUESTION CRUD
// ══════════════════════════════════════════════════════════════════

/** Create a new question. Defaults ownerType/ownerId to 'webOwner' if omitted. */
export async function createQuestion(
  data: Omit<Question, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'>
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
  const ref = doc(db, COL.questions, id);
  await setDoc(ref, removeUndefined(question as any));
  console.log(`✅ [QB] createQuestion → ${id} (${question.ownerType}:${question.ownerId})`);
  return question;
}

/** Fetch a single question by id (returns null if not found or deleted). */
export async function getQuestion(id: string): Promise<Question | null> {
  const snap = await getDoc(doc(db, COL.questions, id));
  if (!snap.exists()) return null;
  const data = snap.data() as Question;
  return data.isDeleted ? null : data;
}

/**
 * Batch-fetch questions by an array of IDs.
 * Firestore `in` operator cap is 30 — automatically chunks the request.
 * Deleted questions are excluded from the result.
 */
export async function getQuestionsByIds(ids: string[]): Promise<Question[]> {
  if (ids.length === 0) return [];
  const results: Question[] = [];
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const q = query(collection(db, COL.questions), where('id', 'in', chunk));
    const snap = await getDocs(q);
    snap.docs.forEach((d) => {
      const data = d.data() as Question;
      if (!data.isDeleted) results.push(data);
    });
  }
  return results;
}

/**
 * Fetch ALL non-deleted Web Owner questions (global pool).
 * Returns questions where ownerType === 'webOwner' OR ownerType is absent
 * (backward compat for questions created before Phase 1).
 */
export async function getAllQuestions(): Promise<Question[]> {
  const snap = await getDocs(
    query(collection(db, COL.questions), where('isDeleted', '==', false))
  );
  return snap.docs
    .map((d) => d.data() as Question)
    .filter((q) => !q.ownerType || q.ownerType === 'webOwner');
}

/**
 * Fetch all non-deleted questions for a specific owner.
 * Used by Institute Admin and Faculty question pages.
 */
export async function getQuestionsByOwner(
  ownerType: QuestionOwnerType,
  ownerId: string
): Promise<Question[]> {
  const snap = await getDocs(
    query(
      collection(db, COL.questions),
      where('isDeleted',  '==', false),
      where('ownerType',  '==', ownerType),
      where('ownerId',    '==', ownerId)
    )
  );
  return snap.docs.map((d) => d.data() as Question);
}

/** Update question metadata or content. Always bumps updatedAt. */
export async function updateQuestion(
  id: string,
  data: Partial<Omit<Question, 'id' | 'createdAt'>>
): Promise<void> {
  const ref = doc(db, COL.questions, id);
  await updateDoc(ref, removeUndefined({ ...data, updatedAt: now() } as any));
  console.log(`✅ [QB] updateQuestion → ${id}`);
}

/**
 * Soft-delete a question.
 * NOTE: existing grants that reference this question are NOT automatically updated.
 * Downstream consumers should filter out isDeleted === true when resolving grants.
 */
export async function softDeleteQuestion(id: string): Promise<void> {
  await updateDoc(doc(db, COL.questions, id), {
    isDeleted: true,
    updatedAt: now(),
  });
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
    const questions = await getQuestionsByIds(grant.snapshotQuestionIds);
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

    const questions = await getQuestionsByIds(grant.questionIds);
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