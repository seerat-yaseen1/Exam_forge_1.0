// ── Roster sign-in state ──────────────────────────────────────────
// Client half of the getRosterSignInState callable (functions/src/index.ts).
//
// ── WHAT THIS REPLACES ────────────────────────────────────────────
//
// The "Never signed in" tile on the institute dashboard, and the per-row
// badges on both rosters, were fed by `firstLoginRequired` on the profile
// document. Nothing ever set that field to true: every provisioning path
// writes `firstLoginRequired: false` at creation, because provisioning
// generates a password nobody sees and emails a reset link instead.
//
// So the tile read 0 for every institute, always, with the subtitle
// "everyone has". That is worse than a dead feature — it was a confident,
// specific, wrong answer to a question an administrator would act on. The
// number now comes from Firebase Auth's own `metadata.lastSignInTime`, which
// is set by Firebase on every sign-in and needs no migration to be correct.
//
// ── WHY A SEPARATE FETCH ──────────────────────────────────────────
//
// The rosters come from Firestore and this comes from Auth, so it cannot ride
// along on the same read. It is deliberately a SECOND, independent load: the
// roster renders immediately from Firestore and the sign-in state fills in
// when it arrives. A dashboard that waited for both would be slower for
// everyone in order to be complete for a tile.
//
// That is also why `null` and "empty set" are different states, and why
// callers have to keep them apart — see RosterSignIn below.

import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

export interface RosterSignIn {
  /** Uids with no Firebase Auth sign-in on record. */
  neverSignedIn: Set<string>;
  /**
   * How many accounts Auth actually answered for.
   *
   * A profile whose Auth user is missing is omitted rather than guessed at,
   * and a lookup chunk that failed is skipped rather than failing the whole
   * dashboard. Both make this smaller than the roster, which is the signal
   * that the count below is a floor rather than a total.
   */
  checked: number;
  /** Roster members considered, before the Auth lookup. */
  total: number;
  /** The roster exceeded the server's cap; the answer covers only part of it. */
  truncated: boolean;
}

/**
 * Which members of one institute's roster have never signed in.
 *
 * Returns null when the answer is not available — the call failed, or the
 * result cannot be trusted to be complete. NULL IS NOT ZERO, and callers must
 * not collapse the two: rendering 0 because a lookup failed is precisely the
 * confidently-wrong number this replaced. Show a dash and say nothing.
 */
export async function fetchRosterSignIn(
  instituteId: string,
  role: 'faculty' | 'student',
): Promise<RosterSignIn | null> {
  try {
    const call = httpsCallable<
      { instituteId: string; role: 'faculty' | 'student' },
      { neverSignedIn: string[]; checked: number; total: number; truncated: boolean }
    >(functions, 'getRosterSignInState');
    const { data } = await call({ instituteId, role });
    if (data.truncated) {
      console.warn(
        `[rosterSignIn] ${role} roster exceeded the server cap — reporting no answer`
        + ' rather than a partial count',
      );
      return null;
    }
    return {
      neverSignedIn: new Set(data.neverSignedIn),
      checked: data.checked,
      total: data.total,
      truncated: data.truncated,
    };
  } catch (err) {
    console.warn('[rosterSignIn] could not read sign-in state', err);
    return null;
  }
}
