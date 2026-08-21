import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  type User as FirebaseUser,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../../lib/firebase';
import { evaluateAccess } from '../../lib/accessGate';
import {
  RESET_VIA_EMAIL_MESSAGE,
  changeRolePassword,
  requestRolePasswordReset,
} from '../../lib/roleAuth';
import { getInstituteLogo } from '../../lib/firebaseService';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FacultySession {
  facultyId: string;
  name: string;
  email: string;
  role: 'Faculty';
  status: 'active' | 'disabled';
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
  ) => Promise<{ success: boolean; error?: string }>;
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
    return { session: null, reason: 'not_faculty' };
  }

  const [facSnap, instSnap] = await Promise.all([
    getDoc(doc(db, 'faculty', facultyId)),
    getDoc(doc(db, 'institutes', instituteId)),
  ]);

  if (!facSnap.exists()) {
    return { session: null, reason: 'no_faculty_doc' };
  }
  if (!instSnap.exists()) {
    return { session: null, reason: 'no_institute_doc' };
  }

  const fac = facSnap.data() as Record<string, unknown>;
  const inst = instSnap.data() as Record<string, unknown>;

  if (
    expectedInstituteCode &&
    String(inst.code ?? '').toUpperCase() !== expectedInstituteCode.toUpperCase()
  ) {
    return { session: null, reason: 'wrong_institute_code' };
  }
  // Feature #15 — soft delete sets `lifecycleState`, NOT `status`. The two are
  // deliberately separate axes (a disabled person is still lifecycle-active),
  // which meant checking only `status` let deleted accounts — and members of a
  // DELETED INSTITUTE — sign in and sit exams exactly as before. Blocking
  // access is the entire point of the deletion, so the lifecycle axis is
  // checked here too.
  const denial = evaluateAccess(inst, fac);
  if (denial) {
    return { session: null, reason: denial };
  }

  const session: FacultySession = {
    facultyId,
    name: String(fac.name ?? ''),
    email: String(fac.email ?? fbUser.email ?? ''),
    role: 'Faculty',
    status: (fac.status as 'active' | 'disabled') ?? 'active',
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

  return { session };
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
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const emailNorm = email.toLowerCase().trim();
        const codeNorm = instituteCode.toUpperCase().trim();

        const cred = await signInWithEmailAndPassword(auth, emailNorm, password);
        const { session: built, reason } = await buildSessionFromAuthUser(
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
        return { success: true };
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
      if (!session) return { success: false, error: 'Not authenticated.' };
      // The operation is identical for all three roles (audit F-8 stage 2);
      // lib/roleAuth owns the sequence, including the session revocation that
      // is the security point of it.
      return changeRolePassword({ newPassword, logLabel: '[FacultyAuth]' });
    },
    [session]
  );

  const requestPasswordReset = useCallback(
    async (instituteCode: string, email: string): Promise<{ success: boolean; error?: string; emailSent?: boolean }> => {
      void instituteCode;   // kept for API compatibility; unused since the
                            // institute code stopped gating the reset email.
      return requestRolePasswordReset(email, '[FacultyAuth]');
    },
    []
  );

  const resetPassword = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    return {
      success: false,
      error: RESET_VIA_EMAIL_MESSAGE,
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