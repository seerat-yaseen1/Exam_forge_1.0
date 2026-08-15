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
import {
  getInstituteLogo,
  setInstituteLogo,
} from '../../lib/firebaseService';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface InstituteSession {
  instituteId: string;
  instituteName: string;
  instituteCode: string;
  adminName: string;
  adminEmail: string;
  firstLoginRequired: boolean;
  status: 'active' | 'disabled';
  activeUntil: string;
  validityType: string;
  schoolsManagementEnabled: boolean;
  canAdminCreateFaculty: boolean;
  canAdminCreateStudents: boolean;
  facultyCanCreateStudents: boolean;
  canAdminCreateQuestions: boolean;
  canAdminManageExamRosters: boolean;
  facultyCanManageExamRosters: boolean;
}

interface InstituteAuthContextType {
  session: InstituteSession | null;
  loading: boolean;
  logo: string | null;
  logoLoading: boolean;
  login: (
    email: string,
    password: string
  ) => Promise<{ success: boolean; error?: string; firstLoginRequired?: boolean }>;
  changePassword: (newPassword: string) => Promise<{ success: boolean; error?: string }>;
  requestPasswordReset: (
    instituteCode: string
  ) => Promise<{ success: boolean; error?: string; emailSent?: boolean }>;
  /** Phase 3: in-app reset code form is no longer used; resets go via email link. */
  resetPassword: (code: string, newPassword: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  uploadLogo: (file: File) => Promise<{ success: boolean; error?: string }>;
}

const InstituteAuthContext = createContext<InstituteAuthContextType | null>(null);

async function buildSessionFromAuthUser(
  fbUser: FirebaseUser
): Promise<{ session: InstituteSession | null; firstLoginRequired: boolean; reason?: string }> {
  // forceRefresh: pull the latest custom claims rather than the cached ones —
  // necessary for accounts whose claims were set just moments before sign-in.
  const tokenResult = await fbUser.getIdTokenResult(true);
  const role = tokenResult.claims.role as string | undefined;
  const instituteId = tokenResult.claims.instituteId as string | undefined;

  if (role !== 'institute' || !instituteId) {
    return { session: null, firstLoginRequired: false, reason: 'not_institute' };
  }

  const instSnap = await getDoc(doc(db, 'institutes', instituteId));
  if (!instSnap.exists()) {
    return { session: null, firstLoginRequired: false, reason: 'no_institute_doc' };
  }
  const inst = instSnap.data() as Record<string, unknown>;

  // Feature #15 — soft delete sets `lifecycleState`, NOT `status`. The two are
  // deliberately separate axes (a disabled person is still lifecycle-active),
  // which meant checking only `status` let deleted accounts — and members of a
  // DELETED INSTITUTE — sign in and sit exams exactly as before.
  //
  // That fix had to be applied to each of the three contexts separately, and
  // nothing would have failed if one had been missed — so the decision now
  // lives in ONE tested place (audit F-8). See lib/accessGate.ts.
  // No member document: an Institute Admin signs in AS the institute.
  const denial = evaluateAccess(inst, null);
  if (denial) {
    return { session: null, firstLoginRequired: false, reason: denial };
  }

  // firstLoginRequired now lives on instituteCredentials/{instituteId}
  const credSnap = await getDoc(doc(db, 'instituteCredentials', instituteId));
  const firstLoginRequired = credSnap.exists()
    ? Boolean((credSnap.data() as { firstLoginRequired?: boolean }).firstLoginRequired)
    : false;

  const session: InstituteSession = {
    instituteId,
    instituteName: String(inst.name ?? ''),
    instituteCode: String(inst.code ?? ''),
    adminName: String(inst.adminName ?? ''),
    adminEmail: String(inst.adminEmail ?? fbUser.email ?? ''),
    firstLoginRequired,
    status: (inst.status as 'active' | 'disabled') ?? 'active',
    // Carried on the session for display (see instituteValidity's helpers).
    // The gate above no longer needs a local binding for it — evaluateAccess
    // reads the field itself — but the session still surfaces it, with the
    // same String(… ?? '') coercion it always had.
    activeUntil: String(inst.activeUntil ?? ''),
    validityType: String(inst.validityType ?? ''),
    schoolsManagementEnabled: Boolean(inst.schoolsManagementEnabled ?? false),
    canAdminCreateFaculty: Boolean(inst.canAdminCreateFaculty ?? false),
    canAdminCreateStudents: Boolean(inst.canAdminCreateStudents ?? false),
    facultyCanCreateStudents: Boolean(inst.facultyCanCreateStudents ?? false),
    canAdminCreateQuestions: Boolean(inst.canAdminCreateQuestions ?? false),
    canAdminManageExamRosters: Boolean(inst.canAdminManageExamRosters ?? false),
    facultyCanManageExamRosters: Boolean(inst.facultyCanManageExamRosters ?? false),
  };

  return { session, firstLoginRequired };
}

export function InstituteAuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<InstituteSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [logo, setLogo] = useState<string | null>(null);
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
        console.error('Institute auth state load error:', err);
        setSession(null);
      } finally {
        setLoading(false);
      }
    });
    return () => unsub();
  }, []);

  // Load logo whenever we have a session
  useEffect(() => {
    if (!session) {
      setLogo(null);
      return;
    }
    setLogoLoading(true);
    getInstituteLogo(session.instituteId)
      .then((logoData) => setLogo(logoData?.dataUrl ?? null))
      .catch(() => setLogo(null))
      .finally(() => setLogoLoading(false));
  }, [session?.instituteId]);

  const login = useCallback(
    async (
      email: string,
      password: string
    ): Promise<{ success: boolean; error?: string; firstLoginRequired?: boolean }> => {
      try {
        const emailNorm = email.toLowerCase().trim();
        const cred = await signInWithEmailAndPassword(auth, emailNorm, password);
        const { session: built, firstLoginRequired, reason } = await buildSessionFromAuthUser(
          cred.user
        );

        if (!built) {
          await signOut(auth);
          if (reason === 'disabled') {
            return {
              success: false,
              error: 'This institute account has been disabled. Contact your platform administrator.',
            };
          }
          if (reason === 'expired') {
            return {
              success: false,
              error: "Your institute's access period has expired. Contact your platform administrator.",
            };
          }
          return { success: false, error: 'This account is not an Institute Admin account.' };
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
        console.error('Institute login error:', err);
        return { success: false, error: 'Network error. Please try again.' };
      }
    },
    []
  );

  const changePassword = useCallback(
    async (newPassword: string): Promise<{ success: boolean; error?: string }> => {
      if (!session) return { success: false, error: 'Not authenticated.' };
      // The operation is identical for all three roles — only the credential
      // document differs (audit F-8 stage 2). lib/roleAuth owns the sequence,
      // including the bookkeeping-must-not-fail-the-operation subtlety that was
      // written out three times; this context owns its own session shape.
      const res = await changeRolePassword({
        newPassword,
        credentialCollection: 'instituteCredentials',
        credentialDocId: session.instituteId,
        logLabel: '[InstituteAuth]',
      });
      if (res.success) {
        setSession((prev) => (prev ? { ...prev, firstLoginRequired: false } : null));
      }
      return res;
    },
    [session]
  );

  const requestPasswordReset = useCallback(
    async (adminEmail: string): Promise<{ success: boolean; error?: string; emailSent?: boolean }> => {
      return requestRolePasswordReset(adminEmail, '[InstituteAuth]');
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
    setLogo(null);
  }, []);

  const uploadLogo = useCallback(
    async (file: File): Promise<{ success: boolean; error?: string }> => {
      if (!session) return { success: false, error: 'Not authenticated.' };
      if (file.size > 2 * 1024 * 1024) {
        return { success: false, error: 'Logo must be smaller than 2 MB.' };
      }
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        await setInstituteLogo(session.instituteId, {
          dataUrl,
          updatedAt: new Date().toISOString(),
        });

        setLogo(dataUrl);
        return { success: true };
      } catch (err) {
        console.error('Logo upload error:', err);
        return { success: false, error: 'Failed to upload logo. Please try again.' };
      }
    },
    [session]
  );

  return (
    <InstituteAuthContext.Provider
      value={{
        session,
        loading,
        logo,
        logoLoading,
        login,
        changePassword,
        requestPasswordReset,
        resetPassword,
        logout,
        uploadLogo,
      }}
    >
      {children}
    </InstituteAuthContext.Provider>
  );
}

export function useInstituteAuth() {
  const ctx = useContext(InstituteAuthContext);
  if (!ctx) throw new Error('useInstituteAuth must be used within InstituteAuthProvider');
  return ctx;
}