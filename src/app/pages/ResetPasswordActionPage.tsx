import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router';
import { motion } from 'motion/react';
import { Eye, EyeOff, Loader2, CheckCircle2, ArrowLeft, AlertTriangle } from 'lucide-react';
import { verifyPasswordResetCode, confirmPasswordReset } from 'firebase/auth';
import { auth } from '../../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { LogoMark } from '../components/PlatformLogo';

// ══════════════════════════════════════════════════════════════════
// Shared password-reset landing page.
//
// This is where Firebase's password-reset EMAIL LINK lands. The link
// carries an ?oobCode=... (Firebase's single-use, expiring reset token).
// The page verifies the code, lets the user set a new password inside our
// own branded UI, and confirms the reset — no Firebase-hosted page, and no
// legacy 16-character code. One page serves every role (webOwner,
// institute, faculty, student); `role` only selects which login link to
// return to.
//
// Firebase Console prerequisites (one-time):
//   • Authentication → Settings → Authorized domains: include the Vercel
//     production domain (and any preview domain used for testing).
//   • Authentication → Templates → Password reset → the action link must
//     point at this route. With the default handler the link arrives as
//     https://<app>/reset-password?oobCode=...&mode=resetPassword — which
//     is exactly what this page reads.
// ══════════════════════════════════════════════════════════════════

const inputStyle: React.CSSProperties = {
  background: '#FAFAF8',
  border: '1px solid #E3E1DB',
  color: '#0C0C0B',
  borderRadius: 2,
  width: '100%',
  outline: 'none',
  fontSize: 13,
  padding: '10px 14px',
};
const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = '#0C0C0B';
  e.target.style.background = '#FFFFFF';
};
const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = '#E3E1DB';
  e.target.style.background = '#FAFAF8';
};

function StrengthBar({ password }: { password: string }) {
  const score = [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
    password.length >= 12,
  ].filter(Boolean).length;
  const colors = ['#E3E1DB', '#D97A5A', '#D9A85A', '#7AB87A', '#2A6B3A'];
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
  if (!password) return null;
  return (
    <div className="mt-2">
      <div className="flex gap-1 mb-1">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex-1 h-0.5 rounded-full transition-all"
            style={{ background: i <= score ? colors[score] : '#E3E1DB' }} />
        ))}
      </div>
      {score > 0 && <p className="text-xs" style={{ color: colors[score] }}>{labels[score]}</p>}
    </div>
  );
}

type Role = 'web_owner' | 'institute' | 'faculty' | 'student';
type Stage = 'verifying' | 'form' | 'success' | 'invalid';

const LOGIN_PATH: Record<Role, string> = {
  web_owner: '/login',
  institute: '/institute/login',
  faculty:   '/faculty/login',
  student:   '/student/login',
};

export function ResetPasswordActionPage({ role }: { role: Role }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { platformSettings } = useAuth();

  const oobCode = params.get('oobCode') ?? '';

  const [stage, setStage]                     = useState<Stage>('verifying');
  const [accountEmail, setAccountEmail]       = useState('');
  const [newPassword, setNewPassword]         = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew, setShowNew]                 = useState(false);
  const [showConfirm, setShowConfirm]         = useState(false);
  const [error, setError]                     = useState('');
  const [loading, setLoading]                 = useState(false);

  // Verify the reset code as soon as the page loads. A missing / expired /
  // already-used code lands on the 'invalid' stage instead of a dead form.
  useEffect(() => {
    let cancelled = false;
    if (!oobCode) { setStage('invalid'); return; }
    verifyPasswordResetCode(auth, oobCode)
      .then((email) => { if (!cancelled) { setAccountEmail(email); setStage('form'); } })
      .catch(() => { if (!cancelled) setStage('invalid'); });
    return () => { cancelled = true; };
  }, [oobCode]);

  const canSubmit =
    newPassword.length >= 8 && confirmPassword.length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
    setError('');
    setLoading(true);
    try {
      await confirmPasswordReset(auth, oobCode, newPassword);
      setStage('success');
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/expired-action-code' || code === 'auth/invalid-action-code') {
        setStage('invalid');
      } else if (code === 'auth/weak-password') {
        setError('Password is too weak. Use at least 8 characters.');
      } else {
        setError('Could not reset password. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const loginPath = LOGIN_PATH[role];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4"
      style={{ background: '#F7F6F3' }}>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[380px]"
      >
        {/* Platform identity */}
        <div className="flex flex-col items-center mb-10">
          <div className="mb-4" style={{ color: '#0C0C0B' }}>
            {platformSettings.logoUrl
              ? <img src={platformSettings.logoUrl} alt={platformSettings.name}
                  style={{ width: 36, height: 36, objectFit: 'contain' }} />
              : <LogoMark px={36} />}
          </div>
          <span className="text-sm font-medium" style={{ letterSpacing: '0.2em', color: '#0C0C0B' }}>
            {platformSettings.name}
          </span>
          <div className="mt-5 w-8" style={{ height: 1, background: '#DDDBD5' }} />
        </div>

        <div className="bg-white px-5 py-7 sm:px-8 sm:py-8"
          style={{ border: '1px solid #E3E1DB', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>

          {stage === 'verifying' && (
            <div className="flex flex-col items-center py-8">
              <Loader2 size={24} strokeWidth={1.5} className="animate-spin" style={{ color: '#9A9891' }} />
              <p className="text-xs mt-4" style={{ color: '#9A9891' }}>Verifying your reset link…</p>
            </div>
          )}

          {stage === 'invalid' && (
            <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
              <div className="flex flex-col items-center py-6">
                <AlertTriangle size={30} strokeWidth={1} style={{ color: '#9B2828' }} />
                <p className="text-sm mt-4" style={{ color: '#0C0C0B' }}>Reset link expired</p>
                <p className="text-xs mt-2 text-center" style={{ color: '#9A9891', lineHeight: 1.6 }}>
                  This password-reset link is invalid, has expired, or has already been used.
                  Reset links can only be opened once. Please request a new one.
                </p>
                <button onClick={() => navigate(loginPath, { replace: true })}
                  className="w-full py-2.5 text-sm mt-6"
                  style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.04em', cursor: 'pointer' }}>
                  Back to sign in
                </button>
              </div>
            </motion.div>
          )}

          {stage === 'success' && (
            <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
              <div className="flex flex-col items-center py-6">
                <CheckCircle2 size={32} strokeWidth={1} style={{ color: '#2A6B3A' }} />
                <p className="text-sm mt-4" style={{ color: '#0C0C0B' }}>Password updated</p>
                <p className="text-xs mt-2 text-center" style={{ color: '#9A9891', lineHeight: 1.6 }}>
                  Your password has been set. You may now sign in with your new credentials.
                </p>
                <button onClick={() => navigate(loginPath, { replace: true })}
                  className="w-full py-2.5 text-sm mt-6"
                  style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.04em', cursor: 'pointer' }}>
                  Go to sign in
                </button>
              </div>
            </motion.div>
          )}

          {stage === 'form' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <p className="text-xs mb-1" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>
                SET A NEW PASSWORD
              </p>
              <p className="text-xs mb-6" style={{ color: '#B0AEA8', lineHeight: 1.6 }}>
                For <span style={{ color: '#4A4A45' }}>{accountEmail}</span>. Choose a strong password you haven't used before.
              </p>

              <form onSubmit={handleSubmit} noValidate>
                <div className="mb-4">
                  <label className="block text-xs mb-2" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
                    New Password
                  </label>
                  <div className="relative">
                    <input type={showNew ? 'text' : 'password'} autoFocus autoComplete="new-password"
                      value={newPassword}
                      onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
                      disabled={loading} placeholder="At least 8 characters"
                      style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
                    <button type="button" onClick={() => setShowNew((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2"
                      style={{ color: '#9A9891' }} tabIndex={-1}>
                      {showNew ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <StrengthBar password={newPassword} />
                </div>

                <div className="mb-5">
                  <label className="block text-xs mb-2" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
                    Confirm Password
                  </label>
                  <div className="relative">
                    <input type={showConfirm ? 'text' : 'password'} autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
                      disabled={loading} placeholder="Re-enter your password"
                      style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
                    <button type="button" onClick={() => setShowConfirm((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2"
                      style={{ color: '#9A9891' }} tabIndex={-1}>
                      {showConfirm ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>

                {error && (
                  <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="text-xs mb-4 -mt-1" style={{ color: '#9B2828' }}>
                    {error}
                  </motion.p>
                )}

                <button type="submit" disabled={!canSubmit}
                  className="w-full py-2.5 text-sm flex items-center justify-center gap-2"
                  style={{
                    background: canSubmit ? '#0C0C0B' : '#C8C7C2',
                    color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.04em',
                    cursor: canSubmit ? 'pointer' : 'not-allowed',
                  }}>
                  {loading ? <Loader2 size={14} className="animate-spin" /> : null}
                  {loading ? 'Updating…' : 'Update password'}
                </button>
              </form>
            </motion.div>
          )}

          <Link to={loginPath}
            className="flex items-center justify-center gap-1.5 mt-5 text-xs"
            style={{ color: '#9A9891' }}>
            <ArrowLeft size={12} /> Back to sign in
          </Link>
        </div>
      </motion.div>
    </div>
  );
}
