// ── Deletion rights — pure resolution helpers ─────────────────────
// (Feature #15, Phase 0a. Deliberately a structural sibling of
// questionRights.ts — same ceiling/grant/mode shape, same clamp
// semantics, same secure-by-default posture. If you know that module,
// you know this one. The SERVER decides; these functions shape the UI
// to match and let the client refuse to submit something the server
// would reject anyway.)
//
// THE CHAIN
//   Web Owner sets a per-institute CEILING → Institute Admin grants
//   faculty rights AT OR BELOW that ceiling → faculty act in the
//   granted mode. Nobody can grant what they do not hold. Everything
//   defaults OFF.
//
// TWO AXES, KEPT SEPARATE (same discipline as questionRights)
//   • WHAT you may act on  — the resource (student, assessment, …)
//   • HOW you may act      — direct (do it now) or request (ask first)
//
// DELIBERATE NAME OVERLAP — IMPORT WITH AN ALIAS IF YOU NEED BOTH
// Six exports here share a name with questionRights.ts by design, so
// the two modules read identically: emptyCeiling, emptyFacultyRights,
// instituteHasRight, grantableModes, clampRightsToCeiling,
// facultyCanDirect. There is no barrel file, so this is harmless
// today — but any component importing BOTH modules must alias, e.g.
//   import { clampRightsToCeiling as clampDeletionRights } from './deletionRights';
// FacultyTab.tsx and the two rights editors are the likely first
// places this comes up, since they already import questionRights.
//
// WHY THIS IS NOT FOLDED INTO questionRights
// questionRights answers "what may you do with your own QUESTIONS" —
// create/edit/share/delete, one collection, already fully implemented
// and working. This module answers "what may you REMOVE" across the
// OTHER entities on the platform. The two do not overlap: 'question'
// is deliberately absent from DeletableResource, so question deletion
// continues to be governed entirely by questionRights and Feature #15
// changes nothing about it.

import type { LifecycleEntity } from './lifecycle';

// ── Vocabulary ────────────────────────────────────────────────────

/**
 * How a holder may exercise a right.
 *
 *   'direct'  — perform immediately; the server will allow the write.
 *   'request' — must go through approval; the approver executes it.
 *
 * Matches QuestionRightMode exactly, on purpose: the request/approval
 * machinery generalises from questionRequests, and a shared vocabulary
 * keeps the two inboxes conceptually identical for the user.
 */
export type DeletionMode = 'direct' | 'request';

/** The decision surface, including the negative case. */
export type EffectiveMode = DeletionMode | 'none';

/**
 * Resources whose removal is governed BY THIS MODULE. Deliberately a
 * subset of LifecycleEntity — two entities are excluded because they
 * already have a working gate, and a second gate could only disagree
 * with the first:
 *
 *   'question'      — questionRights.ts already implements the full
 *                     ceiling → grant → mode chain for question
 *                     create/edit/share/DELETE, with the approval
 *                     inbox behind it. That system is complete and
 *                     stays the sole authority for questions. Nothing
 *                     about question deletion changes under Feature
 *                     #15. Do NOT add a 'question' entry here — it
 *                     would create two gates for one action.
 *   'hierarchyNode' — already governed by canWriteAcademic in
 *                     firestore.rules.
 *
 * NOTE on 'attempt' — locked decision: WEB OWNER ONLY. It appears here
 * so the ceiling can express it, but ceilings must never grant it. See
 * WEBOWNER_ONLY_RESOURCES and clampCeiling().
 */
export type DeletableResource = Exclude<LifecycleEntity, 'hierarchyNode' | 'question'>;

export const DELETABLE_RESOURCES: DeletableResource[] = [
  'institute',
  'faculty',
  'student',
  'assessment',
  'questionBank',
  'subjectTopic',
  'attempt',
];

/**
 * Resources no institute may ever hold, at any mode, regardless of what
 * a ceiling document happens to say.
 *
 *   'attempt'   — locked decision: attempts are the audit trail. An
 *                 institute that can delete attempts can delete the
 *                 evidence of what happened in an exam. Institutes
 *                 request; the Web Owner executes.
 *   'institute' — a tenant deleting tenants is a containment breach,
 *                 including deleting ITSELF (which would strand every
 *                 user under it with no one able to restore them).
 *
 * Enforced in clampCeiling() so it holds even if a ceiling doc is
 * hand-edited or written by an older build. The server enforces the
 * same list independently — this is the client mirror, not the gate.
 */
export const WEBOWNER_ONLY_RESOURCES: DeletableResource[] = ['attempt', 'institute'];

/** Is this resource permanently reserved to the Web Owner? */
export function isWebOwnerOnly(resource: DeletableResource): boolean {
  return WEBOWNER_ONLY_RESOURCES.includes(resource);
}

// ── Shapes ────────────────────────────────────────────────────────

/**
 * One resource's entry in an institute ceiling.
 *
 *   allowed — may the institute delete this resource type at all?
 *   modes   — the subset it may grant ONWARD to faculty.
 *
 * The questionRights convention is preserved exactly: allowed:true with
 * an EMPTY modes array means the institute may use the right itself but
 * may not delegate it to faculty. That is a real and useful
 * configuration, not a malformed one.
 *
 *   selfMode — how the INSTITUTE itself acts. Absent is read as
 *              'direct' for backward compatibility with the
 *              questionRights shape, which has no equivalent field.
 *              Setting it to 'request' is what makes "institute admin
 *              can raise a request when it lacks permission" a
 *              first-class configuration rather than a special case.
 */
export type DeletionCeilingRight = {
  allowed: boolean;
  modes: DeletionMode[];
  selfMode?: DeletionMode;
};

export type DeletionRightsCeiling = Record<DeletableResource, DeletionCeilingRight>;

/** One granted right for a faculty member. */
export type FacultyDeletionRight = {
  granted: boolean;
  mode: DeletionMode;
};

export type FacultyDeletionRights = Record<DeletableResource, FacultyDeletionRight>;

const EMPTY_CEILING_RIGHT: DeletionCeilingRight = { allowed: false, modes: [] };
const EMPTY_FACULTY_RIGHT: FacultyDeletionRight = { granted: false, mode: 'request' };

/**
 * A fully-off ceiling — the effective default when an institute has
 * none. This is what every institute gets at migration: the locked
 * decision is that existing faculty receive NO deletion rights and must
 * be granted them through the new model. Clean break, no grandfathering.
 */
export function emptyCeiling(): DeletionRightsCeiling {
  const out = {} as DeletionRightsCeiling;
  for (const r of DELETABLE_RESOURCES) out[r] = { ...EMPTY_CEILING_RIGHT, modes: [] };
  return out;
}

/**
 * A fully-off faculty rights object — the effective default.
 *
 * Note the default mode is 'request', not 'direct': if a grant is ever
 * constructed with granted flipped true but no mode considered, the
 * safe interpretation is that it needs approval.
 */
export function emptyFacultyRights(): FacultyDeletionRights {
  const out = {} as FacultyDeletionRights;
  for (const r of DELETABLE_RESOURCES) out[r] = { ...EMPTY_FACULTY_RIGHT };
  return out;
}

// ── Ceiling queries ───────────────────────────────────────────────

/** Does the institute hold this right at all? */
export function instituteHasRight(
  ceiling: DeletionRightsCeiling | undefined,
  resource: DeletableResource,
): boolean {
  if (isWebOwnerOnly(resource)) return false;
  return !!ceiling?.[resource]?.allowed;
}

/** Modes the institute may grant onward for this resource. */
export function grantableModes(
  ceiling: DeletionRightsCeiling | undefined,
  resource: DeletableResource,
): DeletionMode[] {
  if (isWebOwnerOnly(resource)) return [];
  const c = ceiling?.[resource];
  if (!c?.allowed) return [];
  return c.modes ?? [];
}

/**
 * How the INSTITUTE ITSELF acts on this resource.
 *
 * 'none'    — no ceiling entry; the institute must escalate to the Web
 *             Owner, which Phase 4 exposes as a request.
 * 'request' — holds the right but must have it approved above.
 * 'direct'  — acts immediately.
 */
export function instituteMode(
  ceiling: DeletionRightsCeiling | undefined,
  resource: DeletableResource,
): EffectiveMode {
  if (!instituteHasRight(ceiling, resource)) return 'none';
  return ceiling?.[resource]?.selfMode ?? 'direct';
}

/** Convenience: may the institute act without approval? */
export function instituteCanDirect(
  ceiling: DeletionRightsCeiling | undefined,
  resource: DeletableResource,
): boolean {
  return instituteMode(ceiling, resource) === 'direct';
}

// ── Clamping ──────────────────────────────────────────────────────

/**
 * Sanitize a ceiling the Web Owner is proposing.
 *
 * Enforces the two invariants that must hold no matter what a stored
 * document says: web-owner-only resources are forced off, and a mode
 * list is never allowed to contain something outside the vocabulary.
 * Run this on READ as well as on write — a ceiling doc written by an
 * older build, or hand-edited in the console, must not be able to
 * widen anyone's rights just by existing.
 */
export function clampCeiling(
  proposed: DeletionRightsCeiling | undefined,
): DeletionRightsCeiling {
  const out = emptyCeiling();

  for (const r of DELETABLE_RESOURCES) {
    if (isWebOwnerOnly(r)) continue;   // forced off, always

    const p = proposed?.[r];
    if (!p?.allowed) continue;

    const modes = (p.modes ?? []).filter(
      (m): m is DeletionMode => m === 'direct' || m === 'request',
    );
    // De-duplicate without relying on Set iteration order.
    const uniq: DeletionMode[] = [];
    for (const m of modes) if (!uniq.includes(m)) uniq.push(m);

    const selfMode: DeletionMode =
      p.selfMode === 'direct' || p.selfMode === 'request' ? p.selfMode : 'direct';

    out[r] = { allowed: true, modes: uniq, selfMode };
  }

  return out;
}

/**
 * Validate proposed faculty rights against the institute ceiling.
 * Returns the SANITIZED rights, never exceeding the ceiling — the same
 * clamp the server applies, so the UI cannot submit something the
 * server would silently reject.
 *
 * A right is dropped to off if the institute lacks it. A mode not
 * permitted by the ceiling is clamped to the first grantable mode
 * rather than dropping the grant entirely — matching
 * clampRightsToCeiling in questionRights, so an admin who picks
 * 'direct' where only 'request' is grantable gets a working grant at
 * the permitted level instead of a silent no-op.
 */
export function clampRightsToCeiling(
  proposed: FacultyDeletionRights | undefined,
  ceiling: DeletionRightsCeiling | undefined,
): FacultyDeletionRights {
  const out = emptyFacultyRights();

  for (const r of DELETABLE_RESOURCES) {
    const modes = grantableModes(ceiling, r);
    if (modes.length === 0) continue;          // nothing grantable → stays off

    const p = proposed?.[r];
    if (!p?.granted) continue;

    out[r] = modes.includes(p.mode)
      ? { granted: true, mode: p.mode }
      : { granted: true, mode: modes[0] };
  }

  return out;
}

// ── Effective decisions ───────────────────────────────────────────

/**
 * The effective decision for a FACULTY action, given both levels.
 * Both must agree: the institute must hold the right, the faculty must
 * be granted it, and the granted mode must still be within what the
 * ceiling currently permits.
 *
 * That last check matters — a ceiling narrowed after a grant was made
 * must immediately constrain the grant, without needing every faculty
 * document to be rewritten.
 */
export function effectiveFacultyMode(
  faculty: { deletionRights?: FacultyDeletionRights } | undefined,
  ceiling: DeletionRightsCeiling | undefined,
  resource: DeletableResource,
): EffectiveMode {
  if (!instituteHasRight(ceiling, resource)) return 'none';

  const fr = faculty?.deletionRights?.[resource];
  if (!fr?.granted) return 'none';

  if (!grantableModes(ceiling, resource).includes(fr.mode)) return 'none';

  return fr.mode;
}

/** Convenience: may this faculty act without approval right now? */
export function facultyCanDirect(
  faculty: { deletionRights?: FacultyDeletionRights } | undefined,
  ceiling: DeletionRightsCeiling | undefined,
  resource: DeletableResource,
): boolean {
  return effectiveFacultyMode(faculty, ceiling, resource) === 'direct';
}

/** Would this faculty's action become a request rather than a write? */
export function facultyMustRequest(
  faculty: { deletionRights?: FacultyDeletionRights } | undefined,
  ceiling: DeletionRightsCeiling | undefined,
  resource: DeletableResource,
): boolean {
  return effectiveFacultyMode(faculty, ceiling, resource) === 'request';
}

// ── Role-level entry point ────────────────────────────────────────

export type ActorRole = 'webOwner' | 'institute' | 'faculty';

/**
 * One call the UI can make regardless of who is signed in: what happens
 * if this actor tries to delete this resource type?
 *
 *   'direct'  — show a confirm dialog and perform it
 *   'request' — show a request dialog; someone above approves
 *   'none'    — hide or disable the control entirely
 *
 * The Web Owner is unconditionally 'direct' — they are the top of the
 * chain and the holder of the web-owner-only resources.
 *
 * IMPORTANT: this is presentation logic. It decides what the UI offers,
 * never what is permitted. The server re-derives the same answer from
 * the same inputs and is the only thing that actually gates a write.
 */
export function resolveActorMode(
  role: ActorRole,
  resource: DeletableResource,
  ctx: {
    ceiling?: DeletionRightsCeiling;
    faculty?: { deletionRights?: FacultyDeletionRights };
  } = {},
): EffectiveMode {
  switch (role) {
    case 'webOwner':
      return 'direct';
    case 'institute':
      return instituteMode(ctx.ceiling, resource);
    case 'faculty':
      return effectiveFacultyMode(ctx.faculty, ctx.ceiling, resource);
    default:
      return 'none';
  }
}

/** Who approves a request raised by this actor? */
export function approverFor(role: ActorRole): ActorRole | null {
  if (role === 'faculty') return 'institute';
  if (role === 'institute') return 'webOwner';
  return null;   // webOwner answers to nobody
}

// ── Institute content transfer (exercised WHILE ACTIVE) ───────────
//
// Locked decision: deleting an institute WIPES its content. The Web
// Owner does not silently absorb a departing tenant's question bank —
// that content is the institute's, and inheriting thousands of unvetted
// questions by default is not a good outcome for either side.
//
// The exception is a deliberate hand-over the institute performs while
// it is still ACTIVE. This is a capability, not a deletion mode: it is
// not offered in the delete dialog, and the Web Owner cannot trigger it
// on a departing institute's behalf. If the institute did not transfer
// beforehand, the content is gone at purge.
//
// SCOPE: questions and question banks only. Assessments never transfer
// — they carry allocation rules, section config, grading policy and SEB
// settings bound to a tenant that is disappearing, so a transferred
// assessment would point at students and hierarchy nodes that no longer
// exist.
//
// WHAT SURVIVES A WIPE REGARDLESS: anything the Web Owner already
// owns. A webOwner-authored assessment that was conducted FOR this
// institute's students stays — ownership was never the institute's, and
// who sat the exam does not determine who owns it. Same for webOwner
// questions the institute merely had access to through a grant: the
// grant dies with the tenant, the content does not.

/**
 * May this institute hand its questions and banks up to the Web Owner
 * before it is removed? Set per-institute by the Web Owner.
 *
 * Stored on the ceiling document rather than as a deletion resource
 * because it is not a deletion right — it is something the institute
 * does while healthy, and it is exercised through its own flow.
 */
export type ContentTransferRight = {
  /** May the institute initiate a hand-over at all? */
  allowed: boolean;
};

/** Does this institute hold the content-transfer capability? */
export function canTransferContentUp(
  transfer: ContentTransferRight | undefined,
): boolean {
  return !!transfer?.allowed;
}

// ── Ownership succession ──────────────────────────────────────────

export type OwnerRef = {
  ownerType: 'webOwner' | 'institute' | 'faculty';
  ownerId: string;
};

export type SuccessionOutcome = {
  to: OwnerRef;
  reason: 'chosen' | 'defaulted' | 'fallback';
};

/**
 * Where does a departing FACULTY member's content go?
 *
 * Default is the institute admin — the one successor that always
 * exists as long as the institute does, so it can never fail and needs
 * nobody to choose anything. That makes it safe for bulk deletes and
 * for cascades where no human is present to pick.
 *
 * An explicitly chosen successor wins, but ONLY if still valid at the
 * moment of execution. Requests can sit in an approval inbox for days;
 * a colleague picked on Monday may be archived by Thursday. Validating
 * at selection time and trusting it at execution time would transfer
 * content to a dead account.
 *
 * ONE HOP, ALWAYS. This returns a direct successor and never consults
 * where the departing owner's content originally came from. If A's
 * content passed to B and B is now leaving, B's content — including
 * A's — goes to the institute admin, not onward to whoever B named.
 * Chains are unreadable and make restore ambiguous.
 */
export function resolveFacultySuccessor(
  instituteId: string,
  chosen: { facultyId: string; isValid: boolean } | null | undefined,
): SuccessionOutcome {
  const instituteAdmin: OwnerRef = { ownerType: 'institute', ownerId: instituteId };

  if (!chosen) {
    return { to: instituteAdmin, reason: 'defaulted' };
  }
  if (!chosen.isValid) {
    // An intent existed and could not be honoured — distinct from
    // nobody having chosen, and worth surfacing to whoever chose.
    return { to: instituteAdmin, reason: 'fallback' };
  }
  return {
    to: { ownerType: 'faculty', ownerId: chosen.facultyId },
    reason: 'chosen',
  };
}

/**
 * Does ownership move at this transition?
 *
 *   archive     — NO. Archive is reversible and the person may return;
 *                 their content stays theirs and remains readable by
 *                 the institute. Moving ownership on archive would
 *                 mean a restore left their content belonging to
 *                 someone else, with no record it was ever theirs.
 *   softDelete  — YES, and it is recorded so restore can reverse it.
 *   purge       — succession is already done; purge makes it final.
 */
export function successionRunsOn(
  action: 'archive' | 'softDelete' | 'restore' | 'purge',
): boolean {
  return action === 'softDelete';
}


export function resourceLabel(resource: DeletableResource): string {
  switch (resource) {
    case 'institute':    return 'Institutes';
    case 'faculty':      return 'Faculty';
    case 'student':      return 'Students';
    case 'assessment':   return 'Assessments';
    case 'questionBank': return 'Question banks';
    case 'subjectTopic': return 'Subjects & topics';
    case 'attempt':      return 'Exam attempts';
    default:             return resource;
  }
}

export function modeLabel(mode: EffectiveMode): string {
  switch (mode) {
    case 'direct':  return 'Delete directly';
    case 'request': return 'Request approval';
    case 'none':    return 'Not permitted';
    default:        return 'Not permitted';
  }
}