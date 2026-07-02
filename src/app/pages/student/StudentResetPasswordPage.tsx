import { useState } from 'react';
import { useNavigate, Link } from 'react-router';
import { motion } from 'motion/react';
import { Eye, EyeOff, Loader2, CheckCircle2, ArrowLeft } from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { LogoMark } from '../../components/PlatformLogo';

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

type Stage = 'form' | 'success';

export function StudentResetPasswordPage() {
  const navigate  = useNavigate();
  const { resetPassword } = useStudentAuth();

  const [code, setCode]                       = useState('');
  const [newPassword, setNewPassword]         = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew, setShowNew]                 = useState(false);
  const [showConfirm, setShowConfirm]         = useState(false);
  const [error, setError]                     = useState('');
  const [loading, setLoading]                 = useState(false);
  const [stage, setStage]                     = useState<Stage>('form');

  const canSubmit = code.trim().length === 16 && newPassword.length >= 8 && confirmPassword.length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
    setError('');
    setLoading(true);
    const result = await resetPassword(code.trim().toUpperCase(), newPassword);
    setLoading(false);
    if (!result.success) { setError(result.error ?? 'Failed to reset password.'); return; }
    setStage('success');
  };

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
            <LogoMark px={36} />
          </div>
          <span className="text-sm font-medium" style={{ letterSpacing: '0.2em', color: '#0C0C0B' }}>
            Platform Name
          </span>
          <div className="mt-5 w-8" style={{ height: 1, background: '#DDDBD5' }} />
        </div>

        <div className="bg-white px-5 py-7 sm:px-8 sm:py-8"
          style={{ border: '1px solid #E3E1DB', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>

          {stage === 'success' ? (
            <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
              <div className="flex flex-col items-center py-6">
                <CheckCircle2 size={32} strokeWidth={1} style={{ color: '#2A6B3A' }} />
                <p className="text-sm mt-4" style={{ color: '#0C0C0B' }}>Password updated</p>
                <p className="text-xs mt-2 text-center" style={{ color: '#9A9891', lineHeight: 1.6 }}>
                  Your password has been set. You may now sign in with your new credentials.
                </p>
                <button onClick={() => navigate('/student/login', { replace: true })}
                  className="mt-6 w-full py-2.5 text-sm"
                  style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.04em' }}>
                  Sign in
                </button>
              </div>
            </motion.div>
          ) : (
            <>
              <p className="text-xs mb-1" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>
                RESET PASSWORD
              </p>
              <p className="text-xs mb-6" style={{ color: '#B0AEA8', lineHeight: 1.6 }}>
                Enter the 16-character code from your email, then choose a new password.
              </p>

              <form onSubmit={handleSubmit} noValidate>
                {/* Reset code */}
                <div className="mb-5">
                  <label className="block text-xs mb-2" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
                    Reset code
                  </label>
                  <input type="text" autoFocus autoComplete="off" autoCapitalize="characters"
                    value={code}
                    onChange={(e) => { setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16)); setError(''); }}
                    disabled={loading} placeholder="16 characters"
                    style={{ ...inputStyle, fontFamily: 'monospace', letterSpacing: '0.14em', fontSize: 12 }}
                    onFocus={onFocus} onBlur={onBlur} />
                  {code && code.length === 16 && (
                    <p className="text-xs mt-1.5" style={{ color: '#2A6B3A' }}>Code format valid</p>
                  )}
                </div>

                {/* New password */}
                <div className="mb-4">
                  <label className="block text-xs mb-2" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
                    New password
                  </label>
                  <div className="relative">
                    <input type={showNew ? 'text' : 'password'} autoComplete="new-password"
                      value={newPassword}
                      onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
                      disabled={loading} placeholder="Min. 8 characters"
                      style={{ ...inputStyle, paddingRight: 40 }}
                      onFocus={onFocus} onBlur={onBlur} />
                    <button type="button" tabIndex={-1} onClick={() => setShowNew((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                      style={{ color: '#B0AEA8' }}
                      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#4A4A45')}
                      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#B0AEA8')}>
                      {showNew ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
                    </button>
                  </div>
                  <StrengthBar password={newPassword} />
                </div>

                {/* Confirm password */}
                <div className="mb-6">
                  <label className="block text-xs mb-2" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
                    Confirm new password
                  </label>
                  <div className="relative">
                    <input type={showConfirm ? 'text' : 'password'} autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
                      disabled={loading} placeholder="Repeat password"
                      style={{ ...inputStyle, paddingRight: 40 }}
                      onFocus={onFocus} onBlur={onBlur} />
                    <button type="button" tabIndex={-1} onClick={() => setShowConfirm((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                      style={{ color: '#B0AEA8' }}
                      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#4A4A45')}
                      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#B0AEA8')}>
                      {showConfirm ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
                    </button>
                  </div>
                  {confirmPassword && newPassword && (
                    <p className="text-xs mt-1.5" style={{
                      color: confirmPassword === newPassword ? '#2A6B3A' : '#9B2828',
                    }}>
                      {confirmPassword === newPassword ? 'Passwords match' : 'Passwords do not match'}
                    </p>
                  )}
                </div>

                {error && (
                  <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="text-xs mb-4 -mt-2" style={{ color: '#9B2828' }}>
                    {error}
                  </motion.p>
                )}

                <button type="submit" disabled={!canSubmit}
                  className="w-full py-2.5 text-sm flex items-center justify-center gap-2 mb-3"
                  style={{
                    background: canSubmit ? '#0C0C0B' : '#C8C7C2',
                    color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.04em',
                    cursor: canSubmit ? 'pointer' : 'not-allowed',
                  }}>
                  {loading
                    ? <><Loader2 size={14} className="animate-spin" /><span>Resetting…</span></>
                    : 'Reset password'}
                </button>
              </form>
            </>
          )}

          {stage !== 'success' && (
            <Link to="/student/login"
              className="flex items-center gap-1.5 text-xs transition-colors"
              style={{ color: '#9A9891', textDecoration: 'none' }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#0C0C0B')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#9A9891')}>
              <ArrowLeft size={12} strokeWidth={1.5} />Back to sign in
            </Link>
          )}
        </div>
      </motion.div>
    </div>
  );
}