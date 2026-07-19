// ── Question rights — pure resolution helpers ─────────────────────
// (Permission-model Phase 2. Client mirror of the enforcement in the
// question callables — the SERVER decides; these shape the UI to match.)
//
// Two axes, kept deliberately separate elsewhere in the codebase:
//   • CONTENT grants (bankGrants / instituteGrants / questionShares) —
//     WHICH questions you can see. Unchanged by this module.
//   • RIGHTS (this module) — WHAT you may do with your OWN questions:
//     create / edit / share / delete.
//
// The chain: Web Owner sets a per-institute CEILING → Institute Admin
// grants faculty rights AT OR BELOW that ceiling → faculty act in the
// granted mode. Everything defaults OFF (secure-by-default).

import type {
  QuestionRightsCeiling,
  FacultyQuestionRights,
  QuestionRightName,
  QuestionRightMode,
  CeilingRight,
  FacultyRight,
} from './firebaseService';

export const RIGHT_NAMES: QuestionRightName[] = ['create', 'edit', 'share', 'delete'];

const EMPTY_CEILING_RIGHT: CeilingRight = { allowed: false, modes: [] };
const EMPTY_FACULTY_RIGHT: FacultyRight = { granted: false, mode: 'direct' };

/** A fully-off ceiling — the effective default when an institute has none. */
export function emptyCeiling(): QuestionRightsCeiling {
  return {
    create: { ...EMPTY_CEILING_RIGHT },
    edit:   { ...EMPTY_CEILING_RIGHT },
    share:  { ...EMPTY_CEILING_RIGHT },
    delete: { ...EMPTY_CEILING_RIGHT },
  };
}

/** A fully-off faculty rights object — the effective default. */
export function emptyFacultyRights(): FacultyQuestionRights {
  return {
    create: { ...EMPTY_FACULTY_RIGHT },
    edit:   { ...EMPTY_FACULTY_RIGHT },
    share:  { ...EMPTY_FACULTY_RIGHT },
    delete: { ...EMPTY_FACULTY_RIGHT },
  };
}

/** Does the institute hold this right at all (ceiling allowed)? */
export function instituteHasRight(
  ceiling: QuestionRightsCeiling | undefined,
  right: QuestionRightName,
): boolean {
  return !!ceiling?.[right]?.allowed;
}

/** Modes the institute may grant onward for this right (∩ with allowed). */
export function grantableModes(
  ceiling: QuestionRightsCeiling | undefined,
  right: QuestionRightName,
): QuestionRightMode[] {
  const c = ceiling?.[right];
  if (!c?.allowed) return [];
  return c.modes ?? [];
}

/**
 * Validate a proposed faculty-rights object against the institute ceiling.
 * Returns the SANITIZED rights (never exceeding the ceiling) — the same
 * clamp the server applies, so the UI can't submit something the server
 * would silently reject. A right is dropped to off if the institute lacks
 * it; a mode is dropped to the first grantable mode if not permitted.
 */
export function clampRightsToCeiling(
  proposed: FacultyQuestionRights | undefined,
  ceiling: QuestionRightsCeiling | undefined,
): FacultyQuestionRights {
  const out = emptyFacultyRights();
  for (const r of RIGHT_NAMES) {
    const modes = grantableModes(ceiling, r);
    const p = proposed?.[r];
    if (p?.granted && instituteHasRight(ceiling, r) && modes.includes(p.mode)) {
      out[r] = { granted: true, mode: p.mode };
    } else if (p?.granted && instituteHasRight(ceiling, r) && modes.length > 0) {
      // Right allowed but the requested mode isn't grantable — clamp to the
      // first permitted mode rather than dropping the grant entirely.
      out[r] = { granted: true, mode: modes[0] };
    }
    // else: stays off
  }
  return out;
}

/**
 * The effective decision for a faculty action, given both levels. In Phase 2
 * only 'direct' takes effect; 'request' resolves to 'request' here but its
 * execution (approval inbox) is Phase 3, so callers treat 'request' as
 * "not directly permitted yet".
 *
 *   'direct'  — perform immediately (server will allow the write)
 *   'request' — must go through approval (Phase 3); blocked in Phase 2
 *   'none'    — not permitted
 */
export function effectiveFacultyMode(
  faculty: { questionRights?: FacultyQuestionRights } | undefined,
  ceiling: QuestionRightsCeiling | undefined,
  right: QuestionRightName,
): 'direct' | 'request' | 'none' {
  if (!instituteHasRight(ceiling, right)) return 'none';
  const fr = faculty?.questionRights?.[right];
  if (!fr?.granted) return 'none';
  // The granted mode must still be within what the ceiling permits.
  if (!grantableModes(ceiling, right).includes(fr.mode)) return 'none';
  return fr.mode;
}

/** Convenience: may this faculty perform `right` right now (direct only)? */
export function facultyCanDirect(
  faculty: { questionRights?: FacultyQuestionRights } | undefined,
  ceiling: QuestionRightsCeiling | undefined,
  right: QuestionRightName,
): boolean {
  return effectiveFacultyMode(faculty, ceiling, right) === 'direct';
}