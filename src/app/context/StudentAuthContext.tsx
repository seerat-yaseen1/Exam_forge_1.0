import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import {
  getStudentByEmail,
  getStudentCredentials,
  updateStudentCredentials,
  getInstituteLogo,
  getInstituteByCode,
  getInstitute,
  generatePassword,
} from '../../lib/firebaseService';
import { sendStudentResetEmail } from '../../lib/emailService';

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

const StudentAuthContext = createContext<StudentAuthContextType | null>(null);

const SESSION_KEY = 'stratum_student_session';

export function StudentAuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<StudentSession | null>(() => {
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

      // Find student by email
      const student = await getStudentByEmail(emailNorm);
      if (!student) {
        return { success: false, error: 'Student account not found. Verify your email address.' };
      }

      // Verify student belongs to this institute
      if (student.instituteId !== institute.id) {
        return { success: false, error: 'Student account not found in this institute.' };
      }

      // Check student status
      if (student.status === 'disabled') {
        return { success: false, error: 'Your account has been disabled. Contact your institute administrator.' };
      }

      // Validate credentials
      const creds = await getStudentCredentials(student.id);
      if (!creds) {
        return { success: false, error: 'Credentials not configured. Contact your administrator.' };
      }

      if (creds.password !== password) {
        return { success: false, error: 'Incorrect email or password.' };
      }

      const newSession: StudentSession = {
        studentId: student.id,
        name: student.name,
        email: student.email,
        role: 'Student',
        status: student.status,
        firstLoginRequired: creds.firstLoginRequired,
        instituteId: institute.id,
        instituteName: institute.name,
        instituteCode: institute.code,
        createdAt: student.createdAt,
      };

      setSession(newSession);
      return { success: true, firstLoginRequired: creds.firstLoginRequired };
    } catch (err: any) {
      console.error('Student login error:', err);
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
        await updateStudentCredentials(session.studentId, {
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

        // Find student
        const student = await getStudentByEmail(emailNorm);
        if (!student || student.instituteId !== institute.id) {
          return { success: false, error: 'Student account not found in this institute.' };
        }

        // Generate new password
        const newPassword = generatePassword();
        await updateStudentCredentials(student.id, {
          password: newPassword,
          firstLoginRequired: true,
        });

        // Send reset email
        const emailResult = await sendStudentResetEmail(student as any, institute.name, newPassword);
        if (!emailResult.ok) {
          console.warn('[StudentAuthContext] reset email failed:', emailResult.error);
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

  // ── Logout ────────────────────────────────────────────────────────

  const logout = useCallback(() => {
    setSession(null);
    setInstituteLogo(null);
  }, []);

  return (
    <StudentAuthContext.Provider
      value={{ session, instituteLogo, logoLoading, login, changePassword, requestPasswordReset, resetPassword, logout }}
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