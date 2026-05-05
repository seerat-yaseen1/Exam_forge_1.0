import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  type User as FirebaseUser,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../../lib/firebase';

export interface PlatformSettings {
  name: string;
  logoUrl: string | null;
}

export interface AuthUser {
  email: string;
  name: string;
  uid: string;
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  platformSettings: PlatformSettings;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<{ success: boolean; error?: string }>;
  /** Phase 2 note: reset is now handled via Firebase's emailed link, so the
   *  in-app code form is no longer needed. Kept for API compatibility — always
   *  returns an error directing the user to the email link. */
  resetPassword: (email: string, code: string, newPassword: string) => Promise<{ success: boolean; error?: string }>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<{ success: boolean; error?: string }>;
  verifyPassword: (password: string) => Promise<boolean>;
  updatePlatformSettings: (settings: Partial<PlatformSettings>) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

async function loadProfile(fbUser: FirebaseUser): Promise<AuthUser | null> {
  const snap = await getDoc(doc(db, 'webOwners', fbUser.uid));
  if (!snap.exists()) {
    // Legacy account keyed by email — try email lookup as a fallback during migration.
    const emailSnap = fbUser.email ? await getDoc(doc(db, 'webOwners', fbUser.email.toLowerCase())) : null;
    if (!emailSnap?.exists()) return null;
    const data = emailSnap.data() as { name?: string };
    return { uid: fbUser.uid, email: fbUser.email || '', name: data.name || '' };
  }
  const data = snap.data() as { name?: string; email?: string };
  return { uid: fbUser.uid, email: data.email || fbUser.email || '', name: data.name || '' };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [platformSettings, setPlatformSettings] = useState<PlatformSettings>({
    name: 'STRATUM',
    logoUrl: null,
  });

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) {
        setUser(null);
        setLoading(false);
        return;
      }
      try {
        // Confirm this signed-in user is actually a Web Owner. Firebase Auth
        // is shared across roles once Phases 3-5 land, so the role custom
        // claim is the source of truth.
        const tokenResult = await fbUser.getIdTokenResult();
        if (tokenResult.claims.role && tokenResult.claims.role !== 'webOwner') {
          setUser(null);
          setLoading(false);
          return;
        }
        const profile = await loadProfile(fbUser);
        setUser(profile);
      } catch (err) {
        console.error('Auth state load error:', err);
        setUser(null);
      } finally {
        setLoading(false);
      }
    });
    return () => unsub();
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const emailNorm = email.toLowerCase().trim();
        const cred = await signInWithEmailAndPassword(auth, emailNorm, password);
        const tokenResult = await cred.user.getIdTokenResult();
        if (tokenResult.claims.role && tokenResult.claims.role !== 'webOwner') {
          await signOut(auth);
          return { success: false, error: 'This account is not a Web Owner account.' };
        }
        return { success: true };
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
          return { success: false, error: 'Incorrect email or password.' };
        }
        if (code === 'auth/too-many-requests') {
          return { success: false, error: 'Too many attempts. Try again in a few minutes.' };
        }
        console.error('Login error:', err);
        return { success: false, error: 'Network error. Please try again.' };
      }
    },
    []
  );

  const logout = useCallback(async () => {
    await signOut(auth);
  }, []);

  const requestPasswordReset = useCallback(
    async (email: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const emailNorm = email.toLowerCase().trim();
        await sendPasswordResetEmail(auth, emailNorm);
        return { success: true };
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'auth/user-not-found') {
          // Don't leak account existence — pretend success.
          return { success: true };
        }
        console.error('Reset request error:', err);
        return { success: false, error: 'Network error. Please try again.' };
      }
    },
    []
  );

  const resetPassword = useCallback(
    async (): Promise<{ success: boolean; error?: string }> => {
      return {
        success: false,
        error: 'Password reset is now handled via the email link. Please check your inbox.',
      };
    },
    []
  );

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }> => {
      const fbUser = auth.currentUser;
      if (!fbUser || !fbUser.email) return { success: false, error: 'Not authenticated.' };

      try {
        const credential = EmailAuthProvider.credential(fbUser.email, currentPassword);
        await reauthenticateWithCredential(fbUser, credential);
        await updatePassword(fbUser, newPassword);
        return { success: true };
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'auth/invalid-credential' || code === 'auth/wrong-password') {
          return { success: false, error: 'Current password is incorrect.' };
        }
        if (code === 'auth/weak-password') {
          return { success: false, error: 'New password is too weak.' };
        }
        console.error('Password change error:', err);
        return { success: false, error: 'Network error. Please try again.' };
      }
    },
    []
  );

  const verifyPassword = useCallback(async (password: string): Promise<boolean> => {
    const fbUser = auth.currentUser;
    if (!fbUser || !fbUser.email) return false;
    try {
      const credential = EmailAuthProvider.credential(fbUser.email, password);
      await reauthenticateWithCredential(fbUser, credential);
      return true;
    } catch {
      return false;
    }
  }, []);

  const updatePlatformSettings = useCallback((settings: Partial<PlatformSettings>) => {
    setPlatformSettings((prev) => ({ ...prev, ...settings }));
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
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
