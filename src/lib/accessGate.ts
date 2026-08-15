// ══════════════════════════════════════════════════════════════════
// ACCESS GATE — may this person sign in right now?  (Audit F-8, stage 1)
// ══════════════════════════════════════════════════════════════════
//
// PURE. Takes two plain documents and a clock, returns a decision. No
// Firebase, no React, no I/O — the same discipline as instituteValidity and
// examMachine, and for the same reason: a decision about who may enter an
// examination platform should be reachable from a test without standing up an
// auth provider.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────
//
// The audit's F-8 is that four auth contexts differ mostly by role name —
// Institute and Faculty differ by 196 of ~360 lines, much of that
// substitution. Collapsing the four PROVIDERS is the large half of that
// finding and is not what this module does.
//
// This is the half worth doing first, because it is the half where a
// divergence is a SECURITY bug rather than a maintenance cost. Three of the
// four contexts each carry their own copy of the same admission decision:
//
//     if (inst.status === 'disabled' || X.status === 'disabled'
//         || inst.lifecycleState === 'softDeleted'
//         || X.lifecycleState === 'softDeleted') → denied
//     if (activeUntil && new Date(activeUntil) < new Date())        → expired
//
// Three copies, two shapes (the institute context has no member document),
// and nothing holding them together. The comment in StudentAuthContext
// records what the last divergence here cost: soft delete sets
// `lifecycleState`, NOT `status`, so a gate checking only `status` let deleted
// accounts — and members of a DELETED INSTITUTE — sign in and sit exams
// exactly as before. That fix had to be made in each copy separately, and
// nothing would have failed if one had been missed.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────
//
// This is the CLIENT's gate, and a client gate is a courtesy: it produces a
// clear message instead of a confusing half-signed-in state. It is not what
// keeps a deleted account out of the data. That is firestore.rules and the
// callables' own claim checks, which is where it has to be, because anything
// here runs on the candidate's machine.
//
// It also does not decide ROLE. Whether the caller is a student at all is a
// custom-claim check that happens before this, and belongs there — claims are
// the only identity assertion the client cannot forge.

/** Why admission was refused, or null when it was not. */
export type AccessDenial = 'disabled' | 'expired';

/**
 * The fields this gate reads. Deliberately `unknown`-typed and narrow: these
 * documents arrive from Firestore, so every field is optional in practice
 * whatever the local interface claims, and a gate that assumed otherwise
 * would throw on a legacy document rather than deny it.
 */
export interface GateDoc {
  status?: unknown;
  lifecycleState?: unknown;
}

export interface InstituteGateDoc extends GateDoc {
  activeUntil?: unknown;
}

import { hasExpired } from './instituteValidity';

function isBlocked(doc: GateDoc | null | undefined): boolean {
  if (!doc) return false;
  return doc.status === 'disabled' || doc.lifecycleState === 'softDeleted';
}

/**
 * Decide admission for one sign-in.
 *
 * @param institute the institute document — always required, because every
 *   role in this platform belongs to one and an institute's state governs
 *   its members.
 * @param member the faculty or student document, or null for an Institute
 *   Admin signing in as the institute itself.
 * @param now injectable clock, so the expiry boundary is testable.
 *
 * ORDER IS PART OF THE CONTRACT. `disabled` is checked before `expired`
 * because it is the more specific and more actionable answer: an admin who
 * disabled an account wants that reported, not "your institute's access
 * period has expired", which would send the person to the wrong place to get
 * it fixed. The three call sites already agreed on this order; it is written
 * down here so a fourth cannot quietly pick the other one.
 */
export function evaluateAccess(
  institute: InstituteGateDoc | null | undefined,
  member: GateDoc | null | undefined,
  now: number = Date.now(),
): AccessDenial | null {
  if (isBlocked(institute) || isBlocked(member)) return 'disabled';
  if (hasExpired(institute?.activeUntil, now)) return 'expired';
  return null;
}
