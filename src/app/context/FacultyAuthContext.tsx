import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  updatePassword,
  type User as FirebaseUser,
} from 'firebase/auth';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { auth, db } from '../../lib/firebase';
import { revokeOtherSessionsKeepCurrent } from '../../lib/sessionSecurity';
import { getInstituteLogo } from '../../lib/firebaseService';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FacultySession {
  facultyId: string;
  name: string;
  email: string;
  role: 'Faculty';
  status: 'active' | 'disabled';
  firstLoginRequired: boolean;
  instituteId: string;
  instituteName: string;
  instituteCode: string;
  createdAt: string;
  canCreateStudents: boolean;
  canManageExamRosters: boolean;
}

interface FacultyAuthContextType {
  session: FacultySession | null;
  loading: boolean;
  instituteLogo: string | null;
  logoLoading: boolean;
  login: (
    instituteCode: string,
    email: string,
    password: string
  ) => Promise<{ success: boolean; error?: string; firstLoginRequired?: boolean }>;
  changePassword: (newPassword: string) => Promise<{ success: boolean; error?: string }>;
  requestPasswordReset: (
    instituteCode: string,
    email: string
  ) => Promise<{ success: boolean; error?: string; emailSent?: boolean }>;
  resetPassword: (code: string, newPassword: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
}

const FacultyAuthContext = createContext<FacultyAuthContextType | null>(null);

interface BuildResult {
  session: FacultySession | null;
  reason?: 'not_faculty' | 'no_faculty_doc' | 'no_institute_doc' | 'disabled' | 'expired' | 'wrong_institute_code';
  firstLoginRequired: boolean;
}

async function buildSessionFromAuthUser(
  fbUser: FirebaseUser,
  expectedInstituteCode?: string
): Promise<BuildResult> {
  const tokenResult = await fbUser.getIdTokenResult(true);
  const role = tokenResult.claims.role as string | undefined;
  const instituteId = tokenResult.claims.instituteId as string | undefined;
  const facultyId = tokenResult.claims.facultyId as string | undefined;

  if (role !== 'faculty' || !instituteId || !facultyId) {
    return { session: null, reason: 'not_faculty', firstLoginRequired: false };
  }

  const [facSnap, instSnap, credSnap] = await Promise.all([
    getDoc(doc(db, 'faculty', facultyId)),
    getDoc(doc(db, 'institutes', instituteId)),
    getDoc(doc(db, 'facultyCredentials', facultyId)),
  ]);

  if (!facSnap.exists()) {
    return { session: null, reason: 'no_faculty_doc', firstLoginRequired: false };
  }
  if (!instSnap.exists()) {
    return { session: null, reason: 'no_institute_doc', firstLoginRequired: false };
  }

  const fac = facSnap.data() as Record<string, unknown>;
  const inst = instSnap.data() as Record<string, unknown>;

  if (
    expectedInstituteCode &&
    String(inst.code ?? '').toUpperCase() !== expectedInstituteCode.toUpperCase()
  ) {
    return { session: null, reason: 'wrong_institute_code', firstLoginRequired: false };
  }
  // Feature #15 — soft delete sets `lifecycleState`, NOT `status`. The two are
  // deliberately separate axes (a disabled person is still lifecycle-active),
  // which meant checking only `status` let deleted accounts — and members of a
  // DELETED INSTITUTE — sign in and sit exams exactly as before. Blocking
  // access is the entire point of the deletion, so the lifecycle axis is
  // checked here too.
  if (
    inst.status === 'disabled' || fac.status === 'disabled'
    || inst.lifecycleState === 'softDeleted' || fac.lifecycleState === 'softDeleted'
  ) {
    return { session: null, reason: 'disabled', firstLoginRequired: false };
  }
  const activeUntil = String(inst.activeUntil ?? '');
  if (activeUntil && new Date(activeUntil) < new Date()) {
    return { session: null, reason: 'expired', firstLoginRequired: false };
  }

  const firstLoginRequired = credSnap.exists()
    ? Boolean((credSnap.data() as { firstLoginRequired?: boolean }).firstLoginRequired)
    : false;

  const session: FacultySession = {
    facultyId,
    name: String(fac.name ?? ''),
    email: String(fac.email ?? fbUser.email ?? ''),
    role: 'Faculty',
    status: (fac.status as 'active' | 'disabled') ?? 'active',
    firstLoginRequired,
    instituteId,
    instituteName: String(inst.name ?? ''),
    instituteCode: String(inst.code ?? ''),
    createdAt: String(fac.createdAt ?? ''),
    canCreateStudents:
      Boolean(inst.facultyCanCreateStudents ?? false) && Boolean(fac.canCreateStudents ?? false),
    canManageExamRosters:
      Boolean(inst.facultyCanManageExamRosters ?? false) &&
      Boolean(fac.canManageExamRosters ?? false),
  };

  return { session, firstLoginRequired };
}

export function FacultyAuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<FacultySession | null>(null);
  const [loading, setLoading] = useState(true);
  const [instituteLogo, setInstituteLogo] = useState<string | null>(null);
  const [logoLoading, setLogoLoading] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) {
        setSession(null);
        setLoading(false);
        return;
      }
      try {
        const { session: built } = await buildSessionFromAuthUser(fbUser);
        setSession(built);
      } catch (err) {
        console.error('Faculty auth state load error:', err);
        setSession(null);
      } finally {
        setLoading(false);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!session?.instituteId) {
      setInstituteLogo(null);
      return;
    }
    setLogoLoading(true);
    getInstituteLogo(session.instituteId)
      .then((logoData) => setInstituteLogo(logoData?.dataUrl ?? null))
      .catch(() => setInstituteLogo(null))
      .finally(() => setLogoLoading(false));
  }, [session?.instituteId]);

  const login = useCallback(
    async (
      instituteCode: string,
      email: string,
      password: string
    ): Promise<{ success: boolean; error?: string; firstLoginRequired?: boolean }> => {
      try {
        const emailNorm = email.toLowerCase().trim();
        const codeNorm = instituteCode.toUpperCase().trim();

        const cred = await signInWithEmailAndPassword(auth, emailNorm, password);
        const { session: built, firstLoginRequired, reason } = await buildSessionFromAuthUser(
          cred.user,
          codeNorm
        );

        if (!built) {
          await signOut(auth);
          if (reason === 'wrong_institute_code') {
            return { success: false, error: 'Faculty account not found in this institute.' };
          }
          if (reason === 'disabled') {
            return {
              success: false,
              error: 'Your account has been disabled. Contact your administrator.',
            };
          }
          if (reason === 'expired') {
            return {
              success: false,
              error: 'Institute access period has expired. Contact your administrator.',
            };
          }
          return { success: false, error: 'This account is not a Faculty account.' };
        }

        setSession(built);
        return { success: true, firstLoginRequired };
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (
          code === 'auth/invalid-credential' ||
          code === 'auth/wrong-password' ||
          code === 'auth/user-not-found'
        ) {
          return { success: false, error: 'Incorrect email or password.' };
        }
        if (code === 'auth/too-many-requests') {
          return { success: false, error: 'Too many attempts. Try again in a few minutes.' };
        }
        console.error('Faculty login error:', err);
        return { success: false, error: 'Network error. Please try again.' };
      }
    },
    []
  );

  const changePassword = useCallback(
    async (newPassword: string): Promise<{ success: boolean; error?: string }> => {
      const fbUser = auth.currentUser;
      if (!fbUser || !session) return { success: false, error: 'Not authenticated.' };
      if (newPassword.length < 8) {
        return { success: false, error: 'Password must be at least 8 characters.' };
      }
      try {
        await updatePassword(fbUser, newPassword);
        await updateDoc(doc(db, 'facultyCredentials', session.facultyId), {
          firstLoginRequired: false,
        });
        setSession((prev) => (prev ? { ...prev, firstLoginRequired: false } : null));
        // C'-1 (scoped): the credential changed — sign out every other
        // session (covers first-login forced changes too, killing anyone
        // else holding the provisioned password). Best-effort; the password
        // change has already succeeded. This device is re-authenticated with
        // the new password inside the helper so it survives the revocation.
        await revokeOtherSessionsKeepCurrent(newPassword);
        return { success: true };
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'auth/requires-recent-login') {
          return { success: false, error: 'Please sign out and back in, then change your password.' };
        }
        if (code === 'auth/weak-password') {
          return { success: false, error: 'Password is too weak.' };
        }
        console.error('Faculty change password error:', err);
        return { success: false, error: 'Failed to change password. Please try again.' };
      }
    },
    [session]
  );

  const requestPasswordReset = useCallback(
    async (
      instituteCode: string,
      email: string
    ): Promise<{ success: boolean; error?: string; emailSent?: boolean }> => {
      try {
        void instituteCode; // kept for API compat; the previous institute-code
        // pre-check ran an UNAUTHENTICATED Firestore query — denied by the
        // security rules (flow was silently broken) and it leaked whether a
        // code exists. Firebase Auth keys the reset on the email alone.
        const emailNorm = email.toLowerCase().trim();
        await sendPasswordResetEmail(auth, emailNorm);
        return { success: true, emailSent: true };
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'auth/user-not-found' || code === 'auth/invalid-email') {
          return { success: true, emailSent: true };
        }
        console.error('Faculty reset request error:', err);
        return { success: false, error: 'Failed to send reset email. Please try again.' };
      }
    },
    []
  );

  const resetPassword = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    return {
      success: false,
      error: 'Password reset is now handled via the email link. Please check your inbox.',
    };
  }, []);

  const logout = useCallback(async () => {
    await signOut(auth);
    setSession(null);
    setInstituteLogo(null);
  }, []);

  return (
    <FacultyAuthContext.Provider
      value={{
        session,
        loading,
        instituteLogo,
        logoLoading,
        login,
        changePassword,
        requestPasswordReset,
        resetPassword,
        logout,
      }}
    >
      {children}
    </FacultyAuthContext.Provider>
  );
}

export function useFacultyAuth() {
  const ctx = useContext(FacultyAuthContext);
  if (!ctx) throw new Error('useFacultyAuth must be used within FacultyAuthProvider');
  return ctx;
}