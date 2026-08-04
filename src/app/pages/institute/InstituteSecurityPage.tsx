import { useState } from 'react';
import { motion } from 'motion/react';
import { Eye, EyeOff, Loader2, Check } from 'lucide-react';
import { useInstituteAuth } from '../../context/InstituteAuthContext';

const inputStyle: React.CSSProperties = {
  background: '#FAFAF8', border: '1px solid #E3E1DB', color: '#0C0C0B',
  borderRadius: 2, width: '100%', outline: 'none', fontSize: 13, padding: '10px 14px',
};
const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = '#0C0C0B'; e.target.style.background = '#FFFFFF';
};
const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = '#E3E1DB'; e.target.style.background = '#FAFAF8';
};

function StrengthBar({ password }: { password: string }) {
  const score = [
    password.length >= 8, /[A-Z]/.test(password),
    /[0-9]/.test(password), /[^A-Za-z0-9]/.test(password), password.length >= 12,
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

export function InstituteSecurityPage() {
  const { changePassword } = useInstituteAuth();

  const [newPassword, setNewPassword]         = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew, setShowNew]                 = useState(false);
  const [showConfirm, setShowConfirm]         = useState(false);
  const [error, setError]                     = useState('');
  const [success, setSuccess]                 = useState(false);
  const [loading, setLoading]                 = useState(false);

  const canSubmit = newPassword.length >= 8 && confirmPassword.length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
    setError(''); setLoading(true);
    const result = await changePassword(newPassword);
    setLoading(false);
    if (!result.success) { setError(result.error ?? 'Failed to update password.'); return; }
    setSuccess(true);
    setNewPassword(''); setConfirmPassword('');
    setTimeout(() => setSuccess(false), 5000);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="px-8 py-10"
      style={{ maxWidth: 520, margin: '0 auto' }}
    >
      <p className="text-xs mb-1" style={{ color: '#6B6B66', letterSpacing: '0.1em' }}>SECURITY</p>
      <h1 className="text-base mb-8" style={{ color: '#0C0C0B', borderBottom: '1px solid #E3E1DB', paddingBottom: 20 }}>
        Change Password
      </h1>

      <div className="bg-white px-6 py-6" style={{ border: '1px solid #E3E1DB', borderRadius: 3 }}>
        {success && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2 px-3 py-2.5 mb-5"
            style={{ background: '#F0F7F2', border: '1px solid #C6DECE', borderRadius: 2 }}>
            <Check size={12} strokeWidth={2} style={{ color: '#2A6B3A', flexShrink: 0 }} />
            <p className="text-xs" style={{ color: '#2A6B3A' }}>Password updated successfully.</p>
          </motion.div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="mb-4">
            <label className="block text-xs mb-2" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
              New password
            </label>
            <div className="relative">
              <input type={showNew ? 'text' : 'password'} autoComplete="new-password"
                value={newPassword} onChange={(e) => { setNewPassword(e.target.value); setError(''); setSuccess(false); }}
                disabled={loading} placeholder="Min. 8 characters"
                style={{ ...inputStyle, paddingRight: 40 }} onFocus={onFocus} onBlur={onBlur} />
              <button type="button" tabIndex={-1} onClick={() => setShowNew((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                style={{ color: '#6B6B66' }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#4A4A45')}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#6B6B66')}>
                {showNew ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
              </button>
            </div>
            <StrengthBar password={newPassword} />
          </div>

          <div className="mb-6">
            <label className="block text-xs mb-2" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
              Confirm new password
            </label>
            <div className="relative">
              <input type={showConfirm ? 'text' : 'password'} autoComplete="new-password"
                value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); setError(''); setSuccess(false); }}
                disabled={loading} placeholder="Repeat password"
                style={{ ...inputStyle, paddingRight: 40 }} onFocus={onFocus} onBlur={onBlur} />
              <button type="button" tabIndex={-1} onClick={() => setShowConfirm((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                style={{ color: '#6B6B66' }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#4A4A45')}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#6B6B66')}>
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
            className="w-full py-2.5 text-sm flex items-center justify-center gap-2"
            style={{
              background: canSubmit ? '#0C0C0B' : '#C8C7C2',
              color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.04em',
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}>
            {loading
              ? <><Loader2 size={14} className="animate-spin" /><span>Updating…</span></>
              : 'Update password'}
          </button>
        </form>

        <p className="text-xs mt-4 pt-4" style={{ color: '#6B6B66', borderTop: '1px solid #F0EFEB', lineHeight: 1.6 }}>
          Choose a strong password with at least 8 characters, including uppercase, lowercase, numbers, and symbols.
        </p>
      </div>
    </motion.div>
  );
}
