// ── Deletion audit — the lifecycle trail ──────────────────────────
// (Feature #15, Phase 0a. Types + pure builders + read queries. No
// writes from the client: audit rows are written SERVER-SIDE only, by
// the same callable that performs the transition, inside the same
// operation. See the WRITE POSTURE note below.)
//
// Closes bug (c) from the folded Feature #29: nothing in the codebase
// currently records who deleted what, when, or why — not deletes, not
// edits, not attempt overrides.
//
// WRITE POSTURE — WHY CLIENTS NEVER WRITE HERE
// An audit trail a client can write is an audit trail a client can
// forge. It is also one a client can FORGET to write: if the row and
// the state change are two separate calls, any failure between them
// leaves a deletion with no record, which is precisely the case the
// trail exists to cover. So the row is written by the server, in the
// same operation as the transition. firestore.rules (Phase 0b) makes
// the collection read-only to every client and unwritable by all of
// them, including the Web Owner.
//
// RETENTION AND PERSONAL DATA
// These rows contain actor identity and entity labels — personal data
// by most definitions. The Phase 7 erasure path must therefore decide
// what happens to the audit trail when a person is erased, or erasure
// leaves behind a record of the person it erased. Flagged here so the
// decision cannot be missed: it is a legal question, not a technical
// one, and it is deliberately unanswered in Phase 0a.

import {
  collection, query, where, orderBy, limit as fsLimit, getDocs,
} from 'firebase/firestore';
import { db } from './firebase';
import type { LifecycleEntity, LifecycleState } from './lifecycle';

export const DELETION_AUDIT_COLLECTION = 'deletionAudit';

// ── Row shape ─────────────────────────────────────────────────────

/**
 * What happened. Distinct from the resulting state because two actions
 * can land on the same state and mean different things — a 'restore'
 * and a 'create' both end at 'active', and the trail should say which
 * occurred.
 *
 *   archive / softDelete / restore / purge — lifecycle transitions
 *   requestSubmitted / requestApproved / requestRejected
 *                                          — the approval workflow
 *                                            (Phase 4; the row shape
 *                                            is defined now so the
 *                                            collection never needs a
 *                                            migration later)
 *   erasure                                — Phase 7, legally gated,
 *                                            the only action permitted
 *                                            to touch attempt data
 */
/**
 * Twin of AuditActionS in functions/src/index.ts — KEEP IN SYNC.
 *
 * It had already drifted: the server has written attemptFrozen,
 * attemptUnfrozen, attemptGradedProvisional and attemptRewritten rows since
 * Phase 4, and none of them was named here. Nothing failed, because
 * `auditActionLabel` falls through to returning the raw action — so a trail
 * of exam-authority decisions rendered as `attemptGradedProvisional` instead
 * of a sentence, in the one view that exists to be read by a person.
 *
 * twinSync.test.ts now asserts the two lists match.
 */
export type AuditAction =
  | 'archive'
  | 'softDelete'
  | 'restore'
  | 'purge'
  | 'requestSubmitted'
  | 'requestApproved'
  | 'requestRejected'
  | 'erasure'
  | 'attemptFrozen'
  | 'attemptUnfrozen'
  | 'attemptGradedProvisional'
  | 'attemptRewritten'
  | 'attemptCodingRejudged';

/**
 * One immutable audit row.
 *
 * Field choice follows the spec's required list — actor, timestamp,
 * entity, previous state, new state, optional reason — plus the tenant
 * and label fields the UI needs to render a trail without N extra
 * lookups (and which stay meaningful after the target is purged, when
 * a lookup would return nothing at all).
 */
export type DeletionAuditRow = {
  id: string;

  // ── What happened ──
  action: AuditAction;
  entityType: LifecycleEntity;
  entityId: string;

  /**
   * Human label captured AT THE TIME of the action — a name, title, or
   * email. Denormalized on purpose: after a purge the target document
   * is gone, so a trail that only stored an id would read as a list of
   * opaque strings. This is the field that keeps the log legible.
   */
  entityLabel?: string | null;

  // ── State transition ──
  fromState: LifecycleState | null;   // null for request-workflow rows
  toState: LifecycleState | null;

  // ── Who ──
  actorUid: string;
  actorRole: string;
  actorName?: string | null;

  /**
   * Tenant the ACTION belongs to, used to scope institute reads.
   * Null for platform-level actions by the Web Owner.
   */
  instituteId?: string | null;

  // ── Why ──
  reason?: string | null;

  /**
   * Set when the action was executed as the result of an approved
   * request, linking the row back to the deletionRequests doc. Lets a
   * trail show "deleted by X, approved by Y" as one story.
   */
  requestId?: string | null;

  /**
   * Cascade summary captured at action time — the counts shown in the
   * impact preview the actor confirmed. Stored so the trail records
   * what they were TOLD, not just what they did.
   */
  impact?: Record<string, number> | null;

  /**
   * Ownership succession, when this action moved owned content
   * (questions, banks, assessments) from a departing owner to someone
   * else. Present only on rows where succession actually ran.
   *
   * WHY THIS LIVES IN THE AUDIT ROW AND NOT ONLY ON THE CONTENT
   * Soft delete is reversible, so a restore must be able to hand
   * content BACK. The content documents themselves only carry their
   * CURRENT owner — once succession rewrites ownerId, the previous
   * owner is gone from the doc. This row is the only record of where
   * it came from, so it is what makes restore-reverses-succession
   * possible. Losing it would silently downgrade soft delete from
   * reversible to one-way for anyone who owned content.
   *
   * Succession is ONE HOP by design: if faculty A's content passes to
   * faculty B and B is later removed, B's row records B → institute
   * admin. It never chains back to A. Each row describes exactly one
   * transfer, and restore walks rows newest-first.
   */
  succession?: {
    /** Where ownership came from — the departing owner. */
    fromOwnerType: 'webOwner' | 'institute' | 'faculty';
    fromOwnerId: string;

    /** Where ownership went. */
    toOwnerType: 'webOwner' | 'institute' | 'faculty';
    toOwnerId: string;

    /**
     * 'chosen'    — an admin picked this successor explicitly.
     * 'defaulted' — nobody chose, so it fell to the institute admin.
     * 'fallback'  — a successor WAS chosen but was no longer valid at
     *               execution time (archived/deleted while the request
     *               sat in an inbox), so it fell back to the institute
     *               admin. Distinguished from 'defaulted' because it
     *               means an intent existed and could not be honoured —
     *               worth surfacing to the admin who made the choice.
     */
    reason: 'chosen' | 'defaulted' | 'fallback';

    /** How many documents moved, by collection. */
    counts?: Record<string, number> | null;
  } | null;

  createdAt: string;
};

/** Everything except the server-assigned id and timestamp. */
export type DeletionAuditInput = Omit<DeletionAuditRow, 'id' | 'createdAt'>;

// ── Builder ───────────────────────────────────────────────────────

/**
 * Build a well-formed audit input. Shared by the server callables
 * (Phase 0b) so every row has the same shape regardless of which
 * transition produced it, and so optional fields are explicitly null
 * rather than undefined — Firestore drops undefined, which would make
 * "no reason given" and "field never existed" indistinguishable.
 */
export function buildAuditRow(input: {
  action: AuditAction;
  entityType: LifecycleEntity;
  entityId: string;
  entityLabel?: string | null;
  fromState?: LifecycleState | null;
  toState?: LifecycleState | null;
  actorUid: string;
  actorRole: string;
  actorName?: string | null;
  instituteId?: string | null;
  reason?: string | null;
  requestId?: string | null;
  impact?: Record<string, number> | null;
  succession?: DeletionAuditRow['succession'];
}): DeletionAuditInput {
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
  };
}

/**
 * Find the succession that must be reversed to restore `entityId`.
 *
 * Returns the succession block from the most recent softDelete row for
 * this entity, or null if it never owned content. Phase 5's restore
 * path uses this to hand ownership back.
 *
 * Deliberately reads the newest matching row rather than merging
 * several: succession is one hop, so exactly one transfer needs
 * reversing — the one that ran when this entity was last removed.
 */
export async function getSuccessionToReverse(
  entityType: LifecycleEntity,
  entityId: string,
): Promise<DeletionAuditRow['succession'] | null> {
  const rows = await getAuditForEntity(entityType, entityId, 20);
  for (const row of rows) {
    // Newest-first; the first softDelete we meet is the one being undone.
    if (row.action === 'softDelete') return row.succession ?? null;
    // A later restore means any earlier succession is already reversed.
    if (row.action === 'restore') return null;
  }
  return null;
}

// ── Reads ─────────────────────────────────────────────────────────
// Plain Firestore queries, scoped by the deletionAudit rules block:
// webOwner reads everything; institute reads rows stamped with its own
// instituteId; faculty and students read nothing.
//
// INDEXES: the two-field queries below (equality + orderBy createdAt)
// need composite indexes. Phase 0b adds them to firestore.indexes.json
// — until then these will fail in the console with an index link, which
// is expected and harmless since nothing calls them yet.

function mapRows(snap: Awaited<ReturnType<typeof getDocs>>): DeletionAuditRow[] {
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<DeletionAuditRow, 'id'>) }));
}

/** Full trail for one entity, newest first. */
export async function getAuditForEntity(
  entityType: LifecycleEntity,
  entityId: string,
  max = 50,
): Promise<DeletionAuditRow[]> {
  const snap = await getDocs(query(
    collection(db, DELETION_AUDIT_COLLECTION),
    where('entityType', '==', entityType),
    where('entityId', '==', entityId),
    orderBy('createdAt', 'desc'),
    fsLimit(max),
  ));
  return mapRows(snap);
}

/** Recent activity for one tenant, newest first. */
export async function getAuditForInstitute(
  instituteId: string,
  max = 100,
): Promise<DeletionAuditRow[]> {
  const snap = await getDocs(query(
    collection(db, DELETION_AUDIT_COLLECTION),
    where('instituteId', '==', instituteId),
    orderBy('createdAt', 'desc'),
    fsLimit(max),
  ));
  return mapRows(snap);
}

/** Platform-wide recent activity. Web Owner only (enforced by rules). */
export async function getRecentAudit(max = 100): Promise<DeletionAuditRow[]> {
  const snap = await getDocs(query(
    collection(db, DELETION_AUDIT_COLLECTION),
    orderBy('createdAt', 'desc'),
    fsLimit(max),
  ));
  return mapRows(snap);
}

// ── Labels ────────────────────────────────────────────────────────

export function auditActionLabel(action: AuditAction): string {
  switch (action) {
    case 'archive':          return 'Archived';
    case 'softDelete':       return 'Deleted';
    case 'restore':          return 'Restored';
    case 'purge':            return 'Permanently deleted';
    case 'requestSubmitted': return 'Requested';
    case 'requestApproved':  return 'Approved';
    case 'requestRejected':  return 'Rejected';
    case 'erasure':          return 'Erased';
    case 'attemptFrozen':            return 'Attempt paused';
    case 'attemptUnfrozen':          return 'Attempt resumed';
    case 'attemptGradedProvisional': return 'Graded provisionally';
    case 'attemptRewritten':         return 'Attempt rewritten';
    case 'attemptCodingRejudged':    return 'Coding re-judged';
    default:                 return action;
  }
}

/** One-line summary for a trail row. */
export function describeAuditRow(row: DeletionAuditRow): string {
  const what = row.entityLabel ? `${row.entityLabel}` : `${row.entityType} ${row.entityId}`;
  const who = row.actorName || row.actorRole;
  return `${auditActionLabel(row.action)} ${what} — ${who}`;
}