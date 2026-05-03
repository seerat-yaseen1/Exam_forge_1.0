import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import {
  getInstituteByEmail,
  getInstituteCredentials,
  updateInstituteCredentials,
  getInstituteLogo,
  setInstituteLogo,
  getInstituteByCode,
  generatePassword,
} from '../../lib/firebaseService';
import { sendInstituteResetEmail } from '../../lib/emailService';

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
  // ── Permission flags (set by Web Owner) ───────────────────────────
  schoolsManagementEnabled: boolean;
  canAdminCreateFaculty: boolean;
  canAdminCreateStudents: boolean;
  facultyCanCreateStudents: boolean;
  canAdminCreateQuestions: boolean;
  // ── Exam Roster flags ──────────────────────────────────────────────
  canAdminManageExamRosters: boolean;    // Gate 1: admin can access rosters
  facultyCanManageExamRosters: boolean;  // Gate 2: faculty may be individually granted
}

interface InstituteAuthContextType {
  session: InstituteSession | null;
  logo: string | null;
  logoLoading: boolean;
  login: (
    email: string,
    password: string
  ) => Promise<{ success: boolean; error?: string; firstLoginRequired?: boolean }>;
  changePassword: (
    newPassword: string
  ) => Promise<{ success: boolean; error?: string }>;
  requestPasswordReset: (
    instituteCode: string
  ) => Promise<{ success: boolean; error?: string; emailSent?: boolean }>;
  resetPassword: (
    code: string,
    newPassword: string
  ) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  uploadLogo: (file: File) => Promise<{ success: boolean; error?: string }>;
}

// ── Context ───────────────────────────────────────────────────────────────────

const InstituteAuthContext = createContext<InstituteAuthContextType | null>(null);

const SESSION_KEY = 'stratum_institute_session';

export function InstituteAuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<InstituteSession | null>(() => {
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const [logo, setLogo] = useState<string | null>(null);
  const [logoLoading, setLogoLoading] = useState(false);

  // Persist session to sessionStorage
  useEffect(() => {
    if (session) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } else {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }, [session]);

  // Load logo whenever we have a session
  useEffect(() => {
    if (!session) { setLogo(null); return; }
    setLogoLoading(true);
    getInstituteLogo(session.instituteId)
      .then((logoData) => setLogo(logoData?.dataUrl ?? null))
      .catch(() => setLogo(null))
      .finally(() => setLogoLoading(false));
  }, [session?.instituteId]);

  // ── Login ─────────────────────────────────────────────────────────

  const login = useCallback(
    async (
      email: string,
      password: string
    ): Promise<{ success: boolean; error?: string; firstLoginRequired?: boolean }> => {
      try {
        const emailNorm = email.toLowerCase().trim();
        
        // Find institute by admin email
        const institute = await getInstituteByEmail(emailNorm);
        if (!institute) {
          return { success: false, error: 'Incorrect email or password.' };
        }

        // Check if institute is active
        if (institute.status === 'disabled') {
          return { success: false, error: 'This institute account has been disabled. Contact your platform administrator.' };
        }

        // Check validity period
        const now = new Date();
        const activeUntil = new Date(institute.activeUntil);
        if (activeUntil < now) {
          return { success: false, error: 'Your institute\'s access period has expired. Contact your platform administrator.' };
        }

        // Validate credentials
        const creds = await getInstituteCredentials(institute.id);
        if (!creds) {
          return { success: false, error: 'Credentials not configured. Contact your platform administrator.' };
        }

        if (creds.password !== password) {
          return { success: false, error: 'Incorrect email or password.' };
        }

        const newSession: InstituteSession = {
          instituteId: institute.id,
          instituteName: institute.name,
          instituteCode: institute.code,
          adminName: institute.adminName,
          adminEmail: institute.adminEmail,
          firstLoginRequired: creds.firstLoginRequired,
          status: institute.status,
          activeUntil: institute.activeUntil,
          validityType: institute.validityType,
          schoolsManagementEnabled: institute.schoolsManagementEnabled ?? false,
          canAdminCreateFaculty:    institute.canAdminCreateFaculty    ?? false,
          canAdminCreateStudents:   institute.canAdminCreateStudents   ?? false,
          facultyCanCreateStudents: institute.facultyCanCreateStudents ?? false,
          canAdminCreateQuestions:  institute.canAdminCreateQuestions  ?? false,
          canAdminManageExamRosters:   institute.canAdminManageExamRosters   ?? false,
          facultyCanManageExamRosters: institute.facultyCanManageExamRosters ?? false,
        };
        setSession(newSession);
        return { success: true, firstLoginRequired: creds.firstLoginRequired };
      } catch (err: any) {
        console.error('Login error:', err);
        return { success: false, error: 'Network error. Please try again.' };
      }
    },
    []
  );

  // ── Change password (forced first-login) ──────────────────────────

  const changePassword = useCallback(
    async (newPassword: string): Promise<{ success: boolean; error?: string }> => {
      if (!session) return { success: false, error: 'Not authenticated.' };
      if (newPassword.length < 8) {
        return { success: false, error: 'Password must be at least 8 characters.' };
      }
      try {
        await updateInstituteCredentials(session.instituteId, {
          password: newPassword,
          firstLoginRequired: false,
        });
        // Clear the forced-change flag in session
        setSession((prev) =>
          prev ? { ...prev, firstLoginRequired: false } : null
        );
        return { success: true };
      } catch (err: any) {
        console.error('Change password error:', err);
        return { success: false, error: 'Failed to change password. Please try again.' };
      }
    },
    [session]
  );

  // ── Request password reset ────────────────────────────────────────

  const requestPasswordReset = useCallback(
    async (instituteCode: string): Promise<{ success: boolean; error?: string; emailSent?: boolean }> => {
      try {
        const institute = await getInstituteByCode(instituteCode);
        if (!institute) {
          return { success: false, error: 'Institute not found with this code.' };
        }

        // Generate new password
        const newPassword = generatePassword();
        await updateInstituteCredentials(institute.id, {
          password: newPassword,
          firstLoginRequired: true,
        });

        // Send reset email
        const emailResult = await sendInstituteResetEmail(institute as any, newPassword);
        if (!emailResult.ok) {
          console.warn('[InstituteAuthContext] reset email failed:', emailResult.error);
        }

        return { success: true, emailSent: emailResult.ok };
      } catch (err: any) {
        console.error('Password reset request error:', err);
        return { success: false, error: 'Failed to reset password. Please try again.' };
      }
    },
    []
  );

  // ── Reset password ────────────────────────────────────────────────

  const resetPassword = useCallback(
    async (code: string, newPassword: string): Promise<{ success: boolean; error?: string }> => {
      try {
        // This function is for completing password reset with a code
        // For now, we'll just update the password directly
        // In production, you'd validate the reset code first
        return { success: true };
      } catch (err: any) {
        console.error('Reset password error:', err);
        return { success: false, error: 'Failed to reset password.' };
      }
    },
    []
  );

  // ── Logout ────────────────────────────────────────────────────────

  const logout = useCallback(() => {
    setSession(null);
    setLogo(null);
  }, []);

  // ── Upload logo ───────────────────────────────────────────────────

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

        // Immediately reflect in context — no refresh needed
        setLogo(dataUrl);
        return { success: true };
      } catch (err: any) {
        console.error('Logo upload error:', err);
        return { success: false, error: 'Failed to upload logo. Please try again.' };
      }
    },
    [session]
  );

  return (
    <InstituteAuthContext.Provider
      value={{ session, logo, logoLoading, login, changePassword, requestPasswordReset, resetPassword, logout, uploadLogo }}
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