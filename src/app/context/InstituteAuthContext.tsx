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

  if (inst.status === 'disabled') {
    return { session: null, firstLoginRequired: false, reason: 'disabled' };
  }
  const activeUntil = String(inst.activeUntil ?? '');
  if (activeUntil && new Date(activeUntil) < new Date()) {
    return { session: null, firstLoginRequired: false, reason: 'expired' };
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
    activeUntil,
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
      const fbUser = auth.currentUser;
      if (!fbUser || !session) return { success: false, error: 'Not authenticated.' };
      if (newPassword.length < 8) {
        return { success: false, error: 'Password must be at least 8 characters.' };
      }

      try {
        await updatePassword(fbUser, newPassword);
        await updateDoc(doc(db, 'instituteCredentials', session.instituteId), {
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
        console.error('Institute change password error:', err);
        return { success: false, error: 'Failed to change password. Please try again.' };
      }
    },
    [session]
  );

  const requestPasswordReset = useCallback(
    async (
      adminEmail: string
    ): Promise<{ success: boolean; error?: string; emailSent?: boolean }> => {
      // Email-based reset. The previous flow looked up the institute by code
      // via a Firestore query — which (a) runs UNAUTHENTICATED here and is
      // denied by the security rules (the flow was silently broken), and
      // (b) leaked whether an institute code exists. Firebase Auth keys the
      // reset on the email itself; no Firestore read is needed.
      try {
        const emailNorm = adminEmail.toLowerCase().trim();
        if (!emailNorm) {
          return { success: false, error: 'Please enter the admin email.' };
        }
        await sendPasswordResetEmail(auth, emailNorm);
        return { success: true, emailSent: true };
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'auth/user-not-found' || code === 'auth/invalid-email') {
          // Don't leak whether the account exists
          return { success: true, emailSent: true };
        }
        console.error('Institute reset request error:', err);
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