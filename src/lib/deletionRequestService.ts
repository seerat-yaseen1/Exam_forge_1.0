// ── Deletion requests service (Feature #15, Phase 4) ──────────────
// Client half of the two-hop approval workflow:
//
//   faculty  (mode 'request')     → institute admin approves
//   institute(selfMode 'request') → Web Owner approves
//
// Both mutations go through callables — the server verifies the requester
// holds the right in request mode, re-checks the APPROVER's rights at
// execution time, and EXECUTES the approved deletion itself. Reads are plain
// Firestore queries scoped by the deletionRequests rules block.
//
// Deliberately mirrors questionRequestService.ts, including its choice to
// sort client-side rather than add composite indexes for what are small,
// tenant-scoped result sets.

import { httpsCallable } from 'firebase/functions';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db, functions } from './firebase';

export type DeletionRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type DeletionRequestEntity = 'student' | 'faculty';

export type DeletionRequest = {
  id: string;
  status: DeletionRequestStatus;
  entityType: DeletionRequestEntity;
  entityId: string;
  /** Captured at submission — stays legible if the target is renamed or gone. */
  entityLabel: string | null;
  requesterUid: string;
  requesterRole: 'faculty' | 'institute';
  requesterName: string | null;
  approverRole: 'institute' | 'webOwner';
  instituteId: string;
  reason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
};

const COL = 'deletionRequests';

/**
 * The error code deleteAuthUser throws when the caller holds the right but
 * only in request mode. Callers should catch it and offer to submit a request
 * instead of surfacing a raw error.
 */
export const REQUIRES_APPROVAL = 'DELETION_REQUIRES_APPROVAL';

/** Does this error mean "you must request this instead"? */
export function isRequiresApproval(err: unknown): boolean {
  const m = (err as { message?: string })?.message ?? '';
  return m.includes(REQUIRES_APPROVAL);
}

// ── Mutations ─────────────────────────────────────────────────────

export async function submitDeletionRequest(
  entityType: DeletionRequestEntity,
  entityId: string,
  reason?: string,
): Promise<{ id: string }> {
  const call = httpsCallable<
    { entityType: DeletionRequestEntity; entityId: string; reason?: string },
    { ok: true; id: string }
  >(functions, 'submitDeletionRequest');
  const res = await call({ entityType, entityId, reason });
  return { id: res.data.id };
}

export async function resolveDeletionRequest(
  requestId: string,
  decision: 'approve' | 'reject',
  reviewNote?: string,
): Promise<{ status: 'approved' | 'rejected' }> {
  const call = httpsCallable<
    { requestId: string; decision: 'approve' | 'reject'; reviewNote?: string },
    { ok: true; status: 'approved' | 'rejected' }
  >(functions, 'resolveDeletionRequest');
  const res = await call({ requestId, decision, reviewNote });
  return { status: res.data.status };
}

// ── Reads ─────────────────────────────────────────────────────────

function sortNewestFirst(list: DeletionRequest[]): DeletionRequest[] {
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Every request in a tenant — the institute admin's inbox.
 *
 * Shows both sides of their position in the chain: requests their faculty
 * raised TO them, and requests they raised UPWARD to the Web Owner. Splitting
 * those into two screens would hide half the state from the person who needs
 * to act on it.
 */
export async function getDeletionRequestsForInstitute(
  instituteId: string,
  status?: DeletionRequestStatus,
): Promise<DeletionRequest[]> {
  const constraints = [where('instituteId', '==', instituteId)];
  if (status) constraints.push(where('status', '==', status));
  const snap = await getDocs(query(collection(db, COL), ...constraints));
  return sortNewestFirst(snap.docs.map((d) => d.data() as DeletionRequest));
}

/** A faculty member's own requests. */
export async function getMyDeletionRequests(uid: string): Promise<DeletionRequest[]> {
  const snap = await getDocs(query(collection(db, COL), where('requesterUid', '==', uid)));
  return sortNewestFirst(snap.docs.map((d) => d.data() as DeletionRequest));
}

/** Everything awaiting the Web Owner — institute-raised requests. */
export async function getDeletionRequestsForWebOwner(
  status: DeletionRequestStatus = 'pending',
): Promise<DeletionRequest[]> {
  const snap = await getDocs(query(
    collection(db, COL),
    where('approverRole', '==', 'webOwner'),
    where('status', '==', status),
  ));
  return sortNewestFirst(snap.docs.map((d) => d.data() as DeletionRequest));
}

/** Pending count for an inbox badge. */
export async function getPendingDeletionRequestCount(instituteId: string): Promise<number> {
  const snap = await getDocs(query(
    collection(db, COL),
    where('instituteId', '==', instituteId),
    where('status', '==', 'pending'),
  ));
  return snap.size;
}

// ── Labels ────────────────────────────────────────────────────────

export function requestStatusLabel(s: DeletionRequestStatus): string {
  switch (s) {
    case 'pending':   return 'Pending';
    case 'approved':  return 'Approved';
    case 'rejected':  return 'Rejected';
    case 'cancelled': return 'Cancelled';
    default:          return s;
  }
}

export function entityTypeLabel(e: DeletionRequestEntity): string {
  return e === 'student' ? 'Student' : 'Faculty';
}