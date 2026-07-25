// ── Lifecycle service (Feature #15, Phase 6a) ─────────────────────
// Restore and permanent-delete callables, plus the queries behind the trash
// views.
//
// WHY DELETION NO LONGER DESTROYS
// deleteAuthUser now soft-deletes: the Auth user is disabled and the profile
// enters `lifecycleState: 'softDeleted'` with a `purgeAfter` stamp. Nothing
// is removed until purgeEntity runs — by the Web Owner, or by the scheduled
// job once the window expires. Closes bug (b): every account removal used to
// be immediate and irreversible.

import { httpsCallable } from 'firebase/functions';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db, functions } from './firebase';
import type { LifecycleState } from './lifecycle';

export type LifecycleRole = 'institute' | 'faculty' | 'student';

const COLLECTION_BY_ROLE: Record<LifecycleRole, string> = {
  institute: 'institutes',
  faculty: 'faculty',
  student: 'students',
};

export type TrashedRecord = {
  id: string;
  role: LifecycleRole;
  name: string | null;
  email: string | null;
  instituteId: string | null;
  lifecycleState: LifecycleState;
  deletedAt: string | null;
  deletedByRole: string | null;
  purgeAfter: string | null;
};

// ── Mutations ─────────────────────────────────────────────────────

export async function restoreEntity(
  role: LifecycleRole,
  uid: string,
  reason?: string,
): Promise<void> {
  const call = httpsCallable<
    { role: LifecycleRole; uid: string; reason?: string },
    { ok: true }
  >(functions, 'restoreEntity');
  await call({ role, uid, reason });
}

/**
 * Destroy a soft-deleted record for good. Web Owner only, and only reachable
 * from the soft-deleted state — the server refuses to purge a live record.
 */
export async function purgeEntity(
  role: LifecycleRole,
  uid: string,
  opts: {
    deleteAttemptsOnWebOwnerAssessments?: string[];
    successorId?: string;
    reason?: string;
  } = {},
): Promise<{ counts: Record<string, number> | null }> {
  const call = httpsCallable<
    { role: LifecycleRole; uid: string } & typeof opts,
    { ok: true; counts: Record<string, number> | null }
  >(functions, 'purgeEntity');
  const res = await call({ role, uid, ...opts });
  return { counts: res.data.counts ?? null };
}

// ── Reads ─────────────────────────────────────────────────────────

function mapRecord(role: LifecycleRole, id: string, d: Record<string, unknown>): TrashedRecord {
  return {
    id,
    role,
    name: (d.name as string) ?? null,
    email: (d.email as string) ?? (d.adminEmail as string) ?? null,
    instituteId: (d.instituteId as string) ?? null,
    lifecycleState: (d.lifecycleState as LifecycleState) ?? 'softDeleted',
    deletedAt: (d.deletedAt as string) ?? null,
    deletedByRole: (d.deletedByRole as string) ?? null,
    purgeAfter: (d.purgeAfter as string) ?? null,
  };
}

/**
 * Soft-deleted records of one type.
 *
 * Scoped by instituteId when given, so an institute admin sees only their own
 * tenant's trash. The Web Owner passes nothing and sees everything.
 */
export async function getTrashedByRole(
  role: LifecycleRole,
  instituteId?: string,
): Promise<TrashedRecord[]> {
  const constraints = [where('lifecycleState', '==', 'softDeleted')];
  if (instituteId && role !== 'institute') {
    constraints.push(where('instituteId', '==', instituteId));
  }
  const snap = await getDocs(query(collection(db, COLLECTION_BY_ROLE[role]), ...constraints));
  return snap.docs
    .map((d) => mapRecord(role, d.id, d.data() as Record<string, unknown>))
    // Newest first, client-side — these are small sets and it avoids a
    // composite index for every role.
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
}

/** Everything currently in the trash, across all three types. */
export async function getAllTrashed(instituteId?: string): Promise<TrashedRecord[]> {
  const roles: LifecycleRole[] = instituteId
    ? ['faculty', 'student']          // an institute never sees institutes
    : ['institute', 'faculty', 'student'];
  const lists = await Promise.all(
    roles.map((r) => getTrashedByRole(r, instituteId).catch(() => [])),
  );
  return lists.flat().sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
}

// ── Presentation ──────────────────────────────────────────────────

export function roleLabel(role: LifecycleRole): string {
  switch (role) {
    case 'institute': return 'Institute';
    case 'faculty':   return 'Faculty';
    case 'student':   return 'Student';
    default:          return role;
  }
}

/**
 * Whole days until this record becomes purgeable.
 *
 * null means "not scheduled" — which the purge job must treat as NEVER
 * eligible rather than as immediately due. A missing purgeAfter is missing
 * information, not permission.
 */
export function daysUntilPurge(rec: TrashedRecord, now: Date = new Date()): number | null {
  if (!rec.purgeAfter) return null;
  const t = Date.parse(rec.purgeAfter);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now.getTime()) / 86_400_000));
}

export function retentionLabel(rec: TrashedRecord): string {
  const d = daysUntilPurge(rec);
  if (d === null) return 'No purge scheduled';
  if (d === 0) return 'Eligible for permanent deletion';
  return `${d} day${d === 1 ? '' : 's'} until permanent deletion`;
}