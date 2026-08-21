// ── Account access ────────────────────────────────────────────────
// Client half of the setAccountStatus callable (functions/src/index.ts).
//
// ── WHY THIS IS NOT AN updateDoc ──────────────────────────────────
//
// Switching an account off used to be a plain Firestore write: StudentTab and
// FacultyTab flipped `status: 'disabled'` with a full-document `set`, and
// UserManagementPage did the same for an institute. That write is all it was.
// Firebase Auth was never told, refresh tokens were never revoked, and
// `firestore.rules` reads `status` nowhere — so a disabled account kept a
// working session for as long as it stayed signed in, which on this platform
// is forever: nothing here calls setPersistence, so Firebase's default
// browserLocalPersistence keeps a session alive across restarts indefinitely.
//
// The client gates in the four auth contexts (evaluateAccess) only run while a
// session is being BUILT, and they run on the account holder's own machine.
// They shape the UI. They were never the boundary.
//
// So the decision moved server-side, where it can do the two things a client
// cannot: `updateUser({ disabled })` on the Auth account, and
// `revokeRefreshTokens` on its live sessions. firestore.rules now rejects any
// client write that CHANGES `status` on students, faculty or institutes, which
// is what stops a fourth caller from quietly reintroducing the bare updateDoc.
//
// ── THE HOUR THAT REMAINS ─────────────────────────────────────────
//
// An ID token already minted stays valid until it expires, up to one hour, and
// Cloud Firestore rules do not check token revocation. A session open at the
// moment of disabling can therefore keep working for up to an hour and then
// stops dead, because it cannot refresh. That is the same window soft delete
// has always had, and it is a bounded hour in place of an unbounded forever.

import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

export type StatusRole = 'institute' | 'faculty' | 'student';

export interface SetAccountStatusInput {
  role: StatusRole;
  uid: string;
  status: 'active' | 'disabled';
}

/**
 * Switch an account on or off, for real.
 *
 * THROWS on failure, deliberately. The write it replaced could not fail in any
 * way worth reporting, so its call sites swallowed errors into a console log
 * and left the row looking unchanged. This one can fail in ways the person
 * pressing the button needs to hear — the account is soft-deleted, the
 * institute has expired, the caller does not govern this account — so the
 * message is theirs to render.
 */
export async function setAccountStatus(input: SetAccountStatusInput): Promise<void> {
  const call = httpsCallable<SetAccountStatusInput, { ok: boolean; status: string }>(
    functions,
    'setAccountStatus',
  );
  await call(input);
}

/**
 * Put a renewed institute's people back.
 *
 * Called after `activeUntil` is extended. The hourly sweep reaches the same
 * state on its own, so this is not what makes renewal correct — it is what
 * stops a customer who has just paid waiting up to an hour to get back in.
 *
 * Best-effort by design: the validity extension has already been saved by the
 * time this runs, and a transient failure here must not report the renewal
 * itself as failed. Never throws; returns whether the reconcile ran.
 */
export async function restoreInstituteAccess(instituteId: string): Promise<boolean> {
  try {
    const call = httpsCallable<{ instituteId: string }, { ok: boolean; changed: number }>(
      functions,
      'restoreInstituteAccess',
    );
    await call({ instituteId });
    return true;
  } catch (err) {
    console.warn(
      '[accountAccess] could not reconcile institute access now —'
      + ' the nightly sweep will pick it up',
      err,
    );
    return false;
  }
}
