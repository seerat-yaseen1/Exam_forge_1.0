import { useState } from 'react';
import { motion } from 'motion/react';
import { Eye, EyeOff, Loader2, Check } from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';

const inputStyle: React.CSSProperties = {
  background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', color: 'var(--ef-ink)',
  borderRadius: 2, width: '100%', outline: 'none', fontSize: 13, padding: '10px 14px',
};
const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = 'var(--ef-ink)'; e.target.style.background = 'var(--ef-surface)';
};
const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = 'var(--ef-border)'; e.target.style.background = 'var(--ef-canvas-raised)';
};

function StrengthBar({ password }: { password: string }) {
  const score = [
    password.length >= 8, /[A-Z]/.test(password),
    /[0-9]/.test(password), /[^A-Za-z0-9]/.test(password), password.length >= 12,
  ].filter(Boolean).length;
  const colors = ['var(--ef-border)', '#D97A5A', '#D9A85A', '#7AB87A', 'var(--ef-success)'];
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
  if (!password) return null;
  return (
    <div className="mt-2">
      <div className="flex gap-1 mb-1">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex-1 h-0.5 rounded-full transition-all"
            style={{ background: i <= score ? colors[score] : 'var(--ef-border)' }} />
        ))}
      </div>
      {score > 0 && <p className="text-xs" style={{ color: colors[score] }}>{labels[score]}</p>}
    </div>
  );
}

export function StudentSecurityPage() {
  const { changePassword } = useStudentAuth();

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
      <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>SECURITY</p>
      <h1 className="text-base mb-8" style={{ color: 'var(--ef-ink)', borderBottom: '1px solid var(--ef-border)', paddingBottom: 20 }}>
        Change Password
      </h1>

      <div className="bg-white px-6 py-6" style={{ border: '1px solid var(--ef-border)', borderRadius: 3 }}>
        {success && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2 px-3 py-2.5 mb-5"
            style={{ background: 'var(--ef-success-bg-alt)', border: '1px solid var(--ef-success-border-alt)', borderRadius: 2 }}>
            <Check size={12} strokeWidth={2} style={{ color: 'var(--ef-success)', flexShrink: 0 }} />
            <p className="text-xs" style={{ color: 'var(--ef-success)' }}>Password updated successfully.</p>
          </motion.div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="mb-4">
            <label className="block text-xs mb-2" style={{ color: 'var(--ef-text-subtle)', letterSpacing: '0.04em' }}>
              New password
            </label>
            <div className="relative">
              <input type={showNew ? 'text' : 'password'} autoComplete="new-password"
                value={newPassword} onChange={(e) => { setNewPassword(e.target.value); setError(''); setSuccess(false); }}
                disabled={loading} placeholder="Min. 8 characters"
                style={{ ...inputStyle, paddingRight: 40 }} onFocus={onFocus} onBlur={onBlur} />
              <button type="button" tabIndex={-1} onClick={() => setShowNew((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                style={{ color: 'var(--ef-text-muted)' }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)')}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)')}>
                {showNew ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
              </button>
            </div>
            <StrengthBar password={newPassword} />
          </div>

          <div className="mb-6">
            <label className="block text-xs mb-2" style={{ color: 'var(--ef-text-subtle)', letterSpacing: '0.04em' }}>
              Confirm new password
            </label>
            <div className="relative">
              <input type={showConfirm ? 'text' : 'password'} autoComplete="new-password"
                value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); setError(''); setSuccess(false); }}
                disabled={loading} placeholder="Repeat password"
                style={{ ...inputStyle, paddingRight: 40 }} onFocus={onFocus} onBlur={onBlur} />
              <button type="button" tabIndex={-1} onClick={() => setShowConfirm((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                style={{ color: 'var(--ef-text-muted)' }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)')}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)')}>
                {showConfirm ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
              </button>
            </div>
            {confirmPassword && newPassword && (
              <p className="text-xs mt-1.5" style={{
                color: confirmPassword === newPassword ? 'var(--ef-success)' : 'var(--ef-danger)',
              }}>
                {confirmPassword === newPassword ? 'Passwords match' : 'Passwords do not match'}
              </p>
            )}
          </div>

          {error && (
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="text-xs mb-4 -mt-2" style={{ color: 'var(--ef-danger)' }}>
              {error}
            </motion.p>
          )}

          <button type="submit" disabled={!canSubmit}
            className="w-full py-2.5 text-sm flex items-center justify-center gap-2"
            style={{
              background: canSubmit ? 'var(--ef-ink)' : 'var(--ef-track)',
              color: 'var(--ef-surface)', borderRadius: 2, letterSpacing: '0.04em',
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}>
            {loading
              ? <><Loader2 size={14} className="animate-spin" /><span>Updating…</span></>
              : 'Update password'}
          </button>
        </form>

        <p className="text-xs mt-4 pt-4" style={{ color: 'var(--ef-text-muted)', borderTop: '1px solid var(--ef-border-subtle)', lineHeight: 1.6 }}>
          Choose a strong password with at least 8 characters, including uppercase, lowercase, numbers, and symbols.
        </p>
      </div>
    </motion.div>
  );
}
