import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  multiFactor,
  TotpMultiFactorGenerator,
  TotpSecret,
  getMultiFactorResolver,
  type MultiFactorResolver,
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

  // ── Two-factor authentication (TOTP) — webOwner only ──
  /** True once a login hits the MFA challenge; the login page shows the code step. */
  mfaPending: boolean;
  /** Whether the currently signed-in webOwner has TOTP enrolled. */
  isMfaEnrolled: () => boolean;
  /** Begin enrollment: returns the otpauth:// URI (for QR) + shared secret.
   *  Requires a recent login — call verifyPassword first if it's been a while. */
  startMfaEnrollment: () => Promise<{ success: boolean; qrUri?: string; secretKey?: string; error?: string }>;
  /** Finish enrollment by confirming a 6-digit code from the authenticator app. */
  confirmMfaEnrollment: (verificationCode: string) => Promise<{ success: boolean; error?: string }>;
  /** Remove TOTP from the account (requires recent login). */
  disableMfa: () => Promise<{ success: boolean; error?: string }>;
  /** Complete a login that was interrupted by the MFA challenge. */
  resolveMfaSignIn: (verificationCode: string) => Promise<{ success: boolean; error?: string }>;
}

const AuthContext = createContext<AuthContextType | null>(null);

async function loadProfile(fbUser: FirebaseUser): Promise<AuthUser | null> {
  const snap = await getDoc(doc(db, 'webowners', fbUser.uid));
  if (!snap.exists()) {
    // Legacy account keyed by email — try email lookup as a fallback during migration.
    const emailSnap = fbUser.email ? await getDoc(doc(db, 'webowners', fbUser.email.toLowerCase())) : null;
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
  // MFA challenge state — set when a login is interrupted by TOTP.
  const [mfaPending, setMfaPending] = useState(false);
  const mfaResolverRef = useRef<MultiFactorResolver | null>(null);
  // Holds the in-progress TOTP secret between startMfaEnrollment and confirm.
  const totpSecretRef = useRef<TotpSecret | null>(null);
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
        const tokenResult = await fbUser.getIdTokenResult(true);
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
        const tokenResult = await cred.user.getIdTokenResult(true);
        if (tokenResult.claims.role && tokenResult.claims.role !== 'webOwner') {
          await signOut(auth);
          return { success: false, error: 'This account is not a Web Owner account.' };
        }
        return { success: true };
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        // TOTP challenge — the password was correct but 2FA is required.
        // Stash the resolver and signal the login page to show the code step.
        if (code === 'auth/multi-factor-auth-required') {
          try {
            mfaResolverRef.current = getMultiFactorResolver(auth, err as never);
            setMfaPending(true);
            return { success: false, error: '__MFA_REQUIRED__' };
          } catch (resolveErr) {
            console.error('MFA resolver error:', resolveErr);
            return { success: false, error: 'Two-factor sign-in could not start. Please try again.' };
          }
        }
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

  // ── Two-factor (TOTP) ──────────────────────────────────────────────

  const isMfaEnrolled = useCallback((): boolean => {
    const fbUser = auth.currentUser;
    if (!fbUser) return false;
    return multiFactor(fbUser).enrolledFactors.length > 0;
  }, []);

  const startMfaEnrollment = useCallback(async (): Promise<{ success: boolean; qrUri?: string; secretKey?: string; error?: string }> => {
    const fbUser = auth.currentUser;
    if (!fbUser) return { success: false, error: 'Not signed in.' };
    try {
      const session = await multiFactor(fbUser).getSession();
      const secret = await TotpMultiFactorGenerator.generateSecret(session);
      totpSecretRef.current = secret;
      const qrUri = secret.generateQrCodeUrl(
        fbUser.email ?? 'account',
        platformSettings.name || 'STRATUM',
      );
      return { success: true, qrUri, secretKey: secret.secretKey };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/requires-recent-login') {
        return { success: false, error: 'Please re-enter your password before enabling 2FA.' };
      }
      if (code === 'auth/operation-not-allowed') {
        return { success: false, error: 'TOTP is not enabled for this project. Enable it in Firebase Console → Authentication → Sign-in method → Multi-factor.' };
      }
      console.error('startMfaEnrollment error:', err);
      return { success: false, error: 'Could not start 2FA setup. Please try again.' };
    }
  }, [platformSettings.name]);

  const confirmMfaEnrollment = useCallback(async (verificationCode: string): Promise<{ success: boolean; error?: string }> => {
    const fbUser = auth.currentUser;
    const secret = totpSecretRef.current;
    if (!fbUser) return { success: false, error: 'Not signed in.' };
    if (!secret) return { success: false, error: 'Setup session expired. Please restart 2FA setup.' };
    try {
      const cred = TotpMultiFactorGenerator.assertionForEnrollment(secret, verificationCode.trim());
      await multiFactor(fbUser).enroll(cred, 'Authenticator app');
      totpSecretRef.current = null;
      return { success: true };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/invalid-verification-code') {
        return { success: false, error: 'That code is incorrect. Check your authenticator app and try again.' };
      }
      console.error('confirmMfaEnrollment error:', err);
      return { success: false, error: 'Could not confirm the code. Please try again.' };
    }
  }, []);

  const disableMfa = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    const fbUser = auth.currentUser;
    if (!fbUser) return { success: false, error: 'Not signed in.' };
    try {
      const enrolled = multiFactor(fbUser).enrolledFactors;
      if (enrolled.length === 0) return { success: true };
      await multiFactor(fbUser).unenroll(enrolled[0]);
      return { success: true };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/requires-recent-login') {
        return { success: false, error: 'Please re-enter your password before disabling 2FA.' };
      }
      console.error('disableMfa error:', err);
      return { success: false, error: 'Could not disable 2FA. Please try again.' };
    }
  }, []);

  const resolveMfaSignIn = useCallback(async (verificationCode: string): Promise<{ success: boolean; error?: string }> => {
    const resolver = mfaResolverRef.current;
    if (!resolver) return { success: false, error: 'Your session expired. Please sign in again.' };
    try {
      // Find the enrolled TOTP factor from the resolver's hints.
      const totpHint = resolver.hints.find(
        (h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID,
      );
      if (!totpHint) return { success: false, error: 'No authenticator app is set up for this account.' };
      const assertion = TotpMultiFactorGenerator.assertionForSignIn(totpHint.uid, verificationCode.trim());
      await resolver.resolveSignIn(assertion);
      mfaResolverRef.current = null;
      setMfaPending(false);
      return { success: true };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/invalid-verification-code') {
        return { success: false, error: 'That code is incorrect. Please try again.' };
      }
      console.error('resolveMfaSignIn error:', err);
      return { success: false, error: 'Could not verify the code. Please try again.' };
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
        mfaPending,
        isMfaEnrolled,
        startMfaEnrollment,
        confirmMfaEnrollment,
        disableMfa,
        resolveMfaSignIn,
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
