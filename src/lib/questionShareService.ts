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
import { removeUndefined } from './firestoreSanitize';
import { getQuestionsByIds, type Question } from './questionBankService';

// ══════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ══════════════════════════════════════════════════════════════════

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function now(): string {
  return new Date().toISOString();
}

// ══════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ══════════════════════════════════════════════════════════════════

/**
 * QuestionShare — peer-level sharing of questions.
 *
 * Two use-cases:
 *   1. Institute Admin → Faculty     (sharedByType: 'institute')
 *      Institute shares its own questions (ownerType:'institute') with a faculty member.
 *
 *   2. Faculty → Faculty / Institute Admin   (sharedByType: 'faculty')
 *      A faculty member shares their own questions with peers or the institute admin.
 *
 * questionIds are LIVE references — the recipient always sees the latest
 * version of each question. Questions that are soft-deleted are filtered
 * out at resolve time.
 */
export type QuestionShareType = 'institute' | 'faculty';

export type QuestionShare = {
  id: string;

  // ── Sender ─────────────────────────────────────────────────────
  sharedBy:            string;             // instituteId or facultyId
  sharedByType:        QuestionShareType;  // 'institute' | 'faculty'
  sharedByInstituteId: string;             // always the institute context

  // ── Recipient ──────────────────────────────────────────────────
  sharedWith:          string;             // facultyId or instituteId
  sharedWithType:      QuestionShareType;  // 'faculty' | 'institute'

  // ── Questions ──────────────────────────────────────────────────
  // Live references — NOT frozen snapshots.
  questionIds:         string[];

  // ── Optional label ─────────────────────────────────────────────
  note: string;

  // ── System ─────────────────────────────────────────────────────
  isRevoked: boolean;
  sharedAt:  string;
  updatedAt: string;
};

// ── Resolved view (convenience, not stored) ───────────────────────

export type ResolvedQuestionShare = {
  share:     QuestionShare;
  questions: Question[];         // live-resolved, filtered for isDeleted
};

// ══════════════════════════════════════════════════════════════════
// COLLECTION NAME
// ══════════════════════════════════════════════════════════════════

const COL = 'questionShares';

// ══════════════════════════════════════════════════════════════════
// QUESTION SHARE CRUD
// ══════════════════════════════════════════════════════════════════

/**
 * Create a new question share.
 *
 * Institute Admin sharing their own questions with a faculty member:
 *   sharedByType: 'institute', sharedWithType: 'faculty'
 *
 * Faculty sharing their own questions with another faculty or the institute admin:
 *   sharedByType: 'faculty', sharedWithType: 'faculty' | 'institute'
 */
export async function createQuestionShare(data: {
  sharedBy:            string;
  sharedByType:        QuestionShareType;
  sharedByInstituteId: string;
  sharedWith:          string;
  sharedWithType:      QuestionShareType;
  questionIds:         string[];
  note?:               string;
}): Promise<QuestionShare> {
  const id = newId('qs');
  const share: QuestionShare = {
    id,
    sharedBy:            data.sharedBy,
    sharedByType:        data.sharedByType,
    sharedByInstituteId: data.sharedByInstituteId,
    sharedWith:          data.sharedWith,
    sharedWithType:      data.sharedWithType,
    questionIds:         data.questionIds,
    note:                data.note ?? '',
    isRevoked:           false,
    sharedAt:            now(),
    updatedAt:           now(),
  };
  await setDoc(doc(db, COL, id), removeUndefined(share));
  console.log(
    `✅ [QS] createQuestionShare → ${id} ` +
    `(${data.sharedByType}:${data.sharedBy} → ${data.sharedWithType}:${data.sharedWith})`
  );
  return share;
}

/** Fetch a single share by id. */
export async function getQuestionShare(id: string): Promise<QuestionShare | null> {
  const snap = await getDoc(doc(db, COL, id));
  if (!snap.exists()) return null;
  return snap.data() as QuestionShare;
}

/**
 * Fetch all shares sent TO a specific recipient (faculty or institute admin).
 * Includes both active and revoked — caller filters as needed.
 */
export async function getSharesForRecipient(
  sharedWith: string
): Promise<QuestionShare[]> {
  const snap = await getDocs(
    query(collection(db, COL), where('sharedWith', '==', sharedWith))
  );
  return snap.docs.map((d) => d.data() as QuestionShare);
}

/**
 * Fetch all active (non-revoked) shares received by a recipient.
 */
export async function getActiveSharesForRecipient(
  sharedWith: string
): Promise<QuestionShare[]> {
  const all = await getSharesForRecipient(sharedWith);
  return all.filter((s) => !s.isRevoked);
}

/**
 * Fetch all shares issued BY a specific sender.
 * Includes active and revoked.
 */
export async function getSharesByIssuer(
  sharedBy: string
): Promise<QuestionShare[]> {
  const snap = await getDocs(
    query(collection(db, COL), where('sharedBy', '==', sharedBy))
  );
  return snap.docs.map((d) => d.data() as QuestionShare);
}

/**
 * Fetch all shares issued within a specific institute context.
 * Useful for the Institute Admin to see all outgoing shares (from themselves
 * and from faculty) within their institute.
 */
export async function getSharesByInstituteContext(
  instituteId: string
): Promise<QuestionShare[]> {
  const snap = await getDocs(
    query(collection(db, COL), where('sharedByInstituteId', '==', instituteId))
  );
  return snap.docs.map((d) => d.data() as QuestionShare);
}

/** Revoke a question share. The recipient can no longer access the questions via this share. */
export async function revokeQuestionShare(shareId: string): Promise<void> {
  await updateDoc(doc(db, COL, shareId), {
    isRevoked: true,
    updatedAt: now(),
  });
  console.log(`✅ [QS] revokeQuestionShare → ${shareId}`);
}

/** Restore a previously revoked share. */
export async function restoreQuestionShare(shareId: string): Promise<void> {
  await updateDoc(doc(db, COL, shareId), {
    isRevoked: false,
    updatedAt: now(),
  });
  console.log(`✅ [QS] restoreQuestionShare → ${shareId}`);
}

/**
 * Update the question list on an existing share.
 * Can be used to add or remove questions from an active share.
 */
export async function updateQuestionShareIds(
  shareId: string,
  questionIds: string[]
): Promise<void> {
  await updateDoc(doc(db, COL, shareId), {
    questionIds,
    updatedAt: now(),
  });
  console.log(`✅ [QS] updateQuestionShareIds → ${shareId} (${questionIds.length} questions)`);
}

/** Update the note on an existing share. */
export async function updateQuestionShareNote(
  shareId: string,
  note: string
): Promise<void> {
  await updateDoc(doc(db, COL, shareId), { note, updatedAt: now() });
}

// ══════════════════════════════════════════════════════════════════
// RESOLUTION UTILITIES
// ══════════════════════════════════════════════════════════════════

/**
 * Resolve a single share into its live questions.
 * Questions soft-deleted after the share was created are excluded.
 */
export async function resolveShare(
  share: QuestionShare
): Promise<ResolvedQuestionShare> {
  const questions = await getQuestionsByIds(share.questionIds);
  return { share, questions };
}

/**
 * Resolve all active shares received by a recipient into a flat, deduplicated
 * list of questions.
 *
 * Used for the Faculty "Received" tab — merges questions from:
 *   - Institute Admin shares (sharedByType: 'institute')
 *   - Peer faculty shares   (sharedByType: 'faculty')
 * into one unified list, deduped by question id.
 */
export async function getFlatReceivedQuestions(
  recipientId: string,
  // Recipient's institute — shares are strictly intra-institute, so the
  // batch declares a same-institute scope for tenant-fence provability.
  instituteId?: string,
): Promise<{ shares: QuestionShare[]; questions: Question[] }> {
  const shares = await getActiveSharesForRecipient(recipientId);
  const seen   = new Set<string>();
  const out:   Question[] = [];

  for (const share of shares) {
    const questions = await getQuestionsByIds(
      share.questionIds,
      undefined,
      instituteId ? { instituteId } : undefined,
    );
    for (const q of questions) {
      if (!seen.has(q.id)) {
        seen.add(q.id);
        out.push(q);
      }
    }
  }

  return { shares, questions: out };
}