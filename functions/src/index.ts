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
import { onSchedule } from 'firebase-functions/v2/scheduler';
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
    // ext #16 (server half, identity paths): the bulk student/faculty upload
    // modals validate rows client-side only — anything reaching this endpoint
    // is re-validated here so a crafted call can't create malformed accounts.
    // (Question bulk-upload validation is a separate rules-side design.)
    {
      const emailStr = String(profile.email).trim();
      const nameStr  = String(profile.name).trim();
      if (emailStr.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr)) {
        throw new HttpsError('invalid-argument', 'Invalid email address.');
      }
      if (nameStr.length < 1 || nameStr.length > 120) {
        throw new HttpsError('invalid-argument', 'Name must be between 1 and 120 characters.');
      }
      if (password.length > 128) {
        throw new HttpsError('invalid-argument', 'Password must be at most 128 characters.');
      }
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
  /**
   * Faculty only (Feature #15, Phase 5a). Another active faculty member in the
   * same institute to inherit this person's questions, banks and assessments.
   * Omitted ⇒ the institute admin inherits, which is the safe default and the
   * only target guaranteed to exist.
   */
  successorId?: string;
  /** Set once the admin has acknowledged live-exam ownership. */
  confirmLiveOwnership?: boolean;
  /**
   * Institute only (Feature #15, Phase 5b). WebOwner-owned assessments whose
   * attempts by this institute's students should ALSO be deleted. Absent ⇒
   * none, which is the safe default: a cascade that destroys the Web Owner's
   * own exam history by omission is the worst failure mode available here.
   */
  deleteAttemptsOnWebOwnerAssessments?: string[];
}

const CREDENTIALS_BY_ROLE: Partial<Record<Role, string>> = {
  institute: 'instituteCredentials',
  faculty: 'facultyCredentials',
  student: 'studentCredentials',
};

// ── Deletion rights enforcement (Feature #15, Phase 3) ────────────
// Server twin of src/lib/deletionRights.ts. THIS IS THE GATE — the client
// mirrors this logic to shape its UI, but this copy is what decides.
// KEEP IN SYNC with the client module.
//
// Closes bug (f): until now deleteAuthUser had ROLE gating (institute may
// delete faculty/students, faculty may delete students, tenant-matched) but
// no RIGHTS check at all. Any faculty member could delete any student in
// their institute, ungoverned — the widest blast radius on the platform with
// the least oversight.

type DeletionModeS = 'direct' | 'request';
type DeletableResourceS =
  | 'institute' | 'faculty' | 'student' | 'assessment' | 'questionBank' | 'subjectTopic' | 'attempt';

type DeletionCeilingRightS = { allowed?: boolean; modes?: DeletionModeS[]; selfMode?: DeletionModeS };
type DeletionCeilingS = Partial<Record<DeletableResourceS, DeletionCeilingRightS>>;
type FacultyDeletionRightsS = Partial<Record<DeletableResourceS, { granted?: boolean; mode?: DeletionModeS }>>;

/**
 * Resources no institute may ever hold, whatever a stored ceiling says.
 * Twin of WEBOWNER_ONLY_RESOURCES in the client module.
 *
 *   attempt   — attempts are the audit trail; a tenant that can delete them
 *               can delete the evidence of what happened in an exam.
 *   institute — a tenant deleting tenants is a containment breach, including
 *               deleting itself (which would strand every user under it).
 */
const WEBOWNER_ONLY_S: DeletableResourceS[] = ['attempt', 'institute'];

/**
 * The effective deletion mode for an actor on a resource: 'direct' (do it
 * now), 'request' (needs approval — Phase 4), or 'none' (not permitted).
 *
 * Fails closed on every missing input: no ceiling, no grant, or a grant whose
 * mode the ceiling no longer permits all yield 'none'.
 */
function resolveDeletionModeS(
  callerRole: string | undefined,
  resource: DeletableResourceS,
  ceiling: DeletionCeilingS | undefined,
  facultyRights: FacultyDeletionRightsS | undefined,
): DeletionModeS | 'none' {
  if (callerRole === 'webOwner') return 'direct';

  // Forced off regardless of what the ceiling document contains.
  if (WEBOWNER_ONLY_S.includes(resource)) return 'none';

  const c = ceiling?.[resource];
  if (!c?.allowed) return 'none';

  if (callerRole === 'institute') {
    // Absent selfMode reads as 'direct' — matches the client default and the
    // questionRights shape, which has no equivalent field.
    return c.selfMode === 'request' ? 'request' : 'direct';
  }

  if (callerRole === 'faculty') {
    const fr = facultyRights?.[resource];
    if (!fr?.granted || !fr.mode) return 'none';
    // A ceiling narrowed AFTER the grant must bite immediately, without
    // needing every faculty document to be rewritten.
    if (!(c.modes ?? []).includes(fr.mode)) return 'none';
    return fr.mode;
  }

  return 'none';
}

// ── Ownership succession (Feature #15, Phase 5a) ──────────────────
//
// When a faculty member is removed, their content must go somewhere. Left
// alone it becomes UNWRITABLE BY EVERYONE: canWriteOwned in firestore.rules
// grants write/delete to whoever matches ownerId, so a question owned by a
// deleted uid can be read (the tenant stamp survives) but never edited or
// removed again. Stranded, maintainable by nobody.
//
// DEFAULT SUCCESSOR = THE INSTITUTE ADMIN. It is the one target that always
// exists as long as the institute does, so it can never fail and needs nobody
// to choose anything — which is what makes it safe for bulk deletes and for
// cascades where no human is present.
//
// ONE HOP, ALWAYS. If A's content passed to B and B now leaves, B's content
// (including A's) goes to the institute admin — never onward to whoever B
// once named. Chains are unreadable and make restore ambiguous.
//
// The previous owner is recorded on the AUDIT ROW, not on the content: the
// content doc only carries its CURRENT owner, so once succession rewrites
// ownerId the original is gone from it. The row is the only record, and is
// what will let Phase 6 reverse a succession on restore.

type SuccessionOutcomeS = {
  toOwnerType: 'institute' | 'faculty';
  toOwnerId: string;
  reason: 'chosen' | 'defaulted' | 'fallback';
  counts: Record<string, number>;
};

/** Rewrite ownerType/ownerId across one collection, in batches. */
async function reassignOwned(
  db: FirebaseFirestore.Firestore,
  collection: string,
  fromOwnerId: string,
  to: { ownerType: string; ownerId: string },
): Promise<number> {
  let moved = 0;
  try {
    const snap = await db.collection(collection)
      .where('ownerType', '==', 'faculty')
      .where('ownerId', '==', fromOwnerId)
      .get();
    let batch = db.batch();
    let n = 0;
    for (const d of snap.docs) {
      const patch: Record<string, unknown> = {
        ownerType: to.ownerType,
        ownerId: to.ownerId,
        updatedAt: new Date().toISOString(),
      };
      // Preserve authorship. "Who controls this now" changes; "who wrote it"
      // must not. Only stamped if absent, so a second succession never
      // overwrites the true original author with an intermediate holder.
      if (d.get('originalOwnerId') === undefined) {
        patch.originalOwnerType = 'faculty';
        patch.originalOwnerId = fromOwnerId;
      }
      batch.update(d.ref, patch);
      moved++;
      if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
    }
    if (n > 0) await batch.commit();
  } catch (err) {
    console.error('reassignOwned failed', collection, fromOwnerId, err);
  }
  return moved;
}

/**
 * Move a departing faculty member's content to a successor.
 *
 * The chosen successor is validated HERE, at execution time — not when it was
 * picked. A request can sit in an approval inbox for days; a colleague chosen
 * on Monday may be archived or deleted by Thursday. Trusting a selection-time
 * check would transfer content to a dead account.
 */
async function performFacultySuccession(
  db: FirebaseFirestore.Firestore,
  facultyId: string,
  instituteId: string,
  chosenSuccessorId?: string | null,
): Promise<SuccessionOutcomeS> {
  let to: { ownerType: 'institute' | 'faculty'; ownerId: string } =
    { ownerType: 'institute', ownerId: instituteId };
  let reason: SuccessionOutcomeS['reason'] = 'defaulted';

  if (chosenSuccessorId && chosenSuccessorId !== facultyId) {
    const sucSnap = await db.collection('faculty').doc(chosenSuccessorId).get();
    const valid = sucSnap.exists
      && sucSnap.get('instituteId') === instituteId
      && sucSnap.get('status') !== 'disabled'
      && sucSnap.get('lifecycleState') !== 'softDeleted'
      && sucSnap.get('lifecycleState') !== 'archived';
    if (valid) {
      to = { ownerType: 'faculty', ownerId: chosenSuccessorId };
      reason = 'chosen';
    } else {
      // An intent existed and could not be honoured — distinct from nobody
      // having chosen, and worth surfacing to whoever chose.
      reason = 'fallback';
    }
  }

  const [questions, questionBanks, assessments] = await Promise.all([
    reassignOwned(db, 'questions', facultyId, to),
    reassignOwned(db, 'questionBanks', facultyId, to),
    reassignOwned(db, 'assessments', facultyId, to),
  ]);

  return {
    toOwnerType: to.ownerType,
    toOwnerId: to.ownerId,
    reason,
    counts: { questions, questionBanks, assessments },
  };
}

/**
 * Does this faculty member own assessments that are LIVE right now?
 *
 * Deleting the owner of a running exam is the one case succession does not
 * make safe: students may be mid-attempt, and an ownership change during a
 * sitting is a variable nobody wants in an exam-integrity story. The caller
 * blocks and asks for reassignment first.
 */
async function countLiveOwnedAssessments(
  db: FirebaseFirestore.Firestore,
  facultyId: string,
): Promise<number> {
  try {
    const snap = await db.collection('assessments')
      .where('ownerType', '==', 'faculty')
      .where('ownerId', '==', facultyId)
      .where('status', '==', 'active')
      .count().get();
    return snap.data().count;
  } catch (err) {
    console.error('countLiveOwnedAssessments failed', facultyId, err);
    // Fail CLOSED: if we cannot prove nothing is live, treat it as live.
    return 1;
  }
}

// ── Institute cascade (Feature #15, Phase 5b) ─────────────────────
//
// CLOSES BUG (a). Until now, deleting an institute removed only its own
// profile, credentials and logo. Its faculty, students, assessments,
// questions, banks, attempts and mappings were left behind — still stamped
// with the id of a tenant that no longer existed, invisible to everyone but
// the Web Owner, and impossible to clean up through any UI.
//
// LOCKED DECISION (D4): "institute goes so goes with their data". The chain
// is purge institute → purge its students → purge their attempts. This is the
// ONE path permitted to destroy attempt data outside the Phase 7 erasure
// flow, and it is permitted only because the students themselves are going.
//
// THE ONE EXCEPTION, and it is the Web Owner's call:
// A WEBOWNER-OWNED assessment survives the wipe — ownership was never the
// institute's, and who sat the exam does not determine who owns it. But the
// attempts on it by this institute's students are a genuine judgement call:
//   • if that assessment was ONLY ever sat by this institute's students, its
//     results are worthless once they are gone — deleting is reasonable
//   • if it spans several institutes, deleting would silently gut a
//     cross-institute exam's results and analytics with no record of why
// So the caller passes an explicit list of webOwner assessment ids whose
// attempts should ALSO go. Absent ⇒ none of them, which is the safe default:
// a cascade that destroys the Web Owner's own exam history by omission would
// be the worst possible failure mode here.

/** Delete every doc matching one equality filter, in batches. Returns the count. */
async function purgeWhere(
  db: FirebaseFirestore.Firestore,
  collection: string,
  field: string,
  value: string,
): Promise<number> {
  let removed = 0;
  try {
    const snap = await db.collection(collection).where(field, '==', value).get();
    let batch = db.batch();
    let n = 0;
    for (const d of snap.docs) {
      batch.delete(d.ref);
      removed++;
      if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
    }
    if (n > 0) await batch.commit();
  } catch (err) {
    console.error('purgeWhere failed', collection, field, value, err);
  }
  return removed;
}

/**
 * Remove an assessment's materialized membership and its allocation doc.
 *
 * Fixes a long-parked orphan: deleteAssessment never cleaned up
 * assessmentMembers or the allocations doc, so soft-deleted assessments left
 * member rows behind indefinitely. Harmless in isolation (the student query
 * joins against live assessment docs) but it accumulates, and at institute
 * purge it would leave rows pointing at assessments that no longer exist.
 */
async function purgeAssessmentSatellites(
  db: FirebaseFirestore.Firestore,
  assessmentId: string,
): Promise<{ members: number; allocations: number }> {
  const members = await purgeWhere(db, 'assessmentMembers', 'assessmentId', assessmentId);
  let allocations = 0;
  try {
    await db.collection('allocations').doc(assessmentId).delete();
    allocations = 1;
  } catch {
    // No allocation doc — normal for legacy-targeted assessments.
  }
  return { members, allocations };
}

/**
 * Purge everything belonging to an institute.
 *
 * Ordered leaves-first: satellites before their parents, content before the
 * accounts that own it, accounts before the institute itself. If the run dies
 * partway, what remains is still reachable from the institute doc — the
 * opposite order would strand orphans with nothing pointing at them.
 *
 * Auth users are removed alongside their profiles; a profile deleted without
 * its Auth user leaves a credential that can still sign in.
 */
async function performInstituteCascade(
  db: FirebaseFirestore.Firestore,
  instituteId: string,
  opts: { deleteAttemptsOnWebOwnerAssessments?: string[] } = {},
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  // 1. Assessments owned by this institute (and their satellites).
  let memberRows = 0;
  let allocationRows = 0;
  const ownAssessments = await db.collection('assessments')
    .where('ownerType', '==', 'institute')
    .where('ownerId', '==', instituteId)
    .get()
    .catch(() => null);

  if (ownAssessments) {
    for (const a of ownAssessments.docs) {
      const sat = await purgeAssessmentSatellites(db, a.id);
      memberRows += sat.members;
      allocationRows += sat.allocations;
      // Attempts on the institute's OWN assessments go unconditionally —
      // both the exam and the people who sat it are being destroyed.
      counts.attempts = (counts.attempts ?? 0)
        + await purgeWhere(db, 'attempts', 'assessmentId', a.id);
      await a.ref.delete().catch(() => undefined);
    }
    counts.assessments = ownAssessments.size;
  }

  // 2. Attempts on WEBOWNER-owned assessments — only where the Web Owner
  //    explicitly said so. Default is to keep them.
  for (const assessmentId of opts.deleteAttemptsOnWebOwnerAssessments ?? []) {
    const snap = await db.collection('attempts')
      .where('assessmentId', '==', assessmentId)
      .where('instituteId', '==', instituteId)
      .get()
      .catch(() => null);
    if (!snap) continue;
    let batch = db.batch();
    let n = 0;
    for (const d of snap.docs) {
      batch.delete(d.ref);
      counts.attempts = (counts.attempts ?? 0) + 1;
      if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
    }
    if (n > 0) await batch.commit();
    // Their membership rows go with them; the assessment itself stays.
    memberRows += await purgeWhere(db, 'assessmentMembers', 'assessmentId', assessmentId);
  }

  counts.assessmentMembers = memberRows;
  counts.allocations = allocationRows;

  // 3. Content owned by the institute or its faculty.
  counts.questions = await purgeWhere(db, 'questions', 'instituteId', instituteId);
  counts.questionBanks = await purgeWhere(db, 'questionBanks', 'instituteId', instituteId);
  counts.questionShares = await purgeWhere(db, 'questionShares', 'instituteId', instituteId);
  counts.questionReports = await purgeWhere(db, 'questionReports', 'instituteId', instituteId);

  // 4. Academic hierarchy + mappings.
  counts.academicMappings = await purgeWhere(db, 'academicMappings', 'instituteId', instituteId);
  for (const c of HIERARCHY_COLLECTIONS) {
    counts[c] = await purgeWhere(db, c, 'instituteId', instituteId);
  }

  // 5. People — Auth user first, then profile and credentials. Any remaining
  //    attempts belonging to these students go with them (D4).
  for (const [col, credCol] of [
    ['students', 'studentCredentials'],
    ['faculty', 'facultyCredentials'],
  ] as const) {
    const snap = await db.collection(col).where('instituteId', '==', instituteId).get()
      .catch(() => null);
    if (!snap) continue;
    for (const d of snap.docs) {
      if (col === 'students') {
        counts.attempts = (counts.attempts ?? 0)
          + await purgeWhere(db, 'attempts', 'studentId', d.id);
        // Also by studentId, not only by instituteId above: QuestionReport
        // types instituteId as OPTIONAL, so any report written before that
        // field existed would otherwise survive its own institute's purge as
        // an unreachable orphan. Current code always sets it; this covers the
        // legacy tail. purgeWhere is idempotent, so the overlap is harmless.
        counts.questionReports = (counts.questionReports ?? 0)
          + await purgeWhere(db, 'questionReports', 'studentId', d.id);
      }
      try {
        await getAuth().deleteUser(d.id);
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code !== 'auth/user-not-found') {
          console.error('cascade: auth delete failed', d.id, err);
        }
      }
      await db.collection(credCol).doc(d.id).delete().catch(() => undefined);
      await d.ref.delete().catch(() => undefined);
    }
    counts[col] = snap.size;
  }

  // 6. Requests and grants referencing this tenant.
  counts.deletionRequests = await purgeWhere(db, 'deletionRequests', 'instituteId', instituteId);
  counts.questionRequests = await purgeWhere(db, 'questionRequests', 'instituteId', instituteId);

  return counts;
}

/**
 * Classify the WEBOWNER-owned assessments this institute's students have sat,
 * so the Web Owner can decide per assessment whether the attempts go too.
 *
 * EXCLUSIVE — every attempt on it came from this institute. Its results become
 *             meaningless once they are gone, so deleting is reasonable.
 * SHARED     — other institutes sat it too. Deleting would silently remove a
 *             slice of a cross-institute exam's history.
 *
 * Read-only; safe to call whenever.
 */
export const getInstitutePurgePreview = onCall<{ instituteId: string }>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    if ((request.auth.token.role as string) !== 'webOwner') {
      throw new HttpsError('permission-denied', 'Only the Web Owner may inspect an institute purge.');
    }
    const { instituteId } = request.data || ({} as never);
    if (!instituteId) throw new HttpsError('invalid-argument', 'instituteId is required.');

    const db = getFirestore();

    // Every assessment this tenant's students have attempted.
    const attemptSnap = await db.collection('attempts')
      .where('instituteId', '==', instituteId)
      .select('assessmentId')
      .get();
    const assessmentIds = Array.from(
      new Set(attemptSnap.docs.map((d) => d.get('assessmentId') as string).filter(Boolean)),
    );

    const rows: Array<{
      assessmentId: string;
      title: string | null;
      ownAttempts: number;
      otherInstituteAttempts: number | null;
      exclusive: boolean;
    }> = [];

    for (const id of assessmentIds) {
      const aSnap = await db.collection('assessments').doc(id).get();
      // Only webOwner-owned assessments are a question at all — the
      // institute's own go unconditionally, and there is nothing to decide.
      if (!aSnap.exists || aSnap.get('ownerType') !== 'webOwner') continue;

      const own = attemptSnap.docs.filter((d) => d.get('assessmentId') === id).length;
      let total: number | null = null;
      try {
        const totalSnap = await db.collection('attempts')
          .where('assessmentId', '==', id).count().get();
        total = totalSnap.data().count;
      } catch (err) {
        console.error('purge preview: total count failed', id, err);
      }

      rows.push({
        assessmentId: id,
        title: (aSnap.get('title') as string) ?? null,
        ownAttempts: own,
        otherInstituteAttempts: total === null ? null : Math.max(0, total - own),
        // Unknown totals are treated as SHARED — the conservative reading,
        // since wrongly marking something exclusive invites its deletion.
        exclusive: total !== null && total - own <= 0,
      });
    }

    return { ok: true as const, instituteId, assessments: rows };
  },
);

// ── Soft delete + restore (Feature #15, Phase 6a) ─────────────────
//
// CLOSES BUG (b). Until now every account removal was immediate and
// irreversible — one misclick destroyed a person's record with no undo.
// Deletion now enters a recoverable state first; destruction happens only at
// PURGE, after the retention window or by explicit Web Owner action.
//
// THE AUTH USER IS DISABLED, NOT DELETED.
// Disabling is the only option that makes restore real: the account comes
// back instantly and the person keeps their password. Deleting the Auth user
// would mean restore had to recreate it and reissue credentials, which is a
// different feature wearing the word "restore".
//
// The tradeoff, stated plainly: a disabled Auth user still CLAIMS its email,
// so the same address cannot be re-registered until the record is purged.
// That is the correct trade for a reversibility feature — an email freed
// early is an email that can be re-registered while the original owner is
// still restorable, which would make restore fail in a far more confusing way.

/** Server twin of RETENTION_DAYS in src/lib/lifecycle.ts. KEEP IN SYNC. */
const RETENTION_DAYS_S: Record<string, number> = {
  student: 30,
  faculty: 30,
  institute: 180,
  assessment: 90,
  question: 90,
  questionBank: 90,
  subjectTopic: 90,
  hierarchyNode: 90,
};

function computePurgeAfterS(entity: string, from: Date = new Date()): string | null {
  const days = RETENTION_DAYS_S[entity];
  if (days == null) return null;
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/**
 * Move an account into the recoverable soft-deleted state.
 *
 * Destroys NOTHING. No cascade runs here — for an institute in particular,
 * its faculty, students and content stay exactly where they are, because the
 * whole point is that the tenant can come back intact. The cascade moves to
 * purge, where it belongs.
 */
async function performAccountSoftDelete(
  db: FirebaseFirestore.Firestore,
  params: {
    role: Role;
    uid: string;
    profileRef: FirebaseFirestore.DocumentReference;
    auditLabel: string | null;
    auditFromState: LifecycleStateS;
    targetInstituteId: string | null;
    actorUid: string;
    actorRole: string;
    reason?: string | null;
    requestId?: string | null;
    /**
     * Faculty only. Captured NOW but applied at PURGE, because succession is
     * irreversible and soft delete is not. The admin who knew this person is
     * the one qualified to choose, and they are here today — asking again
     * months later, of whoever happens to run the purge, would get a worse
     * answer. Re-validated at execution regardless.
     */
    pendingSuccessorId?: string | null;
  },
): Promise<void> {
  const now = new Date();

  // Access is revoked FIRST. If the profile were flagged first and this then
  // failed, a person marked deleted would still be able to sign in.
  try {
    await getAuth().updateUser(params.uid, { disabled: true });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code !== 'auth/user-not-found') {
      console.error('softDelete: could not disable auth user', params.uid, err);
      throw new HttpsError('internal', 'Could not revoke sign-in for this account.');
    }
  }

  await params.profileRef.update({
    lifecycleState: 'softDeleted',
    deletedAt: now.toISOString(),
    deletedBy: params.actorUid,
    deletedByRole: params.actorRole,
    lifecycleReason: params.reason ?? null,
    purgeAfter: computePurgeAfterS(params.role, now),
    pendingSuccessorId: params.pendingSuccessorId ?? null,
    updatedAt: now.toISOString(),
  });

  await writeAuditRow(db, {
    action: 'softDelete',
    entityType: params.role,
    entityId: params.uid,
    entityLabel: params.auditLabel,
    fromState: params.auditFromState,
    toState: 'softDeleted',
    actorUid: params.actorUid,
    actorRole: params.actorRole,
    instituteId: params.targetInstituteId,
    reason: params.reason ?? null,
    requestId: params.requestId ?? null,
  });
}

/**
 * Bring a soft-deleted account back.
 *
 * Clears every marker set on the way out — including purgeAfter, which must
 * not survive: a restored record with a live purgeAfter would be silently
 * destroyed later by the scheduled job.
 */
export const restoreEntity = onCall<{
  role: Role;
  uid: string;
  reason?: string;
}>({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { role, uid, reason } = request.data || ({} as never);
  if (!role || !COLLECTION_BY_ROLE[role]) throw new HttpsError('invalid-argument', 'Invalid role.');
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');

  const db = getFirestore();
  const actor = actorFrom(request);
  const ref = db.collection(COLLECTION_BY_ROLE[role]).doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Record not found.');

  const data = snap.data() as Record<string, unknown>;
  const targetInstituteId =
    role === 'institute' ? uid : (data.instituteId as string | undefined) ?? null;

  // Restoring is a lower bar than deleting — it is non-destructive — but it
  // is still scoped: an institute may only restore inside its own tenant, and
  // only the Web Owner may restore an institute.
  if (actor.actorRole !== 'webOwner') {
    if (actor.actorRole !== 'institute' || role === 'institute') {
      throw new HttpsError('permission-denied', 'Insufficient permissions.');
    }
    if (!actor.instituteId || actor.instituteId !== targetInstituteId) {
      throw new HttpsError('permission-denied', 'Different institute.');
    }
  }

  const current: LifecycleStateS =
    (data.lifecycleState as LifecycleStateS) ??
    (data.isDeleted === true ? 'softDeleted' : 'active');
  if (current !== 'softDeleted' && current !== 'archived') {
    throw new HttpsError('failed-precondition', 'This record is not deleted or archived.');
  }

  try {
    await getAuth().updateUser(uid, { disabled: false });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code !== 'auth/user-not-found') {
      console.error('restore: could not re-enable auth user', uid, err);
      throw new HttpsError('internal', 'Could not restore sign-in for this account.');
    }
  }

  const nowIso = new Date().toISOString();
  await ref.update({
    lifecycleState: 'active',
    // Cleared absolutely. A stale purgeAfter on a restored record is a
    // scheduled deletion nobody asked for.
    purgeAfter: null,
    deletedAt: null,
    deletedBy: null,
    deletedByRole: null,
    archivedAt: null,
    archivedBy: null,
    archivedByRole: null,
    lifecycleReason: null,
    pendingSuccessorId: null,
    status: 'active',
    updatedAt: nowIso,
  });

  await writeAuditRow(db, {
    action: 'restore',
    entityType: role,
    entityId: uid,
    entityLabel: (data.name as string) || (data.email as string) || null,
    fromState: current,
    toState: 'active',
    actorUid: actor.actorUid,
    actorRole: actor.actorRole,
    instituteId: targetInstituteId,
    reason: reason ?? null,
  });

  return { ok: true as const, restored: role, uid };
});

/**
 * Destroy a soft-deleted record for good. Web Owner only.
 *
 * This is where the Phase 5b cascade now lives. It moved off the delete path
 * deliberately: deletion is recoverable and must destroy nothing, so a
 * cascade there would have made "soft" a lie.
 */
export const purgeEntity = onCall<{
  role: Role;
  uid: string;
  deleteAttemptsOnWebOwnerAssessments?: string[];
  /** Faculty only — who inherits their content, validated at execution. */
  successorId?: string;
  reason?: string;
}>({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const actor = actorFrom(request);
  if (actor.actorRole !== 'webOwner') {
    throw new HttpsError('permission-denied', 'Only the Web Owner may permanently delete.');
  }

  const { role, uid, deleteAttemptsOnWebOwnerAssessments, successorId, reason } =
    request.data || ({} as never);
  if (!role || !COLLECTION_BY_ROLE[role]) throw new HttpsError('invalid-argument', 'Invalid role.');
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');

  const db = getFirestore();
  const profileRef = db.collection(COLLECTION_BY_ROLE[role]).doc(uid);
  const snap = await profileRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Record not found.');

  const data = snap.data() as Record<string, unknown>;
  const state: LifecycleStateS =
    (data.lifecycleState as LifecycleStateS) ??
    (data.isDeleted === true ? 'softDeleted' : 'active');

  // Purge is reachable only from the recoverable state. Without this, a
  // single call could destroy a live tenant with no soft-delete step and no
  // window in which anyone could have noticed.
  if (state !== 'softDeleted') {
    throw new HttpsError(
      'failed-precondition',
      'Only a deleted record can be permanently removed. Delete it first.',
    );
  }

  const targetInstituteId =
    role === 'institute' ? uid : (data.instituteId as string | undefined) ?? null;

  let cascadeCounts: Record<string, number> | null = null;
  if (role === 'institute') {
    cascadeCounts = await performInstituteCascade(db, uid, {
      deleteAttemptsOnWebOwnerAssessments,
    });
  }

  await performAccountDeletion(db, {
    role,
    uid,
    profileRef,
    auditLabel: (data.name as string) || (data.email as string) || null,
    auditFromState: 'softDeleted',
    targetInstituteId,
    actorUid: actor.actorUid,
    actorRole: actor.actorRole,
    reason: reason ?? null,
    impact: cascadeCounts,
    // An explicit choice at purge wins; otherwise honour what the admin
    // picked when they removed the account.
    successorId: successorId ?? (data.pendingSuccessorId as string | null) ?? null,
  });

  return { ok: true as const, purged: role, uid, counts: cascadeCounts };
});

// ── Scheduled purge (Feature #15, Phase 6b) ───────────────────────
//
// Destroys soft-deleted records whose retention window has expired.
//
// THIS IS THE MOST DANGEROUS CODE IN THE FEATURE. A timer that hard-deletes
// tenants, unattended, with nobody watching. So it is built to be timid:
//
//   • DRY RUN BY DEFAULT. It logs exactly what it WOULD purge and changes
//     nothing. Flipping it on is a deliberate act — set the platform flag
//     platformSettings/lifecycle.purgeEnabled to true — not something that
//     happens because the code shipped.
//   • FAILS CLOSED on every uncertainty. Missing purgeAfter, unparseable
//     purgeAfter, a record that is not softDeleted, or a lifecycleState the
//     job does not recognise: all skipped. A record is destroyed only when
//     the evidence positively says it is due.
//   • CAPPED PER RUN. A bug that made everything look eligible can damage at
//     most PURGE_BATCH_LIMIT records before someone sees the logs.
//   • INSTITUTES ARE NEVER AUTO-PURGED. Their blast radius is a whole tenant
//     — every faculty member, student, assessment and attempt. That decision
//     stays with a human. The job reports them as due and leaves them alone.
//
// Everything it does route through the same performInstituteCascade /
// performAccountDeletion used by the manual path, so there is no second
// implementation of destruction to keep in sync.

const PURGE_BATCH_LIMIT = 50;

/** Roles the scheduled job may purge on its own. Institutes deliberately absent. */
const AUTO_PURGEABLE_ROLES: Role[] = ['faculty', 'student'];

async function isPurgeEnabled(db: FirebaseFirestore.Firestore): Promise<boolean> {
  try {
    const snap = await db.collection('platformSettings').doc('lifecycle').get();
    return snap.exists && snap.get('purgeEnabled') === true;
  } catch (err) {
    // Unreadable flag ⇒ stay in dry run. The safe reading of "I don't know".
    console.error('purge: could not read platformSettings/lifecycle', err);
    return false;
  }
}

/** Is this record positively due for purge? Fails closed on every doubt. */
function isDueForPurge(data: Record<string, unknown>, now: Date): boolean {
  if (data.lifecycleState !== 'softDeleted') return false;
  const after = data.purgeAfter;
  if (typeof after !== 'string' || !after) return false;
  const t = Date.parse(after);
  if (Number.isNaN(t)) return false;
  return now.getTime() >= t;
}

export const scheduledPurge = onSchedule(
  { schedule: 'every day 03:00', timeZone: 'Etc/UTC', region: 'us-central1' },
  async () => {
    const db = getFirestore();
    const now = new Date();
    const live = await isPurgeEnabled(db);

    console.log(`[scheduledPurge] start — mode=${live ? 'LIVE' : 'DRY RUN'}`);

    let examined = 0;
    let purged = 0;
    const skipped: string[] = [];

    for (const role of AUTO_PURGEABLE_ROLES) {
      const col = COLLECTION_BY_ROLE[role];
      let snap;
      try {
        snap = await db.collection(col)
          .where('lifecycleState', '==', 'softDeleted')
          .limit(PURGE_BATCH_LIMIT)
          .get();
      } catch (err) {
        console.error(`[scheduledPurge] query failed for ${col}`, err);
        continue;
      }

      for (const doc of snap.docs) {
        examined++;
        const data = doc.data() as Record<string, unknown>;

        if (!isDueForPurge(data, now)) {
          skipped.push(`${role}/${doc.id} (not due)`);
          continue;
        }
        if (purged >= PURGE_BATCH_LIMIT) {
          console.warn('[scheduledPurge] batch limit reached — remainder deferred to next run');
          break;
        }

        const label = (data.name as string) || (data.email as string) || null;

        if (!live) {
          console.log(`[scheduledPurge] WOULD PURGE ${role}/${doc.id} (${label ?? 'unnamed'}) — purgeAfter ${data.purgeAfter}`);
          purged++;
          continue;
        }

        try {
          await performAccountDeletion(db, {
            role,
            uid: doc.id,
            profileRef: doc.ref,
            auditLabel: label,
            auditFromState: 'softDeleted',
            targetInstituteId: (data.instituteId as string) ?? null,
            actorUid: 'system:scheduledPurge',
            actorRole: 'system',
            reason: 'Retention window expired',
            successorId: (data.pendingSuccessorId as string | null) ?? null,
          });
          purged++;
          console.log(`[scheduledPurge] purged ${role}/${doc.id}`);
        } catch (err) {
          console.error(`[scheduledPurge] FAILED on ${role}/${doc.id}`, err);
        }
      }
    }

    // Institutes are reported, never acted on — a human decides.
    try {
      const instSnap = await db.collection('institutes')
        .where('lifecycleState', '==', 'softDeleted')
        .limit(PURGE_BATCH_LIMIT)
        .get();
      for (const d of instSnap.docs) {
        if (isDueForPurge(d.data() as Record<string, unknown>, now)) {
          console.warn(`[scheduledPurge] institute ${d.id} is past its retention window — awaiting manual purge (never automatic)`);
        }
      }
    } catch (err) {
      console.error('[scheduledPurge] institute survey failed', err);
    }

    console.log(`[scheduledPurge] done — examined=${examined} ${live ? 'purged' : 'would purge'}=${purged} skipped=${skipped.length}`);
    if (skipped.length) console.log('[scheduledPurge] skipped:', skipped.join(', '));
  },
);

/**
 * Perform an account deletion. THE ONE PLACE THIS HAPPENS.
 *
 * Extracted in Phase 4 so that a deletion executed by an APPROVER
 * (resolveDeletionRequest) and one executed DIRECTLY (deleteAuthUser) run
 * byte-identical logic. Duplicating a destructive path is how two paths
 * silently diverge — one gains a cascade fix or an audit field the other
 * never gets.
 *
 * Assumes authorization has ALREADY been decided by the caller. This function
 * enforces nothing; it only executes.
 *
 * `requestId` is set when the deletion came from an approved request, so the
 * audit row links back to it and the trail reads as one story.
 */
async function performAccountDeletion(
  db: FirebaseFirestore.Firestore,
  params: {
    role: Role;
    uid: string;
    profileRef: FirebaseFirestore.DocumentReference;
    auditLabel: string | null;
    auditFromState: LifecycleStateS;
    targetInstituteId: string | null;
    actorUid: string;
    actorRole: string;
    requestId?: string | null;
    reason?: string | null;
    /** Faculty only — successor chosen by the admin, validated at execution. */
    successorId?: string | null;
    /** Institute only — what the cascade actually removed, for the audit row. */
    impact?: Record<string, number> | null;
  },
): Promise<void> {
  const { role, uid, profileRef } = params;

  // ── Succession BEFORE destruction (Feature #15, Phase 5a) ────────
  // Runs first, deliberately. If the profile were deleted first and the
  // reassignment then failed, the content would be orphaned with no owner
  // and no way to work out who it belonged to.
  let succession: SuccessionOutcomeS | null = null;
  if (role === 'faculty' && params.targetInstituteId) {
    succession = await performFacultySuccession(
      db, uid, params.targetInstituteId, params.successorId,
    );
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
  // Cascade: academic-hierarchy mappings for a deleted student are pure
  // orphans — remove them so node rosters don't render ghosts. Attempts and
  // questionReports are DELIBERATELY kept: they are the institute's exam
  // records / audit trail.
  //
  // STUDENTS ONLY, AND THAT IS CORRECT. The original spec listed "no faculty
  // mapping cleanup" as a bug (d), and Phase 5a duly added a facultyId query
  // here — but AcademicMapping has no facultyId field. It carries studentId /
  // studentName / studentEmail and is student-only by design ("a student can
  // have many mappings"), so faculty never had mappings to leak. That query
  // matched nothing on every faculty deletion. Removed rather than left in:
  // dead code that looks like a safety net is worse than no safety net.
  if (role === 'student') {
    const mapField = 'studentId';
    try {
      const mapSnap = await db.collection('academicMappings')
        .where(mapField, '==', uid).get();
      let batch = db.batch();
      let n = 0;
      for (const d of mapSnap.docs) {
        batch.delete(d.ref);
        if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
      }
      if (n > 0) await batch.commit();
    } catch (err) {
      console.error('performAccountDeletion: mapping cascade failed for', uid, err);
    }
  }

  // Lifecycle audit. Still a HARD delete — Phase 6 routes accounts through
  // soft-delete + retention. What Phase 1 changed is that the action stopped
  // being invisible.
  //
  // Written LAST, deliberately. The row asserts the deletion happened, so it
  // must not precede it. writeAuditRow never throws, so a logging failure
  // cannot roll back a completed removal — it logs loudly instead.
  await writeAuditRow(db, {
    action: 'purge',
    entityType: role,
    entityId: uid,
    entityLabel: params.auditLabel,
    fromState: params.auditFromState,
    toState: 'purged',
    actorUid: params.actorUid,
    actorRole: params.actorRole,
    instituteId: params.targetInstituteId,
    requestId: params.requestId ?? null,
    reason: params.reason ?? null,
    impact: params.impact ?? null,
    succession: succession
      ? {
          fromOwnerType: 'faculty',
          fromOwnerId: uid,
          toOwnerType: succession.toOwnerType,
          toOwnerId: succession.toOwnerId,
          reason: succession.reason,
          counts: succession.counts,
        }
      : null,
  });
}

export const deleteAuthUser = onCall<DeleteAuthUserData>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const callerRole = request.auth.token.role as Role | undefined;
    const callerInstituteId = request.auth.token.instituteId as string | undefined;

    const { role, uid, successorId, confirmLiveOwnership,
            deleteAttemptsOnWebOwnerAssessments } =
      request.data || ({} as DeleteAuthUserData);
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

    // Captured BEFORE the delete — after it, the document is gone and these
    // are unrecoverable. The label is what keeps the audit trail legible once
    // the target no longer exists to look up.
    const auditLabel =
      (profile.name as string) || (profile.email as string) || null;
    const auditFromState: LifecycleStateS =
      (profile.lifecycleState as LifecycleStateS) ??
      (profile.isDeleted === true ? 'softDeleted' : 'active');

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

      // ── Deletion-rights gate (Feature #15, Phase 3) ────────────────
      // The role checks above establish WHO may act on WHOM. This
      // establishes whether they hold the RIGHT to do so at all — the
      // check that did not exist before, and the closure of bug (f).
      //
      // Runs for institute and faculty callers only; the Web Owner short-
      // circuits above. Reads the ceiling from the tenant's institute doc
      // and, for faculty, the grant from their own profile.
      const ceilingSnap = await db.collection('institutes').doc(callerInstituteId).get();
      const ceiling = ceilingSnap.exists
        ? (ceilingSnap.get('deletionRightsCeiling') as DeletionCeilingS | undefined)
        : undefined;

      let facultyRights: FacultyDeletionRightsS | undefined;
      if (callerRole === 'faculty') {
        const callerSnap = await db.collection('faculty').doc(request.auth.uid).get();
        facultyRights = callerSnap.exists
          ? (callerSnap.get('deletionRights') as FacultyDeletionRightsS | undefined)
          : undefined;
      }

      const resource = role as DeletableResourceS;
      const mode = resolveDeletionModeS(callerRole, resource, ceiling, facultyRights);

      if (mode === 'request') {
        // Held, but not directly exercisable. The client calls
        // submitDeletionRequest instead; this is a distinct error CODE so the
        // UI can branch on it rather than parsing prose.
        throw new HttpsError(
          'failed-precondition',
          'DELETION_REQUIRES_APPROVAL',
        );
      }
      if (mode !== 'direct') {
        throw new HttpsError(
          'permission-denied',
          callerRole === 'faculty'
            ? 'You have not been granted permission to delete this. Ask your institute administrator.'
            : 'This institute has not been granted permission to delete this. Ask the Web Owner.',
        );
      }
    }

    // ── Live-exam guard (Feature #15, Phase 5a) ────────────────────
    // Succession makes most faculty deletion safe, but not this case: an
    // ACTIVE assessment may have students mid-attempt, and changing its owner
    // during a sitting is a variable nobody wants in an exam-integrity story.
    // Surfaced as a distinct code so the UI can offer reassignment rather
    // than showing a dead end.
    if (role === 'faculty' && !confirmLiveOwnership) {
      const live = await countLiveOwnedAssessments(db, uid);
      if (live > 0) {
        throw new HttpsError(
          'failed-precondition',
          `FACULTY_OWNS_LIVE_ASSESSMENTS:${live}`,
        );
      }
    }

    // ── SOFT delete (Feature #15, Phase 6a) ────────────────────────
    // This path no longer destroys anything. The record enters the
    // recoverable state and the Auth user is disabled; the cascade and the
    // actual removal moved to purgeEntity, where they belong. Closes bug (b).
    //
    // NOTE ON SUCCESSION: ownership transfer deliberately does NOT run here.
    // Soft delete is reversible, so moving a departing faculty member's
    // content now would mean a restore left their questions belonging to
    // someone else. Succession runs at PURGE, when the departure is final —
    // which is exactly what the locked design says.
    await performAccountSoftDelete(db, {
      role,
      uid,
      profileRef,
      auditLabel,
      auditFromState,
      targetInstituteId: targetInstituteId ?? null,
      actorUid: actorFrom(request).actorUid,
      actorRole: actorFrom(request).actorRole,
      pendingSuccessorId: successorId ?? null,
    });

    return { ok: true };
  }
);

// ═══════════════════════════════════════════════════════════════════
// ENTITY LIFECYCLE — audit writer + hierarchy unarchive
// (Feature #15, Phase 0b)
//
// This section adds the SERVER half of the lifecycle foundation. It is
// deliberately inert with respect to existing behaviour: writeAuditRow is a
// helper nothing calls yet (Phase 1 wires it into the existing delete paths),
// and setHierarchyNodeLifecycle closes a real pre-existing gap — archived
// hierarchy nodes had no unarchive path at all, making archive a one-way door.
//
// WHY THE AUDIT WRITER LIVES SERVER-SIDE
// firestore.rules denies every client write to deletionAudit, including the
// Web Owner's. Two reasons: a client-writable trail can be forged, and a trail
// written by a separate call from the action it records can silently go
// missing when that second call fails — exactly the case the trail exists to
// cover. So rows are written here, and Phase 1 onward writes them inside the
// same operation as the transition they describe.
// ═══════════════════════════════════════════════════════════════════

type LifecycleStateS = 'active' | 'archived' | 'softDeleted' | 'purged';

type AuditActionS =
  | 'archive'
  | 'softDelete'
  | 'restore'
  | 'purge'
  | 'requestSubmitted'
  | 'requestApproved'
  | 'requestRejected'
  | 'erasure';

type SuccessionS = {
  fromOwnerType: 'webOwner' | 'institute' | 'faculty';
  fromOwnerId: string;
  toOwnerType: 'webOwner' | 'institute' | 'faculty';
  toOwnerId: string;
  reason: 'chosen' | 'defaulted' | 'fallback';
  counts?: Record<string, number> | null;
};

type AuditRowInput = {
  action: AuditActionS;
  entityType: string;
  entityId: string;
  entityLabel?: string | null;
  fromState?: LifecycleStateS | null;
  toState?: LifecycleStateS | null;
  actorUid: string;
  actorRole: string;
  actorName?: string | null;
  instituteId?: string | null;
  reason?: string | null;
  requestId?: string | null;
  impact?: Record<string, number> | null;
  succession?: SuccessionS | null;
};

/**
 * Server twin of buildAuditRow in src/lib/deletionAudit.ts.
 * KEEP IN SYNC — the client reads these rows and expects this exact shape.
 *
 * Every optional field is written as an explicit null rather than being
 * omitted: Firestore drops undefined, which would make "no reason given"
 * indistinguishable from "this build predates the reason field".
 */
function buildAuditRowS(input: AuditRowInput): Record<string, unknown> {
  return {
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    entityLabel: input.entityLabel ?? null,
    fromState: input.fromState ?? null,
    toState: input.toState ?? null,
    actorUid: input.actorUid,
    actorRole: input.actorRole,
    actorName: input.actorName ?? null,
    instituteId: input.instituteId ?? null,
    reason: input.reason ?? null,
    requestId: input.requestId ?? null,
    impact: input.impact ?? null,
    succession: input.succession ?? null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Append one audit row.
 *
 * Pass `txn` when the caller is already inside a transaction or batch so the
 * row and the state change commit together — that atomicity is the whole
 * point, and Phase 1 onward must use it. The standalone form exists for
 * callers with nothing to bind to.
 *
 * NEVER THROWS. A failure to record an action must not roll back the action
 * itself when the caller is not transactional: losing the row is bad, but
 * leaving a half-completed deletion is worse. Failures are logged loudly so
 * they surface in Cloud Logging rather than vanishing.
 */
async function writeAuditRow(
  db: FirebaseFirestore.Firestore,
  input: AuditRowInput,
  txn?: FirebaseFirestore.Transaction | FirebaseFirestore.WriteBatch,
): Promise<void> {
  try {
    const ref = db.collection('deletionAudit').doc();
    const row = buildAuditRowS(input);
    if (!txn) {
      await ref.set(row);
      return;
    }
    // Transaction.set and WriteBatch.set have structurally different overload
    // sets, so TypeScript refuses to call the union directly. Both accept
    // (ref, data) identically at runtime; narrow explicitly rather than
    // casting the whole union away, so a genuinely wrong third argument
    // would still be caught.
    if (txn instanceof Object && 'commit' in txn && !('get' in txn)) {
      (txn as FirebaseFirestore.WriteBatch).set(ref, row);
    } else {
      (txn as FirebaseFirestore.Transaction).set(ref, row);
    }
  } catch (err) {
    console.error(
      'writeAuditRow FAILED',
      input.action,
      input.entityType,
      input.entityId,
      err,
    );
  }
}

/** Actor identity for an audit row, pulled from the callable's auth context. */
function actorFrom(request: {
  auth?: { uid?: string; token?: Record<string, unknown> } | null;
}): { actorUid: string; actorRole: string; instituteId: string | null } {
  const token = (request.auth?.token ?? {}) as Record<string, unknown>;
  return {
    actorUid: request.auth?.uid ?? 'unknown',
    actorRole: (token.role as string) ?? 'unknown',
    instituteId: (token.instituteId as string) ?? null,
  };
}

// ── Hierarchy node lifecycle ──────────────────────────────────────
// Closes a real gap found during the Feature #15 baseline read: the nine
// academic-hierarchy collections have archiveNode() (status -> 'archived')
// but NO unarchive path anywhere in the codebase, so archiving a school or
// program was irreversible through the UI.
//
// Kept as a callable rather than a client write because it must produce an
// audit row, and clients cannot write deletionAudit.

const HIERARCHY_COLLECTIONS = [
  'schools',
  'academicLevels',
  'programs',
  'academicSessions',
  'academicYears',
  'semesters',
  'courses',
  'sections',
  'groups',
] as const;

type HierarchyCollection = (typeof HIERARCHY_COLLECTIONS)[number];

export const setHierarchyNodeLifecycle = onCall<{
  collection: HierarchyCollection;
  nodeId: string;
  action: 'archive' | 'restore';
  reason?: string;
}>({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { collection, nodeId, action, reason } = request.data || ({} as never);

  if (!collection || !HIERARCHY_COLLECTIONS.includes(collection)) {
    throw new HttpsError('invalid-argument', 'Unknown hierarchy collection.');
  }
  if (!nodeId) throw new HttpsError('invalid-argument', 'nodeId is required.');
  if (action !== 'archive' && action !== 'restore') {
    throw new HttpsError('invalid-argument', 'action must be archive or restore.');
  }

  const db = getFirestore();
  const ref = db.collection(collection).doc(nodeId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Node not found.');

  const data = snap.data() as Record<string, unknown>;
  const nodeInstituteId = (data.instituteId as string) ?? null;

  // Authorisation mirrors canWriteAcademic in firestore.rules: webOwner
  // anywhere, institute admin within its own tenant. Faculty are excluded —
  // hierarchy shape is an admin concern, and Feature #15 does not widen it.
  const actor = actorFrom(request);
  if (actor.actorRole !== 'webOwner') {
    if (actor.actorRole !== 'institute' || !actor.instituteId
        || actor.instituteId !== nodeInstituteId) {
      throw new HttpsError('permission-denied', 'Not permitted for this node.');
    }
  }

  const currentStatus = (data.status as string) ?? 'active';
  const fromState: LifecycleStateS = currentStatus === 'archived' ? 'archived' : 'active';
  const toState: LifecycleStateS = action === 'archive' ? 'archived' : 'active';

  // Reject no-op transitions rather than writing a misleading audit row that
  // claims a change occurred. Matches canTransition() in the client module.
  if (fromState === toState) {
    throw new HttpsError(
      'failed-precondition',
      action === 'archive' ? 'Node is already archived.' : 'Node is already active.',
    );
  }

  const nowIso = new Date().toISOString();

  // Legacy `status` stays authoritative (Option 2 — derive, do not migrate);
  // the lifecycleState envelope is written ALONGSIDE it so new readers get
  // the unified vocabulary and old readers keep working untouched.
  const batch = db.batch();
  batch.update(ref, {
    status: toState === 'archived' ? 'archived' : 'active',
    lifecycleState: toState,
    archivedAt: toState === 'archived' ? nowIso : null,
    archivedBy: toState === 'archived' ? actor.actorUid : null,
    archivedByRole: toState === 'archived' ? actor.actorRole : null,
    lifecycleReason: reason ?? null,
    updatedAt: nowIso,
  });

  await writeAuditRow(db, {
    action: action === 'archive' ? 'archive' : 'restore',
    entityType: 'hierarchyNode',
    entityId: nodeId,
    entityLabel: (data.name as string) ?? null,
    fromState,
    toState,
    actorUid: actor.actorUid,
    actorRole: actor.actorRole,
    instituteId: nodeInstituteId,
    reason: reason ?? null,
  }, batch);

  await batch.commit();

  return { ok: true as const, fromState, toState };
});

// ═══════════════════════════════════════════════════════════════════
// DELETION REQUESTS — the approval workflow (Feature #15, Phase 4)
//
// TWO HOPS, ONE MECHANISM
//   faculty  (mode 'request') → institute admin approves
//   institute(selfMode 'request') → Web Owner approves
// Same collection, same callables, same inbox component — the approver is
// derived from the requester's role, never passed in by the client.
//
// THE APPROVER'S RIGHTS DECIDE, AND THEY ARE CHECKED AT EXECUTION TIME.
// Not the requester's, and not at submission time. A request can sit in an
// inbox for days: the ceiling may narrow, the approver may lose the right,
// the target may already be gone. So resolveDeletionRequest re-resolves
// everything from scratch before it executes. This mirrors how
// resolveQuestionRequest already works.
// ═══════════════════════════════════════════════════════════════════

type DeletionRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** Who must approve a request raised by this role? */
function approverRoleFor(requesterRole: string): 'institute' | 'webOwner' | null {
  if (requesterRole === 'faculty') return 'institute';
  if (requesterRole === 'institute') return 'webOwner';
  return null;   // webOwner answers to nobody
}

export const submitDeletionRequest = onCall<{
  entityType: 'student' | 'faculty';
  entityId: string;
  reason?: string;
}>({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { entityType, entityId, reason } = request.data || ({} as never);
  if (entityType !== 'student' && entityType !== 'faculty') {
    throw new HttpsError('invalid-argument', 'Unsupported entityType.');
  }
  if (!entityId) throw new HttpsError('invalid-argument', 'entityId is required.');

  const db = getFirestore();
  const actor = actorFrom(request);
  const approver = approverRoleFor(actor.actorRole);
  if (!approver) {
    throw new HttpsError('failed-precondition', 'The Web Owner does not raise requests.');
  }
  if (!actor.instituteId) {
    throw new HttpsError('permission-denied', 'Missing tenant claim.');
  }

  // The target must exist and be inside the requester's tenant. Checked here
  // so an impossible request never reaches an approver's inbox.
  const targetRef = db.collection(entityType === 'student' ? 'students' : 'faculty').doc(entityId);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) throw new HttpsError('not-found', 'Target not found.');
  const targetInstituteId = targetSnap.get('instituteId') as string | undefined;
  if (targetInstituteId !== actor.instituteId) {
    throw new HttpsError('permission-denied', 'Different institute.');
  }

  // Faculty may only request student deletion — the same role boundary
  // deleteAuthUser enforces. A request must never be a way around it.
  if (actor.actorRole === 'faculty' && entityType !== 'student') {
    throw new HttpsError('permission-denied', 'Faculty may only request student deletion.');
  }

  // The requester must actually HOLD the right in request mode. Without this,
  // anyone could flood an inbox with requests for rights they were never
  // granted, and an approving admin would have no way to tell.
  const instSnap = await db.collection('institutes').doc(actor.instituteId).get();
  const ceiling = instSnap.exists
    ? (instSnap.get('deletionRightsCeiling') as DeletionCeilingS | undefined)
    : undefined;

  let facultyRights: FacultyDeletionRightsS | undefined;
  if (actor.actorRole === 'faculty') {
    const meSnap = await db.collection('faculty').doc(request.auth.uid).get();
    facultyRights = meSnap.exists
      ? (meSnap.get('deletionRights') as FacultyDeletionRightsS | undefined)
      : undefined;
  }

  const mode = resolveDeletionModeS(
    actor.actorRole, entityType as DeletableResourceS, ceiling, facultyRights,
  );
  if (mode !== 'request') {
    throw new HttpsError(
      'failed-precondition',
      mode === 'direct'
        ? 'You can perform this deletion directly — no request needed.'
        : 'You have not been granted this right, so it cannot be requested.',
    );
  }

  // One pending request per target. Without this a faculty member can submit
  // the same deletion twenty times and the approver sees twenty rows for one
  // decision.
  const dupe = await db.collection('deletionRequests')
    .where('entityId', '==', entityId)
    .where('status', '==', 'pending')
    .limit(1)
    .get();
  if (!dupe.empty) {
    throw new HttpsError('already-exists', 'A pending request for this already exists.');
  }

  const nowIso = new Date().toISOString();
  const ref = db.collection('deletionRequests').doc();
  await ref.set({
    id: ref.id,
    status: 'pending' as DeletionRequestStatus,
    entityType,
    entityId,
    // Captured at submission so the inbox reads legibly even if the target is
    // renamed — or removed by some other path — before anyone looks.
    entityLabel: (targetSnap.get('name') as string) || (targetSnap.get('email') as string) || null,
    requesterUid: request.auth.uid,
    requesterRole: actor.actorRole,
    requesterName: null,
    approverRole: approver,
    instituteId: actor.instituteId,
    reason: reason ?? null,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  await writeAuditRow(db, {
    action: 'requestSubmitted',
    entityType,
    entityId,
    entityLabel: (targetSnap.get('name') as string) ?? null,
    actorUid: actor.actorUid,
    actorRole: actor.actorRole,
    instituteId: actor.instituteId,
    reason: reason ?? null,
    requestId: ref.id,
  });

  return { ok: true as const, id: ref.id };
});

export const resolveDeletionRequest = onCall<{
  requestId: string;
  decision: 'approve' | 'reject';
  reviewNote?: string;
}>({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { requestId, decision, reviewNote } = request.data || ({} as never);
  if (!requestId) throw new HttpsError('invalid-argument', 'requestId is required.');
  if (decision !== 'approve' && decision !== 'reject') {
    throw new HttpsError('invalid-argument', 'decision must be approve or reject.');
  }

  const db = getFirestore();
  const actor = actorFrom(request);

  const reqRef = db.collection('deletionRequests').doc(requestId);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) throw new HttpsError('not-found', 'Request not found.');
  const req = reqSnap.data() as Record<string, unknown>;

  if (req.status !== 'pending') {
    throw new HttpsError('failed-precondition', 'This request has already been resolved.');
  }

  // Only the designated approver may resolve, and only inside the right
  // tenant. approverRole was written at submission from the requester's role,
  // so a client cannot choose its own approver.
  const approverRole = req.approverRole as string;
  if (actor.actorRole !== approverRole) {
    throw new HttpsError('permission-denied', 'You are not the approver for this request.');
  }
  if (approverRole === 'institute'
      && (!actor.instituteId || actor.instituteId !== req.instituteId)) {
    throw new HttpsError('permission-denied', 'Different institute.');
  }

  const nowIso = new Date().toISOString();
  const entityType = req.entityType as 'student' | 'faculty';
  const entityId = req.entityId as string;

  if (decision === 'reject') {
    await reqRef.update({
      status: 'rejected' as DeletionRequestStatus,
      reviewedBy: actor.actorUid,
      reviewedAt: nowIso,
      reviewNote: reviewNote ?? null,
      updatedAt: nowIso,
    });
    await writeAuditRow(db, {
      action: 'requestRejected',
      entityType,
      entityId,
      entityLabel: (req.entityLabel as string) ?? null,
      actorUid: actor.actorUid,
      actorRole: actor.actorRole,
      instituteId: (req.instituteId as string) ?? null,
      reason: reviewNote ?? null,
      requestId,
    });
    return { ok: true as const, status: 'rejected' as const };
  }

  // ── APPROVE: re-check everything, then execute ──────────────────
  // The APPROVER's rights are what matter, resolved NOW. A request may have
  // sat here for days while the ceiling narrowed or the approver's own rights
  // changed. Nothing about the submission is trusted.
  if (actor.actorRole !== 'webOwner') {
    if (!actor.instituteId) throw new HttpsError('permission-denied', 'Missing tenant claim.');
    const instSnap = await db.collection('institutes').doc(actor.instituteId).get();
    const ceiling = instSnap.exists
      ? (instSnap.get('deletionRightsCeiling') as DeletionCeilingS | undefined)
      : undefined;
    const approverMode = resolveDeletionModeS(
      actor.actorRole, entityType as DeletableResourceS, ceiling, undefined,
    );
    if (approverMode !== 'direct') {
      throw new HttpsError(
        'permission-denied',
        'You can no longer perform this deletion yourself, so it cannot be approved.',
      );
    }
  }

  // The target may have been removed by another path while this sat pending.
  const targetRef = db.collection(entityType === 'student' ? 'students' : 'faculty').doc(entityId);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) {
    await reqRef.update({
      status: 'cancelled' as DeletionRequestStatus,
      reviewedBy: actor.actorUid,
      reviewedAt: nowIso,
      reviewNote: 'Target no longer exists.',
      updatedAt: nowIso,
    });
    throw new HttpsError('not-found', 'The target no longer exists; the request was cancelled.');
  }

  const profile = targetSnap.data() as Record<string, unknown>;
  const auditFromState: LifecycleStateS =
    (profile.lifecycleState as LifecycleStateS) ??
    (profile.isDeleted === true ? 'softDeleted' : 'active');

  await performAccountDeletion(db, {
    role: entityType as Role,
    uid: entityId,
    profileRef: targetRef,
    auditLabel: (profile.name as string) || (profile.email as string) || null,
    auditFromState,
    targetInstituteId: (profile.instituteId as string) ?? null,
    actorUid: actor.actorUid,
    actorRole: actor.actorRole,
    requestId,
    reason: reviewNote ?? (req.reason as string) ?? null,
  });

  await reqRef.update({
    status: 'approved' as DeletionRequestStatus,
    reviewedBy: actor.actorUid,
    reviewedAt: nowIso,
    reviewNote: reviewNote ?? null,
    updatedAt: nowIso,
  });

  await writeAuditRow(db, {
    action: 'requestApproved',
    entityType,
    entityId,
    entityLabel: (req.entityLabel as string) ?? null,
    actorUid: actor.actorUid,
    actorRole: actor.actorRole,
    instituteId: (req.instituteId as string) ?? null,
    reason: reviewNote ?? null,
    requestId,
  });

  return { ok: true as const, status: 'approved' as const };
});

// ═══════════════════════════════════════════════════════════════════
// ERASURE EXECUTION (Feature #15, Phase 7c)
//
// THE MOST DESTRUCTIVE CODE IN THE PLATFORM. It is the only path besides
// institute purge permitted to touch attempt data, and unlike everything else
// in Feature #15 it is deliberately irreversible — it bypasses the retention
// window entirely, because a person exercising an erasure right should not
// have their data sit recoverable for another 30 days.
//
// SHIPS INERT. platformSettings/erasure holds two values:
//
//   retentionYears : how long exam records must be kept
//   mode           : 'delete' | 'anonymize'
//
// UNSET MEANS REFUSE. Until a human writes both, every erasure is rejected
// with "Retention policy not configured." Those two values are legal answers,
// not engineering ones, so the code declines to guess at them — the same
// fail-closed posture as scheduledPurge's dry-run default.
//
// FIVE GATES, IN ORDER (§6.1 of the spec)
//   1. Web Owner only. Not delegable — no ceiling entry exists for erasure.
//   2. An OPEN erasure request must exist. No ad-hoc destruction.
//   3. Policy configured, else refuse.
//   4. Retention window: if the subject has attempts inside it, refuse BY
//      DEFAULT. Overridable only with an explicit acknowledgement, which is
//      recorded in the decision text.
//   5. Typed confirmation of the subject's name.
//
// THE AUDIT PARADOX
// Erasing someone while logging "webOwner erased <name>" creates a fresh
// record of the person just erased. So the surviving audit row keeps a
// reference, a date and an entity type — NO name, no email, no label — and
// the subjectRequests row is redacted the same way. This is the ONE place in
// Feature #15 where the trail is deliberately made less complete. It is not a
// bug and must not be "fixed".
// ═══════════════════════════════════════════════════════════════════

type ErasureMode = 'delete' | 'anonymize';

type ErasurePolicy = {
  retentionYears?: number;
  mode?: ErasureMode;
  configuredBy?: string;
  configuredAt?: string;
};

async function readErasurePolicy(
  db: FirebaseFirestore.Firestore,
): Promise<ErasurePolicy | null> {
  try {
    const snap = await db.collection('platformSettings').doc('erasure').get();
    return snap.exists ? (snap.data() as ErasurePolicy) : null;
  } catch (err) {
    // Unreadable policy ⇒ treated as unconfigured. The safe reading of
    // "I don't know what the rules are" is "do not destroy anything".
    console.error('readErasurePolicy failed', err);
    return null;
  }
}

function policyIsConfigured(p: ErasurePolicy | null): boolean {
  return !!p
    && typeof p.retentionYears === 'number'
    && p.retentionYears >= 0
    && (p.mode === 'delete' || p.mode === 'anonymize');
}

/**
 * The subject's most recent attempt, or null if they have none / it cannot be
 * determined. Fails CLOSED: an unreadable query returns a sentinel that keeps
 * the record inside the retention window, so uncertainty blocks erasure
 * rather than permitting it.
 */
async function latestAttemptAt(
  db: FirebaseFirestore.Firestore,
  studentId: string,
): Promise<{ iso: string | null; unknown: boolean }> {
  try {
    const snap = await db.collection('attempts')
      .where('studentId', '==', studentId)
      .select('startedAt')
      .get();
    if (snap.empty) return { iso: null, unknown: false };
    let latest = '';
    for (const d of snap.docs) {
      const v = (d.get('startedAt') as string) ?? '';
      if (v > latest) latest = v;
    }
    return { iso: latest || null, unknown: false };
  } catch (err) {
    console.error('latestAttemptAt failed', studentId, err);
    return { iso: null, unknown: true };
  }
}

/** Strip identity from a subject's attempts, keeping them as statistical rows. */
async function anonymizeAttempts(
  db: FirebaseFirestore.Firestore,
  studentId: string,
): Promise<number> {
  let touched = 0;
  try {
    const snap = await db.collection('attempts').where('studentId', '==', studentId).get();
    let batch = db.batch();
    let n = 0;
    for (const d of snap.docs) {
      batch.update(d.ref, {
        // The link is SEVERED, not remapped. Keeping any mapping back to the
        // person would make this pseudonymisation, which does not satisfy an
        // erasure right.
        studentId: `erased:${d.id}`,
        studentName: 'Erased',
        anonymizedAt: new Date().toISOString(),
      });
      touched++;
      if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
    }
    if (n > 0) await batch.commit();
  } catch (err) {
    console.error('anonymizeAttempts failed', studentId, err);
  }
  return touched;
}

export const executeErasure = onCall<{
  requestId: string;
  /** Must exactly match the subject's stored name. */
  confirmName: string;
  /** Required to proceed when attempts sit inside the retention window. */
  acknowledgeRetentionOverride?: boolean;
  /** Recorded verbatim on the request before it is redacted. */
  decision?: string;
}>({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const actor = actorFrom(request);
  // GATE 1 — Web Owner only, and deliberately not delegable.
  if (actor.actorRole !== 'webOwner') {
    throw new HttpsError('permission-denied', 'Only the Web Owner may carry out an erasure.');
  }

  const { requestId, confirmName, acknowledgeRetentionOverride, decision } =
    request.data || ({} as never);
  if (!requestId) throw new HttpsError('invalid-argument', 'requestId is required.');

  const db = getFirestore();

  // GATE 2 — an open erasure request must exist. No ad-hoc destruction.
  const reqRef = db.collection('subjectRequests').doc(requestId);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) throw new HttpsError('not-found', 'Request not found.');
  const req = reqSnap.data() as Record<string, unknown>;
  if (req.type !== 'erasure') {
    throw new HttpsError('failed-precondition', 'That request is not an erasure request.');
  }
  if (req.status !== 'open') {
    throw new HttpsError('failed-precondition', 'This request has already been decided.');
  }

  // GATE 3 — policy configured, else refuse.
  const policy = await readErasurePolicy(db);
  if (!policyIsConfigured(policy)) {
    throw new HttpsError(
      'failed-precondition',
      'ERASURE_POLICY_NOT_CONFIGURED',
    );
  }
  const mode = policy!.mode as ErasureMode;
  const retentionYears = policy!.retentionYears as number;

  const subjectRole = req.subjectRole as Role;
  const subjectId = req.subjectId as string;
  const profileRef = db.collection(COLLECTION_BY_ROLE[subjectRole]).doc(subjectId);
  const profileSnap = await profileRef.get();
  if (!profileSnap.exists) throw new HttpsError('not-found', 'Subject no longer exists.');
  const profile = profileSnap.data() as Record<string, unknown>;

  // GATE 5 — typed confirmation. Checked before the retention gate so a
  // mistyped name never reaches the override path.
  const storedName = ((profile.name as string) || '').trim();
  if (!confirmName || confirmName.trim() !== storedName) {
    throw new HttpsError('invalid-argument', 'The typed name does not match this person.');
  }

  // GATE 4 — retention window. Refuse by default; override must be explicit
  // and is recorded.
  let retentionNote = '';
  if (subjectRole === 'student' && retentionYears > 0) {
    const { iso, unknown } = await latestAttemptAt(db, subjectId);
    const cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - retentionYears);

    const insideWindow = unknown || (iso !== null && Date.parse(iso) >= cutoff.getTime());
    if (insideWindow && !acknowledgeRetentionOverride) {
      throw new HttpsError(
        'failed-precondition',
        unknown
          ? 'RETENTION_UNKNOWN'
          : `RETENTION_WINDOW_ACTIVE:${iso}`,
      );
    }
    if (insideWindow) {
      retentionNote = unknown
        ? ' [retention status could not be determined; override acknowledged]'
        : ` [within ${retentionYears}-year retention window; override acknowledged]`;
    }
  }

  const nowIso = new Date().toISOString();
  const counts: Record<string, number> = {};

  // ── Attempts: the one thing ordinary deletion never touches ──────
  if (subjectRole === 'student') {
    if (mode === 'anonymize') {
      counts.attemptsAnonymized = await anonymizeAttempts(db, subjectId);
    } else {
      counts.attemptsDeleted = await purgeWhere(db, 'attempts', 'studentId', subjectId);
    }
    counts.questionReports = await purgeWhere(db, 'questionReports', 'studentId', subjectId);
    counts.assessmentMembers = await purgeWhere(db, 'assessmentMembers', 'studentId', subjectId);
  }

  // ── The account itself, via the one place deletion happens ───────
  await performAccountDeletion(db, {
    role: subjectRole,
    uid: subjectId,
    profileRef,
    // NO LABEL. This is the audit paradox resolution: the surviving row must
    // not name the person it records the erasure of.
    auditLabel: null,
    auditFromState:
      (profile.lifecycleState as LifecycleStateS) ??
      (profile.isDeleted === true ? 'softDeleted' : 'active'),
    targetInstituteId: (profile.instituteId as string) ?? null,
    actorUid: actor.actorUid,
    actorRole: actor.actorRole,
    reason: `Erasure request ${requestId}${retentionNote}`,
    requestId,
    impact: counts,
  });

  // ── Redact the request row ───────────────────────────────────────
  // Keeps enough to prove the request was received and honoured — id, dates,
  // who decided, and the reason — and drops everything that identifies who it
  // concerned. Deliberately less complete than every other record in this
  // feature.
  await reqRef.update({
    status: 'erased',
    subjectId: FieldValue.delete(),
    subjectLabel: FieldValue.delete(),
    basis: FieldValue.delete(),
    redacted: true,
    decision: `${(decision ?? 'Erased under data-subject request').trim()}${retentionNote}`,
    decidedBy: actor.actorUid,
    decidedAt: nowIso,
    updatedAt: nowIso,
  });

  return { ok: true as const, mode, counts };
});

// ═══════════════════════════════════════════════════════════════════
// SUBJECT REQUESTS — access & erasure requests (Feature #15, Phase 7b)
//
// RECORDS DECISIONS. DESTROYS NOTHING. No policy configuration required.
//
// WHY REFUSAL IS FIRST-CLASS HERE
// If examination records carry a mandatory retention period, then erasure
// requests received inside that window are lawfully refusable — that is the
// ordinary operation of the legal-compliance exception, not a loophole. But
// refusing is not the same as ignoring: a dated, reasoned refusal IS the
// compliance artifact, because it shows the request was received, considered
// and answered. Before this there was nowhere to record one at all.
//
// So for a platform with real retention obligations, the refusal path is the
// one that runs most of the time, and it is built to be as first-class as
// fulfilment rather than an afterthought bolted onto an erasure button.
//
// SPLIT CONTROLLERSHIP (locked): institutes are controllers for their own
// students, the Web Owner for platform-level data. But attempts are
// Web-Owner-only, so an institute carrying the legal duty cannot discharge it
// alone. Institutes RAISE; the Web Owner EXECUTES erasure. Access requests an
// institute can fulfil itself, since getSubjectData is already scoped to
// their own members.
//
// NOTE ON TIMEFRAMES: `receivedAt` is deliberately separate from `createdAt`.
// Compliance clocks run from when the PERSON asked, not from when somebody
// got round to logging it. An institute's deadline can therefore already be
// part-spent when the request reaches this system.
// ═══════════════════════════════════════════════════════════════════

type SubjectRequestType = 'access' | 'erasure';
type SubjectRequestStatus = 'open' | 'fulfilled' | 'refused' | 'erased';

export const submitSubjectRequest = onCall<{
  type: SubjectRequestType;
  subjectRole: 'student' | 'faculty';
  subjectId: string;
  /** What the person asked for, in their words. Free text. */
  basis?: string;
  /** When the PERSON asked — ISO date. Defaults to now if omitted. */
  receivedAt?: string;
}>({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { type, subjectRole, subjectId, basis, receivedAt } = request.data || ({} as never);
  if (type !== 'access' && type !== 'erasure') {
    throw new HttpsError('invalid-argument', 'type must be access or erasure.');
  }
  if (subjectRole !== 'student' && subjectRole !== 'faculty') {
    throw new HttpsError('invalid-argument', 'subjectRole must be student or faculty.');
  }
  if (!subjectId) throw new HttpsError('invalid-argument', 'subjectId is required.');

  const db = getFirestore();
  const actor = actorFrom(request);
  if (actor.actorRole !== 'webOwner' && actor.actorRole !== 'institute') {
    throw new HttpsError('permission-denied', 'Only staff may log a subject request.');
  }

  const col = subjectRole === 'student' ? 'students' : 'faculty';
  const snap = await db.collection(col).doc(subjectId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Subject not found.');
  const subjectInstituteId = (snap.get('instituteId') as string) ?? null;

  if (actor.actorRole === 'institute') {
    if (!actor.instituteId || actor.instituteId !== subjectInstituteId) {
      throw new HttpsError('permission-denied', 'Different institute.');
    }
  }

  // One open request per subject per type. A person asking twice is one
  // request; two rows would mean two decisions to make and two chances to
  // give inconsistent answers.
  const dupe = await db.collection('subjectRequests')
    .where('subjectId', '==', subjectId)
    .where('type', '==', type)
    .where('status', '==', 'open')
    .limit(1)
    .get();
  if (!dupe.empty) {
    throw new HttpsError('already-exists', 'An open request of this type already exists for this person.');
  }

  const nowIso = new Date().toISOString();
  const ref = db.collection('subjectRequests').doc();
  await ref.set({
    id: ref.id,
    type,
    status: 'open' as SubjectRequestStatus,
    subjectRole,
    subjectId,
    subjectLabel: (snap.get('name') as string) || (snap.get('email') as string) || null,
    requestedBy: actor.actorUid,
    requestedByRole: actor.actorRole,
    instituteId: subjectInstituteId,
    basis: basis ?? null,
    receivedAt: receivedAt || nowIso,
    decision: null,
    decidedBy: null,
    decidedAt: null,
    exportGeneratedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  return { ok: true as const, id: ref.id };
});

export const decideSubjectRequest = onCall<{
  requestId: string;
  outcome: 'fulfilled' | 'refused';
  /** Required on refusal. Recorded verbatim — this is the artifact. */
  decision?: string;
  /** Set when an access export was produced for the person. */
  exportGenerated?: boolean;
}>({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { requestId, outcome, decision, exportGenerated } = request.data || ({} as never);
  if (!requestId) throw new HttpsError('invalid-argument', 'requestId is required.');
  if (outcome !== 'fulfilled' && outcome !== 'refused') {
    throw new HttpsError('invalid-argument', 'outcome must be fulfilled or refused.');
  }

  // A refusal without a reason is indistinguishable from ignoring the
  // request, which is the thing this record exists to disprove.
  if (outcome === 'refused' && (!decision || !decision.trim())) {
    throw new HttpsError('invalid-argument', 'A refusal must record a reason.');
  }

  const db = getFirestore();
  const actor = actorFrom(request);
  const ref = db.collection('subjectRequests').doc(requestId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Request not found.');
  const req = snap.data() as Record<string, unknown>;

  if (req.status !== 'open') {
    throw new HttpsError('failed-precondition', 'This request has already been decided.');
  }

  if (actor.actorRole !== 'webOwner') {
    if (actor.actorRole !== 'institute'
        || !actor.instituteId
        || actor.instituteId !== req.instituteId) {
      throw new HttpsError('permission-denied', 'Insufficient permissions.');
    }
    // An institute may fulfil an ACCESS request itself — getSubjectData is
    // already scoped to its own members. It may also refuse either type,
    // since refusing destroys nothing. What it cannot do is fulfil an
    // ERASURE request: that requires touching attempts, which is
    // Web-Owner-only, and 7c is where it actually happens.
    if (req.type === 'erasure' && outcome === 'fulfilled') {
      throw new HttpsError(
        'permission-denied',
        'Erasure is carried out by the Web Owner. Leave this open for them, or refuse it with a reason.',
      );
    }
  }

  // Guard against a fulfilled erasure before 7c exists. Marking one fulfilled
  // when nothing was destroyed would make the record claim something untrue —
  // worse than having no record.
  if (req.type === 'erasure' && outcome === 'fulfilled') {
    throw new HttpsError(
      'failed-precondition',
      'Erasure execution is not yet available. Refuse with a reason, or leave the request open.',
    );
  }

  const nowIso = new Date().toISOString();
  await ref.update({
    status: outcome as SubjectRequestStatus,
    decision: decision?.trim() || null,
    decidedBy: actor.actorUid,
    decidedAt: nowIso,
    exportGeneratedAt: exportGenerated ? nowIso : (req.exportGeneratedAt ?? null),
    updatedAt: nowIso,
  });

  return { ok: true as const, status: outcome };
});

// ═══════════════════════════════════════════════════════════════════
// SUBJECT DATA — everything held about one person (Feature #15, Phase 7a)
//
// DESTROYS NOTHING. Read-only, no legal precondition, safe to call any time.
//
// WHY THIS EXISTS BEFORE ERASURE
// The right of ACCESS precedes the right of erasure in essentially every
// regime, and it is the request far more likely to actually arrive. Without
// this, answering "what do you hold about me?" means hand-querying Firestore.
// It is also the foundation for erasure: you cannot honestly decide a request
// without seeing what would be destroyed.
//
// THE UNREADABLE CONTRACT — same discipline as getDeletionImpact
// A collection that cannot be read is reported as `null`, never as an empty
// array. This export gets handed to a person as a complete answer; one that
// silently omits a collection is worse than no export at all.
//
// SECRETS ARE NEVER EXPORTED
// studentCredentials / facultyCredentials carry a `password` field. It is
// stripped here unconditionally. An access export is handed to whoever asked
// for it, frequently over email — putting a working credential in it would
// turn a compliance feature into a credential-disclosure channel.
// ═══════════════════════════════════════════════════════════════════

type SubjectSection = {
  collection: string;
  /** null ⇒ could not be read. Distinct from [] which means "none". */
  records: Record<string, unknown>[] | null;
  note?: string;
};

/** Fields never included in an export, whatever collection they appear on. */
const NEVER_EXPORT = ['password', 'passwordHash', 'sebToken', 'activeSessionId'];

function scrub(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (NEVER_EXPORT.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Read one collection by equality filter. Returns null if unreadable. */
async function collectSection(
  db: FirebaseFirestore.Firestore,
  collection: string,
  field: string,
  value: string,
  note?: string,
): Promise<SubjectSection> {
  try {
    const snap = await db.collection(collection).where(field, '==', value).get();
    return {
      collection,
      records: snap.docs.map((d) => ({ id: d.id, ...scrub(d.data() as Record<string, unknown>) })),
      note,
    };
  } catch (err) {
    console.error('collectSection failed', collection, field, value, err);
    return { collection, records: null, note: 'Could not be read.' };
  }
}

/** Read one document by id. Returns null records if unreadable. */
async function collectDoc(
  db: FirebaseFirestore.Firestore,
  collection: string,
  id: string,
  note?: string,
): Promise<SubjectSection> {
  try {
    const snap = await db.collection(collection).doc(id).get();
    return {
      collection,
      records: snap.exists
        ? [{ id: snap.id, ...scrub(snap.data() as Record<string, unknown>) }]
        : [],
      note,
    };
  } catch (err) {
    console.error('collectDoc failed', collection, id, err);
    return { collection, records: null, note: 'Could not be read.' };
  }
}

export const getSubjectData = onCall<{
  role: 'student' | 'faculty';
  uid: string;
}>({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { role, uid } = request.data || ({} as never);
  if (role !== 'student' && role !== 'faculty') {
    throw new HttpsError('invalid-argument', 'role must be student or faculty.');
  }
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');

  const db = getFirestore();
  const actor = actorFrom(request);

  const profileCol = role === 'student' ? 'students' : 'faculty';
  const credCol = role === 'student' ? 'studentCredentials' : 'facultyCredentials';

  const profileSnap = await db.collection(profileCol).doc(uid).get();
  if (!profileSnap.exists) throw new HttpsError('not-found', 'Subject not found.');
  const subjectInstituteId = (profileSnap.get('instituteId') as string) ?? null;

  // Web Owner sees anyone; an institute admin only its own members. Faculty
  // and students cannot run this on anyone, including themselves — a
  // self-service export is a separate feature with its own identity checks.
  if (actor.actorRole !== 'webOwner') {
    if (actor.actorRole !== 'institute'
        || !actor.instituteId
        || actor.instituteId !== subjectInstituteId) {
      throw new HttpsError('permission-denied', 'Insufficient permissions.');
    }
  }

  const sections: SubjectSection[] = [];

  sections.push(await collectDoc(db, profileCol, uid, 'Profile record.'));
  sections.push(await collectDoc(db, credCol, uid,
    'Account provisioning state. Credentials themselves are never exported.'));

  if (role === 'student') {
    sections.push(await collectSection(db, 'attempts', 'studentId', uid,
      'Exam sittings, including answers, timings, scores and integrity events.'));
    sections.push(await collectSection(db, 'academicMappings', 'studentId', uid,
      'Placement in the academic hierarchy.'));
    sections.push(await collectSection(db, 'assessmentMembers', 'studentId', uid,
      'Exams this person was allocated to.'));
    sections.push(await collectSection(db, 'questionReports', 'studentId', uid,
      'Question issues this person reported during an exam.'));
  } else {
    sections.push(await collectSection(db, 'questions', 'ownerId', uid,
      'Questions authored by this person.'));
    sections.push(await collectSection(db, 'questionBanks', 'ownerId', uid,
      'Question banks owned by this person.'));
    sections.push(await collectSection(db, 'assessments', 'ownerId', uid,
      'Assessments owned by this person.'));
    sections.push(await collectSection(db, 'questionShares', 'ownerId', uid,
      'Content this person shared.'));
  }

  // Audit + request surfaces name the subject regardless of role.
  sections.push(await collectSection(db, 'deletionAudit', 'entityId', uid,
    'Lifecycle actions recorded against this person.'));
  sections.push(await collectSection(db, 'deletionRequests', 'entityId', uid,
    'Deletion requests naming this person.'));

  const unreadable = sections.filter((s) => s.records === null).map((s) => s.collection);

  return {
    ok: true as const,
    generatedAt: new Date().toISOString(),
    generatedBy: actor.actorUid,
    generatedByRole: actor.actorRole,
    subject: {
      role,
      uid,
      name: (profileSnap.get('name') as string) ?? null,
      email: (profileSnap.get('email') as string) ?? null,
      instituteId: subjectInstituteId,
    },
    sections,
    // Surfaced at the top level so the UI cannot present a partial export as
    // complete without saying so.
    unreadable,
    note: 'Firebase Authentication holds this account\'s email, password hash '
      + 'and sign-in timestamps; those are not included here.',
  };
});

// ═══════════════════════════════════════════════════════════════════
// DELETION IMPACT — dependency counts before a destructive action
// (Feature #15, Phase 1)
//
// WHY SERVER-SIDE
// The counts are the whole point of the confirmation dialog, and they must be
// TRUE. Counting client-side would mean either fetching every dependent doc
// (thousands of reads to render one dialog — an institute with 1,200 students
// and 48,000 attempts would be unusable) or trusting a stale denormalized
// number. count() aggregation queries run in the datastore and return a single
// number per collection, so the dialog costs a handful of aggregations
// regardless of tenant size.
//
// It also sidesteps a rules problem: a faculty member may be permitted to
// delete a student without being permitted to read every collection that
// student appears in. The server can count what the caller cannot see.
//
// FAIL-LOUD, NOT FAIL-QUIET
// If a count cannot be computed it is returned as null, and the UI must render
// that as "unknown", never as zero. A dialog that silently shows 0 attempts for
// a student who has 40 is worse than no dialog at all — it actively invites
// the destructive click it was built to prevent.
// ═══════════════════════════════════════════════════════════════════

type ImpactCounts = Record<string, number | null>;

/**
 * Count documents matching one equality filter, using an aggregation query.
 * Returns null on failure so the caller can distinguish "none" from "unknown".
 */
async function countWhere(
  db: FirebaseFirestore.Firestore,
  collection: string,
  field: string,
  value: string,
  extra?: { field: string; value: unknown },
): Promise<number | null> {
  try {
    let q: FirebaseFirestore.Query = db.collection(collection).where(field, '==', value);
    if (extra) q = q.where(extra.field, '==', extra.value);
    const snap = await q.count().get();
    return snap.data().count;
  } catch (err) {
    console.error('countWhere failed', collection, field, value, err);
    return null;
  }
}

/**
 * What would be affected by removing this entity?
 *
 * Counts only — nothing is written, nothing is validated, and calling this has
 * no side effects. It is safe to call on every dialog open.
 *
 * The dependency table mirrors Section 7 of the feature spec, mapped onto the
 * real collections rather than assumed ones.
 */
export const getDeletionImpact = onCall<{
  entityType: 'institute' | 'faculty' | 'student' | 'assessment';
  entityId: string;
}>({ region: 'us-central1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { entityType, entityId } = request.data || ({} as never);
  if (!entityType || !entityId) {
    throw new HttpsError('invalid-argument', 'entityType and entityId are required.');
  }

  const db = getFirestore();
  const actor = actorFrom(request);

  // Authorisation: a caller may only inspect an entity they could plausibly
  // act on. This is a READ of counts, so the bar is tenant membership rather
  // than a deletion right — Phase 3 gates the action itself.
  const requireTenant = async (): Promise<string | null> => {
    if (actor.actorRole === 'webOwner') return null;
    if (actor.actorRole !== 'institute' && actor.actorRole !== 'faculty') {
      throw new HttpsError('permission-denied', 'Insufficient permissions.');
    }
    if (!actor.instituteId) {
      throw new HttpsError('permission-denied', 'Missing tenant claim.');
    }
    return actor.instituteId;
  };

  const callerInstitute = await requireTenant();

  const counts: ImpactCounts = {};
  let label: string | null = null;
  let ownerInstituteId: string | null = null;

  if (entityType === 'institute') {
    // Only the Web Owner may inspect an institute — its dependents span the
    // whole tenant, and no tenant-level actor should enumerate another's.
    if (actor.actorRole !== 'webOwner') {
      throw new HttpsError('permission-denied', 'Only the Web Owner may inspect an institute.');
    }
    const snap = await db.collection('institutes').doc(entityId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Institute not found.');
    label = (snap.get('name') as string) ?? null;
    ownerInstituteId = entityId;

    const [faculty, students, assessments, attempts, reports, schools, programs, courses] =
      await Promise.all([
        countWhere(db, 'faculty', 'instituteId', entityId),
        countWhere(db, 'students', 'instituteId', entityId),
        countWhere(db, 'assessments', 'ownerId', entityId),
        countWhere(db, 'attempts', 'instituteId', entityId),
        countWhere(db, 'questionReports', 'instituteId', entityId),
        countWhere(db, 'schools', 'instituteId', entityId),
        countWhere(db, 'programs', 'instituteId', entityId),
        countWhere(db, 'courses', 'instituteId', entityId),
      ]);
    Object.assign(counts, {
      faculty, students, assessments, attempts, reports, schools, programs, courses,
    });
  } else if (entityType === 'faculty') {
    const snap = await db.collection('faculty').doc(entityId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Faculty not found.');
    ownerInstituteId = (snap.get('instituteId') as string) ?? null;
    label = (snap.get('name') as string) ?? null;
    if (callerInstitute && callerInstitute !== ownerInstituteId) {
      throw new HttpsError('permission-denied', 'Different institute.');
    }

    // Owned content is what makes faculty deletion consequential — these are
    // the counts that drive the succession decision in Phase 5.
    // No academicMappings row here: that collection is student-only (see the
    // note in performAccountDeletion). Counting it for faculty would query a
    // field that does not exist and render a permanent, meaningless "0".
    const [assessments, questions, banks] = await Promise.all([
      countWhere(db, 'assessments', 'ownerId', entityId),
      countWhere(db, 'questions', 'ownerId', entityId),
      countWhere(db, 'questionBanks', 'ownerId', entityId),
    ]);
    Object.assign(counts, { assessments, questions, questionBanks: banks });
  } else if (entityType === 'student') {
    const snap = await db.collection('students').doc(entityId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Student not found.');
    ownerInstituteId = (snap.get('instituteId') as string) ?? null;
    label = (snap.get('name') as string) ?? null;
    if (callerInstitute && callerInstitute !== ownerInstituteId) {
      throw new HttpsError('permission-denied', 'Different institute.');
    }

    const [attempts, mappings, reports, memberships] = await Promise.all([
      countWhere(db, 'attempts', 'studentId', entityId),
      countWhere(db, 'academicMappings', 'studentId', entityId),
      countWhere(db, 'questionReports', 'studentId', entityId),
      countWhere(db, 'assessmentMembers', 'studentId', entityId),
    ]);
    Object.assign(counts, { attempts, mappings, reports, memberships });
  } else if (entityType === 'assessment') {
    const snap = await db.collection('assessments').doc(entityId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    label = (snap.get('title') as string) ?? null;
    const ownerType = snap.get('ownerType') as string | undefined;
    const ownerId = snap.get('ownerId') as string | undefined;
    ownerInstituteId = ownerType === 'institute' ? (ownerId ?? null) : null;
    if (callerInstitute && ownerInstituteId && callerInstitute !== ownerInstituteId) {
      throw new HttpsError('permission-denied', 'Different institute.');
    }

    const [attempts, members] = await Promise.all([
      countWhere(db, 'attempts', 'assessmentId', entityId),
      countWhere(db, 'assessmentMembers', 'assessmentId', entityId),
    ]);
    Object.assign(counts, { attempts, members });
  } else {
    throw new HttpsError('invalid-argument', 'Unsupported entityType.');
  }

  // Anything that would be PRESERVED rather than destroyed is called out
  // separately, so the dialog can say so explicitly. The locked guarantee is
  // that account deletion never touches attempts or reports, and a dialog
  // that lists them beside faculty and students without that distinction
  // reads as "all of this will be destroyed" — the opposite of the truth.
  const preserved: string[] =
    entityType === 'student' ? ['attempts', 'reports']
    : entityType === 'faculty' ? ['attempts', 'reports']
    : [];

  return {
    ok: true as const,
    entityType,
    entityId,
    label,
    instituteId: ownerInstituteId,
    counts,
    preserved,
  };
});

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
  difficulty?: 'easy' | 'medium' | 'hard';   // server-read; used for per-row grading policy
}

// ── Grading policy (server twin of resolveGradingPolicy in assessmentService) ──
// Negative marking + blank handling, resolved per question through the chain
// exam → section → difficulty-row with the exam master switch as a hard gate.
// Frozen onto the attempt at start so a mid-flight edit can't regrade. Keep in
// EXACT sync with src/lib/assessmentService.ts.
type PenaltyTypeS = 'fixed' | 'percent';
interface GradingPolicyS {
  negativeMarking?: boolean;
  penaltyType?: PenaltyTypeS;
  penaltyValue?: number;
  blankScore?: number;
}
interface SectionGradingPolicyS {
  section?: GradingPolicyS;
  byDifficulty?: Partial<Record<'easy' | 'medium' | 'hard', GradingPolicyS>>;
}
interface AssessmentGradingConfigS {
  exam?: GradingPolicyS;
  sections?: Record<string, SectionGradingPolicyS>;
}
interface ResolvedGradingPolicyS {
  negativeMarking: boolean;
  penaltyType: PenaltyTypeS;
  penaltyValue: number;
  blankScore: number;
}

function resolveGradingPolicyS(
  config: AssessmentGradingConfigS | undefined,
  sectionId: string,
  difficulty: 'easy' | 'medium' | 'hard',
): ResolvedGradingPolicyS {
  const exam = config?.exam;
  const gateOpen = exam?.negativeMarking === true;
  const sectionPol = config?.sections?.[sectionId];
  const rowPol = sectionPol?.byDifficulty?.[difficulty];
  const pick = <K extends keyof GradingPolicyS>(k: K): GradingPolicyS[K] | undefined =>
    rowPol?.[k] ?? sectionPol?.section?.[k] ?? exam?.[k];

  const blankScore = pick('blankScore') ?? 0;
  if (!gateOpen) {
    return { negativeMarking: false, penaltyType: 'fixed', penaltyValue: 0, blankScore };
  }
  const negOn = pick('negativeMarking') ?? true;
  if (!negOn) {
    return { negativeMarking: false, penaltyType: 'fixed', penaltyValue: 0, blankScore };
  }
  return {
    negativeMarking: true,
    penaltyType: pick('penaltyType') ?? 'fixed',
    penaltyValue: Math.max(0, pick('penaltyValue') ?? 0),
    blankScore,
  };
}

// Compute the penalty (a POSITIVE number to subtract) for a fully-wrong answer
// under a resolved policy, given the question's own marks.
function penaltyFor(policy: ResolvedGradingPolicyS, questionMarks: number): number {
  if (!policy.negativeMarking || policy.penaltyValue <= 0) return 0;
  if (policy.penaltyType === 'percent') {
    return Math.max(0, (policy.penaltyValue / 100) * questionMarks);
  }
  return Math.max(0, policy.penaltyValue);
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
  // N5 final form (2026-07-17) — audience-scoped visibility. When present,
  // these arrays are authoritative; when absent (legacy docs), the old
  // booleans govern (see reviewAudienceAllows).
  allowReviewTo?: unknown;
  showResultsTo?: unknown;
  gradingConfig?: AssessmentGradingConfigS;   // negative marking + blank policy
}

// ── Visibility audiences (N5 final form) ──────────────────────────
// Owner-controlled, per-assessment: who may see correct answers.
//   allowReviewTo present → the array is authoritative per audience.
//   allowReviewTo absent  → legacy: the allowReview boolean governs
//     EVERYONE. Staff key access mirrors student access (staff ≤ students
//     symmetry) — this deliberately closes audit N5 for legacy docs too:
//     an allowReview:false exam exposes keys to no one, instead of to every
//     assigned institute's staff while live. Keys students already hold
//     (written into their attempts when they may review) are the floor;
//     granting staff less than students is only enforceable at the key
//     endpoint, not inside student-readable attempt docs.
type VisibilityAudience = 'students' | 'institute' | 'faculty';

function reviewAudienceAllows(
  assessment: { allowReview?: boolean; allowReviewTo?: unknown },
  audience: VisibilityAudience,
): boolean {
  const list = Array.isArray(assessment.allowReviewTo)
    ? (assessment.allowReviewTo as unknown[]).filter((x): x is string => typeof x === 'string')
    : null;
  if (list) return list.includes(audience);
  return assessment.allowReview === true;
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
  exposeKeysToStudent: boolean;
  invalidatedQuestionIds?: Set<string>;
  // Frozen grading policy (negative marking + blank handling). Absent = legacy
  // scoring (no penalty, blank = 0), so existing exams are unaffected.
  gradingConfig?: AssessmentGradingConfigS;
}): { scores: ScoresOut; gradedAnswers: Record<string, GradedAnswerOut> } {
  const { sections, questionMap, answerMap, answers, passingScore, exposeKeysToStudent } = params;
  const invalidated = params.invalidatedQuestionIds ?? new Set<string>();
  const gradingConfig = params.gradingConfig;

  let totalAwarded   = 0;
  let totalAvailable = 0;
  let requiresManualReview = false;
  const bySection: ScoresOut['bySection'] = [];
  const gradedAnswers: Record<string, GradedAnswerOut> = {};

  const exposeKeys = exposeKeysToStudent;

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

      // Resolve the grading policy for THIS question (exam → section → row).
      // Difficulty is read from the server-fetched question doc (trustworthy),
      // defaulting to 'medium' when absent. No config → NO_PENALTY equivalent.
      const difficulty = (q?.difficulty === 'easy' || q?.difficulty === 'hard') ? q.difficulty : 'medium';
      const policy = resolveGradingPolicyS(gradingConfig, sec.id, difficulty);

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
          // Option A: negative marking applies ONLY to a FULLY wrong answer
          // (multiplier 0). Any correct/partial content keeps its positive
          // award untouched — negative marking and partial credit stay
          // cleanly separated (partial credit is its own future feature).
          const award = multiplier > 0 ? multiplier * aq.marks : -penaltyFor(policy, aq.marks);
          sectionAwarded += award;
          totalAwarded   += award;
          exposed.marksAwarded = award;
          exposed.isCorrect    = isCorrect;
        } else if (q.engine === 'match') {
          const { multiplier, isCorrect } = scoreMatchMultiplier(ans, studentAnswer.value);
          const award = multiplier > 0 ? multiplier * aq.marks : -penaltyFor(policy, aq.marks);
          sectionAwarded += award;
          totalAwarded   += award;
          exposed.marksAwarded = award;
          exposed.isCorrect    = isCorrect;
        } else {
          // text engine — needs human grading
          requiresManualReview = true;
        }
      } else {
        // BLANK / unanswered — apply the policy's blankScore (default 0), NEVER
        // the wrong-answer penalty. A student can't lose marks for a question
        // they never attempted. Left out of `answered`.
        if (policy.blankScore !== 0) {
          sectionAwarded += policy.blankScore;
          totalAwarded   += policy.blankScore;
          exposed.marksAwarded = policy.blankScore;
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

  // Assessment-level floor: the headline total can never go below zero, even
  // if penalties exceeded earned marks. Sections are NOT floored — a section
  // may be internally net-negative (visible to staff as a diagnostic); only
  // the aggregate the student sees is clamped. (Seerat's decision.)
  const flooredTotal = Math.max(0, totalAwarded);

  const percentage = totalAvailable > 0
    ? Math.round((flooredTotal / totalAvailable) * 100 * 10) / 10
    : 0;
  const passed = passingScore !== undefined
    ? percentage >= passingScore
    : true;

  return {
    scores: {
      total: flooredTotal,
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
      gradingConfig?: AssessmentGradingConfigS;   // frozen at startExam
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
      // Keys land in the student's own attempt only when STUDENTS are in
      // the review audience (N5 final form).
      exposeKeysToStudent: reviewAudienceAllows(assessment, 'students'),
      // Grade under the policy FROZEN on the attempt at start; fall back to the
      // live assessment for attempts that predate the freeze (older in-progress).
      gradingConfig: attempt.gradingConfig ?? assessment.gradingConfig,
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
        gradingConfig?: AssessmentGradingConfigS;   // frozen policy for this attempt
      };
      if (!att.status || !FINISHED.has(att.status)) continue;
      if (att.isDeleted) continue;

      const { scores, gradedAnswers } = scoreAttemptAnswers({
        sections,
        questionMap,
        answerMap,
        answers: att.answers,
        passingScore: assessment.passingScore,
        exposeKeysToStudent: reviewAudienceAllows(assessment, 'students'),
        invalidatedQuestionIds: invalidated,
        // Regrade under each attempt's OWN frozen policy (fall back to live).
        gradingConfig: att.gradingConfig ?? assessment.gradingConfig,
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
      // N5 final form: non-owner staff get keys ONLY when the exam owner has
      // put their audience in allowReviewTo (or, on legacy docs, when the
      // allowReview boolean is on — the same access students have). Being
      // assigned/published alone no longer exports the key set; exam status
      // (active vs closed) is irrelevant once the audience allows it, which
      // is the point: the owner's flag is the consent, not the clock.
      const audience: VisibilityAudience =
        callerRole === 'institute' ? 'institute' : 'faculty';
      const staffMayReview = reviewAudienceAllows(assessment, audience);
      if (!ownsIt && !(assignedToCaller && staffMayReview)) {
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
      blockedStudents?: string[];
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

    // Explanation only for post-exam review, and only when STUDENTS are in
    // the assessment's review audience (N5 final form) — same gate
    // gradeAttempt applies when writing keys into the attempt.
    const includeExplanation =
      mode === 'review'
      && hasFinishedAttempt
      && reviewAudienceAllows(
           assessment as { allowReview?: boolean; allowReviewTo?: unknown },
           'students');

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

    // ── S-01 (audit 2026-07-26) — no paper without a live sitting ─────
    // Before this gate, `published && assigned` was sufficient to receive the
    // whole paper. AssessmentStatus has no 'scheduled' state (draft|active|
    // closed), so an exam published for next week is 'active' today: every
    // assigned student could download the entire question set before it
    // opened, with no attempt and — because the SEB check below keyed off
    // `liveAttempt?.status === 'in_progress'`, undefined when no attempt
    // exists — without Safe Exam Browser either.
    //
    // The fix is to require a live attempt rather than to re-list startExam's
    // schedule checks. A live attempt can only exist because startExam
    // admitted it, and startExam gates on startDate, endDate, maxAttempts,
    // blockedStudents, targeting, device class, camera and SEB (:4461-4558).
    // Requiring one is therefore strictly stronger than re-checking the
    // schedule here, and it cannot drift from startExam the way a duplicated
    // copy of those checks would.
    //
    // Deliberately NOT re-checking startDate/endDate: those are evaluated at
    // admission, and re-evaluating them on every fetch would cut off a student
    // who is legitimately mid-exam when the window closes or when staff edit
    // the schedule underneath them. ExamShell:872 states the same rule from
    // the client side — "once started, letting a running attempt continue is
    // the right thing."
    //
    // blockedStudents IS re-checked, because unlike the schedule it is a live
    // invigilation action: a student blocked mid-exam must stop being able to
    // re-fetch the paper on reload.
    //
    // 'frozen' counts as live. It is a paused sitting, not a finished one, and
    // both startExam (:4547-4550) and ExamShell (:876, :901) already treat
    // in_progress|frozen as the live pair. Gating on 'in_progress' alone would
    // break resume for any student an invigilator has frozen.
    //
    // Both modes are gated. 'review' is NOT a safe default: the authz check
    // above passes on `published && assigned` alone, so a caller who simply
    // sends mode:'review' would otherwise walk out with the same paper the
    // live-attempt requirement is meant to protect. Review therefore requires
    // an attempt to exist — proof the student actually sat the paper.
    //
    // hasAttempt (any status), not hasFinishedAttempt: it mirrors the client's
    // own precondition (ExamResultsPage:327 gates on `att &&`), and it is
    // already sufficient here — creating an attempt at all means clearing
    // every startExam gate, so a caller who can do that could equally read the
    // paper through exam mode. Requiring 'finished' would buy no security and
    // would break a student who opens results with a sitting still open.
    if (mode === 'review') {
      if (!hasAttempt) {
        throw new HttpsError('failed-precondition', 'You have not sat this exam.');
      }
    } else {
      if ((assessment.blockedStudents ?? []).includes(studentId)) {
        throw new HttpsError('permission-denied', 'This exam is not available to you.');
      }
      const liveStatus = liveAttempt?.status;
      if (liveStatus !== 'in_progress' && liveStatus !== 'frozen') {
        throw new HttpsError(
          'failed-precondition',
          'Start the exam before fetching questions.',
        );
      }
    }

    // Phase 3 — gate the LIVE exam fetch only. 'review' runs after submission,
    // when the student has quit SEB; requiring SEB there would make results
    // permanently unviewable.
    //
    // S-01: the gate above guarantees a live attempt in every non-review call,
    // so this no longer needs its own status test — and dropping that test is
    // what closes the frozen-resume hole, where SEB was previously skipped.
    // The attempt's FROZEN securityConfig.requireSEB is still the input, never
    // the client's claim; ExamShell arms the token manager at :867 on the
    // resume path too, so a frozen resume carries a proof.
    if (mode !== 'review') {
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
// STUDENT ASSESSMENT LIST  (audit 2026-07-26, S-04)
// ══════════════════════════════════════════════════════════════════
// Replaces a client-side collection scan. The old getAssessmentsForStudent
// ran two UNFILTERED queries — status=='active' and status=='closed', with no
// tenant or assignment constraint — pulling every assessment on the platform
// to every student's browser and filtering there. The filtering was cosmetic:
// the full set, including other institutes' exams, was already on the wire.
//
// That could not be fixed in firestore.rules alone. Rules are evaluated per
// returned document and one failure rejects the whole query, so tightening
// the student read rule while the client still issued an unscoped query would
// simply have emptied every student's dashboard. The list has to move to a
// place that can filter BEFORE returning, which means here.
//
// Deliberately the same visibility logic and the same two queries the client
// ran, executed server-side. Matching current behaviour exactly is the point:
// this is a security fix, not a rewrite, and a targeted-query optimisation
// would change which exams appear. Reducing the read cost is worth doing —
// see P-02 — but as its own change, where a visibility regression would be
// attributable.
//
// Legacy docs with no assignedTo field at all are treated as webOwner-global,
// byte-for-byte as the client did (`if (!t) return true`). They cannot be
// found by query — Firestore cannot match a missing field — which is the
// other reason the scan stays.

/** Fields a student may see in their OWN assessment list. */
interface StudentAssessmentSummary {
  id: string;
  title?: unknown;
  subject?: unknown;
  status?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  totalMarks?: unknown;
  passingScore?: unknown;
  maxAttempts?: unknown;
  showResults?: unknown;
  allowReview?: unknown;
  questions?: unknown;
  sections?: unknown;
  blockedStudents: string[];
  attemptOverrides: Record<string, number>;
}

/**
 * Field WHITELIST, same construction as sanitizeQuestionForStudent — anything
 * not named here never reaches a student, so a leaky field added to assessment
 * docs later is contained by default rather than by remembering to exclude it.
 *
 * Two fields are REDUCED rather than dropped, because the list UI genuinely
 * needs them but only ever reads this student's own entry:
 *
 *   blockedStudents  — a roster of other students' ids. The page asks exactly
 *                      one question of it (`includes(studentId)`, :50 and
 *                      :300), so returning either [] or [studentId] preserves
 *                      that check bit-for-bit while disclosing nobody else.
 *   attemptOverrides — a map keyed by student id. Read only as
 *                      `[studentId]` (:52, :258), so a single-entry map is
 *                      indistinguishable to the client.
 *
 * questions / sections are kept INTACT. Question ids used to matter because
 * they were half the input to the S-01 paper-download attack, but that is
 * closed: getExamQuestions now demands a live attempt, and firestore.rules:621
 * denies students direct reads of the questions collection. An id on its own
 * is inert, and the list needs `questions.length` plus each section's id, name
 * and timeLimit to render.
 */
function sanitizeAssessmentForStudent(
  id: string,
  a: Record<string, unknown>,
  studentId: string,
): StudentAssessmentSummary {
  const blocked = Array.isArray(a.blockedStudents) ? (a.blockedStudents as string[]) : [];
  const overrides = (a.attemptOverrides ?? {}) as Record<string, number>;
  const own = overrides[studentId];

  return {
    id,
    title: a.title,
    subject: a.subject,
    status: a.status,
    startDate: a.startDate,
    endDate: a.endDate,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    totalMarks: a.totalMarks,
    passingScore: a.passingScore,
    maxAttempts: a.maxAttempts,
    showResults: a.showResults,
    allowReview: a.allowReview,
    questions: a.questions ?? [],
    sections: a.sections ?? [],
    blockedStudents: blocked.includes(studentId) ? [studentId] : [],
    attemptOverrides: own === undefined ? {} : { [studentId]: own },
  };
}

export const getStudentAssessments = onCall(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role        = request.auth.token.role        as string | undefined;
    const studentId   = request.auth.token.studentId   as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    if (role !== 'student' || !studentId || !instituteId) {
      throw new HttpsError('permission-denied', 'Only students may list their assessments here.');
    }

    const db = getFirestore();

    const [activeSnap, closedSnap, memberSnap] = await Promise.all([
      db.collection('assessments')
        .where('status', '==', 'active').where('isDeleted', '==', false).get(),
      db.collection('assessments')
        .where('status', '==', 'closed').where('isDeleted', '==', false).get(),
      db.collection('assessmentMembers')
        .where('studentId', '==', studentId).where('active', '==', true).get(),
    ]);

    const memberOf = new Set(memberSnap.docs.map((d) => String(d.get('assessmentId'))));

    const assessments: StudentAssessmentSummary[] = [];
    for (const doc of [...activeSnap.docs, ...closedSnap.docs]) {
      const a = doc.data() as Record<string, unknown> & {
        allocationMode?: string;
        assignedTo?: { type?: string; instituteIds?: string[]; studentIds?: string[] };
      };

      // Two paths, chosen per-assessment by allocationMode — the same split
      // startExam and getExamQuestions use. Under 'rules' the materialized
      // membership list is authoritative and assignedTo is stale by design
      // (resolveAllocation does not clear it), so consulting assignedTo here
      // would let a rules-allocated exam carrying assignedTo.type 'all' show
      // up for every student on the platform.
      let visible: boolean;
      if (a.allocationMode === 'rules') {
        visible = memberOf.has(doc.id);
      } else {
        const t = a.assignedTo;
        visible = !t
          || t.type === 'all'
          || (t.type === 'institutes' && (t.instituteIds ?? []).includes(instituteId))
          || (t.type === 'students'   && (t.studentIds   ?? []).includes(studentId));
      }
      if (!visible) continue;

      assessments.push(sanitizeAssessmentForStudent(doc.id, a, studentId));
    }

    return { ok: true, assessments };
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
const DEFAULT_OVERALL_GRACE_SECONDS = 30;

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
      gradingConfig?: AssessmentGradingConfigS;   // frozen onto the attempt below
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
      // Frozen grading policy — negative marking + blank handling, resolved per
      // question at grade time from THIS snapshot, so editing the exam's policy
      // mid-flight can't change how an in-progress student is scored. Only
      // stored when the exam actually defines a policy (keeps legacy attempts
      // clean; absent === legacy scoring).
      ...(a.gradingConfig ? { gradingConfig: a.gradingConfig } : {}),
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

// ── Positional break resolution ───────────────────────────────────
// (Server twin of breakAfterCompletion in src/app/pages/student/ExamShell.tsx
// — the client schedules the UI from the same formula. Keep them in sync.)
//
// A break is AUTHORED on a section in builder order, but is APPLIED by
// completion count: the break after the Nth completed section is the one
// authored on the Nth section in builder order, regardless of the per-student
// play order. Under 'random' / 'student_choice' this makes the break schedule
// identical for every student; under 'sequential' builder order == play
// order, so it is exactly the legacy per-section behaviour.
//
// builderSections = assessment.sections (builder order). attemptSectionIds is
// the attempt's frozen played set (possibly a filtered subset of the builder
// list — empty sections are dropped client-side; legacy flat-question
// attempts use a synthetic id that matches nothing → no breaks). Sections
// complete strictly in play order in every mode, so a section's play index IS
// its completion ordinal.
type BreakCfg = { durationMinutes: number; mandatory: boolean };

function breakAfterCompletion(
  builderSections: Array<{ id: string; breakAfter?: BreakCfg }> | undefined,
  attemptSectionIds: string[] | undefined,
  completedCount: number,
): BreakCfg | null {
  if (!builderSections || builderSections.length === 0 || completedCount < 1) return null;
  const played = new Set(attemptSectionIds ?? []);
  const ordered = played.size > 0
    ? builderSections.filter((s) => played.has(s.id))
    : builderSections;
  if (completedCount >= ordered.length) return null; // no break after the last section
  const brk = ordered[completedCount - 1]?.breakAfter;
  return brk && typeof brk.durationMinutes === 'number' && brk.durationMinutes > 0 ? brk : null;
}
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

    // Mandatory-break gate (POSITIONAL): starting the section at play index
    // `idx` means `idx` sections are already completed, so the applicable
    // break is the one after the idx-th completion — resolved by builder-
    // order position via breakAfterCompletion, NOT by which section happened
    // to be played (random shuffles / student picks make identity meaningless
    // for scheduling). Deny if that break is mandatory and hasn't elapsed
    // since the previous play-order section's submit.
    const idx = sectionIds.indexOf(sectionId);
    if (idx > 0) {
      const prevId = sectionIds[idx - 1];
      const prevTiming = attempt.sectionTimings[prevId];
      if (prevTiming?.submittedAt) {
        const aSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
        const a = aSnap.data() as {
          sections?: Array<{ id: string; breakAfter?: BreakCfg }>;
        } | undefined;
        const brk = breakAfterCompletion(a?.sections, attempt.sectionIds, idx);
        if (brk && brk.mandatory) {
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
      startedAt?: string;      // wall-clock start of the whole sitting — overall-clock anchor
      sectionIds?: string[];   // frozen play order — used for positional break resolution
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
      overallTimeLimit?: number;
      overallGraceSeconds?: number;
      sections?: Array<{ id: string; timeLimit?: number; breakAfter?: BreakCfg }>;
    };

    // ── Server-side pause decision (positional breaks) ───────────────
    // Submitting the section at play index `playIdx` completes playIdx + 1
    // sections, so the break due now is breakAfterCompletion(…, playIdx + 1).
    // When that break is MANDATORY, the server refuses to auto-start the next
    // section regardless of the client's pauseBeforeNext — a tampered client
    // can no longer skip a mandatory break by claiming no pause is needed.
    // (Skippable breaks stay client-scheduled: the student may continue
    // immediately anyway, so forcing a pause here would add nothing.)
    const playIdx = Array.isArray(attempt.sectionIds) ? attempt.sectionIds.indexOf(sectionId) : -1;
    const breakDue = playIdx >= 0
      ? breakAfterCompletion(a.sections, attempt.sectionIds, playIdx + 1)
      : null;
    const mandatoryBreakDue = !!(breakDue && breakDue.mandatory);

    const startedMs = new Date(timing.startedAt).getTime();
    const serverNow = Date.now();
    const timeUsedSeconds = Math.max(0, Math.floor((serverNow - startedMs) / 1000));

    const sec = a.sections?.find((s) => s.id === sectionId);
    const graceSec = a.sectionGraceSeconds ?? DEFAULT_SECTION_GRACE_SECONDS;

    // ── Overall exam deadline (hard cut) ─────────────────────────────
    // Anchored on attempt.startedAt — the wall-clock start of the whole
    // sitting — so all idle time between/inside sections and every break
    // counts against it. This is the fence that closes the "walk away
    // between sections" leak: the section clocks each run independently and
    // honestly, but nothing else stops a student from taking hours across
    // the exam. Checked BEFORE the section deadline: if the whole exam is
    // over, that verdict wins regardless of the section's own clock.
    //
    // On breach we HARD CUT — close the current section at the overall
    // deadline and refuse to advance to any next section. The client
    // finalises the attempt (gradeAttempt) on seeing this signal; whatever
    // is answered stands. Grace is the overall knob (own 30s default), the
    // single trailing buffer for network lag at the buzzer.
    //
    // Freeze posture matches the section check: the server ignores freeze
    // here (grace absorbs slack; freeze is an invigilator escape hatch
    // credited only in the client display). Consistent with the existing
    // section-deadline enforcement above.
    if (a.overallTimeLimit && a.overallTimeLimit > 0 && attempt.startedAt) {
      const overallGraceSec = a.overallGraceSeconds ?? DEFAULT_OVERALL_GRACE_SECONDS;
      const examStartMs = new Date(attempt.startedAt).getTime();
      const overallDeadlineMs = examStartMs + a.overallTimeLimit * 60_000 + overallGraceSec * 1000;
      if (serverNow > overallDeadlineMs) {
        // Close the current section at its true submit time (clamped to the
        // section's own deadline if that is earlier), never advancing.
        let sectionCloseMs = serverNow;
        if (sec?.timeLimit && sec.timeLimit > 0) {
          const sectionDeadlineMs = startedMs + sec.timeLimit * 60_000 + graceSec * 1000;
          sectionCloseMs = Math.min(serverNow, sectionDeadlineMs);
        }
        const closeIso = new Date(sectionCloseMs).toISOString();
        const usedSec = Math.max(0, Math.floor((sectionCloseMs - startedMs) / 1000));
        await attemptRef.update({
          [`sectionTimings.${sectionId}.submittedAt`]: closeIso,
          [`sectionTimings.${sectionId}.timeUsedSeconds`]: usedSec,
          updatedAt: new Date().toISOString(),
        });
        // The client catches this and calls gradeAttempt('time_expired') to
        // finalise the whole attempt. No next section is served.
        throw new HttpsError('deadline-exceeded', 'OVERALL_DEADLINE_EXCEEDED');
      }
    }

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
        if (nextSectionId && !pauseBeforeNext && !mandatoryBreakDue) {
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
    if (nextSectionId && !pauseBeforeNext && !mandatoryBreakDue) {
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
    // breakDue is informational for the client (the new bundle computes the
    // same positional schedule itself); it also documents why an auto-start
    // was refused when a mandatory break was due.
    return { ok: true, timeUsedSeconds, question: nextQuestion, breakDue };
  },
);
// ═══════════════════════════════════════════════════════════════════════════
// QUESTION RIGHTS — Phase 2 (permission model)
// Rights-enforced write path for institute/faculty question authoring.
// Web Owner authoring stays on the direct client path (unrestricted owner).
// These callables make the create/edit/delete RIGHT tamper-proof: the client
// UI hides buttons, but the actual write is gated here against the caller's
// server-side rights, the institute ceiling, ownership, and the tenant stamp.
// Direct mode only in Phase 2; 'request' mode is stored but its approval
// workflow is Phase 3, so a request-mode grant is treated as "not permitted"
// for direct execution here.
// ═══════════════════════════════════════════════════════════════════════════

type CeilingRightS = { allowed?: boolean; modes?: Array<'direct' | 'request'> };
type QuestionRightsCeilingS = Record<'create' | 'edit' | 'share' | 'delete', CeilingRightS | undefined>;
type FacultyRightS = { granted?: boolean; mode?: 'direct' | 'request' };
type FacultyRightsS = Record<'create' | 'edit' | 'share' | 'delete', FacultyRightS | undefined>;

// Server twin of effectiveFacultyMode/instituteHasRight in
// src/lib/questionRights.ts — keep in sync. Resolves whether the caller may
// perform `right` in DIRECT mode right now.
async function assertQuestionRight(
  db: FirebaseFirestore.Firestore,
  callerRole: string | undefined,
  callerInstituteId: string | undefined,
  callerFacultyId: string | undefined,
  right: 'create' | 'edit' | 'share' | 'delete',
  // Which mode the caller must hold for this action:
  //   'direct'  — the direct callables (act immediately)
  //   'request' — the request-submission callable (faculty raises a request)
  //   'any'     — accept either (used when the mode isn't the gate)
  // The institute admin always resolves to 'direct' (never operates in
  // request mode against themselves).
  requireMode: 'direct' | 'request' | 'any' = 'direct',
): Promise<{ ownerType: 'institute' | 'faculty'; ownerId: string; instituteId: string; mode: 'direct' | 'request' }> {
  if (callerRole !== 'institute' && callerRole !== 'faculty') {
    throw new HttpsError('permission-denied', 'Only institute or faculty accounts use this endpoint.');
  }
  if (!callerInstituteId) {
    throw new HttpsError('permission-denied', 'Missing institute context.');
  }

  // Institute ceiling — required for the right to exist at all.
  const instSnap = await db.collection('institutes').doc(callerInstituteId).get();
  const ceiling = (instSnap.get('questionRightsCeiling') as QuestionRightsCeilingS | undefined) ?? undefined;
  const cr = ceiling?.[right];
  if (!cr?.allowed) {
    throw new HttpsError('permission-denied', `This institute does not have the "${right}" right.`);
  }

  if (callerRole === 'institute') {
    // The institute admin holds all rights the ceiling allows, in direct mode.
    if (requireMode === 'request') {
      throw new HttpsError('failed-precondition', 'Institute admins act directly, not by request.');
    }
    return { ownerType: 'institute', ownerId: callerInstituteId, instituteId: callerInstituteId, mode: 'direct' };
  }

  // Faculty: needs the individual grant, in an allowed mode, within the ceiling.
  if (!callerFacultyId) {
    throw new HttpsError('permission-denied', 'Missing faculty context.');
  }
  const facSnap = await db.collection('faculty').doc(callerFacultyId).get();
  if (!facSnap.exists) {
    throw new HttpsError('permission-denied', 'Faculty account not found.');
  }
  const rights = (facSnap.get('questionRights') as FacultyRightsS | undefined) ?? undefined;
  const fr = rights?.[right];
  const grantableModes = cr.modes ?? [];
  // The granted mode must be currently grantable by the ceiling.
  if (!fr?.granted || !fr.mode || !grantableModes.includes(fr.mode)) {
    throw new HttpsError(
      'permission-denied',
      `The "${right}" right is not enabled for your account. Ask your institute admin.`,
    );
  }
  if (requireMode !== 'any' && fr.mode !== requireMode) {
    throw new HttpsError(
      'failed-precondition',
      requireMode === 'direct'
        ? `Your "${right}" right requires approval — submit a request instead.`
        : `Your "${right}" right is direct — no request needed.`,
    );
  }
  return { ownerType: 'faculty', ownerId: callerFacultyId, instituteId: callerInstituteId, mode: fr.mode };
}

// Shared answer-key extraction — mirrors src/lib/questionBankService.ts.
const ANSWER_KEYS_S = ['correctIds', 'correctPairs', 'modelAnswer'] as const;
function splitQuestionPayload(payload: Record<string, unknown>) {
  const publicPart: Record<string, unknown> = {};
  const answerPart: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if ((ANSWER_KEYS_S as readonly string[]).includes(k)) answerPart[k] = v;
    else publicPart[k] = v;
  }
  return { publicPart, answerPart };
}
function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

// ── Reusable question executors ───────────────────────────────────
// The actual write logic for each action, factored out so BOTH the direct
// callables and the request-approval path (resolveQuestionRequest) run
// identical, server-authoritative writes. Each takes the resolved owner
// (from assertQuestionRight) plus the payload, and performs no rights check
// of its own — the caller must have already authorized.

type QOwner = { ownerType: 'institute' | 'faculty'; ownerId: string; instituteId: string };

async function execCreateQuestion(
  db: FirebaseFirestore.Firestore,
  owner: QOwner,
  src: Record<string, unknown>,
  taxonomy: { subjectId?: string | null; topicId?: string | null },
): Promise<{ id: string }> {
  const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const nowIso = new Date().toISOString();
  const full: Record<string, unknown> = {
    ...src,
    id,
    ownerType: owner.ownerType,
    ownerId:   owner.ownerId,
    instituteId: owner.instituteId,
    isDeleted: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const { publicPart, answerPart } = splitQuestionPayload(full);
  const publicDoc = stripUndefined({ ...publicPart, correctIds: [], correctPairs: [], modelAnswer: '' });
  const answerDoc = stripUndefined({
    id, ownerType: owner.ownerType, ownerId: owner.ownerId,
    correctIds: [], correctPairs: [], modelAnswer: '', ...answerPart, updatedAt: nowIso,
  });
  const batch = db.batch();
  batch.set(db.collection('questions').doc(id), publicDoc);
  batch.set(db.collection('questionAnswers').doc(id), answerDoc);
  await batch.commit();
  try {
    if (taxonomy.subjectId) await db.collection('subjects').doc(String(taxonomy.subjectId)).update({ questionCount: FieldValue.increment(1) });
    if (taxonomy.topicId)   await db.collection('topics').doc(String(taxonomy.topicId)).update({ questionCount: FieldValue.increment(1) });
  } catch (e) { console.warn('[execCreateQuestion] counter bump skipped', e); }
  return { id };
}

async function execEditQuestion(
  db: FirebaseFirestore.Firestore,
  owner: QOwner,
  id: string,
  src: Record<string, unknown>,
  taxonomy: { subjectId?: string | null; topicId?: string | null; prevSubjectId?: string | null; prevTopicId?: string | null },
): Promise<void> {
  // Ownership: edit is OWN-questions-only.
  const existing = await db.collection('questions').doc(id).get();
  if (!existing.exists) throw new HttpsError('not-found', 'Question not found.');
  if (existing.get('ownerType') !== owner.ownerType || existing.get('ownerId') !== owner.ownerId) {
    throw new HttpsError('permission-denied', 'You can only edit your own questions.');
  }
  const nowIso = new Date().toISOString();
  const { publicPart, answerPart } = splitQuestionPayload(src);
  delete publicPart.id; delete publicPart.ownerType; delete publicPart.ownerId;
  delete publicPart.instituteId; delete publicPart.createdAt;
  const batch = db.batch();
  if (Object.keys(publicPart).length > 0) {
    batch.update(db.collection('questions').doc(id), stripUndefined({ ...publicPart, updatedAt: nowIso }));
  }
  if (Object.keys(answerPart).length > 0) {
    batch.set(
      db.collection('questionAnswers').doc(id),
      stripUndefined({ ...answerPart, ownerType: owner.ownerType, ownerId: owner.ownerId, updatedAt: nowIso }),
      { merge: true },
    );
  }
  await batch.commit();
  const { subjectId, topicId, prevSubjectId, prevTopicId } = taxonomy;
  try {
    if (prevSubjectId && prevSubjectId !== subjectId) await db.collection('subjects').doc(String(prevSubjectId)).update({ questionCount: FieldValue.increment(-1) });
    if (subjectId && subjectId !== prevSubjectId)     await db.collection('subjects').doc(String(subjectId)).update({ questionCount: FieldValue.increment(1) });
    if (prevTopicId && prevTopicId !== topicId)       await db.collection('topics').doc(String(prevTopicId)).update({ questionCount: FieldValue.increment(-1) });
    if (topicId && topicId !== prevTopicId)           await db.collection('topics').doc(String(topicId)).update({ questionCount: FieldValue.increment(1) });
  } catch (e) { console.warn('[execEditQuestion] counter shift skipped', e); }
}

async function execDeleteQuestion(
  db: FirebaseFirestore.Firestore,
  owner: QOwner,
  id: string,
  taxonomy: { subjectId?: string | null; topicId?: string | null },
): Promise<void> {
  const existing = await db.collection('questions').doc(id).get();
  if (!existing.exists) throw new HttpsError('not-found', 'Question not found.');
  if (existing.get('ownerType') !== owner.ownerType || existing.get('ownerId') !== owner.ownerId) {
    throw new HttpsError('permission-denied', 'You can only delete your own questions.');
  }
  await db.collection('questions').doc(id).update({ isDeleted: true, updatedAt: new Date().toISOString() });
  const subjectId = taxonomy.subjectId ?? existing.get('subjectId') ?? null;
  const topicId   = taxonomy.topicId ?? existing.get('topicId') ?? null;
  try {
    if (subjectId) await db.collection('subjects').doc(String(subjectId)).update({ questionCount: FieldValue.increment(-1) });
    if (topicId)   await db.collection('topics').doc(String(topicId)).update({ questionCount: FieldValue.increment(-1) });
  } catch (e) { console.warn('[execDeleteQuestion] counter bump skipped', e); }
}

async function execShareQuestions(
  db: FirebaseFirestore.Firestore,
  owner: QOwner,
  questionIds: string[],
  recipients: Array<{ id: string; type: 'faculty' | 'institute' }>,
  note: string,
): Promise<{ shareIds: string[] }> {
  // Recipients must be inside the caller's institute.
  for (const r of recipients) {
    if (r.type === 'institute') {
      if (r.id !== owner.instituteId) throw new HttpsError('permission-denied', 'Can only share within your own institute.');
    } else if (r.type === 'faculty') {
      const facSnap = await db.collection('faculty').doc(r.id).get();
      if (!facSnap.exists || facSnap.get('instituteId') !== owner.instituteId) {
        throw new HttpsError('permission-denied', 'Recipient is not in your institute.');
      }
    } else {
      throw new HttpsError('invalid-argument', 'Invalid recipient type.');
    }
  }
  // Each shared question must be legitimately held by the caller.
  for (let i = 0; i < questionIds.length; i += 30) {
    const chunk = questionIds.slice(i, i + 30);
    const snap = await db.collection('questions').where('id', 'in', chunk).get();
    const found = new Map(snap.docs.map((d) => [d.id, d]));
    for (const qid of chunk) {
      const doc = found.get(qid);
      if (!doc) throw new HttpsError('not-found', `Question ${qid} not found.`);
      const qOwnerType = doc.get('ownerType') ?? 'webOwner';
      const qOwnerId   = doc.get('ownerId')   ?? 'webOwner';
      const qInstitute = doc.get('instituteId') ?? '';
      const ownedByCaller = qOwnerType === owner.ownerType && qOwnerId === owner.ownerId;
      const inCallerInstitute = qInstitute === owner.instituteId;
      const isWebOwnerContent = qOwnerType === 'webOwner';
      if (!ownedByCaller && !inCallerInstitute && !isWebOwnerContent) {
        throw new HttpsError('permission-denied', `You cannot share question ${qid}.`);
      }
    }
  }
  const nowIso = new Date().toISOString();
  const batch = db.batch();
  const created: string[] = [];
  for (const r of recipients) {
    const id = `qs_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    created.push(id);
    batch.set(db.collection('questionShares').doc(id), {
      id,
      sharedBy:            owner.ownerId,
      sharedByType:        owner.ownerType,
      sharedByInstituteId: owner.instituteId,
      sharedWith:          r.id,
      sharedWithType:      r.type,
      questionIds,
      note,
      isRevoked:           false,
      sharedAt:            nowIso,
      updatedAt:           nowIso,
    });
  }
  await batch.commit();
  return { shareIds: created };
}

interface QWritePayload {
  id?: string;
  // Full question fields the client already assembled (public + answer keys),
  // minus owner/stamp which the server assigns authoritatively.
  question: Record<string, unknown>;
  // taxonomy hint for counter bumps
  subjectId?: string | null;
  topicId?: string | null;
  prevSubjectId?: string | null;
  prevTopicId?: string | null;
}

/** Create a question as institute/faculty, gated by the create right. */
export const createQuestionAsRole = onCall<QWritePayload>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    const facultyId   = request.auth.token.facultyId   as string | undefined;

    const owner = await assertQuestionRight(db, role, instituteId, facultyId, 'create');

    const src = request.data?.question;
    if (!src || typeof src !== 'object') {
      throw new HttpsError('invalid-argument', 'Missing question payload.');
    }
    const { id } = await execCreateQuestion(db, owner, src, {
      subjectId: request.data?.subjectId ?? null,
      topicId:   request.data?.topicId ?? null,
    });
    return { ok: true, id };
  },
);

/** Edit a question as institute/faculty — gated by the edit right AND ownership. */
export const editQuestionAsRole = onCall<QWritePayload>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    const facultyId   = request.auth.token.facultyId   as string | undefined;

    const owner = await assertQuestionRight(db, role, instituteId, facultyId, 'edit');

    const id = request.data?.id;
    if (!id) throw new HttpsError('invalid-argument', 'Missing question id.');
    const src = request.data?.question;
    if (!src || typeof src !== 'object') throw new HttpsError('invalid-argument', 'Missing question payload.');

    await execEditQuestion(db, owner, id, src, {
      subjectId: request.data?.subjectId ?? null,
      topicId:   request.data?.topicId ?? null,
      prevSubjectId: request.data?.prevSubjectId ?? null,
      prevTopicId:   request.data?.prevTopicId ?? null,
    });
    return { ok: true };
  },
);

/** Soft-delete a question as institute/faculty — gated by the delete right AND ownership. */
export const deleteQuestionAsRole = onCall<{ id?: string; subjectId?: string | null; topicId?: string | null }>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    const facultyId   = request.auth.token.facultyId   as string | undefined;

    const owner = await assertQuestionRight(db, role, instituteId, facultyId, 'delete');

    const id = request.data?.id;
    if (!id) throw new HttpsError('invalid-argument', 'Missing question id.');

    await execDeleteQuestion(db, owner, id, {
      subjectId: request.data?.subjectId ?? null,
      topicId:   request.data?.topicId ?? null,
    });
    return { ok: true };
  },
);

/**
 * Share questions with peers as institute/faculty — gated by the SHARE right.
 * Faculty may share their OWN questions and content GRANTED to them, strictly
 * with recipients inside their own institute. The server:
 *   1. enforces the share right (ceiling + faculty grant, direct mode),
 *   2. verifies every recipient is inside the caller's institute,
 *   3. verifies every shared question is one the caller legitimately holds
 *      (owns, or was shared/granted to them),
 * then writes one QuestionShare per recipient. Direct mode only in Phase 2;
 * request mode routes to the Phase-3 approval workflow.
 */
export const shareQuestionsAsRole = onCall<{
  questionIds?: string[];
  recipients?: Array<{ id: string; type: 'faculty' | 'institute' }>;
  note?: string;
}>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    const facultyId   = request.auth.token.facultyId   as string | undefined;

    const owner = await assertQuestionRight(db, role, instituteId, facultyId, 'share');

    const questionIds = Array.isArray(request.data?.questionIds) ? request.data!.questionIds! : [];
    const recipients  = Array.isArray(request.data?.recipients) ? request.data!.recipients! : [];
    const note = typeof request.data?.note === 'string' ? request.data!.note.slice(0, 500) : '';
    if (questionIds.length === 0) throw new HttpsError('invalid-argument', 'No questions to share.');
    if (recipients.length === 0)  throw new HttpsError('invalid-argument', 'No recipients selected.');
    if (questionIds.length > 200) throw new HttpsError('invalid-argument', 'Too many questions in one share.');

    const { shareIds } = await execShareQuestions(db, owner, questionIds, recipients, note);
    return { ok: true, shareIds };
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// QUESTION REQUESTS — Phase 3 (request/approval workflow)
// When a faculty member's grant for an action is in REQUEST mode, the action
// doesn't execute directly — it becomes a pending questionRequests doc that
// the institute admin approves or rejects. Approval EXECUTES the action
// server-side via the same exec* functions the direct callables use, so the
// approval path is exactly as tamper-proof as the direct path.
// ═══════════════════════════════════════════════════════════════════════════

interface RequestPayload {
  type?: 'create' | 'edit' | 'delete' | 'share';
  // create/edit: full question fields; delete: unused; share: unused
  question?: Record<string, unknown>;
  questionId?: string;                // edit/delete/share subject
  questionStem?: string;              // denormalized for inbox display
  subjectId?: string | null;
  topicId?: string | null;
  prevSubjectId?: string | null;
  prevTopicId?: string | null;
  // share
  recipients?: Array<{ id: string; type: 'faculty' | 'institute' }>;
  note?: string;
}

/**
 * Faculty submits a request for an action their grant only permits in REQUEST
 * mode. Verifies the request-mode grant, validates the payload the same way
 * the direct callables do (ownership for edit/delete; recipients+holdings for
 * share), and writes a PENDING questionRequests doc. Does NOT mutate anything.
 */
export const submitQuestionRequest = onCall<RequestPayload>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    const facultyId   = request.auth.token.facultyId   as string | undefined;

    const type = request.data?.type;
    if (!type || !['create', 'edit', 'delete', 'share'].includes(type)) {
      throw new HttpsError('invalid-argument', 'Invalid request type.');
    }

    // Must hold the right in REQUEST mode (institute admins never reach here —
    // they act directly). This throws if the grant is direct or absent.
    const owner = await assertQuestionRight(db, role, instituteId, facultyId, type, 'request');

    // Pre-validate the payload so obviously-invalid requests are rejected at
    // submission rather than sitting in the inbox until approval fails.
    if (type === 'edit' || type === 'delete') {
      const qid = request.data?.questionId;
      if (!qid) throw new HttpsError('invalid-argument', 'Missing question id.');
      const existing = await db.collection('questions').doc(qid).get();
      if (!existing.exists) throw new HttpsError('not-found', 'Question not found.');
      if (existing.get('ownerType') !== owner.ownerType || existing.get('ownerId') !== owner.ownerId) {
        throw new HttpsError('permission-denied', `You can only ${type} your own questions.`);
      }
    }
    if (type === 'create' || type === 'edit') {
      if (!request.data?.question || typeof request.data.question !== 'object') {
        throw new HttpsError('invalid-argument', 'Missing question payload.');
      }
    }
    if (type === 'share') {
      const recips = request.data?.recipients;
      if (!Array.isArray(recips) || recips.length === 0) {
        throw new HttpsError('invalid-argument', 'No recipients selected.');
      }
    }

    // Faculty display name for the inbox.
    const facSnap = await db.collection('faculty').doc(facultyId!).get();
    const facultyName = (facSnap.get('name') as string | undefined) ?? 'Faculty';

    const id = `qr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const nowIso = new Date().toISOString();
    await db.collection('questionRequests').doc(id).set(stripUndefined({
      id,
      type,
      status: 'pending',
      facultyId,
      facultyName,
      instituteId: owner.instituteId,
      questionId:   request.data?.questionId ?? null,
      questionStem: request.data?.questionStem ?? null,
      payload: stripUndefined({
        question:  request.data?.question ?? null,
        recipients: request.data?.recipients ?? null,
        note:       request.data?.note ?? null,
        subjectId:  request.data?.subjectId ?? null,
        topicId:    request.data?.topicId ?? null,
        prevSubjectId: request.data?.prevSubjectId ?? null,
        prevTopicId:   request.data?.prevTopicId ?? null,
      }),
      createdAt: nowIso,
      updatedAt: nowIso,
    }));
    return { ok: true, id };
  },
);

/**
 * Institute admin approves or rejects a pending request. On APPROVE, executes
 * the action server-side via the exec* functions with the ORIGINAL faculty
 * requester as owner (so ownership checks pass and the question stays theirs).
 * On REJECT, just marks it. Idempotent-ish: a non-pending request is refused.
 */
export const resolveQuestionRequest = onCall<{ requestId?: string; decision?: 'approve' | 'reject'; reviewNote?: string }>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const callerInst  = request.auth.token.instituteId as string | undefined;

    if (role !== 'institute') {
      throw new HttpsError('permission-denied', 'Only the institute admin can resolve requests.');
    }
    const requestId = request.data?.requestId;
    const decision  = request.data?.decision;
    if (!requestId) throw new HttpsError('invalid-argument', 'Missing request id.');
    if (decision !== 'approve' && decision !== 'reject') {
      throw new HttpsError('invalid-argument', 'Decision must be approve or reject.');
    }

    const reqRef = db.collection('questionRequests').doc(requestId);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) throw new HttpsError('not-found', 'Request not found.');
    const req = reqSnap.data() as {
      type: 'create' | 'edit' | 'delete' | 'share';
      status: string;
      facultyId: string;
      instituteId: string;
      questionId?: string | null;
      payload?: {
        question?: Record<string, unknown> | null;
        recipients?: Array<{ id: string; type: 'faculty' | 'institute' }> | null;
        note?: string | null;
        subjectId?: string | null; topicId?: string | null;
        prevSubjectId?: string | null; prevTopicId?: string | null;
      };
    };

    // Authorization: the caller must be the admin of this request's institute.
    if (req.instituteId !== callerInst) {
      throw new HttpsError('permission-denied', 'This request belongs to another institute.');
    }
    if (req.status !== 'pending') {
      throw new HttpsError('failed-precondition', 'This request has already been resolved.');
    }

    const nowIso = new Date().toISOString();
    const reviewNote = typeof request.data?.reviewNote === 'string' ? request.data.reviewNote.slice(0, 500) : '';

    if (decision === 'reject') {
      await reqRef.update({ status: 'rejected', reviewedBy: callerInst, reviewNote, updatedAt: nowIso });
      return { ok: true, status: 'rejected' };
    }

    // APPROVE — execute the action as the ORIGINAL faculty requester so
    // ownership checks pass and authored content stays theirs. The faculty's
    // request-mode grant was verified at submission; we re-confirm the right
    // still exists at all (ceiling may have changed) but not the mode.
    const owner: QOwner = { ownerType: 'faculty', ownerId: req.facultyId, instituteId: req.instituteId };
    // Re-check the institute still has this right (ceiling could have been
    // revoked between submission and approval).
    const instSnap = await db.collection('institutes').doc(req.instituteId).get();
    const ceiling = instSnap.get('questionRightsCeiling') as QuestionRightsCeilingS | undefined;
    if (!ceiling?.[req.type]?.allowed) {
      throw new HttpsError('failed-precondition', `The institute no longer has the "${req.type}" right — cannot approve.`);
    }

    const p = req.payload ?? {};
    try {
      if (req.type === 'create') {
        if (!p.question) throw new HttpsError('failed-precondition', 'Request has no question payload.');
        await execCreateQuestion(db, owner, p.question, { subjectId: p.subjectId ?? null, topicId: p.topicId ?? null });
      } else if (req.type === 'edit') {
        if (!req.questionId || !p.question) throw new HttpsError('failed-precondition', 'Request has no edit payload.');
        await execEditQuestion(db, owner, req.questionId, p.question, {
          subjectId: p.subjectId ?? null, topicId: p.topicId ?? null,
          prevSubjectId: p.prevSubjectId ?? null, prevTopicId: p.prevTopicId ?? null,
        });
      } else if (req.type === 'delete') {
        if (!req.questionId) throw new HttpsError('failed-precondition', 'Request has no question id.');
        await execDeleteQuestion(db, owner, req.questionId, { subjectId: p.subjectId ?? null, topicId: p.topicId ?? null });
      } else if (req.type === 'share') {
        if (!Array.isArray(p.recipients) || p.recipients.length === 0) {
          throw new HttpsError('failed-precondition', 'Request has no recipients.');
        }
        const qids = req.questionId ? [req.questionId] : [];
        if (qids.length === 0) throw new HttpsError('failed-precondition', 'Request has no question to share.');
        await execShareQuestions(db, owner, qids, p.recipients, p.note ?? '');
      }
    } catch (e) {
      // Execution failed (e.g. ownership changed, question deleted). Leave the
      // request pending so the admin can retry or reject, and surface why.
      if (e instanceof HttpsError) throw e;
      throw new HttpsError('internal', 'Failed to execute the approved action.');
    }

    await reqRef.update({ status: 'approved', reviewedBy: callerInst, reviewNote, updatedAt: nowIso });
    return { ok: true, status: 'approved' };
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

      // Stamp the mode AND denormalize the resolved head-count onto the
      // assessment doc. The count matters because every STAFF surface (list
      // rows, roster, export) reads the assessment doc and nothing else:
      // `allocations` and `assessmentMembers` are webOwner-only in the rules,
      // so an institute admin or faculty member physically cannot read them.
      // Without this field they fall back to `assignedTo`, which is empty for
      // a rule-allocated exam — that is the "0 Students" bug.
      //
      // This is a display counter, never an authorization input. The exam gate
      // remains the materialized assessmentMembers list (invariant 6); nothing
      // reads allocatedCount to decide who may sit the exam.
      txn.set(assessmentRef, {
        allocationMode: 'rules',
        allocatedCount: result.members.length,
      }, { merge: true });

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
    // Keep the denormalized staff-facing head-count in step with the member
    // list. resolveAllocation writes it absolutely (it knows the whole set);
    // here we only know we added exactly one, so increment. Guarded by the
    // `existing.exists` early-return above, so this can't double-count.
    batch.set(db.collection('assessments').doc(assessmentId), {
      allocatedCount: FieldValue.increment(1),
    }, { merge: true });
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