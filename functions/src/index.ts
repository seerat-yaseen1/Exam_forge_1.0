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

// ── Timing core (master plan Phase 3a/3b) ─────────────────────────
// The single implementation of every deadline in this module. Phase 3b points
// computeAttemptLocks at it so the number the write gate enforces and the
// number the resolver reasons about cannot drift — every timing defect in this
// module has been two expressions of the same rule disagreeing.
import {
  sectionDeadlineMs,
  overallDeadlineMs,
  creditForAnchor,
  penaltyForClock,
  computeFreezeCredits,
  computeDeadlines,
  // D-14's "one number, consumed by BOTH sides". index.ts previously declared
  // its own section/overall defaults and hardcoded the question one as a bare
  // `5` in two places (F13) — so a per-assessment questionGraceSeconds was
  // honoured by the resolver and ignored by the two functions that flag a late
  // answer. Imported, not redeclared.
  DEFAULT_QUESTION_GRACE_SECONDS,
  effectiveNowMs,
  openFreezeStartedMs,
  openSectionId,
  type CorePenalty,
  resolve as resolveTiming,
  checkInvariants as checkTimingInvariants,
  type CoreAssessment,
  type CoreAttempt,
} from './examTimingCore';

// Phase 3 — shared with Vercel's /api/seb-verify. Declared at module top so
// every callable that lists it in `secrets` can reference it (const, not hoisted).
const SEB_SIGNING_SECRET = defineSecret('SEB_SIGNING_SECRET');

/**
 * Capacity settings for the SIX functions a whole cohort hits at once
 * (audit P-01 / 10k scale target).
 *
 * Nothing in this file previously set maxInstances, minInstances or
 * concurrency, so every function ran on pure Gen2 defaults: 100 instances x 80
 * concurrent requests. Capacity is measured in requests IN FLIGHT, not
 * requests served — in-flight is arrival rate x handler duration — so the
 * default 8,000 is ample for a 10,000-student opening spread over a minute,
 * and still fine for one compressed into a second at normal ~300ms handlers.
 *
 * The failure mode is not steady-state throughput, it's the cold-start
 * thundering herd: minInstances defaults to 0, so the first burst of an exam
 * window meets zero warm instances, every request pays a multi-second cold
 * start, slow handlers inflate the in-flight count, and THAT is what walks
 * into the ceiling. It is self-reinforcing — the burst causes cold starts,
 * cold starts slow handlers, slow handlers trigger more instances.
 *
 * maxInstances 200 is the CEILING THIS PROJECT ALLOWS, not a free choice.
 * Cloud Run validates maxScale x CPU against the CpuAllocPerProjectRegion
 * quota, which is 200 CPU in us-central1 here; at 1 CPU per instance that caps
 * maxScale at 200. A first attempt at 400 was rejected outright with
 * "Max instances must be set to 200 or fewer to set the requested total CPU"
 * — the deploy fails, it does not silently clamp. Raising this requires a
 * quota increase request in the Cloud Console first.
 *
 * 200 is still double the Gen2 default and gives 16,000 in-flight capacity,
 * comfortably past the 10,000-student target — remember in-flight is arrival
 * rate x handler duration, so 10,000 starts over even ten seconds at ~300ms
 * handlers is only ~300 in flight. The headroom is for the cold-start
 * pathological case, not the steady state. It costs nothing when unused: this
 * is a ceiling, not a reservation.
 *
 * minInstances is deliberately left at the default 0 here, because warm
 * instances bill continuously whether or not an exam is running. Set it to 2-3
 * on startExam and getExamQuestions before a large scheduled sitting to remove
 * the cold-start cliff, and back to 0 afterwards. Applied ONLY to these six —
 * the other 34 are staff-driven and will never see a cohort-sized burst.
 */
const EXAM_HOT_PATH = {
  region: 'us-central1',
  secrets: [SEB_SIGNING_SECRET],
  maxInstances: 200,
  concurrency: 80,
};
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
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

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

/**
 * Close attempts whose writable window has expired (audit 2026-07-28).
 *
 * The rule change stops a late student WRITING, but on its own it leaves the
 * attempt sitting in_progress forever. That matters for three reasons: the
 * attempt is never graded, so the student has no result; it occupies one of
 * their attempt slots indefinitely, since evaluateStudentAttempts counts
 * in_progress as live and returns it instead of allowing a fresh start; and
 * abandoned attempts accumulate without bound, which at a 10,000-student scale
 * is a real pile.
 *
 * It is also the only thing that covers attempts created BEFORE
 * answersLockedAfter existed. Those have no lock field, the rule deliberately
 * lets them through rather than freezing every exam in flight at deploy, and
 * this sweep is what actually closes them.
 *
 * Marks them auto_submitted rather than deleting anything — the answers the
 * student did record stand, exactly as they would if the client had hit its
 * own timer. Grading is left to the existing gradeAttempt path rather than
 * duplicated here, so there is one scoring implementation, not two that can
 * drift.
 *
 * Hourly, not by-the-minute: this is a backstop for abandonment, and the rule
 * above is what enforces the deadline precisely. A student who walks away is
 * closed out within the hour; a student still at the keyboard is stopped at
 * the exact second by the rule.
 */
/**
 * How long a frozen attempt may sit unresolved before the sweep closes it.
 *
 * Doctrine D8: an automatic freeze (extension check) is entered without a
 * human, so it must be exitable without one. An invigilator queue nobody is
 * watching must never become an indefinite hold on a student's exam.
 *
 * Six hours is deliberately generous — long enough that it never fires during
 * a supervised sitting, short enough that a forgotten freeze resolves the same
 * day. Closing GRANTS the full frozen interval, so a student is never punished
 * for an unattended queue.
 */
// Retired in Phase 4.4 (D-30). A freeze no longer expires on a timer: it ends
// when a human ends it, or when the availability window closes. Left as a
// named tombstone rather than deleted silently, so anyone looking for the
// six-hour behaviour finds out where it went.
// const STALE_FREEZE_HOURS = 6;

/**
 * How long an attempt may sit untouched before the sweep closes it even
 * though the resolver says the student still has somewhere to go.
 *
 * Needed because of D-24 below: once the sweep stops closing everything past
 * `answersLockedAfter`, an abandoned attempt on an exam with no overall limit
 * and no window would otherwise stay open forever. Six hours is long enough
 * that it can never fire on a supervised sitting or a break, short enough that
 * an abandoned attempt resolves the same day.
 */
const STALE_ATTEMPT_HOURS = 6;

export const scheduledCloseExpiredAttempts = onSchedule(
  {
    schedule: 'every 60 minutes',
    timeZone: 'Etc/UTC',
    region: 'us-central1',
    // Grading is real work now (see below), so the 60s Gen2 default is no
    // longer enough headroom for a large batch. Memory is raised for the same
    // reason: gradedAnswers for a few hundred long papers is not small.
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    const db = getFirestore();
    const now = Timestamp.now();
    const nowMs = now.toMillis();
    const nowIso = new Date(nowMs).toISOString();

    // ── (A) in_progress attempts past their lock ──────────────────
    // Firestore range queries skip documents missing the field entirely, which
    // is exactly right — a legacy or genuinely untimed attempt has no deadline
    // to be past. Uses the existing (status, answersLockedAfter) index.
    const expiredSnap = await db.collection('attempts')
      .where('status', '==', 'in_progress')
      .where('answersLockedAfter', '<', now)
      .limit(500)
      .get();

    // ── (B) frozen attempts (D-02, master plan Phase 1) ───────────
    // A frozen attempt was invisible to this sweep, because the query above
    // filters on in_progress. Combined with firestore.rules (which require
    // in_progress on both sides of a student write) and gradeAttempt's
    // finalised guard, status:'frozen' was a state with an entrance and no
    // exit: blocked from answering, clock draining, unable to submit, unable
    // to be closed.
    //
    // A SEPARATE equality-only query rather than `status in [...]` on the
    // query above: a single-field filter needs no composite index, so this
    // ships with the functions deploy and cannot fail on a missing index in
    // production. Frozen attempts are a small set by nature.
    //
    // Two reasons to close a frozen attempt, both evaluated in memory:
    //   1. its answer window has already passed — the trap case;
    //   2. (retired, D-30) it had been frozen longer than six hours. A freeze
    //      is owned by a human and does not time out — see the note below.
    const frozenSnap = await db.collection('attempts')
      .where('status', '==', 'frozen')
      .limit(300)
      .get();

    type Closing = {
      doc: FirebaseFirestore.QueryDocumentSnapshot;
      // 'stale_freeze_sweep' retired with D-30 — nothing produces it now.
      reason: string;
      /** Frozen seconds to credit on close (stale freezes are granted in full). */
      grantFrozenSeconds: number;
      wasFrozen: boolean;
    };

    const candidates: Closing[] = expiredSnap.docs.map((doc) => ({
      doc,
      reason: 'deadline_expired_sweep',
      grantFrozenSeconds: 0,
      wasFrozen: false,
    }));

    // ── D-30: the stale-freeze auto-close is GONE; the window close stays ──
    //
    // Half of this branch was removed and half deliberately kept, and the
    // distinction matters.
    //
    // REMOVED — frozenTooLong. A freeze older than STALE_FREEZE_HOURS used to
    // close itself and grant the whole pause. That was doctrine D8: an
    // automatic state needs an automatic exit. But A2 settles that a freeze is
    // NOT an ownerless automatic state — a named human paused this sitting and
    // owes a decision on the paused time. Closing it on a timer, six hours
    // later, with a grant nobody chose, is the system inventing an
    // authority's decision for them. "Never unfrozen" is a legitimate ending
    // (A10), not a failure to be swept up.
    //
    // KEPT — windowGone. A10 row 1 is closed: the availability window closing
    // while a student is frozen DOES finalise the attempt, and it is "the only
    // automatic ending, and what stops provisional running forever". Deleting
    // this branch wholesale — which is what "remove the sweep's frozen-attempt
    // handling" says if read literally — would remove the sole enforcement of
    // a decision already made.
    //
    // The window is the institution's outer wall, not one of the student's
    // clocks. Same reason resolve() evaluates it against real time while every
    // other deadline pauses (4.3).
    if (candidates.length === 0 && frozenSnap.empty) {
      console.log('[closeExpiredAttempts] nothing to consider');
      return;
    }

    // ── Per-assessment cache ──────────────────────────────────────
    // Expired attempts cluster hard by assessment — a whole cohort abandoning
    // one exam is the common case — so the paper is loaded once, not once per
    // student. Without this a 500-attempt sweep would re-read every question
    // and answer document 500 times.
    type Paper = {
      /** The LIVE document. Per-attempt contracts are merged onto it below. */
      assessment: GradingAssessmentDoc;
      questionMap: Awaited<ReturnType<typeof loadQuestionAndAnswerMaps>>['questionMap'];
      answerMap: Awaited<ReturnType<typeof loadQuestionAndAnswerMaps>>['answerMap'];
      exposeKeysToStudent: boolean;
    };
    const papers = new Map<string, Paper | null>();

    async function loadPaper(assessmentId: string): Promise<Paper | null> {
      if (papers.has(assessmentId)) return papers.get(assessmentId) ?? null;
      try {
        const aSnap = await db.collection('assessments').doc(assessmentId).get();
        if (!aSnap.exists) { papers.set(assessmentId, null); return null; }
        const assessment = aSnap.data() as GradingAssessmentDoc;
        const sections = normalizeSections(assessment);
        const qIds = Array.from(new Set(
          sections.flatMap((s) => s.questions.map((q) => q.questionId)),
        ));
        const { questionMap, answerMap } = await loadQuestionAndAnswerMaps(db, qIds);
        const paper: Paper = {
          assessment,
          questionMap,
          answerMap,
          exposeKeysToStudent: reviewAudienceAllows(assessment, 'students'),
        };
        papers.set(assessmentId, paper);
        return paper;
      } catch (e) {
        console.error('[closeExpiredAttempts] paper load failed', assessmentId, e);
        papers.set(assessmentId, null);
        return null;
      }
    }

    // ── Per-attempt contract (A-05 / A-06) ────────────────────────
    //
    // `sections` and the resolver's view were cached PER ASSESSMENT, which was
    // right while every attempt of an exam was marked against one live paper.
    // They are per attempt now: each carries the paper and the clocks it was
    // actually given, so two students of the same exam can legitimately differ
    // (a shuffle, or a staff edit between their start times).
    //
    // The question/answer MAPS stay cached per assessment — they are keyed by
    // question id, and re-reading them 500 times is the cost this cache exists
    // to avoid. A frozen paper can name an id the live document no longer
    // lists, so anything missing is topped up once and folded into the same
    // cache. On the common path (no edit since publish) nothing is missing and
    // this reads nothing.
    async function contractFor(paper: Paper, attemptRaw: Record<string, unknown>) {
      const live = paper.assessment as unknown as Record<string, unknown>;
      const contract = examContractFor(attemptRaw, live) ?? live;
      const sections = normalizeSections(contract as GradingAssessmentDoc);
      const missing = Array.from(new Set(
        sections.flatMap((s) => s.questions.map((q) => q.questionId)),
      )).filter((qid) => !paper.questionMap.has(qid));
      if (missing.length > 0) {
        const extra = await loadQuestionAndAnswerMaps(db, missing);
        for (const [k, v] of extra.questionMap) paper.questionMap.set(k, v);
        for (const [k, v] of extra.answerMap) paper.answerMap.set(k, v);
      }
      return { sections, coreAssessment: toCoreAssessment(contract) };
    }

    // ── The frozen branch, asking the RESOLVER (F9) ───────────────
    //
    // This used to gate on attemptWindowClosed(), which despite its name reads
    // `answersLockedAfter` — the SECTION/OVERALL lock, not the availability
    // window. Those are the clocks a freeze is supposed to hold, and a paused
    // attempt necessarily carries a stale one, so the branch fired on exactly
    // the state it was meant to protect: a seven-hour pause was auto-submitted
    // and graded because its pre-freeze section lock had passed.
    //
    // A10 row 1 says the AVAILABILITY WINDOW closing during a freeze finalises
    // the attempt, and nothing else does. resolve() is the one place that
    // knows the difference — it evaluates the window against real time while
    // every other deadline pauses (4.3) — so the sweep asks it rather than
    // approximating it. Placed here, after loadPaper exists, because it needs
    // the paper to answer at all.
    for (const doc of frozenSnap.docs) {
      const d = doc.data() as { assessmentId?: string };
      const paper = d.assessmentId ? await loadPaper(d.assessmentId) : null;
      if (!paper) continue;          // cannot prove the sitting over; leave it
      let endedReason: string | null = null;
      try {
        const verdict = resolveTiming(
          toCoreAttempt(doc.data() as Record<string, unknown>),
          (await contractFor(paper, doc.data() as Record<string, unknown>)).coreAssessment,
          nowMs,
        );
        // ANY 'ended', not only window_closed (widened 2026-08-03). While a
        // freeze is open the resolver pins every student clock at the freeze
        // instant, so 'ended' here means one of exactly two things: the
        // availability window shut in real time (A10 row 1), or the sitting
        // was ALREADY over before the pause began — someone froze an attempt
        // whose overall clock had run out. The second kind was invisible to
        // both sweep queries: status 'frozen' excluded it from query (A), and
        // the window test here excluded it too, so with no endDate it would
        // simply never close. An attempt the resolver calls over is over;
        // which wall ended it does not change that.
        endedReason = verdict.kind === 'ended' ? verdict.reason : null;
      } catch (e) {
        console.warn('[closeExpiredAttempts] frozen verdict failed; leaving open', doc.id, e);
        continue;
      }
      if (endedReason === null || endedReason === 'not_open_yet') continue;

      candidates.push({
        doc,
        reason: `sweep_${endedReason}`,
        // No grant on this path. FREEZE_CREDIT_EXTENDS_WINDOW is false, so
        // credit cannot move the wall that is ending this attempt — handing
        // out time here would be arithmetic that changes nothing, recorded as
        // though it were a decision. The paused time stays unadjudicated,
        // which is the truth: nobody adjudicated it.
        grantFrozenSeconds: 0,
        wasFrozen: true,
      });
    }

    let closed = 0;
    let graded = 0;
    let ungraded = 0;

    // ── Close, GRADING each one (D-04, master plan Phase 1) ───────
    // The sweep used to set status:'auto_submitted' and stop — no scores, no
    // gradedAnswers. The roster then rendered the attempt as complete with no
    // mark, and it stayed that way until somebody noticed and ran a manual
    // regrade. A student whose laptop died was left with a finished, unscored
    // exam. Invariant INV-10: a terminal attempt has both scores and
    // gradedAnswers.
    //
    // Grading uses the SAME primitives as gradeAttempt — normalizeSections,
    // loadQuestionAndAnswerMaps, scoreAttemptAnswers — rather than a private
    // reimplementation, so the sweep and the live path cannot reach different
    // marks for the same answers.
    //
    // A grading failure never blocks the close. An attempt stuck in_progress
    // forever is strictly worse than one closed without a score, and the
    // latter is repairable with regradeAttempts.
    const writes: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];

    let skipped = 0;

    for (const item of candidates) {
      const att = item.doc.data() as {
        assessmentId?: string;
        answers?: Record<string, AttemptAnswerDoc & { answeredAt?: string }>;
        gradingConfig?: AssessmentGradingConfigS;
        updatedAt?: string;
        freezes?: FreezeLedgerEntry[];
      };

      const paperEarly = att.assessmentId ? await loadPaper(att.assessmentId) : null;

      // ── D-24: the sweep must not END what should merely ADVANCE ────
      //
      // This closed anything whose `answersLockedAfter` had passed. That field
      // is min(section, overall), so it fired for a student who had simply run
      // out of SECTION time and should have moved to the next section — which
      // is exactly the bug Phase 0 fixed on the client ("section expiry ends
      // the whole sitting"), still alive here on the server.
      //
      // The sharpest case is a BREAK. The break path never recomputes the
      // lock, so a student waiting out a twenty-minute break still carries the
      // previous section's deadline, already passed. An hourly sweep landing
      // in that window auto-submitted their exam while they sat waiting to
      // continue.
      //
      // The resolver decides now, so the swept path and the live path reach
      // the same conclusion from the same function — which is the whole point
      // of the resolver existing. A verdict of anything other than 'ended'
      // means the student still has somewhere to go, and the sweep leaves them
      // alone.
      //
      // The staleness fallback below is what stops that leaking: an attempt
      // nobody has touched for STALE_ATTEMPT_HOURS is closed regardless,
      // because an exam with no overall limit and no window would otherwise
      // never resolve.
      let closeReason: string = item.reason;
      if (paperEarly && !item.wasFrozen) {
        try {
          const core = toCoreAttempt(att as unknown as Record<string, unknown>);
          const verdict = resolveTiming(
            core,
            (await contractFor(paperEarly, att as unknown as Record<string, unknown>)).coreAssessment,
            nowMs,
          );
          if (verdict.kind !== 'ended') {
            // ── D-30, restored (F8) ─────────────────────────────────
            //
            // STALE_FREEZE_HOURS was commented out for D-30 — "a freeze is
            // owned by a human and does not time out" — and the generic
            // staleness fallback below re-implemented it at the same six
            // hours, from the other side. A paused attempt keeps its stale
            // pre-freeze answersLockedAfter, so query (A) picks it up; the
            // resolver correctly answers "not ended" because the clocks are
            // held; and this branch then closed it anyway as
            // 'abandoned_sweep', grading it with no credit and without even
            // the finalizedWhileFrozen flag.
            //
            // An open pause is the one state where "nobody has touched this"
            // is expected rather than evidence of abandonment. The student
            // cannot touch it — that is what the pause means. The window
            // branch above is still the automatic ending (A10); this one is
            // for attempts nobody is holding.
            const paused = openFreezeStartedMs(core) !== null;
            const touched = att.updatedAt ? Date.parse(att.updatedAt) : NaN;
            const stale = !paused
              && (!Number.isFinite(touched)
                || touched <= nowMs - STALE_ATTEMPT_HOURS * 3_600_000);
            if (!stale) {
              skipped++;
              console.log(`[closeExpiredAttempts] leaving ${item.doc.id} open — ` +
                `verdict=${verdict.kind} (student still has somewhere to go)`);
              continue;
            }
            closeReason = 'abandoned_sweep';
          } else {
            // Carry the resolver's reason so the record says WHY, not just
            // that a deadline somewhere had passed.
            closeReason = `sweep_${verdict.reason}`;
          }
        } catch (e) {
          // A resolver fault must never leave an attempt stuck open. Fall back
          // to the previous behaviour, which errs toward closing.
          console.warn('[closeExpiredAttempts] verdict failed; closing anyway', item.doc.id, e);
        }
      }

      const data: Record<string, unknown> = {
        status: 'auto_submitted',
        submittedAt: nowIso,
        autoSubmitReason: closeReason,
        updatedAt: nowIso,
      };

      if (item.wasFrozen) {
        // Detective flag, matching gradeAttempt's behaviour for the same case.
        data['integrityLog.finalizedWhileFrozen'] = true;
        data.freezeState = { frozen: false, clearedBy: 'sweep', since: nowIso };
        data.resumeRequiresVerification = false;
        if (item.grantFrozenSeconds > 0) {
          data.totalFrozenSeconds = FieldValue.increment(item.grantFrozenSeconds);
        }
        // ── A terminal attempt carries no live freeze state (2026-08-03) ─
        //
        // Same cleanup gradeAttempt does at finalisation, for the same
        // reason: deriveRosterStatus reads frozenAt BEFORE the terminal
        // status, so leaving it behind showed a closed sitting as "frozen"
        // in the roster forever. The ledger entry is CLOSED with a zero
        // grant, not deleted — the pause happened, and the record says so.
        data.frozenAt = FieldValue.delete();
        data.frozenBy = FieldValue.delete();
        data.frozenReason = FieldValue.delete();
        if (Array.isArray(att.freezes) && att.freezes.some((f) => !f.endedAt)) {
          data.freezes = att.freezes.map((f) => {
            if (f.endedAt) return f;
            const startMsF = Date.parse(f.startedAt);
            return {
              ...f,
              endedAt: nowIso,
              elapsedMs: Number.isFinite(startMsF)
                ? Math.max(0, nowMs - startMsF) : 0,
              grantedMs: 0,
              decidedBy: null,
              decidedAt: nowIso,
              note: `closed by sweep (${closeReason})`,
            };
          });
        }
      }

      const paper = paperEarly;
      if (paper) {
        try {
          // A-05: mark against the paper THIS attempt sat.
          const { sections: attemptSections } =
            await contractFor(paper, att as unknown as Record<string, unknown>);
          const { scores, gradedAnswers } = scoreAttemptAnswers({
            sections: attemptSections,
            questionMap: paper.questionMap,
            answerMap: paper.answerMap,
            answers: att.answers,
            passingScore: paper.assessment.passingScore,
            exposeKeysToStudent: paper.exposeKeysToStudent,
            // Frozen policy first, live assessment as the legacy fallback —
            // identical precedence to gradeAttempt.
            gradingConfig: att.gradingConfig ?? paper.assessment.gradingConfig,
          });
          data.scores = scores;
          data.gradedAnswers = gradedAnswers;
          graded++;
        } catch (e) {
          console.error('[closeExpiredAttempts] grading failed', item.doc.id, e);
          data.gradeError = 'sweep_grading_failed';
          ungraded++;
        }
      } else {
        data.gradeError = 'assessment_unavailable';
        ungraded++;
      }

      writes.push({ ref: item.doc.ref, data });
    }

    // Chunked to stay under the 500-write batch ceiling.
    for (let i = 0; i < writes.length; i += 400) {
      const batch = db.batch();
      for (const w of writes.slice(i, i + 400)) {
        batch.update(w.ref, w.data);
        closed++;
      }
      await batch.commit();
    }

    console.log(
      `[closeExpiredAttempts] closed ${closed} (graded ${graded}, ungraded ${ungraded}),`
      + ` left open ${skipped}; expired=${expiredSnap.size} frozenScanned=${frozenSnap.size}`,
    );
  },
);

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

    // NOTE (found by enabling noUnusedLocals, 2026-08-03): the payload also
    // carries `deleteAttemptsOnWebOwnerAssessments`, and purgeStudentData
    // accepts an option of that name — but this callable destructured it and
    // never forwarded it, so the option has never had any effect. Left
    // unforwarded here deliberately: wiring it up CHANGES WHAT GETS DELETED,
    // which is not a decision a timer audit should make on the way past. It
    // needs its own change, with its own review.
    const { role, uid, successorId, confirmLiveOwnership } =
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
  | 'erasure'
  // Phase 4: a freeze takes time away from a student and a grant gives it
  // back. Both are authority decisions about someone's exam, so both leave a
  // record — the same standard already applied to deletion.
  | 'attemptFrozen'
  | 'attemptUnfrozen'
  // Phase 4.4: a provisional grade is a staff action on a live sitting, and
  // it is visible to staff before the student's exam is over. Same standard.
  | 'attemptGradedProvisional'
  | 'attemptRewritten';

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
  // `order` is present on stored AssessmentQuestion entries and is what
  // startExam sorts by when building questionOrder. Grading ignores it, which
  // is why it was previously undeclared — the data always carried it.
  questions: Array<{ questionId: string; marks: number; order?: number }>;
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
      freezes?: FreezeLedgerEntry[];
      securityConfig?: { tier?: string; requireSEB?: boolean } | null;
      gradingConfig?: AssessmentGradingConfigS;   // frozen at startExam
      // Read for the trapped-frozen escape hatch below. Loose shape: a
      // Firestore Timestamp over the wire, an ISO string on legacy attempts,
      // absent on attempts that predate the field.
      answersLockedAfter?: unknown;
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
    // ── Escape hatch for a trapped frozen attempt (D-02, Phase 1) ──
    //
    // status:'frozen' had an entrance and no exit. firestore.rules require
    // status=='in_progress' on both sides of a student update, so a frozen
    // student cannot save an answer; the hourly sweep queried in_progress
    // only, so it never saw them; and this guard refused their finalise. A
    // student whose antivirus tripped the extension check was blocked from
    // answering, watched their clock drain, and could neither submit nor be
    // closed — stuck until a human noticed.
    //
    // Gated on the deadline having ALREADY passed, which is what keeps this
    // from becoming an escape from invigilation: while there is still time on
    // the clock a frozen student must wait for the freeze to be cleared, and
    // only once their window is provably over may they close their own
    // sitting. Whatever they answered before the freeze stands.
    //
    // Doctrine D8: every automatic state a student can be put into must have
    // an automatic exit, on a bounded timer, in the student's favour.
    //
    // Loaded BEFORE the freeze/idempotency guards (moved 2026-08-03): the
    // trapped-frozen decision below is now the RESOLVER's, and the resolver
    // needs the assessment. One extra read on the idempotent no-op path is
    // the cost; a guard that reasons from the same clock the rest of the
    // system runs on is what it buys.
    const assessmentSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    if (!assessmentSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    // A-05 / A-06: the paper and clocks THIS attempt was given, not whatever
    // the assessment says now. Legacy attempts carry no snapshot and fall
    // through to the live document, exactly as before.
    const assessment = examContractFor(
      attempt as unknown as Record<string, unknown>,
      assessmentSnap.data() as Record<string, unknown>,
    ) as GradingAssessmentDoc;

    // ── Is this sitting actually OVER? Ask the resolver ────────────
    //
    // The old test was attemptWindowClosed(), which reads answersLockedAfter —
    // the section/overall lock, NOT the availability window. Those are
    // precisely the clocks an open freeze HOLDS (4.3), so "lock instant has
    // passed while frozen" no longer means the sitting is over; it means the
    // pause is old. Deciding the escape hatch on it would reopen the hole F5
    // closed, through the guard built to be its one exception.
    //
    // resolve() knows the difference: while a freeze is open it pins every
    // student clock at the freeze instant and races only the availability
    // window against real time (A10). 'ended' therefore means one of exactly
    // two things — the window shut, or the sitting was already over before
    // the pause began — and both are states where finalising is right.
    //
    // Fails soft to the previous lock-based reading: a resolver fault must
    // never leave a genuinely trapped student with no exit (D8).
    let sittingOver: boolean;
    try {
      const v = resolveTiming(
        toCoreAttempt(attempt as unknown as Record<string, unknown>),
        toCoreAssessment(assessment as unknown as Record<string, unknown>),
        Date.now(),
      );
      sittingOver = v.kind === 'ended';
    } catch {
      sittingOver = attemptWindowClosed(attempt);
    }
    const isTrappedFrozen = attempt.status === 'frozen' && sittingOver;

    // ── A paused student may not end their own sitting (F5) ────────
    //
    // The guard below tests `status !== 'in_progress'`, and a freeze now puts
    // the attempt in 'frozen', so this is mostly closed by construction. It is
    // stated explicitly anyway because the ONE exception — a sitting the
    // resolver says is OVER — must stay scoped to the case that justifies it.
    // While there is still held time on the clock, a paused student waits for
    // the human who paused them; once the sitting is provably over, refusing
    // their finalise would strand them (D8). A grader is unaffected either
    // way; ending a paused sitting is a legitimate staff action.
    const openFreeze = (attempt.freezes ?? []).find((f) => !f.endedAt);
    if (openFreeze && !isGrader && !sittingOver) {
      throw new HttpsError('failed-precondition',
        'ATTEMPT_PAUSED: this sitting has been paused by an invigilator and ' +
        'cannot be submitted until it is resumed.');
    }

    if (attempt.status !== 'in_progress' && !isGrader && !isTrappedFrozen) {
      if (reason === 'terminated') {
        return { ok: true, alreadyFinalized: true, status: attempt.status };
      }
      throw new HttpsError('failed-precondition', 'Attempt already finalised.');
    }

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
    // Record if this attempt was finalized while still paused. Detective flag
    // for the reviewer — not blocking.
    //
    // The ledger is checked as well as freezeState (F5). freezeState is only
    // written by the extension path, so an attempt finalised during an
    // INVIGILATOR pause — the case a reviewer most needs to see — carried no
    // flag at all and closed looking like an ordinary manual submit.
    if (attempt.freezeState?.frozen === true || openFreeze) {
      updates['integrityLog.finalizedWhileFrozen'] = true;
    }

    // ── A terminal attempt carries no live freeze state (2026-08-03) ─
    //
    // Nothing that finalised an attempt ever cleared these, and the roster's
    // deriveRosterStatus checks `frozenAt` BEFORE the terminal status — so a
    // sitting finalised while paused (grader action, trapped-frozen escape,
    // or the sweep) showed as "frozen" in the roster forever, over a status
    // of submitted. The pause is over by definition: the sitting it paused no
    // longer exists.
    //
    // The ledger entry is CLOSED, not deleted — it is the record that the
    // pause happened. grantedMs 0: finalisation grants nothing, because
    // there is no remaining sitting for credit to extend, and inventing a
    // grant here would be the sweep's retired stale-freeze mistake again.
    if (openFreeze || attempt.freezeState?.frozen === true) {
      updates.frozenAt = FieldValue.delete();
      updates.frozenBy = FieldValue.delete();
      updates.frozenReason = FieldValue.delete();
      updates.freezeState = { frozen: false, clearedBy: 'finalize', since: nowIso };
      updates.resumeRequiresVerification = false;
      if (openFreeze) {
        const startMsF = Date.parse(openFreeze.startedAt);
        updates.freezes = (attempt.freezes ?? []).map((f) => f.endedAt ? f : ({
          ...f,
          endedAt: nowIso,
          elapsedMs: Number.isFinite(startMsF)
            ? Math.max(0, Date.parse(nowIso) - startMsF) : 0,
          grantedMs: 0,
          decidedBy: isGrader ? request.auth!.uid : null,
          decidedAt: nowIso,
          note: `closed at finalisation (${reason ?? 'auto'})`,
        }));
      }
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
  EXAM_HOT_PATH,
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
// ATTEMPT SOFT DELETE  (audit 2026-07-26, S-03)
// ══════════════════════════════════════════════════════════════════
// Attempts were deletable by any institute or faculty in the owning tenant:
// firestore.rules listed 'isDeleted' in staffAttemptUpdateFieldsAllowed(), and
// the client did it with a bare updateDoc. That contradicted the deletion
// rights model outright — WEBOWNER_ONLY_S names 'attempt' precisely because
// "attempts are the audit trail; a tenant that can delete them can delete the
// evidence of what happened in an exam". Two defects, not one:
//
//   1. the wrong principals could do it at all, and
//   2. nothing was recorded when they did — a bare updateDoc writes no
//      deletionAudit row, so evidence could disappear without a trace of who
//      removed it. For an attempt that is the whole problem.
//
// This callable is now the only path. It is webOwner-only, and it writes the
// state change and the audit row in ONE transaction so an attempt can never be
// deleted without a corresponding record.
//
// Scope note: the bare-updateDoc pattern is shared by softDeleteQuestion,
// softDeleteQuestionBank and softDeleteAssessment, which are equally
// unaudited. Those are resources a tenant is legitimately allowed to delete,
// so the missing audit row there is a gap rather than a contradiction, and
// closing it is its own change. Only attempts are fixed here.

interface SoftDeleteAttemptData {
  attemptId: string;
  reason?: string;
}

export const softDeleteAttempt = onCall<SoftDeleteAttemptData>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

    // webOwner ONLY. Not "owner of the assessment" — the owning institute is
    // exactly the principal this finding is about, since an institute deleting
    // the attempts of an exam it ran is the evidence-destruction case.
    if ((request.auth.token.role as string | undefined) !== 'webOwner') {
      throw new HttpsError(
        'permission-denied',
        'Only the platform owner may delete exam attempts.',
      );
    }

    const attemptId = request.data?.attemptId;
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    const reason = typeof request.data?.reason === 'string'
      ? request.data.reason.slice(0, 500)
      : null;

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);

    await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');

      const a = snap.data() as {
        isDeleted?: boolean;
        studentId?: string;
        studentName?: string;
        instituteId?: string;
        assessmentTitle?: string;
        status?: string;
      };

      // Idempotent: deleting an already-deleted attempt is a no-op rather than
      // an error, so a double-click cannot produce two audit rows for one act.
      if (a.isDeleted === true) return;

      txn.update(ref, { isDeleted: true, updatedAt: new Date().toISOString() });

      // Bound to the same transaction, so there is no window in which the
      // attempt is gone but the record of its removal is not.
      await writeAuditRow(db, {
        action: 'softDelete',
        entityType: 'attempt',
        entityId: attemptId,
        entityLabel: a.studentName
          ? `${a.studentName} — ${a.assessmentTitle ?? 'attempt'}`
          : attemptId,
        fromState: 'active',
        toState: 'softDeleted',
        actorUid: request.auth!.uid,
        actorRole: 'webOwner',
        actorName: (request.auth!.token.name as string | undefined) ?? null,
        instituteId: a.instituteId ?? null,
        reason,
      }, txn);
    });

    return { ok: true };
  }
);


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
  EXAM_HOT_PATH,
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
    const callerUid = request.auth.uid;
    const callerStudentId = request.auth.token.studentId as string | undefined;
    const { attemptId, passed, found } = request.data || ({} as ReportExtensionCheckData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);

    // Transactional now, because a freeze is a ledger append and an append
    // read-modify-written outside a transaction can lose a concurrent entry.
    const shouldFreeze = await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');
      const a = snap.data() as {
        studentId: string;
        status: string;
        assessmentId: string;
        freezes?: FreezeLedgerEntry[];
        securityConfig?: { tier?: string; requireExtensionCheck?: boolean; requireSEB?: boolean } | null;
      };
      if (a.studentId !== callerStudentId) {
        throw new HttpsError('permission-denied', 'Not your attempt.');
      }
      assertSEB(request.data?.sebToken, callerUid, a.securityConfig?.requireSEB, a.assessmentId);

      const nowIso = new Date().toISOString();
      const tierRequiresCheck = a.securityConfig?.requireExtensionCheck === true;
      const alreadyOpen = (a.freezes ?? []).some((f) => !f.endedAt);
      const freezeNow = !passed && a.status === 'in_progress' && tierRequiresCheck && !alreadyOpen;

      // Read before write, and only when there is a freeze to snapshot.
      const aSnap = freezeNow && a.assessmentId
        ? await txn.get(db.collection('assessments').doc(a.assessmentId))
        : null;

      const updates: Record<string, unknown> = {
        lastExtensionCheck: { at: nowIso, passed: !!passed, found: found ?? [] },
        updatedAt: nowIso,
      };

      if (freezeNow) {
        // ── The same pause every other freeze opens (F6) ───────────
        //
        // This wrote freezeState + status and nothing else. No ledger entry
        // meant openFreezeStartedMs found nothing, so effectiveNowMs never
        // pinned and every SERVER clock kept running; no frozenAt meant
        // ExamShell's isFrozen stayed false, so every CLIENT clock kept
        // running too and all four auto-expiry paths stayed armed. A student
        // frozen out by an antivirus false positive was refused answer
        // writes by the rules while their section drained, and was resolved
        // into the next section without ever being released.
        //
        // reason:'extension_check' is what still distinguishes it, and
        // assertCanUnfreeze already reads that field: a system pause has no
        // human owner, so any invigilator may clear it.
        const opened = openFreezeUpdates(
          a as unknown as Record<string, unknown>,
          aSnap?.exists ? (aSnap.data() as Record<string, unknown>) : null,
          { reason: 'extension_check', frozenBy: 'system', frozenByRole: 'system', nowIso },
        );
        Object.assign(updates, opened.updates);
        updates.freezeState = { frozen: true, reason: 'extension_detected', since: nowIso };
        updates.resumeRequiresVerification = true;
        updates.frozenReason = 'Browser extension detected';
      }

      txn.update(ref, updates);
      return freezeNow;
    });

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
      // Phase 1: where this freeze started, so its duration can be measured.
      // Extension freezes stamp freezeState.since; invigilator freezes stamp
      // frozenAt. Both are read — see the accumulation note below.
      freezeState?: { frozen?: boolean; since?: string } | null;
      frozenAt?: string | null;
      freezes?: FreezeLedgerEntry[];
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

    // ── Release through the SAME function as unfreezeAttempt ──────
    //
    // This used to write status, freezeState and
    // `totalFrozenSeconds: FieldValue.increment(elapsed)` — and no lock, no
    // freezeCredits. Two separate defects came out of that:
    //
    //   F4  Two writers, two meanings, one field. unfreezeAttempt SETS
    //       totalFrozenSeconds from the ledger (GRANTED time); this
    //       INCREMENTED it with measured ELAPSED time. A later invigilator
    //       pause therefore overwrote the extension credit with its own much
    //       smaller ledger sum, and accumulated credit FELL — measured at ten
    //       minutes lost, with overallLockedAfter moving eight minutes
    //       earlier and no penalty row to justify it. INV-4a and INV-3a.
    //
    //   F7  Doctrine D5: the materialised lock is a CACHE and every event
    //       that changes an input must recompute it. Granting credit changes
    //       an input. A released student carried a pre-freeze
    //       answersLockedAfter and pre-freeze freezeCredits until some later
    //       section boundary happened to recompute them.
    //
    // GRANTED IN FULL, and that is a policy choice worth naming. A human
    // pauses a sitting and owes a decision on the paused time, which is why
    // unfreezeAttempt demands an explicit grantedMs. Nobody decided this one:
    // an automated check paused the student. Doctrine D8 says an automatic
    // state needs an automatic exit in the STUDENT'S FAVOUR, and the retired
    // stale-freeze branch in the sweep applied exactly this rule ("stale
    // freezes are granted in full"). An invigilator who judges the pause the
    // student's own fault can still deduct it with unfreezeAttempt's
    // penalties.
    const elapsedForGrant = (() => {
      const open = (a.freezes ?? []).find((f) => !f.endedAt);
      const since = open?.startedAt ?? a.freezeState?.since ?? a.frozenAt ?? null;
      if (!since) return 0;
      const ms = Date.parse(since);
      return Number.isFinite(ms) ? Math.max(0, Date.now() - ms) : 0;
    })();

    const aSnap = a.assessmentId
      ? await db.collection('assessments').doc(a.assessmentId).get()
      : null;

    const closed = closeFreezeUpdates(
      a as unknown as Record<string, unknown>,
      aSnap?.exists ? (aSnap.data() as Record<string, unknown>) : null,
      {
        grantedMs: elapsedForGrant,
        decidedBy: isInvigilator ? request.auth!.uid : null,
        note: 'extension check cleared',
        nowIso,
        clearedBy: isInvigilator ? 'invigilator' : 'auto',
      },
    );

    await ref.update(closed.updates);
    return {
      ok: true,
      resumed: true,
      frozenForSeconds: Math.round(closed.elapsedMs / 1000),
      grantedMs: closed.grantedMs,
    };
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
  /** Phase 2 — the browser session driving this sitting (INV-5a). */
  sessionId?: string;
  questionId: string;
  // null = no answer (e.g. per-question timer expired). We deliberately do NOT
  // write a blank answer: an unanswered served question already scores 0, and
  // writing a null value would pollute the timing analytics with a fake
  // answeredAt. Skipping the write keeps grading unambiguous.
  answer: { type: string; value: unknown } | null;
}

/**
 * Refuse an answer whose section or overall clock has already run out. (A-03.)
 *
 * WHY THIS EXISTS AT ALL — the asymmetry it closes.
 *
 * In STANDARD delivery answers are a direct client write and firestore.rules
 * refuse them past `answersLockedAfter` (answerWriteWindowOpen, :754). In
 * LINEAR/ADAPTIVE the rules refuse the direct write outright
 * (studentAnswerWriteAllowed, :629) — answers may travel ONLY through
 * submitAnswerAndAdvance and saveAnswerNoAdvance, which run under the Admin SDK
 * and therefore bypass rules entirely.
 *
 * Both callables checked auth, ownership, session, SEB, status, delivery mode
 * and the served-question pointer, then computed `lateAnswer` against the
 * QUESTION clock — and stored the answer regardless. Neither ever read the
 * section or overall bound. So sequential delivery, which is the MORE
 * controlled mode (one question at a time, no going back, the client never
 * holds the paper), was the WEAKER one on time: measured accepting an answer 25
 * minutes past the overall deadline while getExamVerdict already said 'ended'.
 *
 * The bound enforced here is deliberately min(section, overall) — byte-for-byte
 * what `answersLockedAfter` holds and what the rules enforce for standard mode.
 * Parity is the point; a sequential student should face the same wall as a
 * standard one, no earlier and no later.
 *
 * Freeze is credited and paused exactly as everywhere else: computeDeadlines
 * applies per-clock credit (D-28) and subtracts recorded penalties (A4), and
 * effectiveNowMs holds time still while a freeze is open (4.3). A paused
 * student therefore cannot be refused for time that was never theirs to spend.
 *
 * A MISSING BOUND IS NOT AN EXPIRED BOUND. An untimed exam, an unreadable
 * anchor or an absent assessment all yield null, and null means "no
 * constraint" — never "over". The failure direction favours the student, which
 * is the rule the whole timing module is built on.
 */
function assertSequentialAnswerWindowOpen(
  attempt: Record<string, unknown>,
  assessmentRaw: Record<string, unknown> | undefined,
  nowMs: number,
): void {
  if (!assessmentRaw) return;          // cannot prove a deadline; do not invent one
  let endsAt: number | null;
  let evalNow: number;
  try {
    const core = toCoreAttempt(attempt);
    // A-06: the clocks this attempt was given, not the exam's current ones.
    const contract = examContractFor(attempt, assessmentRaw) ?? assessmentRaw;
    const dl = computeDeadlines(core, toCoreAssessment(contract));
    endsAt = minNonNullMs(dl.sectionEndsAt, dl.overallEndsAt);
    evalNow = effectiveNowMs(core, nowMs);
  } catch (e) {
    // A resolver fault must never cost a student their answer. Same posture as
    // auditTiming and gradeAttempt's escape hatch: fail soft, let them write.
    console.warn('[assertSequentialAnswerWindowOpen] deadline check failed; allowing', e);
    return;
  }
  if (endsAt === null || evalNow <= endsAt) return;
  throw new HttpsError(
    'deadline-exceeded',
    'ANSWER_WINDOW_CLOSED: your time for this section has ended.',
  );
}

/** min() over the bounds that actually exist. Null when none do. */
function minNonNullMs(...xs: Array<number | null>): number | null {
  const vals = xs.filter((x): x is number => x !== null);
  return vals.length === 0 ? null : Math.min(...vals);
}

export const submitAnswerAndAdvance = onCall<SubmitAnswerAndAdvanceData>(
  EXAM_HOT_PATH,
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
      activeSessionId?: string | null;
    };

    if (attempt.studentId !== studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    assertSession(attempt, request.data?.sessionId, 'submitAnswerAndAdvance');
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
    // D-21: reuses the read above — no extra cost.
    assertNotBlocked(assessment as { blockedStudents?: string[] } | undefined, studentId);
    // A-03: the section and overall clocks reach this path at last. Placed
    // before any write, so a refused answer leaves no trace and the served
    // pointer does not move.
    assertSequentialAnswerWindowOpen(
      attempt as unknown as Record<string, unknown>,
      assessment as unknown as Record<string, unknown> | undefined,
      Date.parse(nowIso),
    );
    const sectionsNorm = assessment ? normalizeSections(assessment) : [];

    // Phase 3b shadow — the question clock is where server and client have
    // historically disagreed most (D-14: 5s grace here, 0s there, and the last
    // question of every section untimed). Reported only.
    auditTiming('submitAnswerAndAdvance', attemptId,
      attempt as unknown as Record<string, unknown>,
      assessment as unknown as Record<string, unknown> | undefined,
      ['question', 'section', 'break', 'choose', 'ended']);
    const secDef = sectionsNorm.find((s) => s.id === current.sectionId);
    const qLimit = secDef?.questionTimeLimit;
    // ── What "late" means, from one source (F13 / D-14) ────────────
    //
    // This was `qLimit + 5`, hardcoded, in both this function and its sibling.
    // D-14's fix was "one number, consumed by BOTH sides" — the assessment's
    // questionGraceSeconds — and the resolver consumed it while these two did
    // not, so an exam configured with a 15s grace flagged answers late that
    // the resolver considered on time.
    //
    // Freeze credit is applied for the same reason it applies to every other
    // clock: a pause the invigilator gave back is time the student is entitled
    // to spend, and flagging their answer late for spending it re-imposes the
    // pause as a penalty nobody decided.
    const lateGraceSec =
      (assessment as { questionGraceSeconds?: number } | undefined)?.questionGraceSeconds
      ?? DEFAULT_QUESTION_GRACE_SECONDS;
    let lateAnswer = false;
    if (typeof qLimit === 'number' && qLimit > 0) {
      const creditSec = creditForAnchor(
        toCoreAttempt(attempt as unknown as Record<string, unknown>), current.servedAt) / 1000;
      const elapsedSec = (Date.parse(nowIso) - Date.parse(current.servedAt)) / 1000;
      if (elapsedSec > qLimit + lateGraceSec + creditSec) lateAnswer = true;
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

    // ── D-35 completion: serving a question RESETS its credit ───────
    //
    // freezeCredits.questionMs is anchored on the CURRENT question's servedAt,
    // so it has to be recomputed every time that anchor moves. This site was
    // missed: startExam, startSection and both submitSection branches all
    // refresh it, and this one — the ordinary next-question advance, by far
    // the most frequent of the four — did not.
    //
    // The effect was that a pause was paid out again on every subsequent
    // question. Freeze 40s on question 1, grant it in full, and question 2
    // opened showing 24s + 5s grace + that same 40s. The student saw a minute
    // and four seconds on a twenty-four second question, and the server's own
    // deadline agreed, because both read the same stale number.
    //
    // The new question was served AT nowIso, so no freeze can have begun after
    // its anchor: creditForAnchor returns 0 by arithmetic, exactly as at a
    // section advance. The outer clocks keep their credit, which is the whole
    // point of crediting per clock.
    applyCreditUpdates(
      updates,
      toCoreAttempt(attempt as unknown as Record<string, unknown>),
      { questionServedAt: nowIso },
    );

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
// PHASE 4.2 — SAVE WITHOUT ADVANCING  (sequential delivery)
//
// WHY THIS EXISTS
// In linear/adaptive the ONLY route an answer has to the server is
// submitAnswerAndAdvance, and firestore.rules reject a direct client write.
// That function does not merely save — it LOCKS the answered question and
// SERVES the next one. So there has been no way to persist the selection in
// front of a student without also moving them past it.
//
// Three things need exactly that:
//
//   1. FREEZE (FREEZE_AND_ROADMAP A2 step 1). The first thing that must happen
//      when an invigilator pauses a sitting is "their answer is saved".
//      Advancing a student you have just paused would be a worse bug than the
//      one being fixed — ExamShell said so in as many words, which is why
//      flushAnswers() returned early for sequential modes and the current
//      selection was simply lost on freeze.
//   2. ANSWER DURABILITY (Part B / D-31). The retry-and-sweep layer needs a
//      commit that is safe to call repeatedly.
//   3. Ordinary crash resilience: a browser that dies between being served a
//      question and advancing past it currently loses the selection entirely.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   • does not set `locked` on the served entry
//   • does not append a new served question
//   • does not touch sectionTimings, currentSectionIdx, or any lock field
//
// It writes exactly two keys: `answers.{questionId}` and `updatedAt`, both as
// dot-paths, so it cannot disturb neighbouring state even if a future edit is
// careless. Calling it twice is harmless — the second write overwrites the
// first with the same shape.
//
// LATE ANSWERS
// Recorded and flagged, never rejected — byte-for-byte the policy
// submitAnswerAndAdvance already applies, including the same `qLimit + 5`
// latency grace, so the two cannot disagree about what "late" means. A lag
// spike must not cost a student their work.
//
// NOT FOR STANDARD DELIVERY. Standard-mode answers are a direct, rules-gated
// client write, which the master plan's trust-boundary table blesses
// explicitly. Routing a whole cohort's 1.5s autosaves through a callable
// instead would be a large capacity change for no security gain.
// ══════════════════════════════════════════════════════════════════

interface SaveAnswerNoAdvanceData {
  attemptId: string;
  sebToken?: string;
  /** Phase 2 — the browser session driving this sitting (INV-5a). */
  sessionId?: string;
  questionId: string;
  /**
   * The student's current selection.
   *
   * `null` is a NO-OP here, not a recorded non-answer. This differs from
   * submitAnswerAndAdvance on purpose: there, null means "the per-question
   * timer expired and they are moving on regardless", which is a real event
   * worth recording as unanswered. Here it means "nothing is selected yet",
   * and writing a blank would put a fake `answeredAt` on a question the
   * student has not answered.
   */
  answer: { type: string; value: unknown } | null;
}

export const saveAnswerNoAdvance = onCall<SaveAnswerNoAdvanceData>(
  // Born with capacity settings (D-19). Every sequential-mode student will hit
  // this on a debounce plus a periodic durability sweep, so it carries
  // strictly MORE traffic than submitAnswerAndAdvance, which it sits beside.
  // Retrofitting capacity onto a hot-path callable after the fact is the
  // mistake D-19 records; this one does not repeat it. EXAM_HOT_PATH also
  // carries SEB_SIGNING_SECRET, without which assertSEB fails closed.
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role      = request.auth.token.role      as string | undefined;
    const studentId = request.auth.token.studentId as string | undefined;
    if (role !== 'student' || !studentId) {
      throw new HttpsError('permission-denied', 'Only students may answer.');
    }
    const { attemptId, questionId, answer, sebToken } =
      request.data || ({} as SaveAnswerNoAdvanceData);
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
      servedQuestions?: Array<{
        questionId: string; sectionId: string; difficulty: string;
        servedAt: string; locked: boolean;
      }>;
      securityConfig?: { deliveryMode?: string; requireSEB?: boolean } | null;
      activeSessionId?: string | null;
    };

    if (attempt.studentId !== studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    assertSession(attempt, request.data?.sessionId, 'saveAnswerNoAdvance');

    // ── `frozen` is accepted, and that is the entire point ──────────
    //
    // The two freeze mechanisms differ in shape: freezeAttempt opens a ledger
    // entry and leaves `status` at 'in_progress', while reportExtensionCheck
    // writes status:'frozen'. More importantly, the client learns of a freeze
    // through its Firestore subscription — so by the time it flushes, the
    // freeze has ALREADY landed. Refusing a frozen attempt would fail this
    // call at precisely the moment it exists to succeed.
    //
    // Terminal attempts are still refused: nothing may be written to a sitting
    // that has been graded (INV-6).
    if (attempt.status !== 'in_progress' && attempt.status !== 'frozen') {
      throw new HttpsError('failed-precondition', 'Attempt is not live.');
    }
    assertSEB(sebToken, request.auth.uid, attempt.securityConfig?.requireSEB, attempt.assessmentId);

    const dMode = attempt.securityConfig?.deliveryMode ?? 'standard';
    if (dMode !== 'linear' && dMode !== 'adaptive') {
      throw new HttpsError('failed-precondition',
        'This exam uses standard delivery; answers are saved directly.');
    }

    // Same gate as submitAnswerAndAdvance: the question must be the current
    // served, unlocked one. A locked question is finished and must never be
    // rewritten; an unserved question is one the client should not know about.
    const served = attempt.servedQuestions ?? [];
    const current = served.length > 0 ? served[served.length - 1] : undefined;
    if (!current || current.questionId !== questionId || current.locked === true) {
      throw new HttpsError('failed-precondition',
        'QUESTION_LOCKED: you cannot answer this question.');
    }

    // Nothing selected. Not an error: the durability sweep is allowed to call
    // this speculatively, and a student clearing their choice is legitimate.
    // Reported honestly as `saved: false` rather than a fake success (D7).
    if (!answer || typeof answer.type !== 'string') {
      return { ok: true, saved: false, savedAt: null, lateAnswer: false };
    }

    const nowIso = new Date().toISOString();

    const aSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    const assessment = aSnap.exists ? (aSnap.data() as GradingAssessmentDoc) : undefined;
    // D-21: reuses the read above — no extra cost. Kept identical to
    // submitAnswerAndAdvance deliberately; whether a blocked student may still
    // SAVE work they had already done is N5's to decide, and this function
    // must not quietly answer it differently from its sibling.
    assertNotBlocked(assessment as { blockedStudents?: string[] } | undefined, studentId);
    // A-03: the same gate its sibling applies, from the same function, so the
    // two cannot disagree about when a student's time is up. A durability
    // flush that arrives after the deadline is refused here exactly as the
    // rules would refuse a standard-mode autosave at the same instant.
    assertSequentialAnswerWindowOpen(
      attempt as unknown as Record<string, unknown>,
      assessment as unknown as Record<string, unknown> | undefined,
      Date.parse(nowIso),
    );
    const sectionsNorm = assessment ? normalizeSections(assessment) : [];
    const secDef = sectionsNorm.find((s) => s.id === current.sectionId);
    const qLimit = secDef?.questionTimeLimit;
    // ── What "late" means, from one source (F13 / D-14) ────────────
    //
    // This was `qLimit + 5`, hardcoded, in both this function and its sibling.
    // D-14's fix was "one number, consumed by BOTH sides" — the assessment's
    // questionGraceSeconds — and the resolver consumed it while these two did
    // not, so an exam configured with a 15s grace flagged answers late that
    // the resolver considered on time.
    //
    // Freeze credit is applied for the same reason it applies to every other
    // clock: a pause the invigilator gave back is time the student is entitled
    // to spend, and flagging their answer late for spending it re-imposes the
    // pause as a penalty nobody decided.
    const lateGraceSec =
      (assessment as { questionGraceSeconds?: number } | undefined)?.questionGraceSeconds
      ?? DEFAULT_QUESTION_GRACE_SECONDS;
    let lateAnswer = false;
    if (typeof qLimit === 'number' && qLimit > 0) {
      const creditSec = creditForAnchor(
        toCoreAttempt(attempt as unknown as Record<string, unknown>), current.servedAt) / 1000;
      const elapsedSec = (Date.parse(nowIso) - Date.parse(current.servedAt)) / 1000;
      if (elapsedSec > qLimit + lateGraceSec + creditSec) lateAnswer = true;
    }

    // Firestore rejects `undefined`, so a missing value is normalised to null.
    await attemptRef.update({
      [`answers.${questionId}`]: {
        type: answer.type,
        value: answer.value === undefined ? null : answer.value,
        sectionId: current.sectionId,
        answeredAt: nowIso,
        ...(lateAnswer ? { lateAnswer: true } : {}),
      },
      updatedAt: nowIso,
    });

    // savedAt is echoed back so the client's durability layer (Phase 4.1) can
    // mark this exact selection confirmed rather than assuming the request it
    // sent was the one that landed.
    return { ok: true, saved: true, savedAt: nowIso, lateAnswer };
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
  // ── IGNORED as of master plan Phase 2 (D-07 / doctrine D6) ──────
  // These three used to define the exam's SHAPE and were taken from the
  // caller verbatim. They are still ACCEPTED so a cached older client keeps
  // working (and so a server rollback is clean), but nothing reads them —
  // sections, question order, shuffling and section order are all derived
  // from the assessment document now. Remove the fields once no client sends
  // them.
  sections?: Array<{
    id: string;
    name: string;
    questions: Array<{ questionId: string; marks: number; order: number }>;
  }>;
  shuffleQuestions?: boolean;
  sectionStartOrder?: 'sequential' | 'random' | 'student_choice';
  // Advisory, and documented as such: an honest-majority signal the client
  // reports about itself. Not evidence. SEB is the real device control.
  cameraDeclined?: boolean;
  deviceClass?: 'desktop' | 'mobile' | 'tablet';
  /** Phase 2 — the browser session claiming this attempt (INV-5a). */
  sessionId?: string;
}

// ── startExam ─────────────────────────────────────────────────────
// Server-authoritative attempt creation. Enforces the schedule window
// (startDate/endDate) and the attempt limit against the SERVER clock and
// the assessment doc (not client-supplied values), then writes the
// attempt with server-set timestamps. Idempotent: returns an existing
// in_progress/frozen attempt if one is present.
/**
 * Classify a student's existing attempts for one assessment.
 *
 * Extracted (audit 2026-07-28) so the cheap pre-check and the authoritative
 * in-transaction check cannot drift. They ask the same question at two
 * different moments; if their answers ever disagreed because someone edited
 * one and not the other, the bug would surface as a duplicate attempt under
 * load and be near-impossible to reproduce.
 */
function evaluateStudentAttempts(
  docs: FirebaseFirestore.QueryDocumentSnapshot[],
  effectiveMax: number,
): {
  live: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  finished: number;
  limitReached: boolean;
} {
  const statusOf = (d: FirebaseFirestore.QueryDocumentSnapshot) =>
    (d.data() as { status?: string }).status;
  const live = docs.find(
    (d) => statusOf(d) === 'in_progress' || statusOf(d) === 'frozen',
  );
  const finished = docs.filter((d) => {
    const s = statusOf(d);
    return s === 'submitted' || s === 'auto_submitted' || s === 'terminated';
  }).length;
  return { live, finished, limitReached: finished >= effectiveMax };
}

// ══════════════════════════════════════════════════════════════════
// SESSION OWNERSHIP + INTEGRITY LOG  (master plan Phase 2)
//
// Both fields used to be written directly by the student's browser under the
// firestore.rules whitelist. Both are moved here for the same reason: a field
// the subject of a measurement can rewrite is not a measurement.
// ══════════════════════════════════════════════════════════════════

interface RegisterSessionData { attemptId: string; sessionId: string }

/**
 * Claim an attempt for one browser session. (INV-5a / INV-5b, D-08.)
 *
 * TAKEOVER IS DELIBERATE, AND SO IS THE TRANSACTION.
 *
 * The joining device wins, exactly as before — "first device wins" would
 * strand a student whose browser crashed behind a session they can no longer
 * produce, which is a far more common event than a cheater with two laptops.
 * What changes is that the swap is ATOMIC and the conflict is recorded
 * server-side, where a student cannot suppress it.
 *
 * The previous client-side implementation was a getDoc followed by an
 * updateDoc — two devices arriving together could both read "unclaimed" and
 * both believe they were first, and no conflict was recorded at all.
 */
export const registerSession = onCall<RegisterSessionData>(
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const studentId = request.auth.token.studentId as string | undefined;
    if ((request.auth.token.role as string | undefined) !== 'student' || !studentId) {
      throw new HttpsError('permission-denied', 'Only students may claim a sitting.');
    }
    const { attemptId, sessionId } = request.data || ({} as RegisterSessionData);
    if (!attemptId || !sessionId) {
      throw new HttpsError('invalid-argument', 'attemptId and sessionId are required.');
    }

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);

    return db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) return { ok: true, conflict: false };
      const d = snap.data() as { studentId?: string; activeSessionId?: string | null };
      if (d.studentId !== studentId) {
        throw new HttpsError('permission-denied', 'Not your attempt.');
      }

      const existing = d.activeSessionId;
      const nowIso = new Date().toISOString();
      const conflict = !!existing && existing !== sessionId;

      txn.update(ref, {
        activeSessionId: sessionId,
        ...(conflict ? { sessionConflictAt: nowIso } : {}),
        updatedAt: nowIso,
      });

      return {
        ok: true,
        conflict,
        ...(conflict ? { existingSessionId: existing } : {}),
      };
    });
  },
);

/** Counter field per violation type. Server twin of VIOLATION_COUNTER in
 *  src/lib/submissionService.ts — KEEP IN SYNC. */
const VIOLATION_COUNTER_S: Record<string, string> = {
  tab_switch: 'tabSwitches',
  focus_loss: 'focusLosses',
  fullscreen_exit: 'fullscreenExits',
  copy_attempt: 'copyAttempts',
  paste_attempt: 'pasteAttempts',
  right_click: 'rightClickAttempts',
  multi_person: 'multiPersonEvents',
  face_absent: 'faceAbsenceEvents',
  devtools_open: 'devtoolsEvents',
  reload_attempt: 'tabSwitches',
  keyboard_block: 'keyboardBlockEvents',
  extension_detected: 'extensionEvents',
};

/** Warning-type violations — the three that drive the termination threshold.
 *  Mirrors WARNING_VIOLATION_TYPES in ExamShell. */
const WARNING_VIOLATION_TYPES_S = new Set(['tab_switch', 'focus_loss', 'fullscreen_exit']);
const MAX_INTEGRITY_WARNINGS_S = 3;

interface LogViolationData {
  attemptId: string;
  type: string;
  detail?: string;
  warningNumber?: number;
  /** Past the shell's event cap: keep counting, stop appending event objects. */
  skipEventDetail?: boolean;
  sessionId?: string;
}

/**
 * Record an integrity violation. (D-09, master plan Phase 2.)
 *
 * WHY THIS IS A CALLABLE NOW
 * `integrityLog` sat on the student rules whitelist. logViolation used
 * increment(), but nothing stopped a plain updateDoc resetting the whole
 * object to zeros — a student could erase their own violation record mid-exam,
 * including the counters the termination threshold reads.
 *
 * Moving the write here makes the log APPEND-ONLY and server-incremented. The
 * rules whitelist drops `integrityLog` in the same phase (deployed after the
 * frontend, so no client is left writing a field it can no longer write).
 *
 * WHAT THIS STILL DOES NOT CLOSE, deliberately: a client that never CALLS this
 * never logs anything. Browser-side proctoring cannot close that and pretending
 * otherwise adds code without adding security — SEB is the control. What
 * changes is that a violation, once reported, cannot be un-reported.
 *
 * `thresholdReached` is returned so the shell can act on a count it no longer
 * owns. Termination itself still runs through gradeAttempt.
 */
export const logViolation = onCall<LogViolationData>(
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const studentId = request.auth.token.studentId as string | undefined;
    if ((request.auth.token.role as string | undefined) !== 'student' || !studentId) {
      throw new HttpsError('permission-denied', 'Only students report violations here.');
    }
    const { attemptId, type, detail, warningNumber, skipEventDetail, sessionId } =
      request.data || ({} as LogViolationData);
    if (!attemptId || !type) {
      throw new HttpsError('invalid-argument', 'attemptId and type are required.');
    }
    const counter = VIOLATION_COUNTER_S[type];
    if (!counter) {
      throw new HttpsError('invalid-argument', `Unknown violation type: ${type}`);
    }

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const att = snap.data() as {
      studentId?: string;
      status?: string;
      activeSessionId?: string | null;
      integrityLog?: Record<string, unknown>;
    };
    if (att.studentId !== studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    // A finished attempt takes no further events; a frozen one still does,
    // because a freeze is a paused sitting and events during it are exactly
    // what a reviewer wants.
    if (att.status !== 'in_progress' && att.status !== 'frozen') {
      return { ok: true, ignored: true };
    }
    assertSession(att, sessionId, 'logViolation');

    const nowIso = new Date().toISOString();
    const updates: Record<string, unknown> = {
      [`integrityLog.${counter}`]: FieldValue.increment(1),
      'integrityLog.totalViolations': FieldValue.increment(1),
      updatedAt: nowIso,
    };
    if (!skipEventDetail) {
      updates['integrityLog.violations'] = FieldValue.arrayUnion({
        type,
        timestamp: nowIso,
        ...(detail ? { detail: String(detail).slice(0, 500) } : {}),
        ...(typeof warningNumber === 'number' ? { warningNumber } : {}),
      });
    }
    await ref.update(updates);

    // Recompute the warning count from the pre-write snapshot plus this event.
    const log = (att.integrityLog ?? {}) as Record<string, number>;
    const warnings =
      (log.tabSwitches ?? 0) + (log.focusLosses ?? 0) + (log.fullscreenExits ?? 0)
      + (WARNING_VIOLATION_TYPES_S.has(type) ? 1 : 0);

    return {
      ok: true,
      warnings,
      thresholdReached: warnings >= MAX_INTEGRITY_WARNINGS_S,
    };
  },
);

interface GetExamVerdictData {
  attemptId: string;
  sessionId?: string;
  sebToken?: string;
}

/**
 * Where does this student stand right now?  (Master plan Phase 3c.)
 *
 * The one endpoint every caller asks instead of deciding for itself — doctrine
 * D1 (the server owns every clock) and D4 (display is local, decisions are
 * remote). The shell's countdown becomes a picture of a decision already made
 * here, rather than a second implementation that drifts from this one.
 *
 * ADDITIVE. Nothing calls it yet; Phase 3d points the shell at it. It ships
 * now, separately, so it can be deployed and watched before anything depends
 * on it — the same reason 3a shipped inert.
 *
 * WHY IT CARRIES EXAM_HOT_PATH FROM BIRTH (D-19)
 * Once the shell asks for a verdict at every countdown zero, a cohort that
 * started together will hit section end together and arrive here in one burst
 * — the same synchronised shape that makes gradeAttempt a scale risk. A
 * capacity setting retrofitted after the first bad exam day is a capacity
 * setting learned the expensive way. The client-side jitter that spreads the
 * burst belongs to 3d and must land with it.
 *
 * DEPLOY NOTE: this is a NEW callable, and on this project the CLI has twice
 * created one without the Cloud Run `allUsers` / `roles/run.invoker` binding —
 * which fails silently, rejecting every call before any code runs. Verify with
 * `gcloud run services get-iam-policy getexamverdict --region=us-central1`
 * before believing a quiet log.
 */
// ══════════════════════════════════════════════════════════════════
// FREEZE AS A LEDGER  (master plan Phase 4, step 1)
//
// Freeze used to be a direct client write of four loose fields, and the time
// it took was never given back — computeAttemptLocks ignored
// totalFrozenSeconds entirely (D-03). The display credited the pause and the
// write gate did not, so a student paused for ten minutes saw ten extra
// minutes and had none. Worse, unfreezeAttempt computed `current + additional`
// from a total supplied BY THE CLIENT, so stale roster state or two
// invigilators acting at once made accumulated credit go DOWN (INV-4a).
//
// The ledger replaces guesswork with a record. Each freeze is an entry with a
// MEASURED elapsedMs and a DECIDED grantedMs, and creditedFreezeMs is their
// sum — one number, consumed uniformly by every deadline.
//
// STEP 1 IS ADDITIVE ON PURPOSE. These callables write the ledger AND keep
// totalFrozenSeconds in step, so nothing that reads the old field breaks. No
// deadline moves yet: examTimingCore's CONSUME_LEGACY_FROZEN_SECONDS is still
// false and no attempt carries creditedFreezeMs until an unfreeze runs here.
// Credit only starts flowing when that constant is flipped, which is the LAST
// step of this phase — after the invigilator can actually make the decision
// and the student is told about it. A deadline that moves for a reason nobody
// authorised is a broken promise even when it moves in the student's favour.
// ══════════════════════════════════════════════════════════════════

interface FreezeAttemptData {
  attemptId: string;
  reason?: string;
}

type FreezeLedgerEntry = {
  id: string;
  startedAt: string;
  endedAt?: string | null;
  reason: 'invigilator' | 'extension_check' | 'system';
  frozenBy?: string | null;
  /** Measured wall-clock duration of the freeze. */
  elapsedMs?: number | null;
  /** Decided credit, 0..elapsedMs. The only figure deadlines consume. */
  grantedMs?: number | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  note?: string | null;
  /**
   * The freezer's ROLE at the instant they froze (§3, §8).
   *
   * Authority attaches per freeze, and unfreezing requires the freezer or
   * someone above them. Deriving that later from a profile lookup asks a
   * question about the past using present data: a faculty member promoted to
   * institute admin would appear to have frozen as an admin, and one who has
   * left would have no role at all. `frozenBy` alone cannot answer "who is
   * above this decision".
   *
   * Recorded now, while nothing depends on it, so 4.6 has a fact rather than
   * an inference.
   */
  frozenByRole?: 'webOwner' | 'institute' | 'faculty' | 'system' | null;
  /**
   * What each clock had left at the instant of the pause (§2).
   *
   * Two things need this and neither has a source today. The student is owed
   * "they see where they stood, frozen at that instant" — a screen that
   * currently has nothing to render. And the resume modal needs the caps for
   * A4's per-clock deductions.
   *
   * Stored rather than recomputed because both would otherwise derive it
   * independently, from different code, at different moments — and would
   * drift. It is also the only honest source: after the pause, "what the
   * question had left" is a fact about the past, not something the present
   * state can be asked.
   *
   * null for a clock that was not running (no question in standard delivery,
   * no section between sections, no cap where none is configured). Distinct
   * from 0, which means the clock had run out.
   */
  clocksAtFreeze?: {
    questionMs: number | null;
    sectionMs: number | null;
    overallMs: number | null;
  } | null;
};

/** Staff who may pause a sitting: webOwner, or the attempt's own tenant. */
function assertInvigilator(
  request: { auth?: { token: Record<string, unknown>; uid: string } | null },
  attempt: { instituteId?: string },
): { uid: string; role: string } {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const role = request.auth.token.role as string | undefined;
  const instituteId = request.auth.token.instituteId as string | undefined;
  // 'webOwner', camelCase — the claim firestore.rules documents at the top of
  // the file and AuthContext issues. Writing 'web_owner' here silently
  // rejected every Web Owner, so freezing appeared to do nothing at all.
  const ok = role === 'webOwner'
    || ((role === 'institute' || role === 'faculty') && attempt.instituteId === instituteId);
  if (!ok) throw new HttpsError('permission-denied', 'Not permitted to invigilate this attempt.');
  return { uid: request.auth.uid, role: role as string };
}

/**
 * Who outranks whom (§3, §8).
 *
 * Deliberately a small ladder rather than a permission matrix: the rule is
 * "the freezer, or anyone above them, never a peer", and a ladder is the only
 * shape that says that in one comparison.
 */
const INVIGILATOR_RANK: Record<string, number> = {
  faculty: 1,
  institute: 2,
  webOwner: 3,
};

/**
 * May this actor clear THIS freeze? (§3, §8.)
 *
 * Authority attaches to the individual pause, not to the attempt. Faculty
 * froze the first, a web owner the second: the second needs a web owner.
 *
 *   Frozen by         Cleared by
 *   faculty           that faculty · their institute admin · web owner
 *   institute admin   that institute admin · web owner
 *   web owner         that web owner only
 *   system / extension any invigilator
 *
 * NEVER A PEER. Two faculty at the same institute cannot undo each other's
 * decisions — the whole reason authority is recorded is that a pause is a
 * judgement about a student, and one colleague overruling another silently is
 * the thing this prevents.
 *
 * Read from the STORED frozenByRole, never from a profile lookup, and the two
 * edge cases in §10 are why:
 *
 *   "The freezer leaves or is deleted" — a lookup would return nothing and
 *   strand the student. The stored rank still says who is above them.
 *   "Freezer promoted" — they are the freezer AND above, and the uid match
 *   below authorises them without needing to re-derive anything.
 *
 * LEGACY ENTRIES (no frozenByRole) fall back to the old flat rule: any
 * invigilator on the tenant. Inventing a restriction retroactively could leave
 * a student frozen with nobody authorised to release them, and a student
 * stranded by our own data migration is a worse outcome than a peer clearing a
 * pause from before the rule existed. Drains as old freezes resolve.
 */
function assertCanUnfreeze(
  actor: { uid: string; role: string },
  entry: FreezeLedgerEntry | undefined,
): void {
  if (!entry) return;                                   // nothing to judge

  // §3: a system freeze has no human owner, so any invigilator may clear it.
  if (entry.reason === 'extension_check' || entry.reason === 'system') return;

  const frozenByRole = entry.frozenByRole;
  if (!frozenByRole) return;                            // legacy — see above

  // The freezer themselves, whatever they have since become.
  if (entry.frozenBy && entry.frozenBy === actor.uid) return;

  const mine = INVIGILATOR_RANK[actor.role] ?? 0;
  const theirs = INVIGILATOR_RANK[frozenByRole] ?? 0;
  // STRICTLY above. Equal rank is a peer, and a peer is not authority.
  if (mine > theirs) return;

  const who = frozenByRole === 'faculty' ? 'a faculty member'
            : frozenByRole === 'institute' ? 'an institute admin'
            : 'the web owner';
  throw new HttpsError('permission-denied',
    `FREEZE_AUTHORITY: this session was paused by ${who}. ` +
    `It can be resumed by them, or by someone above them.`);
}

// ══════════════════════════════════════════════════════════════════
// ONE FREEZE MECHANISM  (F6 / F7 — 2026-08-03)
//
// There were two, with different shapes, and every consumer had to know both:
//
//   freezeAttempt         freezes[] entry + frozenAt   status stays in_progress
//   reportExtensionCheck  freezeState + status:'frozen'  no ledger, no frozenAt
//
// Only the first paused anything. effectiveNowMs() pins the resolver's clock
// off an OPEN LEDGER ENTRY, and ExamShell derives isFrozen from frozenAt, so an
// extension freeze stopped neither the server's clocks nor the client's: a
// student locked out by an antivirus false positive watched their section drain
// behind the overlay, was refused answer writes by firestore.rules
// (status != 'in_progress'), and was resolved into the NEXT section without
// ever being released. That is D-32 and D-36 again, in the mechanism nobody
// converted.
//
// It also left three other rules half-applied: the sweep's window-close branch
// queries status:'frozen' and therefore never saw an invigilator freeze (F9),
// and verifyAndResume wrote totalFrozenSeconds with FieldValue.increment while
// unfreezeAttempt SET the same field from the ledger, so the two disagreed
// about what the field even meant and credit went DOWN (F4).
//
// Both paths now open and close the same ledger entry through these two
// helpers. The difference between an invigilator pause and a system pause is
// where it belongs — in `reason`, which assertCanUnfreeze already keys off —
// and not in the shape of the state.
// ══════════════════════════════════════════════════════════════════

/**
 * Pre-ledger credit, carried across the moment the ledger begins (F3).
 *
 * creditForAnchor switches branch the instant `freezes` is non-empty: with no
 * ledger it returns the flat `totalFrozenSeconds`, with one it sums per-freeze
 * grantedMs. So on an attempt carrying legacy credit, pressing Freeze DELETED
 * that credit — the open entry has no grantedMs yet, so the sum is zero.
 * Measured at eight minutes lost on the button press.
 *
 * Migrating it as a synthetic CLOSED row keeps the arithmetic continuous.
 *
 * THE ANCHOR IS A RECONSTRUCTION, and worth being honest about. A pre-ledger
 * total records no instants, so which clocks it was meant to credit cannot be
 * recovered. Anchoring it at the OPEN SECTION's start (attempt start when
 * between sections) reproduces exactly what the student's deadlines said one
 * moment earlier for the overall and section clocks, and declines to credit a
 * question served later — which is what D-28 would have decided had the data
 * existed. It is the closest truthful reading available, not a measurement.
 *
 * Returns null when there is nothing to migrate, which is every attempt
 * created after the ledger shipped. Drains as legacy attempts finish.
 */
function preLedgerCreditEntry(
  att: { totalFrozenSeconds?: number; freezes?: FreezeLedgerEntry[]; startedAt?: string;
         sectionTimings?: Record<string, { startedAt?: string; submittedAt?: string }> },
  nowIso: string,
): FreezeLedgerEntry | null {
  if (Array.isArray(att.freezes) && att.freezes.length > 0) return null;
  const legacy = att.totalFrozenSeconds;
  if (typeof legacy !== 'number' || !Number.isFinite(legacy) || legacy <= 0) return null;

  const openId = openSectionId(toCoreAttempt(att as unknown as Record<string, unknown>));
  const anchor = (openId ? att.sectionTimings?.[openId]?.startedAt : undefined)
    || att.startedAt
    || nowIso;

  return {
    id: `fz_legacy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    startedAt: anchor,
    endedAt: anchor,
    reason: 'system',
    frozenBy: null,
    frozenByRole: 'system',
    elapsedMs: Math.round(legacy * 1000),
    grantedMs: Math.round(legacy * 1000),
    decidedBy: null,
    decidedAt: nowIso,
    note: 'pre-ledger credit carried forward (totalFrozenSeconds)',
    clocksAtFreeze: null,
  };
}

/**
 * Snapshot what each clock had left at this instant (§2).
 *
 * EXCLUDES GRACE (F11). The stored deadline includes sectionGraceSeconds, so
 * `deadline - now` was 30 s (default) larger than the number on the student's
 * own screen — SectionTimer renders `timeLimit - elapsed` with no grace. The
 * resume modal showed a "time remaining at the pause" the student had never
 * seen, and derived its per-clock penalty caps from it, so a deduction could
 * eat into the latency buffer rather than into the student's time.
 *
 * The server-side clamp in unfreezeAttempt still measures against the real
 * post-credit deadline, grace included. This only changes what is DESCRIBED,
 * so the description matches the thing it describes.
 *
 * null means the clock was not running — no question in standard delivery, no
 * section between sections, no cap configured. Distinct from 0, which means it
 * had run out, and A10 turns on the difference.
 */
function snapshotClocks(
  core: CoreAttempt,
  coreAsmt: CoreAssessment,
  nowMs: number,
): FreezeLedgerEntry['clocksAtFreeze'] {
  const d = computeDeadlines(core, coreAsmt);
  const graceMs = (x: number | null, gs: number | undefined, dflt: number) =>
    x === null ? null : Math.max(0, x - nowMs - (gs ?? dflt) * 1000);
  return {
    questionMs: graceMs(d.questionEndsAt, coreAsmt.questionGraceSeconds, DEFAULT_QUESTION_GRACE_SECONDS),
    sectionMs: graceMs(d.sectionEndsAt, coreAsmt.sectionGraceSeconds, DEFAULT_SECTION_GRACE_SECONDS),
    overallMs: graceMs(d.overallEndsAt, coreAsmt.overallGraceSeconds, DEFAULT_OVERALL_GRACE_SECONDS),
  };
}

/**
 * Everything a pause writes, for either mechanism.
 *
 * Fails soft on the snapshot: a missing or unreadable assessment yields nulls,
 * never a thrown freeze. An invigilator must always be able to stop a sitting,
 * and a system check must always be able to, and a snapshot is worth less than
 * the pause itself.
 */
function openFreezeUpdates(
  att: Record<string, unknown>,
  assessmentRaw: Record<string, unknown> | null,
  opts: {
    reason: FreezeLedgerEntry['reason'];
    frozenBy: string | null;
    frozenByRole: FreezeLedgerEntry['frozenByRole'];
    nowIso: string;
  },
): { updates: Record<string, unknown>; entry: FreezeLedgerEntry } {
  let clocksAtFreeze: FreezeLedgerEntry['clocksAtFreeze'] = null;
  try {
    if (assessmentRaw) {
      // A-06: snapshot against the contract this attempt is sitting under.
      clocksAtFreeze = snapshotClocks(
        toCoreAttempt(att),
        toCoreAssessment(examContractFor(att, assessmentRaw) ?? assessmentRaw),
        Date.parse(opts.nowIso));
    }
  } catch { clocksAtFreeze = null; }

  const entry: FreezeLedgerEntry = {
    id: `fz_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    startedAt: opts.nowIso,
    reason: opts.reason,
    frozenBy: opts.frozenBy,
    frozenByRole: opts.frozenByRole,
    clocksAtFreeze,
  };

  // F3: carry pre-ledger credit across the branch switch, in the same write.
  const carried = preLedgerCreditEntry(
    att as Parameters<typeof preLedgerCreditEntry>[0], opts.nowIso);
  const ledger = carried ? [carried, entry] : [entry];

  return {
    entry,
    updates: {
      freezes: FieldValue.arrayUnion(...ledger),
      ...(carried ? { creditedFreezeMs: carried.grantedMs ?? 0 } : {}),
      // ── A pause is a state the student cannot write from (F5) ────
      //
      // freezeAttempt left `status` at 'in_progress', and every guard on the
      // student's transition paths tests exactly that — so a paused student
      // could still advance questions, start and submit sections, and
      // FINALISE their own attempt, with the clocks stopped by
      // effectiveNowMs. A pause that stops the clock but not the student is
      // an unbounded time grant to anyone willing to call the callable
      // directly.
      //
      // 'frozen' is the state the extension path already used and every
      // reader already understands: firestore.rules require 'in_progress' on
      // both sides of a student write, getStudentAssessments counts it as
      // live, examHeartbeat ignores it, and the sweep's window-close branch
      // queries it — which is also what makes A10 reach an invigilator freeze
      // for the first time (F9).
      //
      // saveAnswerNoAdvance deliberately still accepts it. The client learns
      // of a freeze through its subscription, so the in-flight flush lands
      // AFTER the pause; refusing it would fail the one call that exists to
      // save the answer in front of a student being paused.
      status: 'frozen',
      // Legacy fields kept in step for one release — SectionTimer pauses on
      // frozenAt, and the roster reads frozenBy/frozenReason. The extension
      // path now writes them too, which is what makes the CLIENT pause on a
      // system freeze (F6).
      frozenAt: opts.nowIso,
      frozenBy: opts.frozenBy,
      updatedAt: opts.nowIso,
    },
  };
}

/**
 * Close the open entry, decide credit, and recompute everything that depends
 * on it. The single implementation of "the pause is over".
 *
 * RECOMPUTING IS NOT OPTIONAL (doctrine D5, and F7). verifyAndResume used to
 * write status and freezeState and nothing else, so a released student carried
 * a pre-freeze answersLockedAfter and pre-freeze freezeCredits. The credit
 * surfaced later, at whatever section boundary happened to run
 * computeAttemptLocks next, as the flat legacy total applied to whichever clock
 * was running then. Both halves of that are fixed by doing the work here.
 */
function closeFreezeUpdates(
  att: Record<string, unknown>,
  assessmentRaw: Record<string, unknown> | null,
  opts: {
    grantedMs: number;
    decidedBy: string | null;
    note?: string | null;
    nowIso: string;
    penalties?: { questionMs?: number; sectionMs?: number; overallMs?: number };
    decidedByRole?: string;
    clearedBy?: 'invigilator' | 'auto' | 'sweep';
  },
): {
  updates: Record<string, unknown>;
  elapsedMs: number; grantedMs: number; creditedFreezeMs: number;
} {
  const d = att as {
    freezes?: FreezeLedgerEntry[]; frozenAt?: string | null;
    freezeState?: { frozen?: boolean; since?: string } | null;
    startedAt?: string; penalties?: CorePenalty[];
    sectionTimings?: Record<string, { startedAt?: string; submittedAt?: string }>;
  };
  const nowMs = Date.parse(opts.nowIso);

  const ledger = [...(d.freezes ?? [])];
  const idx = ledger.findIndex((f) => !f.endedAt);
  // Three shapes, because an attempt already paused when this deploys can be
  // in any of them: a ledger entry (both paths, from now on), `frozenAt` (an
  // invigilator freeze from before the ledger), or `freezeState.since` (an
  // extension freeze from before this change — the only field that path ever
  // wrote). Missing all three would measure a zero-length pause and grant
  // nothing, which is the in-flight student paying for our migration.
  const startedAtIso = idx >= 0
    ? ledger[idx].startedAt
    : (d.frozenAt || d.freezeState?.since || null);
  const startMs = startedAtIso ? Date.parse(startedAtIso) : NaN;
  const elapsedMs = Number.isFinite(startMs) ? Math.max(0, nowMs - startMs) : 0;
  // Cannot grant more than actually elapsed (INV-4c).
  const granted = Math.min(Math.max(0, Math.round(opts.grantedMs)), elapsedMs);

  const closed: FreezeLedgerEntry = {
    ...(idx >= 0 ? ledger[idx] : {
      id: `fz_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      startedAt: startedAtIso ?? opts.nowIso,
      reason: 'invigilator' as const,
    }),
    endedAt: opts.nowIso,
    elapsedMs,
    grantedMs: granted,
    decidedBy: opts.decidedBy,
    decidedAt: opts.nowIso,
    ...(opts.note ? { note: String(opts.note).slice(0, 500) } : {}),
  };
  if (idx >= 0) ledger[idx] = closed; else ledger.push(closed);

  // Derived from the ledger, never incremented from a caller-supplied total.
  // This is what makes INV-4a hold by construction — and now holds for BOTH
  // release paths, where verifyAndResume's FieldValue.increment did not (F4).
  const creditedFreezeMs = ledger.reduce(
    (sum, f) => sum + Math.max(0, f.grantedMs ?? 0), 0);

  const creditedAttempt = {
    ...toCoreAttempt(att),
    freezes: ledger,
    creditedFreezeMs,
  } as CoreAttempt;

  // A-06: every deadline this release recomputes is the attempt's own.
  const contractRaw = assessmentRaw ? (examContractFor(att, assessmentRaw) ?? assessmentRaw) : null;
  const coreAsmt = contractRaw ? toCoreAssessment(contractRaw) : ({ sections: [] } as CoreAssessment);

  // Penalties, capped against the POST-CREDIT clock (A4).
  const dl = computeDeadlines(creditedAttempt, coreAsmt);
  const remaining = (endsAt: number | null): number =>
    endsAt === null ? 0 : Math.max(0, endsAt - nowMs);
  const wanted = opts.penalties ?? {};
  const clamp = (asked: unknown, cap: number): number => {
    const n = typeof asked === 'number' && Number.isFinite(asked) ? asked : 0;
    return Math.max(0, Math.min(Math.round(n), cap));
  };
  const penaltyRows: CorePenalty[] = [];
  const addPenalty = (clock: PenaltyClockS, amountMs: number) => {
    if (amountMs <= 0) return;
    penaltyRows.push({
      id: `pen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      freezeId: closed.id,
      clock,
      amountMs,
      decidedAt: opts.nowIso,
      decidedBy: opts.decidedBy ?? undefined,
    });
  };
  // ── The caps are CUMULATIVE, innermost first (A-04) ─────────────
  //
  // Each cap used to be measured against its own clock alone:
  //
  //   question -> remaining(question)
  //   section  -> remaining(section)
  //   overall  -> remaining(overall)
  //
  // Correct in isolation, and wrong together, because PENALTY_REACHES routes a
  // deduction OUTWARD (examTimingCore:204): time taken from the question is
  // also gone from the section and from the total. So the overall clock
  // absorbed sectionPenalty + overallPenalty while only the second had ever
  // been capped against it.
  //
  // Measured: a 60m exam with a 30m section, frozen at +5:00 and released at
  // +8:00 with 3m granted and a large deduction asked on both clocks. Section
  // capped at 25.5m, overall capped at 55.5m, both individually right — and
  // the overall clock then absorbed 81m against 63.5m of runway, landing
  // overallLockedAfter at t0 − 17:30. Seventeen minutes before the exam began.
  // The student was instantly and irrecoverably out of time.
  //
  // A4 promises "no arithmetic that can go negative"; this is that arithmetic
  // going negative through the door A5 left open. Each cap now subtracts what
  // the inner clocks have already taken from it, so the TOTAL any clock
  // absorbs is at most what that clock had left.
  //
  // NO FLOOR IS APPLIED TO THE RESULTING DEADLINE, deliberately. With the caps
  // right, the worst case is a deadline landing exactly at `now` — "you have
  // no time left", which is a legitimate thing for an invigilator to decide.
  // Flooring on top would mask a deadline that had gone into the past for some
  // OTHER reason, and hiding that is how a clock defect survives a release.
  const qPenalty = clamp(wanted.questionMs, remaining(dl.questionEndsAt));
  const sPenalty = clamp(wanted.sectionMs, remaining(dl.sectionEndsAt) - qPenalty);
  const oPenalty = clamp(wanted.overallMs, remaining(dl.overallEndsAt) - qPenalty - sPenalty);
  addPenalty('question', qPenalty);
  addPenalty('section', sPenalty);
  addPenalty('overall', oPenalty);

  const penalisedAttempt = {
    ...creditedAttempt,
    penalties: [...(d.penalties ?? []), ...penaltyRows],
  } as CoreAttempt;

  const openId = openSectionId(penalisedAttempt);
  const openSectionIso = openId ? d.sectionTimings?.[openId]?.startedAt : undefined;
  const openSectionLimit = openId
    ? (assessmentRaw?.sections as Array<{ id: string; timeLimit?: number }> | undefined)
        ?.find((s) => s.id === openId)?.timeLimit
    : undefined;

  const updates: Record<string, unknown> = {
    freezes: ledger,
    creditedFreezeMs,
    penalties: penalisedAttempt.penalties,
    // The exit from the state openFreezeUpdates put them in. Paired here so
    // there is exactly one way in and one way out.
    status: 'in_progress',
    // Cleared on both release paths. verifyAndResume used to leave a stale
    // `{frozen: true}` behind on the invigilator path and vice versa.
    freezeState: { frozen: false, clearedBy: opts.clearedBy ?? 'invigilator', since: opts.nowIso },
    resumeRequiresVerification: false,
    // Legacy mirror, kept in step for one release. GRANTED, not elapsed.
    totalFrozenSeconds: Math.round(creditedFreezeMs / 1000),
    frozenAt: FieldValue.delete(),
    frozenBy: FieldValue.delete(),
    frozenReason: FieldValue.delete(),
    updatedAt: opts.nowIso,
  };
  applyLockUpdates(updates, computeAttemptLocks(
    d.startedAt,
    openSectionIso,
    openSectionLimit,
    (assessmentRaw ?? {}) as Parameters<typeof computeAttemptLocks>[3],
    penalisedAttempt,
  ));
  applyCreditUpdates(updates, penalisedAttempt);

  return { updates, elapsedMs, grantedMs: granted, creditedFreezeMs };
}

type PenaltyClockS = 'question' | 'section' | 'overall';

/**
 * Pause a sitting. (Phase 4.)
 *
 * Opens a ledger entry. It is CLOSED by unfreezeAttempt, which is where the
 * credit decision happens — a freeze on its own grants nothing, because
 * nobody has decided anything yet.
 */
// ══════════════════════════════════════════════════════════════════
// PHASE 4.4 — PROVISIONAL GRADING  (A9)
//
// An invigilator needs to see where a paused student had got to — to decide
// about the pause, to answer a query, to include them in an export — without
// ending their sitting.
//
// STORED OFF THE ATTEMPT, AND THAT IS THE WHOLE DESIGN.
//
// The obvious implementation writes `scores` onto the attempt. A9 rules it
// out in as many words: "a stale score sitting on a live attempt is exactly
// the quiet wrongness this whole project has been about." Two things go wrong
// if you do it. The student reads their own attempt, so a score there is a
// score they can see — and A9 says a frozen student must not see a result
// that is not final. And the moment they answer one more question the stored
// score is a lie that nothing forces anyone to notice.
//
// A sibling document in `provisionalGrades` fixes both by construction. The
// attempt stays unscored and live; students have no read access in the rules;
// and unfreezeAttempt deletes the row, so the grade cannot outlive the pause
// that justified it. Invalidation is not a cleanup step someone must remember
// — the score has nowhere to go stale.
//
// NOT a submission. Status is untouched, submittedAt is untouched, no attempt
// is consumed (A9: unfreezing does not consume another — it is the same
// sitting continuing).
// ══════════════════════════════════════════════════════════════════

interface GradeProvisionalData {
  attemptId: string;
}

export const gradeProvisional = onCall<GradeProvisionalData>(
  { region: 'us-central1' },
  async (request) => {
    const { attemptId } = request.data || ({} as GradeProvisionalData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    const db = getFirestore();
    const attemptSnap = await db.collection('attempts').doc(attemptId).get();
    if (!attemptSnap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const attempt = attemptSnap.data() as {
      instituteId?: string; studentId?: string; assessmentId: string;
      status?: string; answers?: Record<string, AttemptAnswerDoc>;
      gradingConfig?: AssessmentGradingConfigS;
      freezes?: FreezeLedgerEntry[];
    };
    const actor = assertInvigilator(request, attempt);

    // Only while genuinely paused. A running attempt has no need of this, and
    // a terminal one already has a real grade that this must never shadow.
    const open = (attempt.freezes ?? []).find((f) => !f.endedAt);
    if (!open) {
      throw new HttpsError('failed-precondition',
        'NOT_FROZEN: provisional grading applies only to a paused attempt.');
    }

    const assessmentSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    if (!assessmentSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    // A-05: a provisional mark is still a mark; grade the paper they sat.
    const assessment = examContractFor(
      attempt as unknown as Record<string, unknown>,
      assessmentSnap.data() as Record<string, unknown>,
    ) as GradingAssessmentDoc;
    const sections = normalizeSections(assessment);
    const qIds = Array.from(new Set(
      sections.flatMap((sec) => sec.questions.map((q) => q.questionId)),
    ));
    const { questionMap, answerMap } = await loadQuestionAndAnswerMaps(db, qIds);

    const { scores, gradedAnswers } = scoreAttemptAnswers({
      sections,
      questionMap,
      answerMap,
      answers: attempt.answers,
      passingScore: assessment.passingScore,
      // NEVER to the student on this path, whatever the review audience says.
      // This document is staff-only and the student cannot read it; passing
      // true would put answer keys in a row that exists precisely because the
      // sitting is not over.
      exposeKeysToStudent: false,
      // The policy frozen on the attempt at start, exactly as gradeAttempt
      // uses — a provisional mark must be computed the same way as the real
      // one or it is not a preview of anything.
      gradingConfig: attempt.gradingConfig ?? assessment.gradingConfig,
    });

    const nowIso = new Date().toISOString();
    await db.collection('provisionalGrades').doc(attemptId).set({
      attemptId,
      assessmentId: attempt.assessmentId,
      instituteId: attempt.instituteId ?? null,
      studentId: attempt.studentId ?? null,
      scores,
      gradedAnswers,
      // Which pause this describes. If a later freeze is graded the row is
      // replaced; the id makes it checkable that a grade belongs to the freeze
      // currently open rather than an earlier one.
      freezeId: open.id,
      answeredCount: Object.keys(attempt.answers ?? {}).length,
      gradedAt: nowIso,
      gradedBy: actor.uid,
      gradedByRole: actor.role,
    });

    await writeAuditRow(db, {
      action: 'attemptGradedProvisional',
      entityType: 'attempt',
      entityId: attemptId,
      entityLabel: attempt.studentId ?? null,
      instituteId: attempt.instituteId ?? null,
      actorUid: actor.uid,
      actorRole: actor.role,
      reason: `freeze ${open.id}`,
    });

    return { ok: true, scores, provisional: true as const, gradedAt: nowIso };
  },
);

export const freezeAttempt = onCall<FreezeAttemptData>(
  { region: 'us-central1' },
  async (request) => {
    const { attemptId, reason } = request.data || ({} as FreezeAttemptData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);

    const result = await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');
      const att = snap.data() as {
        instituteId?: string; status?: string; frozenAt?: string | null;
        freezes?: FreezeLedgerEntry[];
        // Phase 4.5 Stage 2 — needed to snapshot the clocks at this instant.
        assessmentId?: string;
      };
      const actor = assertInvigilator(request, att);

      if (att.status !== 'in_progress' && att.status !== 'frozen') {
        throw new HttpsError('failed-precondition', 'Attempt is not live.');
      }
      // Already paused: return the open entry rather than opening a second
      // one. Two overlapping entries would break INV-4c and double-count.
      const open = (att.freezes ?? []).find((f) => !f.endedAt);
      if (open || att.frozenAt) {
        return { alreadyFrozen: true, entryId: open?.id ?? null };
      }

      const nowIso = new Date().toISOString();
      // ── §2: capture where the student stood, at this instant ────
      //
      // Read inside the transaction and before the write, so the numbers are
      // the ones that were true when the pause landed — not when someone next
      // opens a modal. Recomputing later would be asking the present state a
      // question about the past.
      const aSnap = att.assessmentId
        ? await txn.get(db.collection('assessments').doc(att.assessmentId))
        : null;

      const { updates, entry } = openFreezeUpdates(
        att as unknown as Record<string, unknown>,
        aSnap?.exists ? (aSnap.data() as Record<string, unknown>) : null,
        {
          reason: 'invigilator',
          frozenBy: actor.uid,
          // §3/§8: authority attaches per freeze, so the role is part of the
          // record rather than something 4.6 has to infer later.
          frozenByRole: actor.role as FreezeLedgerEntry['frozenByRole'],
          nowIso,
        },
      );

      txn.update(ref, {
        ...updates,
        ...(reason ? { frozenReason: String(reason).slice(0, 300) } : {}),
      });
      return { alreadyFrozen: false, entryId: entry.id, actor };
    });

    if (!result.alreadyFrozen && result.actor) {
      await writeAuditRow(db, {
        action: 'attemptFrozen',
        entityType: 'attempt',
        entityId: attemptId,
        actorUid: result.actor.uid,
        actorRole: result.actor.role,
        reason: reason ?? null,
      });
    }
    return { ok: true, ...result };
  },
);

interface UnfreezeAttemptData {
  attemptId: string;
  /**
   * Milliseconds of credit to grant, 0..elapsed. REQUIRED — there is no
   * default, because "how much of this pause was the student's fault" is a
   * judgement the system cannot make for the invigilator. The UI pre-fills the
   * full elapsed time; accepting zero is deliberate and must be explicit.
   */
  grantedMs: number;
  note?: string;
  /**
   * Deductions taken as part of this resume decision (Phase 4.5 / A4).
   *
   * All three clocks in one action, because that is how the decision is made:
   * "give back four minutes but take twenty seconds off the section" is one
   * judgement, not two. Omitted or zero means no penalty — the default, and
   * the only outcome that requires no justification.
   *
   * Each is capped server-side at what that clock has left AFTER the credit
   * lands. A4 promises no arithmetic that can go negative, and measuring the
   * cap before the credit would break that promise whenever the grant is
   * partial.
   */
  penalties?: {
    questionMs?: number;
    sectionMs?: number;
    overallMs?: number;
  };
}

/**
 * Resume a sitting, deciding how much of the pause to give back. (Phase 4.)
 *
 * WHY THE TOTAL IS COMPUTED HERE AND NOT PASSED IN
 * The old client call took `currentTotalFrozenSeconds` as an argument and
 * wrote `current + additional`. Stale roster state — or two invigilators on
 * the same attempt — therefore made accumulated credit DECREASE, which is
 * INV-4a. Inside this transaction the total is derived from the ledger, so it
 * cannot regress no matter who calls it or how stale their screen is.
 */
export const unfreezeAttempt = onCall<UnfreezeAttemptData>(
  { region: 'us-central1' },
  async (request) => {
    const { attemptId, grantedMs, note } = request.data || ({} as UnfreezeAttemptData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');
    if (typeof grantedMs !== 'number' || !Number.isFinite(grantedMs) || grantedMs < 0) {
      throw new HttpsError('invalid-argument', 'grantedMs must be a number >= 0.');
    }

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);

    const result = await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');
      const att = snap.data() as {
        instituteId?: string; frozenAt?: string | null;
        freezes?: FreezeLedgerEntry[]; totalFrozenSeconds?: number;
        // Phase 4.3 — needed to re-materialise the lock once credit is granted.
        assessmentId?: string; startedAt?: string;
        sectionTimings?: Record<string, { startedAt?: string; submittedAt?: string }>;
        // Phase 4.5 — existing deductions, appended to never replaced (INV-11).
        penalties?: CorePenalty[];
      };
      const actor = assertInvigilator(request, att);

      // Read before write — Firestore transactions require it, and the update
      // below is the only write. `{}` when the assessment is missing: an
      // untimed result is the safe direction, never a thrown unfreeze. An
      // invigilator must always be able to release a student.
      const lockSnap = att.assessmentId
        ? await txn.get(db.collection('assessments').doc(att.assessmentId))
        : null;

      const ledger = [...(att.freezes ?? [])];
      const idx = ledger.findIndex((f) => !f.endedAt);
      // §3/§8: checked against THIS entry, inside the transaction, before
      // anything is written. Authority belongs to the pause, so it has to be
      // read from the pause rather than from the attempt.
      assertCanUnfreeze(actor, idx >= 0 ? ledger[idx] : undefined);
      const startedAtIso = idx >= 0 ? ledger[idx].startedAt : att.frozenAt;
      if (!startedAtIso) {
        throw new HttpsError('failed-precondition', 'Attempt is not frozen.');
      }

      const nowIso = new Date().toISOString();

      // ── Everything the release writes lives in closeFreezeUpdates ──
      //
      // Closing the entry, deriving creditedFreezeMs from the ledger, clamping
      // the A4 deductions against the post-credit clock, recomputing the three
      // lock fields and re-materialising freezeCredits are one operation, and
      // they are now expressed once. verifyAndResume performs the same release
      // through the same function, so the invigilator path and the system path
      // cannot reach different state (F4 / F7).
      const closed = closeFreezeUpdates(
        att as unknown as Record<string, unknown>,
        lockSnap?.exists ? (lockSnap.data() as Record<string, unknown>) : null,
        {
          grantedMs,
          decidedBy: actor.uid,
          note,
          nowIso,
          penalties: request.data?.penalties,
          decidedByRole: actor.role,
        },
      );

      // ── A9: unfreeze invalidates the provisional grade ──────────
      //
      // "Unfreeze invalidates the grade. Stale scores are cleared
      // automatically." The student is about to keep working, so any mark
      // describing where they had got to is now describing a moment that has
      // passed.
      //
      // In the same transaction as the release, not a follow-up write: a
      // failure between the two would leave a stale grade on a running
      // attempt, which is the exact state A9 forbids. Deleting a row that is
      // not there is a no-op, so no existence check is needed.
      txn.delete(db.collection('provisionalGrades').doc(attemptId));
      txn.update(ref, closed.updates);

      return {
        elapsedMs: closed.elapsedMs,
        grantedMs: closed.grantedMs,
        creditedFreezeMs: closed.creditedFreezeMs,
        actor,
      };
    });

    await writeAuditRow(db, {
      action: 'attemptUnfrozen',
      entityType: 'attempt',
      entityId: attemptId,
      actorUid: result.actor.uid,
      actorRole: result.actor.role,
      reason: note ?? null,
      impact: { elapsedMs: result.elapsedMs, grantedMs: result.grantedMs },
    });

    return {
      ok: true,
      elapsedMs: result.elapsedMs,
      grantedMs: result.grantedMs,
      creditedFreezeMs: result.creditedFreezeMs,
    };
  },
);

export const getExamVerdict = onCall<GetExamVerdictData>(
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role = request.auth.token.role as string | undefined;
    const studentId = request.auth.token.studentId as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;

    const { attemptId, sessionId, sebToken } = request.data || ({} as GetExamVerdictData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    const db = getFirestore();
    const snap = await db.collection('attempts').doc(attemptId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const att = snap.data() as Record<string, any>;

    // A student may ask about their own sitting; staff may ask about one in
    // their tenant. Same scoping the roster already relies on.
    const isOwner = role === 'student' && att.studentId === studentId;
    const isStaff = role === 'webOwner'
      || ((role === 'institute' || role === 'faculty') && att.instituteId === instituteId);
    if (!isOwner && !isStaff) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }

    if (isOwner) {
      assertSession(att, sessionId, 'getExamVerdict');
      assertSEB(sebToken, request.auth.uid, att.securityConfig?.requireSEB, att.assessmentId);
    }

    const aSnap = await db.collection('assessments').doc(att.assessmentId).get();
    if (!aSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');

    const core = toCoreAttempt(att);
    // A-06: the student's screen renders the contract they started under.
    const coreAsmt = toCoreAssessment(
      examContractFor(att, aSnap.data() as Record<string, unknown>) as Record<string, unknown>);
    const serverNow = Date.now();
    const verdict = resolveTiming(core, coreAsmt, serverNow);

    // serverNow rides along so the client can measure its own skew against the
    // same instant the verdict was computed at, rather than trusting a local
    // clock it has no reason to trust (the existing getServerTime contract).
    return { ok: true, serverNow, verdict };
  },
);

export const startExam = onCall<StartExamData>(
  // Phase 3: the secret must be declared here or SEB_SIGNING_SECRET.value()
  // is empty at runtime and assertSEB would fail closed on every call.
  // EXAM_HOT_PATH carries that secret plus the capacity settings.
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role = request.auth.token.role as string | undefined;
    const studentId = request.auth.token.studentId as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    if (role !== 'student' || !studentId || !instituteId) {
      throw new HttpsError('permission-denied', 'Only students may start an exam.');
    }

    // ── Structure is NOT taken from the caller (D-07, doctrine D6) ──
    // `sections`, `shuffleQuestions` and `sectionStartOrder` used to be read
    // straight out of request.data and used to build the attempt. Because the
    // section time limit was looked up as
    //   a.sections?.find(s => s.id === firstSectionId)?.timeLimit
    // a caller who supplied a section id that does not exist in the document
    // got `undefined` back — computeAttemptLocks then produced no section
    // bound, and submitSection's deadline check was skipped by the same failed
    // lookup. A per-section timed exam became one untimed block. The paper was
    // never at risk (getExamQuestions reads the document) and neither was the
    // mark (grading reads the document too) — the exploit was purely on TIME,
    // which for a timed exam is the whole contract.
    //
    // They are still ACCEPTED in the payload and ignored, so a cached client
    // keeps working through the rollout and a rollback is clean.
    const { assessmentId, cameraDeclined, sebToken, sessionId } =
      request.data || ({} as StartExamData);
    if (!assessmentId) {
      throw new HttpsError('invalid-argument', 'assessmentId is required.');
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
      // Timing, read for the answer-write lock (audit 2026-07-28). Section
      // limits come from HERE, never from the client's sections payload —
      // that array is caller-supplied and a forged timeLimit would buy the
      // student a longer writable window, which is the whole thing being
      // closed.
      sections?: Array<{ id: string; timeLimit?: number }>;
      sectionGraceSeconds?: number;
      overallTimeLimit?: number;
      overallGraceSeconds?: number;
      // Phase 2 (D-07): exam STRUCTURE is read from here, never from the
      // caller. See the note where effectiveSections is built below.
      shuffleQuestions?: boolean;
      sectionStartOrder?: 'sequential' | 'random' | 'student_choice';
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

    // ── Fast path (NOT authoritative) ─────────────────────────────
    // A plain read that short-circuits the two common cases without paying to
    // build an attempt: resuming a live sitting, and a student who is already
    // out of attempts. The transaction at the end of this function is what
    // actually decides — see the note there for why this read alone is not
    // enough.
    const attemptsQuery = db.collection('attempts')
      .where('studentId', '==', studentId)
      .where('assessmentId', '==', assessmentId);

    const effectiveMax = a.attemptOverrides?.[studentId] ?? a.maxAttempts ?? 1;

    const preSnap = await attemptsQuery.get();
    const pre = evaluateStudentAttempts(preSnap.docs, effectiveMax);
    if (pre.live) return { ok: true, attempt: pre.live.data() };

    // ── Manually CLOSED assessment (D-11, master plan Phase 1) ────
    // Only 'draft' was checked here, so an exam a Web Owner closed by hand
    // stayed enterable whenever its endDate was still future or unset — the
    // briefing page was the only thing stopping it, and the briefing page is
    // not a security control.
    //
    // Placed AFTER the live-attempt return, deliberately. A student already
    // mid-sitting when staff close the exam must still be able to resume and
    // submit; closing an exam is an admissions decision, not a reason to
    // destroy work in progress. This blocks NEW sittings only.
    //
    // (endDate is checked earlier and does still block resume. That is the
    // authored hard wall from the timing spec, and changing it belongs to the
    // window work in Phase 5, not here.)
    if (a.status === 'closed') {
      throw new HttpsError('failed-precondition', 'This exam has closed.');
    }

    if (pre.limitReached) {
      throw new HttpsError(
        'resource-exhausted',
        `ATTEMPT_LIMIT_EXCEEDED:${pre.finished}:${effectiveMax}`,
      );
    }

    // ── Build frozen state (mirrors legacy startAttempt) ──────────
    const nowIso = new Date().toISOString();

    // ── Legacy fallback for the security freeze (audit P-01) ───────
    // The freeze now happens at PUBLISH (assessmentService.stampIfPublishing,
    // enforced by firestore.rules), so any assessment published after that
    // change arrives here already stamped and this block is skipped entirely.
    //
    // It remains for assessments that went live BEFORE that change and carry
    // no stamp. Removing it outright would leave those exams' security config
    // editable forever, which is the opposite of the intent.
    //
    // NON-FATAL, and that is the whole point at scale. This is the only write
    // to a SHARED document anywhere on the student hot path. At a large
    // simultaneous opening every invocation that reads the doc before the
    // first write propagates also writes — hundreds to thousands of writes
    // onto one document, against Firestore's ~1-write-per-second-per-document
    // ceiling. Previously this was a bare `await`, so a contention rejection
    // threw and STOPPED THAT STUDENT SITTING THE EXAM. Swallowing it is
    // correct: the stamp is idempotent and racing writers all write the same
    // instant, so with thousands trying at least one lands, and a student is
    // never blocked from starting because of a bookkeeping write.
    if (!a.securityLockedAt) {
      try {
        await db.collection('assessments').doc(assessmentId)
          .set({ securityLockedAt: nowIso, updatedAt: nowIso }, { merge: true });
      } catch (e) {
        console.warn('[startExam] legacy securityLockedAt stamp skipped', assessmentId, e);
      }
    }

    // ── Server-derived exam structure (D-07, doctrine D6) ─────────
    // normalizeSections is the SAME function grading uses, so the sections an
    // attempt is built from and the sections it is marked against can never
    // disagree. It also handles the three legacy shapes (resolved sections /
    // flat question list distributed across named sections / no sections at
    // all) identically to the grader.
    const effectiveSections = normalizeSections(aSnap.data() as GradingAssessmentDoc);
    if (effectiveSections.length === 0) {
      throw new HttpsError('failed-precondition', 'This exam has no questions.');
    }
    const shuffleQuestions = a.shuffleQuestions === true;
    const sectionStartOrder = a.sectionStartOrder ?? 'sequential';

    let ordered = effectiveSections;
    if (sectionStartOrder === 'random' || sectionStartOrder === 'student_choice') {
      ordered = [...effectiveSections];
      for (let i = ordered.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
      }
    }
    const sectionIds = ordered.map((s) => s.id);

    const questionOrder: Record<string, string[]> = {};
    for (const sec of ordered) {
      const qids = [...sec.questions]
        .sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
        .map((q) => q.questionId);
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

    // Answer-write lock for the FIRST section (audit 2026-07-28). startSection
    // recomputes this on every later section, but section one is auto-started
    // here and never passes through it, so without this the opening section
    // would be the one stretch of the exam with no server-side time bound.
    //
    // student_choice defers the first start, so there is no section clock to
    // bound yet — the overall deadline still applies if the exam has one, and
    // the student's own startSection call sets the section bound when they
    // pick. computeAttemptLocks handles that by taking whichever bounds
    // exist.
    const firstSectionId = autoStartFirst ? ordered[0]?.id : undefined;
    const initialLocks = computeAttemptLocks(
      nowIso,
      firstSectionId ? nowIso : undefined,
      a.sections?.find((sec) => sec.id === firstSectionId)?.timeLimit,
      a,
    );

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
      // Combined = min(section, overall); still exactly what the rules gate on.
      // D-35: present from birth so the client never sees the field missing.
      // Always zero here — a new attempt has no ledger to credit from.
      freezeCredits: { overallMs: 0, sectionMs: 0, questionMs: 0, breakMs: 0 },
      answersLockedAfter: initialLocks.combined ? Timestamp.fromDate(initialLocks.combined) : null,
      // Split bounds (Phase 0) — the resume path needs to know WHICH clock
      // tripped, which the minimum alone cannot say.
      sectionLockedAfter: initialLocks.section ? Timestamp.fromDate(initialLocks.section) : null,
      overallLockedAfter: initialLocks.overall ? Timestamp.fromDate(initialLocks.overall) : null,
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
      // Phase 2 (INV-5a): the session that opened this sitting owns it from
      // the first instant, so there is no unclaimed window in which a second
      // device could slip in ahead of the real one.
      ...(sessionId ? { activeSessionId: sessionId } : {}),
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
      // ── Frozen paper + timing contract (A-05 / A-06) ──────────────
      // The third snapshot on this document, and it exists for the same reason
      // as the two above it: what a student is marked against, and the clocks
      // they race, must be what they were given — not whatever the assessment
      // says by the time anyone looks. `ordered` is this student's own play
      // order, so a shuffle is captured too. See examContractFor for what is
      // deliberately left reading live (the availability window).
      examSnapshot: buildExamSnapshot(aSnap.data() as Record<string, unknown>, ordered),
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

    // ── Authoritative create (audit 2026-07-28) ───────────────────
    // The check above is a plain read, and a plain read followed by a plain
    // write is NOT atomic. Two concurrent startExam calls for the same student
    // both read, both see no live attempt, both generate a different random
    // id, and both write — producing TWO live attempts for one student, and
    // letting both pass an attempt-limit check that should have admitted one.
    //
    // That was reachable before (double-click, two tabs, flaky network) but
    // the client-side retry added for the staggered start made it far more
    // likely: 'deadline-exceeded' means "the client stopped waiting", not
    // "the server failed", so the original call may still be running and about
    // to succeed when the retry arrives. Retrying was justified on the grounds
    // that startExam is idempotent — true only for SEQUENTIAL calls. This
    // transaction is what makes that claim true under concurrency, and
    // therefore what makes the retry safe.
    //
    // Scope is deliberate. The read set is a single student's attempts for a
    // single assessment, so two students never contend — unlike a transaction
    // on the shared assessment doc, which is exactly what was rejected for
    // P-01. Only a student's own racing requests serialise, which is the point.
    //
    // Everything expensive — SEB verification, camera and targeting gates,
    // section building and shuffling — stays OUTSIDE. A transaction body can
    // re-run on contention, so anything in here is work that may be repeated,
    // and Firestore requires all reads before all writes within it.
    const created = await db.runTransaction(async (txn) => {
      const snap = await txn.get(attemptsQuery);
      const nowState = evaluateStudentAttempts(snap.docs, effectiveMax);

      // Someone won the race. Return THEIR attempt rather than creating a
      // second one — this is the case the fast path could not see.
      if (nowState.live) return nowState.live.data();

      if (nowState.limitReached) {
        throw new HttpsError(
          'resource-exhausted',
          `ATTEMPT_LIMIT_EXCEEDED:${nowState.finished}:${effectiveMax}`,
        );
      }

      txn.set(db.collection('attempts').doc(id), attempt);
      return attempt as FirebaseFirestore.DocumentData;
    });

    return { ok: true, attempt: created };
  },
);

interface StartSectionData {
  attemptId: string;
  sebToken?: string;
  /** Phase 2 — the browser session driving this sitting (INV-5a). */
  sessionId?: string;
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
/**
 * Absolute instant after which a student may no longer write answers.
 *
 * Audit 2026-07-28, exam integrity. firestore.rules had NO time dimension at
 * all — the student attempt-update branch checked ownership, status
 * in_progress and a field whitelist, and nothing else. So while an attempt was
 * in_progress a student could keep writing answers indefinitely, hours past
 * every deadline. Time was enforced only inside submitSection / gradeAttempt,
 * both of which the STUDENT triggers, which made the limits advisory: leave
 * mid-exam, come back after the clock ran out, keep working. gradeAttempt then
 * scored every one of those late answers.
 *
 * The lock has to be a materialized Firestore Timestamp rather than something
 * the rules derive, because every clock anchor on the attempt is an ISO
 * STRING (attempt.startedAt, sectionTimings[id].startedAt) and rules cannot
 * parse a string into a timestamp. So the server computes the instant and
 * stores it; the rule does one comparison against request.time.
 *
 * It is the EARLIER of the two live deadlines, recomputed whenever a section
 * starts:
 *   section — sectionTimings[id].startedAt + timeLimit + sectionGrace
 *   overall — attempt.startedAt + overallTimeLimit + overallGrace
 * An untimed section contributes no section bound; an exam with no overall
 * limit contributes no overall bound; with neither there is nothing to lock
 * and this returns null, which the rule reads as "no time constraint".
 *
 * FREEZE IS DELIBERATELY NOT CREDITED, matching submitSection's documented
 * posture exactly (see the note above its overall-deadline check): the server
 * ignores freeze, grace absorbs the slack, and freeze is credited only in the
 * client display. Doing anything else here would make the rule disagree with
 * the callable that grades the attempt — and it also means an invigilator
 * unfreezing does NOT have to recompute this field, so staff cannot lengthen
 * a student's writable window by toggling freeze.
 *
 * ── Phase 0 (timer plan, 2026-07-31) ──────────────────────────────
 * Renamed from computeAnswersLockedAfter, and now returns the two bounds
 * SEPARATELY as well as their minimum.
 *
 * WHY. The single value this used to return was min(section, overall), which
 * is the correct WRITE gate but destroys the one fact the resume path needs:
 * WHICH clock ran out. The client could only ask "is the window shut?", and
 * the only safe answer to that question is to finalise the whole attempt — so
 * a student who stepped away during section 2 of 4 lost sections 3 and 4.
 * Section expiry must advance to the next section; only OVERALL expiry ends
 * the sitting.
 *
 * `combined` keeps the exact previous semantics and is still what
 * `answersLockedAfter` stores, so firestore.rules and
 * scheduledCloseExpiredAttempts are untouched. The two new fields are purely
 * additive: attempts that started before this shipped simply lack them, and
 * the client falls back to the previous behaviour for those.
 *
 * The freeze note above still holds — crediting freeze is Phase 2's job, and
 * it will move BOTH bounds together. Nothing in Phase 0 alters a deadline.
 */
function computeAttemptLocks(
  attemptStartedAtIso: string | undefined,
  sectionStartedAtIso: string | undefined,
  sectionTimeLimitMin: number | undefined,
  a: {
    sectionGraceSeconds?: number;
    overallTimeLimit?: number;
    overallGraceSeconds?: number;
  },
  /**
   * The attempt, for freeze credit (Phase 4.3). Optional so every pre-existing
   * call site keeps compiling; omitting it means zero credit, which is exactly
   * what this function did before.
   *
   * PER CLOCK, never a single total — that was D-28. A ten-minute pause during
   * section 1 must not be added to a fifteen-second question in section 3.
   * creditForAnchor gives each bound only the pauses that began after its own
   * anchor.
   */
  creditFrom?: CoreAttempt,
): { section: Date | null; overall: Date | null; combined: Date | null } {
  // ── Phase 3b: the arithmetic lives in examTimingCore now ────────
  //
  // The signature and the result are unchanged on purpose — every existing
  // caller keeps working and this is provably a no-op today. What changes is
  // WHERE the rule lives: the write gate and the resolver now compute a
  // section deadline with the same function, so they cannot disagree.
  //
  // Freeze credit is passed as 0 here, and the core's legacy
  // totalFrozenSeconds fallback is off (CONSUME_LEGACY_FROZEN_SECONDS).
  // Crediting frozen time is Phase 4's decision to make explicitly, with the
  // student told — not a side effect of adopting the resolver.
  //
  // EQUIVALENCE, measured rather than assumed: across 13,824 combinations of
  // valid-or-absent timestamps, limits and grace values, this returns exactly
  // what the previous expression returned. Zero divergence.
  //
  // It is NOT identical on one input, and the difference is a fix. Given an
  // UNPARSEABLE timestamp the old expression produced `new Date(NaN)` — an
  // Invalid Date, which is TRUTHY — so applyLockUpdates went on to call
  // Timestamp.fromDate() on it and threw:
  //     Value for argument "seconds" is not a valid integer
  // A corrupt startedAt therefore 500'd the callable and blocked the student
  // out of their own section. The core returns null instead: no bound, the
  // outer clocks still apply, the student keeps working. Unreadable input
  // means "unknown", never "expired" — the failure direction always favours
  // the student.
  //
  // The WINDOW and QUESTION bounds are deliberately NOT folded in. The core
  // knows about both, but adding them to the materialised lock changes what
  // firestore.rules enforces, and that belongs to Phase 5 with its own deploy
  // and its own rollback.
  // ── Phase 4.3: freeze credit reaches the WRITE GATE ─────────────
  //
  // This was hardcoded to 0, with a note saying crediting frozen time was
  // "Phase 4's decision to make explicitly". This is that step.
  //
  // It matters because answersLockedAfter is what firestore.rules enforces.
  // The resolver has credited per-clock since D-28, so without this the two
  // disagreed: getExamVerdict would say a student had four minutes left while
  // the rules refused their writes. Same rule, two answers — the shape every
  // timing defect in this system has taken.
  //
  // Zero when no attempt is supplied, so untouched callers are unchanged.
  const sectionCredit = creditFrom ? creditForAnchor(creditFrom, sectionStartedAtIso) : 0;
  const overallCredit = creditFrom ? creditForAnchor(creditFrom, attemptStartedAtIso) : 0;
  // ── Phase 4.5 completion: penalties reach the WRITE GATE too (F2) ──
  //
  // Credit reached this function in 4.3 and deductions never did, so a
  // recorded penalty shortened the resolver's answer and the student's screen
  // while answersLockedAfter — the field firestore.rules actually enforces —
  // kept the unpenalised instant. The same split that made D-03, pointed the
  // other way: the display taking time the gate still allowed.
  //
  // Anchored exactly as the credit is. penaltyForClock counts only deductions
  // decided AFTER the clock started, and PENALTY_REACHES routes a question or
  // section deduction outward into the total, so the two bounds absorb
  // precisely what the resolver says they do.
  const sectionPenalty = creditFrom ? penaltyForClock(creditFrom, 'section', sectionStartedAtIso) : 0;
  const overallPenalty = creditFrom ? penaltyForClock(creditFrom, 'overall', attemptStartedAtIso) : 0;
  const secMs = sectionDeadlineMs(
    sectionStartedAtIso, sectionTimeLimitMin, a.sectionGraceSeconds, sectionCredit, sectionPenalty,
  );
  const ovrMs = overallDeadlineMs(
    attemptStartedAtIso, a.overallTimeLimit, a.overallGraceSeconds, overallCredit, overallPenalty,
  );

  const section = secMs === null ? null : new Date(secMs);
  const overall = ovrMs === null ? null : new Date(ovrMs);
  const bounds = [secMs, ovrMs].filter((x): x is number => x !== null);
  const combined = bounds.length === 0 ? null : new Date(Math.min(...bounds));

  return { section, overall, combined };
}

// ══════════════════════════════════════════════════════════════════
// TIMING TELEMETRY  (master plan Phase 3b)
//
// The resolver runs alongside the existing inline logic and REPORTS. It does
// not decide anything yet — that is Phase 3c, and it happens only once these
// logs show the two agreeing on real traffic.
//
// This is the cheapest possible way to answer the question 3b exists to ask:
// "would the resolver have done the same thing?" Running it in shadow costs a
// few array scans on a doc already in memory, and answers it against real
// students rather than generated states.
// ══════════════════════════════════════════════════════════════════

/** Map a stored assessment onto the core's plain input shape. */
/**
 * The exam contract a given attempt is sitting under. (A-05 / A-06.)
 *
 * WHAT WENT WRONG. `securityLockedAt` freezes exactly seven fields —
 * securityTier, deliveryMode, requireCamera, allowMobile,
 * requireExtensionCheck, autoResume and the stamp itself (firestore.rules:571).
 * `sections`, `questions` and every timing field are not among them, while
 * grading marked against normalizeSections(THE LIVE DOC) and computeAttemptLocks
 * read timeLimit / overallTimeLimit / the grace knobs from the LIVE DOC on every
 * recompute.
 *
 * So an ordinary staff edit to a running exam reached students already sitting
 * it. Two measured failures:
 *
 *   A-05  The builder re-draws rule-based sections AT RANDOM on every save with
 *         status 'active' (DetailsStep -> resolveQuestionsForSections). A
 *         student who had answered every question correctly scored 30/40: their
 *         correct answer to a question the re-draw had removed was discarded,
 *         and a question they were never shown was counted as a blank.
 *   A-06  Editing overallTimeLimit from 120 to 20 moved a live student's
 *         deadline 100 minutes earlier, retroactively, and flipped their
 *         verdict to 'ended'.
 *
 * THE FIX IS TO FREEZE, NOT TO FORBID. Locking the fields in the rules would
 * also block legitimate repairs to an exam nobody has started yet, and would
 * not help the attempts already running. Freezing the contract onto the attempt
 * is the pattern this codebase already uses twice — `securityConfig` and
 * `gradingConfig` are both snapshotted at startExam for exactly this reason —
 * so this extends it to the two things that were left reading live.
 *
 * WHAT IS DELIBERATELY NOT FROZEN: startDate and endDate. The availability
 * window is the institution's outer wall, not one of the student's clocks (A10,
 * and the reason resolve() races it against real time while every other
 * deadline pauses). Staff closing an exam early or extending it is an
 * admissions decision that must keep working, so the merge below lets those —
 * and everything else the snapshot does not name, such as passingScore and the
 * review audiences, which regradeAttempts exists to re-apply — come from the
 * live document.
 *
 * LEGACY ATTEMPTS carry no snapshot and fall through to the live document,
 * which is exactly today's behaviour. Nothing in flight changes on deploy.
 */
function examContractFor(
  attempt: Record<string, unknown>,
  liveAssessment: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const snap = (attempt as { examSnapshot?: { sections?: unknown } }).examSnapshot;
  if (!snap || !Array.isArray(snap.sections)) return liveAssessment;
  // Frozen paper + frozen timing OVER the live doc, so fields the snapshot
  // deliberately omits still track the assessment.
  return { ...(liveAssessment ?? {}), ...(snap as Record<string, unknown>) };
}

/**
 * Build the frozen contract, at startExam, from the sections actually played.
 *
 * `ordered` is the per-student play order after any shuffle, so the snapshot
 * records the paper THIS student was given — not the builder's list. Marks and
 * order ride along because grading needs them; timeLimit, questionTimeLimit and
 * breakAfter because the clocks do.
 */
function buildExamSnapshot(
  a: Record<string, unknown>,
  ordered: EffectiveSection[],
): Record<string, unknown> {
  const rawSections = (a.sections ?? []) as Array<{
    id: string; timeLimit?: number; breakAfter?: BreakCfg;
  }>;
  const rawById = new Map(rawSections.map((s) => [s.id, s]));
  return {
    sections: ordered.map((s) => stripUndefined({
      id: s.id,
      name: s.name,
      questions: s.questions.map((q) => stripUndefined({
        questionId: q.questionId, marks: q.marks, order: q.order,
      })),
      timeLimit: rawById.get(s.id)?.timeLimit,
      questionTimeLimit: s.questionTimeLimit,
      breakAfter: rawById.get(s.id)?.breakAfter,
    })),
    ...stripUndefined({
      overallTimeLimit: a.overallTimeLimit as number | undefined,
      overallGraceSeconds: a.overallGraceSeconds as number | undefined,
      sectionGraceSeconds: a.sectionGraceSeconds as number | undefined,
      questionGraceSeconds: a.questionGraceSeconds as number | undefined,
      sectionStartOrder: a.sectionStartOrder as string | undefined,
      deliveryMode: a.deliveryMode as string | undefined,
    }),
  };
}

function toCoreAssessment(raw: Record<string, unknown>): CoreAssessment {
  const doc = raw as GradingAssessmentDoc & {
    startDate?: string; endDate?: string;
    overallTimeLimit?: number; overallGraceSeconds?: number;
    sectionGraceSeconds?: number; questionGraceSeconds?: number;
    sectionStartOrder?: 'sequential' | 'random' | 'student_choice';
    deliveryMode?: 'standard' | 'linear' | 'adaptive';
  };
  // normalizeSections gives the same question sets grading uses; the raw
  // sections carry timeLimit and breakAfter, which its return type drops —
  // hence reading them off the untyped record rather than the narrowed doc.
  const eff = normalizeSections(doc);
  const rawSections = (raw.sections ?? []) as Array<{
    id: string; timeLimit?: number; breakAfter?: BreakCfg;
  }>;
  const rawById = new Map(rawSections.map((s) => [s.id, s]));
  return {
    startDate: doc.startDate,
    endDate: doc.endDate,
    overallTimeLimit: doc.overallTimeLimit,
    overallGraceSeconds: doc.overallGraceSeconds,
    sectionGraceSeconds: doc.sectionGraceSeconds,
    questionGraceSeconds: doc.questionGraceSeconds,
    sectionStartOrder: doc.sectionStartOrder,
    deliveryMode: doc.deliveryMode,
    sections: eff.map((s) => ({
      id: s.id,
      timeLimit: rawById.get(s.id)?.timeLimit,
      questionTimeLimit: s.questionTimeLimit,
      breakAfter: rawById.get(s.id)?.breakAfter as CoreAssessment['sections'][number]['breakAfter'],
      questionIds: s.questions.map((q) => q.questionId),
    })),
  };
}

/**
 * Map a stored attempt onto the core's plain input shape.
 *
 * THIS MAPPER IS THE RESOLVER'S ENTIRE VIEW OF THE WORLD. A field missing here
 * is not missing in one place — it is invisible in every place at once, because
 * every caller that reasons about timing goes through it: getExamVerdict,
 * submitSection's deadline gate, the expiry sweep, gradeAttempt's trapped-frozen
 * check, and every computeAttemptLocks call site.
 *
 * A-01: `penalties` was absent, and the consequences were exactly that broad.
 * penaltyForClock() reads `a.penalties`, found undefined, and returned 0 — so a
 * deduction an invigilator had recorded, with an actor and an instant, was
 * invisible to the student's own screen and was REFUNDED IN FULL the next time
 * anything recomputed the locks. Ordinary progress undid it: submitSection's
 * advance branch re-derives answersLockedAfter from this shape, so pressing
 * "next section" restored the time somebody had deliberately taken away.
 *
 * It looked correct under test because closeFreezeUpdates is the one site that
 * reattaches penalties by hand (see `penalisedAttempt` there) — so the freeze
 * suite's "penalties reach the write gate" check passed on the instant of
 * unfreeze and nothing exercised the instant after.
 *
 * No invariant caught it either, and that is worth stating: INV-3a forbids the
 * overall bound moving EARLIER without a ledger row behind it. A refund moves it
 * LATER, which is the direction the whole module is built to treat as safe.
 */
function toCoreAttempt(raw: Record<string, unknown>): CoreAttempt {
  const d = raw as Record<string, any>;
  return {
    status: d.status,
    startedAt: d.startedAt,
    sectionIds: Array.isArray(d.sectionIds) ? d.sectionIds : [],
    currentSectionIdx: d.currentSectionIdx,
    sectionTimings: d.sectionTimings ?? {},
    servedQuestions: d.servedQuestions ?? [],
    answers: d.answers ?? {},
    creditedFreezeMs: d.creditedFreezeMs,
    totalFrozenSeconds: d.totalFrozenSeconds,
    freezes: d.freezes,
    // A-01. Kept adjacent to `freezes` on purpose: credit and deduction are the
    // two halves of one ledger, and they must travel together or the arithmetic
    // is one-sided in the student's favour.
    penalties: Array.isArray(d.penalties) ? d.penalties : undefined,
    scores: d.scores,
    gradedAnswers: d.gradedAnswers,
    answersLockedAfter: d.answersLockedAfter,
    sectionLockedAfter: d.sectionLockedAfter,
    overallLockedAfter: d.overallLockedAfter,
    activeSessionId: d.activeSessionId,
  };
}

/**
 * Run the resolver and the invariant checker in shadow, and log anything
 * surprising. Never throws — a telemetry fault must not cost a student their
 * exam, which is the whole reason this phase reports rather than decides.
 */
/**
 * Append a newly served question, locking everything already served.
 * (D-23, master plan Phase 3b.)
 *
 * INV-2: at most one served question is unlocked at any moment.
 *
 * BOTH serve sites — startSection and submitSection — used to do
 * `[...served, {locked: false}]`, leaving the outgoing section's current
 * question unlocked forever. Every linear/adaptive multi-section attempt
 * therefore accumulated one stranded question per boundary. The Phase 3b
 * shadow reported it as INV-2 on every advance of a real sitting.
 *
 * Fixing only submitSection left startSection producing the same state, which
 * is exactly why this is now ONE function rather than two similar blocks: two
 * copies of a rule is how the rule ends up applied in one place and not the
 * other.
 *
 * Benign in itself — a stranded question sits in a closed section and cannot
 * be answered — but it is wrong state, and anything identifying "the live
 * question" by lock status gets a second answer it should never see.
 */
function appendServedQuestion<T extends { locked?: boolean }>(
  served: T[],
  entry: T,
): T[] {
  return [
    ...served.map((sq) => (sq.locked === true ? sq : { ...sq, locked: true })),
    entry,
  ];
}

function auditTiming(
  where: string,
  attemptId: string,
  attemptRaw: Record<string, unknown>,
  assessmentRaw: Record<string, unknown> | undefined,
  /**
   * What the callable decided, as the set of verdicts that would agree with
   * it. A set rather than a string because some inline decisions are
   * genuinely ambiguous: `pauseBeforeNext` is client-supplied and covers BOTH
   * "there is a break here" and "this exam lets you pick the next section", so
   * insisting on one verdict reported a disagreement that was mine, not the
   * resolver's.
   */
  decided: string[],
  /**
   * State the callable is ABOUT to write, applied before resolving.
   *
   * Without this the comparison is unfair and useless. submitSection decides
   * "what happens now this section is submitted", but the attempt it holds in
   * memory still shows that section OPEN — so the resolver answers a different
   * question ("where is the student right now?") and reports a disagreement on
   * every single submit. The first real sitting produced exactly that:
   *     verdict=question decided=break
   * which was my instrumentation being wrong, not the resolver.
   */
  project?: (a: CoreAttempt) => CoreAttempt,
): void {
  if (!assessmentRaw) return;
  try {
    const a0 = toCoreAttempt(attemptRaw);
    const a = project ? project(a0) : a0;
    const asmt = toCoreAssessment(examContractFor(attemptRaw, assessmentRaw) ?? assessmentRaw);
    const verdict = resolveTiming(a, asmt, Date.now());

    if (!decided.includes(verdict.kind)) {
      console.log(`[timing/${where}] verdict=${verdict.kind}` +
        (verdict.kind === 'ended' ? `:${verdict.reason}` : '') +
        ` decided=${decided.join('|')} attempt=${attemptId}`);
    }

    // Invariants are checked against the STORED state, never the projection —
    // the point is to detect what is really in the database.
    const errs = checkTimingInvariants(a0, asmt).filter((v) => v.severity === 'error');
    if (errs.length > 0) {
      console.error(`[timing/${where}] INVARIANT VIOLATION attempt=${attemptId} ` +
        errs.map((e) => `${e.id}(${e.message})`).join('; '));
    }
  } catch (e) {
    console.warn(`[timing/${where}] shadow audit failed`, e);
  }
}

type AttemptLocks = ReturnType<typeof computeAttemptLocks>;

/**
 * Write all three lock fields onto an update payload. (Master plan D-01,
 * Phase 1 — 2026-08-01.)
 *
 * WHY THIS EXISTS AS A HELPER RATHER THAN THREE INLINE LINES
 * The three fields are one fact expressed three ways: `combined` is the
 * minimum of the other two, and firestore.rules gates on `combined` while the
 * client reads the split pair to tell WHICH clock ran out. Writing any of them
 * without the others produces an attempt whose stored lock disagrees with
 * itself — and the failure mode is silent, because the rules keep working
 * against a stale minimum while the client renders a fresh section timer.
 *
 * Every site that changes a lock input therefore calls this, never assigns the
 * fields directly. Doctrine D5: the materialised lock is a CACHE, and every
 * event that changes an input must recompute it.
 */
/**
 * Materialise per-clock freeze credit onto the attempt (D-35).
 *
 * The companion to applyLockUpdates, and called from the same places for the
 * same reason: these are a CACHE of the freeze ledger, and every event that
 * changes the ledger must recompute them (doctrine D5).
 *
 * The client reads these four numbers instead of dividing one flat total
 * across every clock. It performs no credit arithmetic of its own, so it
 * cannot disagree with the write gate about how much time a pause was worth.
 */
function applyCreditUpdates(
  updates: Record<string, unknown>,
  a: CoreAttempt,
  anchors?: Parameters<typeof computeFreezeCredits>[1],
): void {
  updates.freezeCredits = computeFreezeCredits(a, anchors);
}

function applyLockUpdates(
  updates: Record<string, unknown>,
  locks: AttemptLocks,
): void {
  // Null (not undefined, not omitted) when a bound does not exist: the rules
  // read a missing/null lock as "no time constraint", which is what keeps
  // untimed exams working. Omitting the key would leave the PREVIOUS section's
  // value in place, which is the D-01 bug in miniature.
  updates.answersLockedAfter = locks.combined ? Timestamp.fromDate(locks.combined) : null;
  updates.sectionLockedAfter = locks.section ? Timestamp.fromDate(locks.section) : null;
  updates.overallLockedAfter = locks.overall ? Timestamp.fromDate(locks.overall) : null;
}

/**
 * Read a stored lock as epoch millis, whatever shape it arrived in.
 *
 * Locks are written as Firestore Timestamps, but attempts predating the field
 * carry nothing and some legacy paths wrote ISO strings. Callers treat null as
 * "no bound", never as "expired" — a missing deadline is missing information,
 * not permission to close someone's exam.
 */
function lockInstantMs(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  }
  const maybe = raw as { toMillis?: () => number };
  if (typeof maybe?.toMillis === 'function') {
    const ms = maybe.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Has this attempt's answer-write window closed? Null lock = never. */
function attemptWindowClosed(
  attempt: { answersLockedAfter?: unknown },
  nowMs: number = Date.now(),
): boolean {
  const ms = lockInstantMs(attempt.answersLockedAfter);
  return ms !== null && nowMs >= ms;
}

/**
 * Reject a call coming from a browser session that no longer owns this
 * attempt. (INV-5a, master plan Phase 2 / D-08.)
 *
 * WHAT THIS DOES AND DOES NOT CLOSE — read before relying on it.
 *
 * `activeSessionId` existed only as a writable field on the student rules
 * whitelist. No rule and no callable ever compared it, so two browsers signed
 * in as the same student could both drive one attempt indefinitely; the
 * conflict overlay was client-side decoration.
 *
 * Enforcing it HERE makes every state transition single-session: a superseded
 * device cannot start a section, submit one, advance a question, or finalise.
 * In linear/adaptive that is complete, because answers only ever move through
 * submitAnswerAndAdvance.
 *
 * In STANDARD delivery answers are written directly by the client under
 * firestore.rules, and rules cannot enforce this — a second device can read
 * the attempt (students may read their own) and echo back whatever
 * `activeSessionId` it finds, so any rules-level check is trivially defeated.
 * The residual gap is therefore "a superseded device can keep autosaving
 * answers but can never advance or submit". Closing it fully needs answers to
 * move through a callable in standard mode too, which is a Phase 3 decision.
 *
 * A caller that supplies NO sessionId is allowed through: during the rollout
 * a cached client predates the field, and locking those students out of their
 * own exam would be a far worse failure than the hole this closes. Flip
 * REQUIRE_SESSION_ID once no such client remains.
 */
const REQUIRE_SESSION_ID = false;

function assertSession(
  attempt: { activeSessionId?: string | null },
  supplied: string | undefined,
  where: string,
): void {
  const active = attempt.activeSessionId;
  if (!active) return;                       // nobody has claimed it yet
  if (!supplied) {
    if (REQUIRE_SESSION_ID) {
      throw new HttpsError('failed-precondition',
        'SESSION_REQUIRED: reload the exam to continue.');
    }
    console.warn(`[${where}] legacy client sent no sessionId`);
    return;
  }
  if (supplied !== active) {
    throw new HttpsError(
      'failed-precondition',
      'SESSION_SUPERSEDED: this exam was opened on another device.',
    );
  }
}

/**
 * Refuse an exam action by a student blocked from this assessment.
 * (D-21, master plan Phase 2.)
 *
 * `blockedStudents` was re-checked in getExamQuestions and startExam only, so
 * blocking someone mid-sitting stopped a reload but not the sitting: they
 * carried on answering, advancing and submitting normally. "Block" therefore
 * meant two different things depending on whether the target happened to
 * refresh.
 *
 * OPEN DECISION (plan item N5): this makes a block stop every TRANSITION —
 * the student cannot advance a section, submit one, or advance a question —
 * but it deliberately does NOT finalise their attempt. Ending someone's exam
 * from an invigilator's click is a policy choice, not a bug fix, and it is
 * still awaiting a decision. Until then the honest behaviour is a distinct,
 * surfaceable error rather than a silent refusal (doctrine D7).
 *
 * Takes the already-loaded assessment data — every caller has it in hand, so
 * this costs no extra read.
 */
function assertNotBlocked(
  assessment: { blockedStudents?: string[] } | undefined,
  studentId: string,
): void {
  if ((assessment?.blockedStudents ?? []).includes(studentId)) {
    throw new HttpsError(
      'permission-denied',
      'BLOCKED_FROM_EXAM: an invigilator has blocked you from this exam.',
    );
  }
}

export const startSection = onCall<StartSectionData>(
  EXAM_HOT_PATH,
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
      // Wall-clock start of the whole sitting — the overall-clock anchor, and
      // one of the two bounds computeAttemptLocks needs.
      startedAt?: string;
      // Phase 2.5 — needed to serve the section's first question in linear mode
      questionOrder?: Record<string, string[]>;
      servedQuestions?: Array<{
        questionId: string; sectionId: string; difficulty: string;
        servedAt: string; locked: boolean;
      }>;
      securityConfig?: { deliveryMode?: string; requireSEB?: boolean } | null;
      activeSessionId?: string | null;
    };
    if (attempt.studentId !== studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    assertSession(attempt, request.data?.sessionId, 'startSection');
    assertSEB(request.data?.sebToken, request.auth.uid, attempt.securityConfig?.requireSEB, attempt.assessmentId);
    if (attempt.status !== 'in_progress') {
      throw new HttpsError('failed-precondition', 'Attempt is not in progress.');
    }
    if (attempt.sectionTimings[sectionId]?.startedAt) {
      throw new HttpsError('failed-precondition', 'Section already started.');
    }

    // ── INV-1: exactly one section open at a time (D-22, Phase 2) ──
    //
    // This callable only ever checked whether the TARGET section had been
    // started. It never checked whether the section the student is CURRENTLY
    // in has been closed, so starting C while B was still open left two
    // sections with a startedAt and no submittedAt — two clocks running, and
    // in linear/adaptive a second UNLOCKED served question that
    // submitAnswerAndAdvance can never reach (it resolves the current question
    // positionally, as served[served.length - 1]), so that question became
    // silently unanswerable.
    //
    // It was also a mandatory-break bypass. The break gate below reads
    // `prevTiming?.submittedAt`, so a section that is simply never submitted
    // makes the gate evaluate to nothing at all. Enforcing INV-1 closes that
    // route at its source rather than patching the gate.
    const openSectionId = Object.entries(attempt.sectionTimings ?? {})
      .find(([, t]) => t?.startedAt && !t?.submittedAt)?.[0];
    if (openSectionId && openSectionId !== sectionId) {
      throw new HttpsError(
        'failed-precondition',
        'SECTION_STILL_OPEN: finish the section you are in before starting another.',
      );
    }

    // Validate reorder (student_choice) is a permutation of the frozen ids.
    let sectionIds = attempt.sectionIds;
    if (reorderedSectionIds) {
      const same = reorderedSectionIds.length === sectionIds.length
        && [...reorderedSectionIds].sort().join('|') === [...sectionIds].sort().join('|');
      if (!same) throw new HttpsError('invalid-argument', 'Invalid section reorder.');

      // ── Played sections are pinned (D-22, second route) ─────────
      // A permutation check alone let a caller move an UNPLAYED section to
      // index 0. The break gate below is guarded on `idx > 0`, so landing at
      // index 0 skipped it entirely — a mandatory break bypass that survived
      // the INV-1 check above, because no section was open at the time.
      //
      // Sections that have already been started keep their index; only
      // unplayed ones may move. That is exactly what "choose your next
      // section" means, and it makes the play position of any new section
      // necessarily greater than the number already played.
      for (let i = 0; i < sectionIds.length; i++) {
        const played = attempt.sectionTimings[sectionIds[i]]?.startedAt;
        if (played && reorderedSectionIds[i] !== sectionIds[i]) {
          throw new HttpsError(
            'invalid-argument',
            'Invalid section reorder: completed sections cannot be moved.',
          );
        }
      }
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
        // A-06: break schedule comes from the frozen contract too — a break
        // added or removed mid-sitting must not reach a student already in it.
        const a = examContractFor(
          attempt as unknown as Record<string, unknown>, aSnap.data(),
        ) as { sections?: Array<{ id: string; breakAfter?: BreakCfg }> } | undefined;
        const brk = breakAfterCompletion(a?.sections, attempt.sectionIds, idx);
        if (brk && brk.mandatory) {
          // ── A break is a clock, and it is credited too (F6 / D-29) ──
          //
          // This was `submittedAt + durationMinutes`, full stop. D-29 added a
          // credit term to the break deadline in the RESOLVER and this gate —
          // the other place that decides when a break ends — was never
          // updated. Freeze a student for six minutes during a ten-minute
          // mandatory break and getExamVerdict held them until +16 while this
          // let them in at +10: the screen said "on a break" and the server
          // said "come in".
          //
          // creditForAnchor on the submit instant, which is when the break
          // began, so only pauses that started after it count — the same
          // per-clock rule every other deadline uses.
          const anchorIso = prevTiming.submittedAt;
          const breakEndsAt = new Date(anchorIso).getTime()
            + brk.durationMinutes * 60_000
            + creditForAnchor(toCoreAttempt(attempt as unknown as Record<string, unknown>), anchorIso);
          if (Date.now() < breakEndsAt) {
            throw new HttpsError('failed-precondition', 'Mandatory break has not ended yet.');
          }
        }
      }
    }

    const nowIso = new Date().toISOString();

    // Recompute the answer-write lock for the section being entered (audit
    // 2026-07-28). Read here rather than reusing the conditional read above,
    // which only happens on the mandatory-break path and fetches a narrower
    // shape. One extra document read per section start is a fair price for the
    // rule that stops a student answering after their time is gone.
    const lockSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    // A-06: timing comes from the contract this attempt is sitting under, so a
    // live edit to timeLimit / overallTimeLimit / grace cannot move the
    // deadline of a student already inside the exam. blockedStudents is
    // deliberately live — a block is an invigilation decision taken NOW, and
    // the snapshot does not carry it, so it arrives through the merge.
    const lockA = (examContractFor(
      attempt as unknown as Record<string, unknown>, lockSnap.data(),
    ) ?? {}) as {
      sections?: Array<{ id: string; timeLimit?: number }>;
      sectionGraceSeconds?: number;
      overallTimeLimit?: number;
      overallGraceSeconds?: number;
      blockedStudents?: string[];
    };
    // D-21: reuses the read this line already performs — no extra cost.
    assertNotBlocked(lockA, studentId);
    // Phase 3b shadow — the resolver's view of a section that is starting.
    auditTiming('startSection', attemptId,
      attempt as unknown as Record<string, unknown>, lockSnap.data(),
      // 'break' belongs here: startSection is exactly how a student LEAVES a
      // break, and the gate above only blocks MANDATORY ones — so skipping an
      // optional break is legal, and the resolver reporting "on a break" at
      // that instant is correct rather than a disagreement.
      ['section', 'question', 'break']);

    const locks = computeAttemptLocks(
      attempt.startedAt,
      nowIso,
      lockA.sections?.find((s) => s.id === sectionId)?.timeLimit,
      lockA,
      toCoreAttempt(attempt as unknown as Record<string, unknown>),
    );

    const updates: Record<string, unknown> = {
      currentSectionIdx: idx,
      [`sectionTimings.${sectionId}.startedAt`]: nowIso,
      [`sectionTimings.${sectionId}.timeUsedSeconds`]: 0,
      // Null when the exam has no timed bound at all — the rule treats a
      // missing/null lock as "no time constraint", which is also what keeps
      // untimed exams working.
      // D-35: credit for the section being entered — 0 by arithmetic, since no
      // freeze can have begun after an anchor of `now`.
      freezeCredits: computeFreezeCredits(
        toCoreAttempt(attempt as unknown as Record<string, unknown>),
        { sectionStartedAt: nowIso, questionServedAt: nowIso, breakAnchor: nowIso },
      ),
      answersLockedAfter: locks.combined ? Timestamp.fromDate(locks.combined) : null,
      // Split bounds (Phase 0). Recomputed on every section entry: the section
      // bound moves with the new section, the overall bound does not move at
      // all, but writing both together keeps the three fields consistent by
      // construction rather than by remembering to update them separately.
      sectionLockedAfter: locks.section ? Timestamp.fromDate(locks.section) : null,
      overallLockedAfter: locks.overall ? Timestamp.fromDate(locks.overall) : null,
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
            // D-23: same rule as submitSection. Fixing one and not the other
            // is what left INV-2 still firing after the first attempt at this.
            updates.servedQuestions = appendServedQuestion(served, {
              questionId: firstQid,
              sectionId,
              difficulty: (qData.difficulty as string) ?? 'medium',
              servedAt: nowIso,
              locked: false,
            });
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
  /** Phase 2 — the browser session driving this sitting (INV-5a). */
  sessionId?: string;
  sectionId: string;
  nextSectionId?: string | null;
  /**
   * IGNORED as of A-02. Still ACCEPTED so a cached client keeps working and a
   * rollback is clean, but nothing reads it: the play index is derived from
   * `sectionIds.indexOf(nextSectionId)` server-side. A caller-supplied index
   * was written straight to `currentSectionIdx`, which is state nobody
   * authored. Remove the field once no client sends it.
   */
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
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role = request.auth.token.role as string | undefined;
    const studentId = request.auth.token.studentId as string | undefined;
    if (role !== 'student' || !studentId) {
      throw new HttpsError('permission-denied', 'Only students may submit a section.');
    }
    // nextSectionIdx is deliberately NOT destructured — see the interface.
    const { attemptId, sectionId, nextSectionId, pauseBeforeNext } =
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
      activeSessionId?: string | null;
    };
    if (attempt.studentId !== studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    assertSession(attempt, request.data?.sessionId, 'submitSection');
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
    // A-06: one contract, used by the break schedule, both deadline gates and
    // every lock recompute below. blockedStudents rides in live through the
    // merge — see examContractFor.
    const contractRaw = examContractFor(
      attempt as unknown as Record<string, unknown>, aSnap.data(),
    ) as Record<string, unknown>;
    const a = contractRaw as {
      sectionGraceSeconds?: number;
      overallTimeLimit?: number;
      overallGraceSeconds?: number;
      sections?: Array<{ id: string; timeLimit?: number; breakAfter?: BreakCfg }>;
      blockedStudents?: string[];
    };
    // D-21: a block must stop the sitting advancing, not only a reload.
    assertNotBlocked(a, studentId);

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

    // ── Which section, if any, this call may advance INTO (A-02) ─────
    //
    // `nextSectionId` and `nextSectionIdx` arrive from request.data and were
    // used verbatim: written as a dot-path key onto sectionTimings, assigned
    // straight to currentSectionIdx, and — the part that mattered — used to
    // re-anchor answersLockedAfter, which is the field firestore.rules gates
    // every answer write on.
    //
    // Naming the section being submitted was therefore a TIME EXPLOIT. The one
    // update both closed SA and re-opened it, and the lock was recomputed as
    // `now + SA's full time limit`. Measured at +30:30 → +56:00 on a single
    // call, repeatable, and unbounded on the very ordinary configuration of
    // per-section limits with no overall cap. It also rewrote the section's own
    // startedAt, which is INV-9 ("a section's start instant never moves").
    //
    // Everything below is a rule startSection has always enforced (:7941 for
    // "already started", :7960 for INV-1). This branch is the same transition
    // and simply never acquired them.
    //
    // ONE CASE IS NOT AN ATTACK AND MUST NOT THROW: a retry after a lost
    // response. The client re-sends the same submit, the next section is by
    // then legitimately started, and the desired end state is exactly what is
    // already stored. That is an idempotent no-op — the advance WRITES are
    // skipped, so nothing is re-anchored, and the call still succeeds and still
    // returns the served question. Turning a dropped response into a hard error
    // would strand a student for a network blip.
    const requestedNext = typeof nextSectionId === 'string' && nextSectionId
      ? nextSectionId : null;
    const playedIds = Array.isArray(attempt.sectionIds) ? attempt.sectionIds : [];
    let advanceTo: string | null = null;
    let advanceIdx = -1;
    let advanceAlreadyStarted = false;
    if (requestedNext) {
      if (requestedNext === sectionId) {
        throw new HttpsError('invalid-argument',
          'SECTION_ADVANCE_INVALID: a section cannot advance into itself.');
      }
      advanceIdx = playedIds.indexOf(requestedNext);
      if (advanceIdx < 0) {
        throw new HttpsError('invalid-argument',
          'SECTION_ADVANCE_INVALID: that section is not part of this attempt.');
      }
      if (attempt.sectionTimings?.[requestedNext]?.submittedAt) {
        throw new HttpsError('invalid-argument',
          'SECTION_ADVANCE_INVALID: that section is already finished.');
      }
      advanceAlreadyStarted = !!attempt.sectionTimings?.[requestedNext]?.startedAt;
      advanceTo = requestedNext;
    }
    // currentSectionIdx is DERIVED, never taken from the caller. It is only a
    // convenience mirror of the play order — the timings are the record — but a
    // caller-set index is still state nobody authored.
    const advanceIdxSafe = advanceIdx;

    const startedMs = new Date(timing.startedAt).getTime();
    const serverNow = Date.now();
    const timeUsedSeconds = Math.max(0, Math.floor((serverNow - startedMs) / 1000));

    // ── The deadlines this call is judged against (F1) ───────────────
    //
    // These two gates used to build their own deadlines inline:
    //
    //   startedMs + sec.timeLimit * 60_000 + graceSec * 1000
    //   examStartMs + a.overallTimeLimit * 60_000 + overallGraceSec * 1000
    //
    // No freeze credit, no penalty, and compared against Date.now() rather
    // than effectiveNowMs. The note that used to sit above the overall check
    // said so in as many words — "the server ignores freeze here; credited
    // only in the client display" — which was the posture BEFORE Phase 4.3
    // credited the write gate, and it stayed here after every other path moved.
    //
    // The result was that a grant could not be spent. answersLockedAfter moved
    // out, getExamVerdict said 'section', the student's screen showed the time
    // restored — and this function threw SECTION_DEADLINE_EXCEEDED and clamped
    // submittedAt back to the pre-freeze instant. The clamp then re-anchored
    // the following break, so the damage outlived the section.
    //
    // One source now. computeDeadlines applies credit per clock (D-28) and
    // subtracts recorded penalties (A4); effectiveNowMs holds time still while
    // a freeze is open (4.3). This gate and the resolver cannot disagree,
    // because they are the same function.
    const gateCore = toCoreAttempt(attempt as unknown as Record<string, unknown>);
    const gateAsmt = toCoreAssessment(contractRaw);
    const gateDl = computeDeadlines(gateCore, gateAsmt);
    const evalNow = effectiveNowMs(gateCore, serverNow);

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
    // Freeze posture: credited and paused, exactly like every other clock —
    // see the note on gateDl above.
    if (gateDl.overallEndsAt !== null) {
      const overallDeadlineMs = gateDl.overallEndsAt;
      if (evalNow > overallDeadlineMs) {
        // Close the current section at its true submit time (clamped to the
        // section's own deadline if that is earlier), never advancing.
        let sectionCloseMs = serverNow;
        if (gateDl.sectionEndsAt !== null) {
          sectionCloseMs = Math.min(serverNow, gateDl.sectionEndsAt);
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

    if (gateDl.sectionEndsAt !== null) {
      const deadlineMs = gateDl.sectionEndsAt;
      if (evalNow > deadlineMs) {
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
        if (advanceTo && !advanceAlreadyStarted && !pauseBeforeNext && !mandatoryBreakDue) {
          const lateNextStartIso = new Date().toISOString();
          lateUpdates.currentSectionIdx = advanceIdxSafe;
          lateUpdates[`sectionTimings.${advanceTo}.startedAt`] = lateNextStartIso;
          lateUpdates[`sectionTimings.${advanceTo}.timeUsedSeconds`] = 0;
          // D-01: recompute the write lock for the section being ENTERED.
          // Same reasoning as the on-time branch below — see the note there.
          const lateCore = toCoreAttempt(attempt as unknown as Record<string, unknown>);
          applyLockUpdates(lateUpdates, computeAttemptLocks(
            attempt.startedAt,
            lateNextStartIso,
            a.sections?.find((s) => s.id === advanceTo)?.timeLimit,
            a,
            lateCore,
          ));
          // D-35: anchors for the section being ENTERED, so its credit is 0
          // rather than the departing section's.
          applyCreditUpdates(lateUpdates, lateCore, {
            sectionStartedAt: lateNextStartIso,
            questionServedAt: lateNextStartIso,
            breakAnchor: lateNextStartIso,
          });
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
    // Phase 3b shadow — what would the resolver have said about the state as
    // it stands the instant before this write? Reported, never acted on.
    auditTiming('submitSection', attemptId,
      attempt as unknown as Record<string, unknown>, aSnap.data(),
      !advanceTo ? ['ended']
        : mandatoryBreakDue ? ['break']
        // pauseBeforeNext is the client saying "stop here" — which it does for
        // a break OR for student-choice. Either verdict agrees.
        : pauseBeforeNext ? ['break', 'choose']
        : ['section', 'question'],
      // Apply the submit this call is about to make, so the resolver is asked
      // the same question the callable just answered.
      (core) => ({
        ...core,
        sectionTimings: {
          ...core.sectionTimings,
          [sectionId]: { ...core.sectionTimings?.[sectionId], submittedAt: nowIso },
        },
      }));

    if (advanceTo && !pauseBeforeNext && !mandatoryBreakDue) {
      // A-02: skipped on a retry whose advance already landed, so a lost
      // response cannot re-anchor a lock or move a section's start instant.
      if (!advanceAlreadyStarted) {
        updates.currentSectionIdx = advanceIdxSafe;
        updates[`sectionTimings.${advanceTo}.startedAt`] = nowIso;
        updates[`sectionTimings.${advanceTo}.timeUsedSeconds`] = 0;
      }

      // ── Recompute the answer-write lock (D-01, master plan Phase 1) ──
      //
      // THIS IS THE FIX FOR THE WORST BUG IN THE MODULE. Read this before
      // touching the branch.
      //
      // Only startExam and startSection used to write the lock fields. This
      // branch advances the student into the next section WITHOUT going
      // through startSection — `pauseBeforeNext` is false for sequential and
      // random order with no break, which is the ordinary case — so the
      // attempt carried the PREVIOUS section's deadline for the rest of the
      // sitting. Once that instant passed, firestore.rules
      // (answerWriteWindowOpen) denied every answer write, and the client
      // swallowed the denial: the 1.5s autosave catches to console, and the
      // final flush treats permission-denied as "the deadline doing its job".
      // Students lost everything they typed from section 2 onward, silently.
      //
      // The client cannot repair this by calling startSection afterwards —
      // that callable throws 'Section already started' against the startedAt
      // written three lines above.
      //
      // Anchored on nowIso (the instant this section actually begins), NOT on
      // the previous section's start, and the section limit is read from the
      // ASSESSMENT DOC via `a`, never from the caller's payload.
      //
      // Note the lock legitimately moves EARLIER here when a long section is
      // followed by a short one (60m section submitted at minute 2, next
      // section 10m -> lock goes 60:30 to 12:30). That is correct: the
      // combined lock is a minimum over a CHANGING active section, so it has
      // no monotonicity property. Only the per-section and overall bounds do.
      const advCore = toCoreAttempt(attempt as unknown as Record<string, unknown>);
      applyLockUpdates(updates, computeAttemptLocks(
        attempt.startedAt,
        nowIso,
        a.sections?.find((s) => s.id === advanceTo)?.timeLimit,
        a,
        advCore,
      ));
      applyCreditUpdates(updates, advCore, {
        sectionStartedAt: nowIso,
        questionServedAt: nowIso,
        breakAnchor: nowIso,
      });

      // ── Serve the next section's first question (Phase 2.5) ──────
      // This is the no-break advance path: the client goes straight from one
      // section to the next without startSection, so the question must be
      // served (and its CONTENT returned) here — the client has no other way
      // to obtain it, since getExamQuestions is scoped to servedQuestions.
      const dMode = attempt.securityConfig?.deliveryMode ?? 'standard';
      if (dMode === 'linear' || dMode === 'adaptive') {
        const served = attempt.servedQuestions ?? [];
        const existingHere = served.find((s) => s.sectionId === advanceTo);
        const firstQid = existingHere?.questionId ?? attempt.questionOrder?.[advanceTo]?.[0];
        if (firstQid) {
          const qSnap = await db.collection('questions').doc(firstQid).get();
          if (qSnap.exists) {
            const qData = qSnap.data() as Record<string, unknown>;
            nextQuestion = sanitizeQuestionForStudent(qData, false);
            if (!existingHere) {
              // ── D-23 (Phase 3b): lock what we are leaving behind ──────
              //
              // This appended the next section's question WITHOUT locking the
              // outgoing section's current one, so every linear/adaptive
              // multi-section attempt ended up with a permanently unlocked
              // question from a section the student had already left — and a
              // fresh one appended at each boundary, so the count grew.
              //
              // Found by the Phase 3b shadow, which reported INV-2 ("2
              // unlocked served questions") on every advance of a real
              // sitting, always pairing the same stranded question with a
              // rotating current one.
              //
              // Benign today: the stranded question sits in a closed section
              // and submitAnswerAndAdvance resolves the current one
              // positionally, so nothing misbehaves. It is still wrong state,
              // and anything that reasons about "which question is live" by
              // lock status — the resolver included — gets a second answer it
              // should never see. Closing it here rather than teaching every
              // reader to tolerate it.
              updates.servedQuestions = appendServedQuestion(served, {
                questionId: firstQid,
                sectionId: advanceTo,
                difficulty: (qData.difficulty as string) ?? 'medium',
                servedAt: nowIso,
                locked: false,
              });
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

/**
 * Build the two documents one question becomes, without writing them.
 *
 * Extracted from execCreateQuestion (audit S-02) so the single-create path and
 * the bulk path produce byte-identical documents. They differ ONLY in how the
 * writes are committed — one batch per question versus one batch per chunk —
 * and that difference must never leak into the document shape. Same reasoning
 * as the Phase 3A exec* extraction: if two paths write the same entity, they
 * share the code that decides what the entity looks like.
 *
 * `seq` disambiguates ids inside a single chunk. The id carries Date.now(),
 * which is identical across a tight server-side loop, so the random suffix
 * would be the only thing keeping two questions apart. That is fine in
 * isolation and needlessly fragile at 200 per call — the sequence number makes
 * a collision structurally impossible rather than merely unlikely. Omitting it
 * reproduces the original format exactly, so the single path is unchanged.
 */
function buildQuestionDocs(
  owner: QOwner,
  src: Record<string, unknown>,
  seq?: number,
): { id: string; publicDoc: Record<string, unknown>; answerDoc: Record<string, unknown> } {
  const suffix = seq === undefined ? '' : `_${seq}`;
  const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 9)}${suffix}`;
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
  return { id, publicDoc, answerDoc };
}

async function execCreateQuestion(
  db: FirebaseFirestore.Firestore,
  owner: QOwner,
  src: Record<string, unknown>,
  taxonomy: { subjectId?: string | null; topicId?: string | null },
): Promise<{ id: string }> {
  const { id, publicDoc, answerDoc } = buildQuestionDocs(owner, src);
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

/**
 * Bulk-create questions as institute/faculty — gated by the create right,
 * checked ONCE for the whole chunk.
 *
 * Audit S-02. Bulk upload previously wrote straight to Firestore in a
 * client-side loop, which meant it bypassed the rights model entirely: a
 * faculty member with no create grant could not add a single question through
 * the UI but could import a thousand through the same page. Routing it through
 * createQuestionAsRole one row at a time would have closed that, but at the
 * cost of one HTTPS round-trip per question — roughly 2-4 minutes for a
 * 500-row file against about 40 seconds for the direct writes it replaced.
 * A security fix that makes a routine task four times slower does not survive
 * contact with the people using it.
 *
 * So the chunk is the unit of work. 500 rows becomes three calls instead of
 * five hundred, and the per-question work happens next to Firestore rather
 * than across the wire — which lands it FASTER than the direct path it
 * replaces, not slower.
 *
 * Sizing, and why 200:
 *   • each question writes TWO documents, so 200 items is 400 writes and stays
 *     under Firestore's hard 500-per-batch ceiling with headroom
 *   • the rights check runs once per call rather than once per row
 *   • counter bumps are AGGREGATED per chunk — a naive loop would issue two
 *     increments per question (400 extra round-trips) to reach the same totals
 *
 * The cap is enforced here as well as in the client. A client-side limit is a
 * usability affordance; this one is the actual constraint, since the endpoint
 * can be called directly.
 */
const BULK_CREATE_MAX_PER_CALL = 200;

interface BulkQuestionItem {
  question: Record<string, unknown>;
  subjectId?: string | null;
  topicId?: string | null;
}

export const createQuestionsBulkAsRole = onCall<{ items?: BulkQuestionItem[] }>(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    const facultyId   = request.auth.token.facultyId   as string | undefined;

    // One check for the chunk. Identical gate to createQuestionAsRole — same
    // ceiling, same per-faculty grant, same direct-mode requirement — so bulk
    // can never be a softer door than single-create. That asymmetry was the
    // bug.
    const owner = await assertQuestionRight(db, role, instituteId, facultyId, 'create');

    const items = request.data?.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw new HttpsError('invalid-argument', 'items must be a non-empty array.');
    }
    if (items.length > BULK_CREATE_MAX_PER_CALL) {
      throw new HttpsError(
        'invalid-argument',
        `At most ${BULK_CREATE_MAX_PER_CALL} questions per call; send in chunks.`,
      );
    }

    // Per-item validation SKIPS rather than throws, deliberately. The client
    // loop this replaces caught per row and incremented a "skipped" counter,
    // so one unusable row never cost the other 499. Throwing here would have
    // quietly converted a partial import into a total failure — the kind of
    // regression that hides behind a green test run because the happy path is
    // identical. Skipped indexes come back so the caller's count stays true.
    const batch = db.batch();
    const ids: string[] = [];
    const skipped: number[] = [];
    const subjectDeltas = new Map<string, number>();
    const topicDeltas   = new Map<string, number>();

    items.forEach((it, i) => {
      if (!it || typeof it !== 'object' || !it.question || typeof it.question !== 'object') {
        skipped.push(i);
        return;
      }
      const { id, publicDoc, answerDoc } = buildQuestionDocs(owner, it.question, i);
      batch.set(db.collection('questions').doc(id), publicDoc);
      batch.set(db.collection('questionAnswers').doc(id), answerDoc);
      ids.push(id);
      if (it.subjectId) subjectDeltas.set(String(it.subjectId), (subjectDeltas.get(String(it.subjectId)) ?? 0) + 1);
      if (it.topicId)   topicDeltas.set(String(it.topicId),     (topicDeltas.get(String(it.topicId))     ?? 0) + 1);
    });

    if (ids.length > 0) await batch.commit();

    // After the commit, and best-effort — matching execCreateQuestion, where a
    // counter failure warns rather than throws. The questions exist at this
    // point; a drifted count is a cosmetic problem that refreshAllSubjectCounts
    // repairs, whereas throwing here would report failure for an import that
    // actually succeeded and invite a duplicate re-run.
    try {
      const bumps: Promise<unknown>[] = [];
      for (const [subjectId, delta] of subjectDeltas) {
        bumps.push(db.collection('subjects').doc(subjectId).update({ questionCount: FieldValue.increment(delta) }));
      }
      for (const [topicId, delta] of topicDeltas) {
        bumps.push(db.collection('topics').doc(topicId).update({ questionCount: FieldValue.increment(delta) }));
      }
      await Promise.all(bumps);
    } catch (e) {
      console.warn('[createQuestionsBulkAsRole] counter bump skipped', e);
    }

    return { ok: true, ids, skipped };
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