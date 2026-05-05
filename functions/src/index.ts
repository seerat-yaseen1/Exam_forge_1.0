/**
 * STRATUM Cloud Functions
 *
 * Phase 1 scope:
 *   - createAuthUser: admin-only callable that provisions a Firebase Auth user
 *     and writes the matching profile document into the role's Firestore
 *     collection. Used by Web Owners (and later, Institute Admins / Faculty)
 *     to create accounts without exposing the Admin SDK to the browser.
 *
 * Caller authorisation (Phase 1):
 *   - Only Web Owners may call this endpoint (auth.token.role === 'webOwner').
 *   - Once Phase 3 lands, Institute Admins will be allowed to create faculty
 *     and students within their own institute — gated by custom claims.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp();

type Role = 'webOwner' | 'institute' | 'faculty' | 'student';

const COLLECTION_BY_ROLE: Record<Role, string> = {
  webOwner: 'webowners',
  institute: 'institutes',
  faculty: 'faculty',
  student: 'students',
};

interface CreateAuthUserData {
  role: Role;
  password: string;
  profile: Record<string, unknown> & { email: string; name: string };
}

export const createAuthUser = onCall<CreateAuthUserData>(
  { region: 'us-central1' },
  async (request) => {
    // ── 1. AuthN: caller must be signed in
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign-in required.');
    }

    // ── 2. AuthZ: caller must be a web owner (Phase 1)
    const callerRole = request.auth.token.role as Role | undefined;
    if (callerRole !== 'webOwner') {
      throw new HttpsError('permission-denied', 'Only Web Owners may create accounts.');
    }

    // ── 3. Validate input
    const { role, password, profile } = request.data || ({} as CreateAuthUserData);
    if (!role || !COLLECTION_BY_ROLE[role]) {
      throw new HttpsError('invalid-argument', 'Invalid role.');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new HttpsError('invalid-argument', 'Password must be at least 8 characters.');
    }
    if (!profile?.email || !profile?.name) {
      throw new HttpsError('invalid-argument', 'Profile must include email and name.');
    }

    const email = String(profile.email).toLowerCase().trim();

    // ── 4. Create Firebase Auth user
    const auth = getAuth();
    let uid: string;
    try {
      const userRecord = await auth.createUser({
        email,
        password,
        displayName: String(profile.name),
        emailVerified: false,
        disabled: false,
      });
      uid = userRecord.uid;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/email-already-exists') {
        throw new HttpsError('already-exists', 'An account with this email already exists.');
      }
      throw new HttpsError('internal', 'Failed to create auth user.', code);
    }

    // ── 5. Set custom claim so security rules + this function can authorise by role
    await auth.setCustomUserClaims(uid, { role });

    // ── 6. Write profile doc (no plaintext password!)
    const db = getFirestore();
    const collection = COLLECTION_BY_ROLE[role];
    const { password: _ignored, ...profileSansPassword } = profile as Record<string, unknown>;
    await db.collection(collection).doc(uid).set({
      ...profileSansPassword,
      email,
      uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { ok: true, uid };
  }
);
