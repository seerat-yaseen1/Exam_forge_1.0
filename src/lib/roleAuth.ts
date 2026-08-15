// ══════════════════════════════════════════════════════════════════
// ROLE AUTH — the operations that are the same for every role
// (Audit F-8, stage 2)
// ══════════════════════════════════════════════════════════════════
//
// Stage 1 extracted the ADMISSION decision (accessGate.ts) — the half where a
// divergence is a security bug. This is the next half: the password
// operations, which were written out three times with nothing but a
// collection name and a log prefix between them.
//
// ── WHAT IS HERE, AND WHAT DELIBERATELY IS NOT ────────────────────
//
// HERE: `changePassword` and `requestPasswordReset`. `changePassword` was
// BYTE-IDENTICAL across the three contexts apart from three parameters — the
// credential collection, the document id, and the string in a console warning.
// Forty lines, three times, including the subtle part (see below).
//
// NOT HERE, on purpose:
//
//   • `login` and session-building. That is where the roles genuinely differ —
//     Institute signs in AS the institute and has no member document, Student
//     carries program tag arrays, Faculty neither. A shared login would need a
//     callback per difference, which is the "one component, twelve boolean
//     props" outcome that is harder to read than three honest copies.
//   • `logout`. Four lines, differing only in which state setter is called.
//     The extraction would be longer than the code it replaced.
//   • The Web Owner context. Its password change re-authenticates first and it
//     carries the whole TOTP enrolment flow; it is a different operation that
//     happens to share a name.
//
// ── THE DECISIONS ARE PURE; THE ORCHESTRATION IS THIN ─────────────
//
// Deliberate split. `passwordChangeError` and `resetRequestIsBenign` decide
// what a Firebase error code MEANS, and they are ordinary functions with
// tests. The async wrappers below only sequence the SDK calls around them.
// The part worth getting right is the part that can be checked.

import { sendPasswordResetEmail, updatePassword } from 'firebase/auth';
import { doc, updateDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { revokeOtherSessionsKeepCurrent } from './sessionSecurity';

/** Shared so four screens cannot word one state four ways. */
export const RESET_VIA_EMAIL_MESSAGE =
  'Password reset is now handled via the email link. Please check your inbox.';

/** Matches the Firebase Auth minimum the three contexts each enforced. */
export const MIN_PASSWORD_LENGTH = 8;

export interface AuthOpResult {
  success: boolean;
  error?: string;
}

/**
 * What a failed password change should tell the person in front of it.
 *
 * Returns null for "not a code we recognise" so the caller logs the raw error
 * and shows its generic message — an unknown code must never render as an
 * empty string, which is what a Record lookup would have done.
 */
export function passwordChangeError(code: string | undefined): string | null {
  if (code === 'auth/requires-recent-login') {
    return 'Please sign out and back in, then change your password.';
  }
  if (code === 'auth/weak-password') return 'Password is too weak.';
  return null;
}

/**
 * Is this reset-request failure one we should report as SUCCESS?
 *
 * `auth/user-not-found` is the load-bearing case, and it is not politeness:
 * reporting it honestly turns the reset form into an account-existence oracle,
 * which is exactly the enumeration attack the login form's own comments say
 * this flow avoids.
 *
 * ── A DIVERGENCE THE THREE COPIES HAD ─────────────────────────────
 *
 * Institute and Faculty also swallowed `auth/invalid-email`; Student did not.
 * So a student who mistyped their address got "Failed to send reset email.
 * Please try again." — an error, for a typo they could have fixed — while the
 * same mistake on the faculty form silently reported success.
 *
 * Resolved toward the NARROWER reading, i.e. Student's. A malformed address is
 * a format problem the person can see and correct, and it reveals nothing
 * about whether an account exists — so an honest error is better UX and costs
 * no enumeration safety. The two roles that swallowed it were hiding a typo.
 */
export function resetRequestIsBenign(code: string | undefined): boolean {
  return code === 'auth/user-not-found';
}

/**
 * Change the signed-in user's password, then invalidate every other session.
 *
 * Returns the result; the CALLER updates its own session state on success.
 * That split is why this can be shared at all — the three contexts hold
 * differently-shaped sessions, but the operation itself is identical.
 */
export async function changeRolePassword(opts: {
  newPassword: string;
  /** e.g. 'studentCredentials' */
  credentialCollection: string;
  /** The credential document id — the role's own id, not the Auth uid. */
  credentialDocId: string;
  /** Prefix for the one warning this can emit, e.g. '[StudentAuth]'. */
  logLabel: string;
}): Promise<AuthOpResult> {
  const { newPassword, credentialCollection, credentialDocId, logLabel } = opts;

  const fbUser = auth.currentUser;
  if (!fbUser) return { success: false, error: 'Not authenticated.' };
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { success: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  try {
    await updatePassword(fbUser, newPassword);

    // BOOKKEEPING, NOT THE OPERATION — and it must not be able to fail the
    // operation. This was the subtle part, and all three copies carried the
    // same long comment explaining it: a bare `await` here reported "Failed to
    // change password" AFTER the password had already changed, and skipped the
    // session revocation below, which is the entire security point of the flow.
    //
    // It rejects routinely: updateDoc REQUIRES the document to exist, and the
    // credential collections are empty — createAuthUser stopped writing them
    // when the plaintext password was removed. A not-found is also harmless,
    // because every context reads the flag as `snap.exists() ? … : false`, so
    // an absent document already means the state this write was reaching for.
    try {
      await updateDoc(doc(db, credentialCollection, credentialDocId), {
        firstLoginRequired: false,
      });
    } catch (e) {
      console.warn(`${logLabel} could not clear firstLoginRequired — the password change stands`, e);
    }

    // The credential changed, so every other session holding the old one — or
    // the provisioned one, on a first-login change — is signed out. Best
    // effort: the password change has already succeeded. This device is
    // re-authenticated inside the helper so it survives its own revocation.
    await revokeOtherSessionsKeepCurrent(newPassword);
    return { success: true };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    const known = passwordChangeError(code);
    if (known) return { success: false, error: known };
    console.error(`${logLabel} change password error:`, err);
    return { success: false, error: 'Failed to change password. Please try again.' };
  }
}

/**
 * Send the reset email, reporting success for the one failure that must not
 * be distinguishable from it. See resetRequestIsBenign.
 */
export async function requestRolePasswordReset(
  email: string,
  logLabel: string,
): Promise<{ success: boolean; error?: string; emailSent?: boolean }> {
  const emailNorm = email.toLowerCase().trim();
  if (!emailNorm) return { success: false, error: 'Please enter your email address.' };
  try {
    await sendPasswordResetEmail(auth, emailNorm);
    return { success: true, emailSent: true };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (resetRequestIsBenign(code)) return { success: true, emailSent: true };
    console.error(`${logLabel} reset request error:`, err);
    return { success: false, error: 'Failed to send reset email. Please try again.' };
  }
}
