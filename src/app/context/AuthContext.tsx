import React, { createContext, useContext, useState, useCallback } from 'react';
import {
  getWebOwnerByEmail,
  setWebOwner,
  updateWebOwner,
} from '../../lib/firebaseService';
import { sendWebOwnerResetEmail } from '../../lib/emailService';

export interface PlatformSettings {
  name: string;
  logoUrl: string | null;
}

export interface AuthUser {
  email: string;
  name: string;
}

interface AuthContextType {
  user: AuthUser | null;
  platformSettings: PlatformSettings;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  requestPasswordReset: (email: string) => Promise<{ success: boolean; code?: string; error?: string }>;
  resetPassword: (email: string, code: string, newPassword: string) => Promise<{ success: boolean; error?: string }>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<{ success: boolean; error?: string }>;
  verifyPassword: (password: string) => Promise<boolean>;
  updatePlatformSettings: (settings: Partial<PlatformSettings>) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [platformSettings, setPlatformSettings] = useState<PlatformSettings>({
    name: 'STRATUM',
    logoUrl: null,
  });

  const login = useCallback(
    async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const emailNorm = email.toLowerCase().trim();
        const webOwner = await getWebOwnerByEmail(emailNorm);

        if (!webOwner) {
          return { success: false, error: 'Account not found. Verify your email address.' };
        }

        if (webOwner.password !== password) {
          return { success: false, error: 'Incorrect email or password.' };
        }

        setUser({ email: webOwner.email, name: webOwner.name });
        return { success: true };
      } catch (err) {
        console.error('Login error:', err);
        return { success: false, error: 'Network error. Please try again.' };
      }
    },
    []
  );

  const logout = useCallback(() => {
    setUser(null);
  }, []);

  const requestPasswordReset = useCallback(
    async (email: string): Promise<{ success: boolean; code?: string; error?: string }> => {
      try {
        const emailNorm = email.toLowerCase().trim();
        const webOwner = await getWebOwnerByEmail(emailNorm);

        if (!webOwner) {
          return { success: false, error: 'No account found with this email address.' };
        }

        // Generate 6-digit reset code
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const resetExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

        await updateWebOwner(emailNorm, {
          resetCode: code,
          resetExpiry,
        });

        // Send reset code via email
        const emailResult = await sendWebOwnerResetEmail(webOwner.name, emailNorm, code);
        if (!emailResult.ok) {
          console.warn('[AuthContext] webowner reset email failed:', emailResult.error);
        }

        return { success: true, code };
      } catch (err) {
        console.error('Reset request error:', err);
        return { success: false, error: 'Network error. Please try again.' };
      }
    },
    []
  );

  const resetPassword = useCallback(
    async (
      email: string,
      code: string,
      newPassword: string
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const emailNorm = email.toLowerCase().trim();
        const webOwner = await getWebOwnerByEmail(emailNorm);

        if (!webOwner) {
          return { success: false, error: 'Account not found.' };
        }

        if (!webOwner.resetCode || webOwner.resetCode !== code) {
          return { success: false, error: 'Invalid or expired reset code.' };
        }

        if (webOwner.resetExpiry) {
          const expiry = new Date(webOwner.resetExpiry);
          if (expiry < new Date()) {
            return { success: false, error: 'Reset code has expired.' };
          }
        }

        await updateWebOwner(emailNorm, {
          password: newPassword,
          resetCode: undefined,
          resetExpiry: undefined,
        });

        return { success: true };
      } catch (err) {
        console.error('Password reset error:', err);
        return { success: false, error: 'Network error. Please try again.' };
      }
    },
    []
  );

  const changePassword = useCallback(
    async (
      currentPassword: string,
      newPassword: string
    ): Promise<{ success: boolean; error?: string }> => {
      if (!user) return { success: false, error: 'Not authenticated.' };

      try {
        const webOwner = await getWebOwnerByEmail(user.email);

        if (!webOwner) {
          return { success: false, error: 'Account not found.' };
        }

        if (webOwner.password !== currentPassword) {
          return { success: false, error: 'Current password is incorrect.' };
        }

        await updateWebOwner(user.email, {
          password: newPassword,
        });

        return { success: true };
      } catch (err) {
        console.error('Password change error:', err);
        return { success: false, error: 'Network error. Please try again.' };
      }
    },
    [user]
  );

  const verifyPassword = useCallback(
    async (password: string): Promise<boolean> => {
      if (!user) return false;

      try {
        const webOwner = await getWebOwnerByEmail(user.email);
        if (!webOwner) return false;
        return webOwner.password === password;
      } catch (err) {
        console.error('Password verify error:', err);
        return false;
      }
    },
    [user]
  );

  const updatePlatformSettings = useCallback((settings: Partial<PlatformSettings>) => {
    setPlatformSettings((prev) => ({ ...prev, ...settings }));
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        platformSettings,
        login,
        logout,
        requestPasswordReset,
        resetPassword,
        changePassword,
        verifyPassword,
        updatePlatformSettings,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}