// ── Entity lifecycle — one vocabulary over three legacy shapes ────
// (Feature #15, Phase 0a. Pure functions only — no Firestore access,
// no writes, no imports from any service. This module is READ-ONLY
// vocabulary: it tells you what state a doc is in. Phase 0b wires the
// writes; Phases 1+ build on top.)
//
// WHY A DERIVATION LAYER AND NOT A DATA MIGRATION
// The platform grew three independent ways of saying "not active":
//
//   • Academic hierarchy (9 node types: schools, academicLevels,
//     programs, academicSessions, academicYears, semesters, courses,
//     sections, groups)        → status: 'active' | 'archived'
//   • People (institutes, faculty, students)
//                              → status: 'active' | 'disabled'
//   • Content (assessments, questions, questionBanks, questionShares,
//     attempts)                → isDeleted: boolean
//
// Rewriting ~15 collections to a single field would mean moving every
// query that filters on the old fields in the same deploy. That is a
// large, irreversible, hard-to-verify change to make FIRST, before any
// of the lifecycle features that justify it exist. So instead the new
// state is DERIVED from whatever field the entity already carries.
// Nothing migrates. Old code keeps working untouched. New code reads
// through lifecycleOf() and sees one vocabulary.
//
// THE 'disabled' TRAP — READ THIS BEFORE CHANGING ANYTHING HERE
// `status: 'disabled'` on people is NOT a lifecycle state. It is an
// ACCESS flag. A disabled student still appears in rosters, still owns
// attempts, still counts as allocated, and is still a live member of
// the institute — they simply cannot log in. Collapsing 'disabled' into
// 'archived' would silently change login gating, roster filtering and
// the exam-entry path. So the two axes are kept deliberately separate:
//
//     lifecycleOf(doc)  → where the entity sits in its lifecycle
//     accessOf(doc)     → whether the account may sign in
//
// A person can be active-and-disabled (suspended, still enrolled) or
// archived-and-enabled (left the institute, account never disabled).
// Both combinations are real. Never derive one axis from the other.

// ── The unified vocabulary ────────────────────────────────────────

/**
 * Where an entity sits in its lifecycle. Restore is a TRANSITION back
 * to 'active' from either 'archived' or 'softDeleted' — deliberately
 * not a state of its own.
 *
 *   active      — normal operation
 *   archived    — deliberate business state change (term ended,
 *                 contract lapsed). Read-only, hidden from default
 *                 views, visible under an explicit filter, reversible
 *                 indefinitely.
 *   softDeleted — a removal action ("I don't want this"). Hidden
 *                 everywhere including archive filters, recoverable
 *                 within the entity's retention window.
 *   purged      — physically removed. Terminal. Never actually READ
 *                 from a doc (the doc is gone); exists so callers can
 *                 name the state in audit rows and UI copy.
 */
export type LifecycleState = 'active' | 'archived' | 'softDeleted' | 'purged';

/** Whether the account may sign in. Orthogonal to LifecycleState. */
export type AccessState = 'enabled' | 'disabled';

/**
 * Every entity this feature governs. The string values double as the
 * resource keys in the deletion-rights ceiling (see deletionRights.ts)
 * and as the `entityType` written to audit rows, so they must stay
 * stable once Phase 0b writes the first audit doc.
 *
 * NOTE — this list is BROADER than DeletableResource on purpose.
 * 'question' and 'hierarchyNode' appear here because they do have
 * lifecycle states and their transitions are worth auditing, but they
 * are NOT governed by the deletion-rights ceiling: questions are
 * governed by the existing, complete questionRights model, and
 * hierarchy nodes by canWriteAcademic in firestore.rules. Feature #15
 * changes nothing about who may delete a question.
 */
export type LifecycleEntity =
  | 'institute'
  | 'faculty'
  | 'student'
  | 'assessment'
  | 'question'
  | 'questionBank'
  | 'subjectTopic'
  | 'attempt'
  | 'hierarchyNode';

// ── The forward-looking envelope ──────────────────────────────────
// Phase 0b starts WRITING these fields alongside the legacy field it
// is already writing (never instead of). Nothing reads them as the
// primary source yet — lifecycleOf() prefers them when present but
// falls back to the legacy shape, so a doc written before this feature
// and a doc written after it both resolve correctly.

export type LifecycleEnvelope = {
  /** Authoritative once written. Absent on every pre-Phase-0 doc. */
  lifecycleState?: LifecycleState;

  archivedAt?: string | null;
  archivedBy?: string | null;
  archivedByRole?: string | null;

  deletedAt?: string | null;
  deletedBy?: string | null;
  deletedByRole?: string | null;

  /** Free-text, optional, captured at the moment of the action. */
  lifecycleReason?: string | null;

  /**
   * ISO timestamp after which a softDeleted doc becomes eligible for
   * the purge job. Set when entering softDeleted, cleared on restore.
   * Absent means "not yet scheduled" — the purge job must treat a
   * missing purgeAfter as NOT eligible rather than as immediately due.
   */
  purgeAfter?: string | null;
};

// ── Legacy shapes, named ──────────────────────────────────────────
// Structural types rather than imports: this module must not depend on
// firebaseService (which would create a cycle, since Phase 0b makes
// firebaseService import this module).

/** Hierarchy nodes: schools … groups. */
type LegacyArchivable = { status?: 'active' | 'archived' | string };

/** People: institutes, faculty, students. */
type LegacyDisableable = { status?: 'active' | 'disabled' | string };

/** Content: assessments, questions, banks, shares, attempts. */
type LegacyDeletable = { isDeleted?: boolean };

/** Anything this module can read. All fields optional by design. */
export type LifecycleDoc = LifecycleEnvelope &
  LegacyArchivable &
  LegacyDisableable &
  LegacyDeletable;

// ── Derivation ────────────────────────────────────────────────────

/**
 * The single question: what lifecycle state is this doc in?
 *
 * Resolution order:
 *   1. lifecycleState, when present  — authoritative, written by
 *      Phase 0b onward.
 *   2. isDeleted === true            — content soft-delete.
 *   3. status === 'archived'         — hierarchy archive.
 *   4. otherwise                     — active.
 *
 * Note what is deliberately NOT in that list: status === 'disabled'.
 * Disabled people are lifecycle-ACTIVE. See the header note.
 *
 * A null/undefined doc resolves to 'active' rather than throwing —
 * callers filtering lists should not have to null-guard every row, and
 * treating an unreadable doc as active is the non-destructive default
 * (it shows up and can be dealt with, rather than silently vanishing).
 */
export function lifecycleOf(doc: LifecycleDoc | null | undefined): LifecycleState {
  if (!doc) return 'active';

  if (doc.lifecycleState) return doc.lifecycleState;

  if (doc.isDeleted === true) return 'softDeleted';
  if (doc.status === 'archived') return 'archived';

  return 'active';
}

/**
 * The other axis: may this account sign in?
 *
 * Only meaningful for people (institutes, faculty, students). Content
 * and hierarchy nodes have no access dimension and always answer
 * 'enabled' — callers should simply not ask.
 *
 * Deliberately independent of lifecycleOf(). An archived faculty member
 * whose status was never flipped still returns 'enabled' here; it is
 * Phase 3's job to decide whether archiving should also disable, and to
 * do it as an explicit, audited action rather than an implicit
 * side-effect of a derivation helper.
 */
export function accessOf(doc: LifecycleDoc | null | undefined): AccessState {
  return doc?.status === 'disabled' ? 'disabled' : 'enabled';
}

// ── Predicates ────────────────────────────────────────────────────
// Thin, but they keep call sites reading as intent rather than as
// string comparison, and they give one place to change if a state is
// ever added.

/** Visible in normal views and fully operable. */
export function isActive(doc: LifecycleDoc | null | undefined): boolean {
  return lifecycleOf(doc) === 'active';
}

/** Read-only, hidden from default views, reversible indefinitely. */
export function isArchived(doc: LifecycleDoc | null | undefined): boolean {
  return lifecycleOf(doc) === 'archived';
}

/** Hidden everywhere, recoverable within its retention window. */
export function isSoftDeleted(doc: LifecycleDoc | null | undefined): boolean {
  return lifecycleOf(doc) === 'softDeleted';
}

/** Archived or soft-deleted — i.e. hidden from default listings. */
export function isHidden(doc: LifecycleDoc | null | undefined): boolean {
  const s = lifecycleOf(doc);
  return s === 'archived' || s === 'softDeleted';
}

/** Can this doc be brought back to active? */
export function canRestore(doc: LifecycleDoc | null | undefined): boolean {
  return isHidden(doc);
}

/** May this account sign in right now? Lifecycle AND access must agree. */
export function canSignIn(doc: LifecycleDoc | null | undefined): boolean {
  return isActive(doc) && accessOf(doc) === 'enabled';
}

// ── Transition validity ───────────────────────────────────────────

/**
 * Is a state change legal? The state machine, encoded once.
 *
 *   active      → archived | softDeleted
 *   archived    → active (restore) | softDeleted
 *   softDeleted → active (restore) | purged
 *   purged      → nothing (terminal)
 *
 * Same-state transitions are rejected: re-archiving an archived doc is
 * a no-op that would still write an audit row, which makes the trail
 * noisier and less trustworthy. Callers should check first and skip.
 */
export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  if (from === to) return false;

  switch (from) {
    case 'active':      return to === 'archived' || to === 'softDeleted';
    case 'archived':    return to === 'active'   || to === 'softDeleted';
    case 'softDeleted': return to === 'active'   || to === 'purged';
    case 'purged':      return false;
    default:            return false;
  }
}

/** Human-readable label for UI and audit copy. */
export function lifecycleLabel(state: LifecycleState): string {
  switch (state) {
    case 'active':      return 'Active';
    case 'archived':    return 'Archived';
    case 'softDeleted': return 'Deleted';
    case 'purged':      return 'Permanently deleted';
    default:            return 'Unknown';
  }
}

// ── Retention ─────────────────────────────────────────────────────

/**
 * Grace window (days) between soft delete and purge eligibility.
 * Graduated by blast radius, per the locked spec.
 *
 * Attempts are NOT in this table on purpose. They are never purged on
 * account grounds — only the separate, legally-gated erasure path
 * (Phase 7) may touch attempt data, and it does not use this window.
 * retentionDaysFor() returns null for them, and the purge job must
 * treat null as "never eligible" rather than "purge immediately".
 */
export const RETENTION_DAYS: Partial<Record<LifecycleEntity, number>> = {
  faculty:       30,
  student:       30,
  assessment:    90,
  question:      90,
  questionBank:  90,
  subjectTopic:  90,
  hierarchyNode: 90,
  institute:    180,
};

/** Days before purge eligibility, or null if never auto-purgeable. */
export function retentionDaysFor(entity: LifecycleEntity): number | null {
  return RETENTION_DAYS[entity] ?? null;
}

/**
 * The purgeAfter timestamp for an entity soft-deleted at `from`.
 * Returns null for entities with no retention window (attempts), which
 * callers must persist as null — an absent purgeAfter is what marks a
 * doc as not-auto-purgeable.
 */
export function computePurgeAfter(
  entity: LifecycleEntity,
  from: Date = new Date(),
): string | null {
  const days = retentionDaysFor(entity);
  if (days == null) return null;
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/**
 * Is a soft-deleted doc past its window and eligible for purge?
 *
 * Fail-CLOSED on every uncertainty: not soft-deleted, no purgeAfter, or
 * an unparseable purgeAfter all return false. A purge job that treats
 * missing data as "go ahead" is how records get destroyed by accident.
 */
export function isPurgeEligible(
  doc: LifecycleDoc | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!isSoftDeleted(doc)) return false;
  const after = doc?.purgeAfter;
  if (!after) return false;
  const t = Date.parse(after);
  if (Number.isNaN(t)) return false;
  return now.getTime() >= t;
}

/** Whole days remaining before purge eligibility; null if not applicable. */
export function daysUntilPurge(
  doc: LifecycleDoc | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!isSoftDeleted(doc)) return null;
  const after = doc?.purgeAfter;
  if (!after) return null;
  const t = Date.parse(after);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now.getTime()) / 86_400_000));
}

// ── Envelope builders ─────────────────────────────────────────────
// Phase 0b uses these so every writer produces the same shape. They
// return ONLY the envelope — the caller merges in the legacy field it
// is already writing (isDeleted / status), because which legacy field
// applies depends on the collection and this module does not know that.

export type Actor = {
  uid: string;
  role: string;
};

/** Envelope for active → archived. */
export function archiveEnvelope(
  actor: Actor,
  reason?: string | null,
  at: Date = new Date(),
): LifecycleEnvelope {
  return {
    lifecycleState: 'archived',
    archivedAt: at.toISOString(),
    archivedBy: actor.uid,
    archivedByRole: actor.role,
    lifecycleReason: reason ?? null,
    // Archive has no purge window — it is reversible indefinitely.
    purgeAfter: null,
  };
}

/** Envelope for active|archived → softDeleted. */
export function softDeleteEnvelope(
  entity: LifecycleEntity,
  actor: Actor,
  reason?: string | null,
  at: Date = new Date(),
): LifecycleEnvelope {
  return {
    lifecycleState: 'softDeleted',
    deletedAt: at.toISOString(),
    deletedBy: actor.uid,
    deletedByRole: actor.role,
    lifecycleReason: reason ?? null,
    purgeAfter: computePurgeAfter(entity, at),
  };
}

/**
 * Envelope for archived|softDeleted → active.
 *
 * Clears every prior marker. Restoring a doc must not leave a stale
 * purgeAfter behind, or the purge job could later delete a record that
 * was deliberately brought back.
 */
export function restoreEnvelope(): LifecycleEnvelope {
  return {
    lifecycleState: 'active',
    archivedAt: null,
    archivedBy: null,
    archivedByRole: null,
    deletedAt: null,
    deletedBy: null,
    deletedByRole: null,
    lifecycleReason: null,
    purgeAfter: null,
  };
}