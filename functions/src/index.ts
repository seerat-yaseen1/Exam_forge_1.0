/**
 * STRATUM Cloud Functions
 *
 * createAuthUser — admin-only callable that provisions a Firebase Auth user
 * and writes the matching profile document into the role's Firestore
 * collection.
 *
 * Caller authorisation:
 *   • Web Owner   → can create any role.
 *   • Institute   → can create faculty or student in own institute only.
 *   • Faculty     → can create student in own institute only.
 *   • Student     → cannot call this endpoint.
 *
 * Custom claims set on the new user:
 *   webOwner  → { role }
 *   institute → { role, instituteId: uid }
 *   faculty   → { role, instituteId, facultyId: uid }
 *   student   → { role, instituteId, studentId: uid }
 *
 * The doc id of the new profile document equals the Firebase Auth uid.
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
  // Required when role === 'faculty' | 'student'.
  // For role === 'institute' the new institute's id IS the uid; ignored.
  // For role === 'webOwner'  ignored.
  instituteId?: string;
}

function authorizeCaller(
  callerRole: Role | undefined,
  callerInstituteId: string | undefined,
  targetRole: Role,
  targetInstituteId: string | undefined
): void {
  if (callerRole === 'webOwner') return;

  if (callerRole === 'institute') {
    if (targetRole !== 'faculty' && targetRole !== 'student') {
      throw new HttpsError('permission-denied', 'Institute admins may only create faculty or students.');
    }
    if (!callerInstituteId || callerInstituteId !== targetInstituteId) {
      throw new HttpsError('permission-denied', 'instituteId must match caller.');
    }
    return;
  }

  if (callerRole === 'faculty') {
    if (targetRole !== 'student') {
      throw new HttpsError('permission-denied', 'Faculty may only create students.');
    }
    if (!callerInstituteId || callerInstituteId !== targetInstituteId) {
      throw new HttpsError('permission-denied', 'instituteId must match caller.');
    }
    return;
  }

  throw new HttpsError('permission-denied', 'Insufficient permissions.');
}

export const createAuthUser = onCall<CreateAuthUserData>(
  { region: 'us-central1' },
  async (request) => {
    // ── 1. AuthN
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign-in required.');
    }
    const callerRole         = request.auth.token.role         as Role   | undefined;
    const callerInstituteId  = request.auth.token.instituteId  as string | undefined;

    // ── 2. Validate input
    const { role, password, profile, instituteId: providedInstituteId } =
      request.data || ({} as CreateAuthUserData);

    if (!role || !COLLECTION_BY_ROLE[role]) {
      throw new HttpsError('invalid-argument', 'Invalid role.');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new HttpsError('invalid-argument', 'Password must be at least 8 characters.');
    }
    if (!profile?.email || !profile?.name) {
      throw new HttpsError('invalid-argument', 'Profile must include email and name.');
    }

    // For faculty / student, instituteId must be supplied explicitly.
    if ((role === 'faculty' || role === 'student') && !providedInstituteId) {
      throw new HttpsError('invalid-argument', 'instituteId is required for faculty / student creation.');
    }

    // ── 3. AuthZ
    const targetInstituteId =
      role === 'institute'
        ? undefined // resolved to uid after creation
        : role === 'webOwner'
          ? undefined
          : providedInstituteId;

    authorizeCaller(callerRole, callerInstituteId, role, targetInstituteId);

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

    // ── 5. Set custom claims
    const claims: Record<string, unknown> = { role };
    if (role === 'institute') {
      claims.instituteId = uid;
    } else if (role === 'faculty') {
      claims.instituteId = providedInstituteId;
      claims.facultyId   = uid;
    } else if (role === 'student') {
      claims.instituteId = providedInstituteId;
      claims.studentId   = uid;
    }
    await auth.setCustomUserClaims(uid, claims);

    // ── 6. Write profile doc (never store plaintext password)
    const db = getFirestore();
    const collection = COLLECTION_BY_ROLE[role];
    const { password: _ignored, ...profileSansPassword } = profile as Record<string, unknown>;

    const docData: Record<string, unknown> = {
      ...profileSansPassword,
      email,
      uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    // Stamp the canonical id field expected by the rest of the app.
    if (role === 'institute') {
      docData.id = uid;
    } else if (role === 'faculty' || role === 'student') {
      docData.id          = uid;
      docData.instituteId = providedInstituteId;
    }

    await db.collection(collection).doc(uid).set(docData);

    return { ok: true, uid };
  }
);
