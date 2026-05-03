import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import {
  getFacultyByEmail,
  getFacultyCredentials,
  updateFacultyCredentials,
  getInstituteLogo,
  getInstituteByCode,
  getInstitute,
  generatePassword,
} from '../../lib/firebaseService';
import { sendFacultyResetEmail } from '../../lib/emailService';

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
  // ── Computed permissions: true only when BOTH gates are open ──────
  canCreateStudents: boolean;
  canManageExamRosters: boolean;  // institute.facultyCanManageExamRosters AND faculty.canManageExamRosters
}

interface FacultyAuthContextType {
  session: FacultySession | null;
  instituteLogo: string | null;
  logoLoading: boolean;
  login: (
    instituteCode: string,
    email: string,
    password: string
  ) => Promise<{ success: boolean; error?: string; firstLoginRequired?: boolean }>;
  changePassword: (
    newPassword: string
  ) => Promise<{ success: boolean; error?: string }>;
  requestPasswordReset: (
    instituteCode: string,
    email: string
  ) => Promise<{ success: boolean; error?: string; emailSent?: boolean }>;
  resetPassword: (
    code: string,
    newPassword: string
  ) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
}

// ── Context ───────────────────────────────────────────────────────────────────

const FacultyAuthContext = createContext<FacultyAuthContextType | null>(null);

const SESSION_KEY = 'stratum_faculty_session';

export function FacultyAuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<FacultySession | null>(() => {
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const [instituteLogo, setInstituteLogo] = useState<string | null>(null);
  const [logoLoading, setLogoLoading]     = useState(false);

  // Persist session
  useEffect(() => {
    if (session) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } else {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }, [session]);

  // Load institute logo whenever session instituteId changes
  useEffect(() => {
    if (!session?.instituteId) { setInstituteLogo(null); return; }
    setLogoLoading(true);
    getInstituteLogo(session.instituteId)
      .then((logoData) => setInstituteLogo(logoData?.dataUrl ?? null))
      .catch(() => setInstituteLogo(null))
      .finally(() => setLogoLoading(false));
  }, [session?.instituteId]);

  // ── Login ──────────────────────────────────────────────────────────

  const login = useCallback(async (
    instituteCode: string,
    email: string,
    password: string
  ): Promise<{ success: boolean; error?: string; firstLoginRequired?: boolean }> => {
    try {
      const emailNorm = email.toLowerCase().trim();
      const codeNorm = instituteCode.toUpperCase().trim();

      // Verify institute exists and is active
      const institute = await getInstituteByCode(codeNorm);
      if (!institute) {
        return { success: false, error: 'Institute not found with this code.' };
      }

      if (institute.status === 'disabled') {
        return { success: false, error: 'This institute has been disabled. Contact your administrator.' };
      }

      // Check validity period
      const now = new Date();
      const activeUntil = new Date(institute.activeUntil);
      if (activeUntil < now) {
        return { success: false, error: 'Institute access period has expired. Contact your administrator.' };
      }

      // Find faculty by email
      const faculty = await getFacultyByEmail(emailNorm);
      if (!faculty) {
        return { success: false, error: 'Faculty account not found. Verify your email address.' };
      }

      // Verify faculty belongs to this institute
      if (faculty.instituteId !== institute.id) {
        return { success: false, error: 'Faculty account not found in this institute.' };
      }

      // Check faculty status
      if (faculty.status === 'disabled') {
        return { success: false, error: 'Your account has been disabled. Contact your institute administrator.' };
      }

      // Validate credentials
      const creds = await getFacultyCredentials(faculty.id);
      if (!creds) {
        return { success: false, error: 'Credentials not configured. Contact your administrator.' };
      }

      if (creds.password !== password) {
        return { success: false, error: 'Incorrect email or password.' };
      }

      const newSession: FacultySession = {
        facultyId: faculty.id,
        name: faculty.name,
        email: faculty.email,
        role: 'Faculty',
        status: faculty.status,
        firstLoginRequired: creds.firstLoginRequired,
        instituteId: institute.id,
        instituteName: institute.name,
        instituteCode: institute.code,
        createdAt: faculty.createdAt,
        // Both gates must be open
        canCreateStudents:
          (institute.facultyCanCreateStudents ?? false) &&
          (faculty.canCreateStudents ?? false),
        canManageExamRosters:
          (institute.facultyCanManageExamRosters ?? false) &&
          (faculty.canManageExamRosters ?? false),
      };

      setSession(newSession);
      return { success: true, firstLoginRequired: creds.firstLoginRequired };
    } catch (err: any) {
      console.error('Faculty login error:', err);
      return { success: false, error: 'Network error. Please try again.' };
    }
  }, []);

  // ── Change password (forced first-login) ──────────────────────────

  const changePassword = useCallback(
    async (newPassword: string): Promise<{ success: boolean; error?: string }> => {
      if (!session) return { success: false, error: 'Not authenticated.' };
      if (newPassword.length < 8) {
        return { success: false, error: 'Password must be at least 8 characters.' };
      }
      try {
        await updateFacultyCredentials(session.facultyId, {
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
    async (instituteCode: string, email: string): Promise<{ success: boolean; error?: string; emailSent?: boolean }> => {
      try {
        const emailNorm = email.toLowerCase().trim();
        const codeNorm = instituteCode.toUpperCase().trim();

        // Verify institute
        const institute = await getInstituteByCode(codeNorm);
        if (!institute) {
          return { success: false, error: 'Institute not found with this code.' };
        }

        // Find faculty
        const faculty = await getFacultyByEmail(emailNorm);
        if (!faculty || faculty.instituteId !== institute.id) {
          return { success: false, error: 'Faculty account not found in this institute.' };
        }

        // Generate new password
        const newPassword = generatePassword();
        await updateFacultyCredentials(faculty.id, {
          password: newPassword,
          firstLoginRequired: true,
        });

        // Send reset email
        const emailResult = await sendFacultyResetEmail(faculty as any, institute.name, newPassword);
        if (!emailResult.ok) {
          console.warn('[FacultyAuthContext] reset email failed:', emailResult.error);
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
        // For now, we'll just return success
        // In production, you'd validate the reset code first
        return { success: true };
      } catch (err: any) {
        console.error('Reset password error:', err);
        return { success: false, error: 'Failed to reset password.' };
      }
    },
    []
  );

  // ── Logout ────────���───────────────────────────────────────────────

  const logout = useCallback(() => {
    setSession(null);
    setInstituteLogo(null);
  }, []);

  return (
    <FacultyAuthContext.Provider
      value={{ session, instituteLogo, logoLoading, login, changePassword, requestPasswordReset, resetPassword, logout }}
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