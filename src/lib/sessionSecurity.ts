// ── Session security ──────────────────────────────────────────────
// Client half of the revokeSessions callable (functions/src/index.ts).
//
// C'-1, scoped (2026-07-18): auto-revoke on password change ONLY — the
// manual "Sign out of all other devices" button was dropped by decision.
// Every changePassword in the four auth contexts calls
// revokeOtherSessionsKeepCurrent(newPassword) after the credential update
// succeeds, so a stolen or shared session cannot outlive the password that
// created it.
//
// How "other devices only" works: Firebase's revokeRefreshTokens is
// all-or-nothing per uid — it revokes THIS device's refresh token too, and
// revocation bites at the next ID-token refresh (≤ 1 h). So after revoking,
// we immediately re-authenticate this device with the NEW password, which
// mints a fresh post-revocation refresh token: this session survives, every
// other one dies at its next refresh.
//
// Known caveat: reauthenticateWithCredential on an MFA-enrolled account
// (the webOwner with TOTP) throws auth/multi-factor-auth-required, so the
// keep-current step is skipped there — after a password change the webOwner
// is signed out EVERYWHERE, including the current device, within ~1 h and
// signs back in with the new password + TOTP. That is an acceptable (arguably
// correct) posture for the sole admin credential, and it is non-fatal here.
//
// Both steps are best-effort by design: the password change has already
// succeeded by the time this runs, and a transient failure to revoke must
// not surface as a failed password change. Nothing here throws.

import { httpsCallable } from 'firebase/functions';
import { EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth';
import { auth, functions } from './firebase';

/**
 * Revoke every signed-in session for the current account, then re-mint this
 * device's session with the new password so only OTHER devices are signed
 * out. Call after a successful password change. Never throws.
 *
 * @returns true if the revocation call succeeded (the keep-current re-auth
 *          is advisory — see the MFA caveat above), false if revocation
 *          itself failed and no session was invalidated.
 */
export async function revokeOtherSessionsKeepCurrent(newPassword: string): Promise<boolean> {
  // 1) Revoke ALL refresh tokens for this uid (server-side, self-scoped).
  try {
    const call = httpsCallable<Record<string, never>, { ok: boolean; revokedAt: string }>(
      functions,
      'revokeSessions',
    );
    await call({});
  } catch (e) {
    console.error('[sessionSecurity] revokeSessions failed — other sessions NOT signed out', e);
    return false;
  }

  // 2) Re-mint THIS device's refresh token with the new credential so the
  //    current session outlives the revocation. Best-effort: on failure
  //    (offline blip, MFA-enrolled account) this device simply signs out
  //    with the rest within ~1 h, which is safe.
  try {
    const fbUser = auth.currentUser;
    if (fbUser?.email) {
      await reauthenticateWithCredential(
        fbUser,
        EmailAuthProvider.credential(fbUser.email, newPassword),
      );
    }
  } catch (e) {
    console.warn('[sessionSecurity] keep-current re-auth skipped — this device signs out at next token refresh too', e);
  }
  return true;
}