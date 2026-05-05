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
import { getInstituteByCode, getInstituteLogo } from '../../lib/firebaseService';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface StudentSession {
  studentId: string;
  name: string;
  email: string;
  role: 'Student';
  status: 'active' | 'disabled';
  firstLoginRequired: boolean;
  instituteId: string;
  instituteName: string;
  instituteCode: string;
  createdAt: string;
}

interface StudentAuthContextType {
  session: StudentSession | null;
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

const StudentAuthContext = createContext<StudentAuthContextType | null>(null);

interface BuildResult {
  session: StudentSession | null;
  reason?: 'not_student' | 'no_student_doc' | 'no_institute_doc' | 'disabled' | 'expired' | 'wrong_institute_code';
  firstLoginRequired: boolean;
}

async function buildSessionFromAuthUser(
  fbUser: FirebaseUser,
  expectedInstituteCode?: string
): Promise<BuildResult> {
  const tokenResult = await fbUser.getIdTokenResult();
  const role = tokenResult.claims.role as string | undefined;
  const instituteId = tokenResult.claims.instituteId as string | undefined;
  const studentId = tokenResult.claims.studentId as string | undefined;

  if (role !== 'student' || !instituteId || !studentId) {
    return { session: null, reason: 'not_student', firstLoginRequired: false };
  }

  const [stuSnap, instSnap, credSnap] = await Promise.all([
    getDoc(doc(db, 'students', studentId)),
    getDoc(doc(db, 'institutes', instituteId)),
    getDoc(doc(db, 'studentCredentials', studentId)),
  ]);

  if (!stuSnap.exists()) {
    return { session: null, reason: 'no_student_doc', firstLoginRequired: false };
  }
  if (!instSnap.exists()) {
    return { session: null, reason: 'no_institute_doc', firstLoginRequired: false };
  }

  const stu = stuSnap.data() as Record<string, unknown>;
  const inst = instSnap.data() as Record<string, unknown>;

  if (
    expectedInstituteCode &&
    String(inst.code ?? '').toUpperCase() !== expectedInstituteCode.toUpperCase()
  ) {
    return { session: null, reason: 'wrong_institute_code', firstLoginRequired: false };
  }
  if (inst.status === 'disabled' || stu.status === 'disabled') {
    return { session: null, reason: 'disabled', firstLoginRequired: false };
  }
  const activeUntil = String(inst.activeUntil ?? '');
  if (activeUntil && new Date(activeUntil) < new Date()) {
    return { session: null, reason: 'expired', firstLoginRequired: false };
  }

  const firstLoginRequired = credSnap.exists()
    ? Boolean((credSnap.data() as { firstLoginRequired?: boolean }).firstLoginRequired)
    : false;

  const session: StudentSession = {
    studentId,
    name: String(stu.name ?? ''),
    email: String(stu.email ?? fbUser.email ?? ''),
    role: 'Student',
    status: (stu.status as 'active' | 'disabled') ?? 'active',
    firstLoginRequired,
    instituteId,
    instituteName: String(inst.name ?? ''),
    instituteCode: String(inst.code ?? ''),
    createdAt: String(stu.createdAt ?? ''),
  };

  return { session, firstLoginRequired };
}

export function StudentAuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<StudentSession | null>(null);
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
        console.error('Student auth state load error:', err);
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
            return { success: false, error: 'Student account not found in this institute.' };
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
          return { success: false, error: 'This account is not a Student account.' };
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
        console.error('Student login error:', err);
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
        await updateDoc(doc(db, 'studentCredentials', session.studentId), {
          firstLoginRequired: false,
        });
        setSession((prev) => (prev ? { ...prev, firstLoginRequired: false } : null));
        return { success: true };
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'auth/requires-recent-login') {
          return { success: false, error: 'Please sign out and back in, then change your password.' };
        }
        if (code === 'auth/weak-password') {
          return { success: false, error: 'Password is too weak.' };
        }
        console.error('Student change password error:', err);
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
        const emailNorm = email.toLowerCase().trim();
        const codeNorm = instituteCode.toUpperCase().trim();
        const institute = await getInstituteByCode(codeNorm);
        if (!institute) {
          return { success: false, error: 'Institute not found with this code.' };
        }
        await sendPasswordResetEmail(auth, emailNorm);
        return { success: true, emailSent: true };
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'auth/user-not-found') {
          return { success: true, emailSent: true };
        }
        console.error('Student reset request error:', err);
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
    <StudentAuthContext.Provider
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
    </StudentAuthContext.Provider>
  );
}

export function useStudentAuth() {
  const ctx = useContext(StudentAuthContext);
  if (!ctx) throw new Error('useStudentAuth must be used within StudentAuthProvider');
  return ctx;
}
