import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router';
import { motion } from 'motion/react';
import { Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react';
import { useInstituteAuth } from '../../context/InstituteAuthContext';
import { usePlatformSettings } from '../../context/PlatformSettingsContext';
import { LogoMark } from '../../components/PlatformLogo';

const inputStyle: React.CSSProperties = {
  background: 'var(--ef-canvas-raised)',
  border: '1px solid var(--ef-border)',
  color: 'var(--ef-ink)',
  borderRadius: 2,
  width: '100%',
  outline: 'none',
  fontSize: 13,
  padding: '10px 14px',
};

function StrengthBar({ password }: { password: string }) {
  const score = [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
    password.length >= 12,
  ].filter(Boolean).length;

  const colors = ['var(--ef-border)', 'var(--ef-danger)', 'var(--ef-warning)', 'var(--ef-success)', 'var(--ef-success)'];
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];

  if (!password) return null;

  return (
    <div className="mt-2">
      <div className="flex gap-1 mb-1">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="flex-1 h-0.5 rounded-full transition-all"
            style={{ background: i <= score ? colors[score] : 'var(--ef-border)' }}
          />
        ))}
      </div>
      {score > 0 && (
        <p className="text-xs" style={{ color: colors[score] }}>
          {labels[score]}
        </p>
      )}
    </div>
  );
}

export function InstituteChangePasswordPage() {
  const navigate = useNavigate();
  const { session, changePassword } = useInstituteAuth();
  const { platformSettings } = usePlatformSettings();

  const [newPassword, setNewPassword]         = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew, setShowNew]                 = useState(false);
  const [showConfirm, setShowConfirm]         = useState(false);
  const [error, setError]                     = useState('');
  const [loading, setLoading]                 = useState(false);

  // Guards
  if (!session) return <Navigate to="/institute/login" replace />;
  if (!session.firstLoginRequired) return <Navigate to="/institute/dashboard" replace />;

  const canSubmit =
    newPassword.length >= 8 &&
    confirmPassword.length > 0 &&
    !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setError('');
    setLoading(true);
    const result = await changePassword(newPassword);
    setLoading(false);
    if (!result.success) {
      setError(result.error ?? 'Failed to set password.');
      return;
    }
    navigate('/institute/dashboard', { replace: true });
  };

  const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = 'var(--ef-ink)';
    e.target.style.background = 'var(--ef-surface)';
  };
  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = 'var(--ef-border)';
    e.target.style.background = 'var(--ef-canvas-raised)';
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-4"
      style={{ background: 'var(--ef-canvas)' }}
    >
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[380px]"
      >
        {/* Platform identity */}
        <div className="flex flex-col items-center mb-10">
          <div className="mb-4" style={{ color: 'var(--ef-ink)' }}>
            {platformSettings.logoUrl ? (
              <img src={platformSettings.logoUrl} alt={platformSettings.name}
                style={{ width: 36, height: 36, objectFit: 'contain' }} />
            ) : <LogoMark px={36} />}
          </div>
          <span className="text-sm font-medium" style={{ letterSpacing: '0.2em', color: 'var(--ef-ink)' }}>
            {platformSettings.name}
          </span>
          <div className="mt-5 w-8" style={{ height: 1, background: 'var(--ef-border-muted)' }} />
        </div>

        {/* Notice banner */}
        <div
          className="flex items-start gap-3 px-4 py-3 mb-6"
          style={{
            background: 'var(--ef-canvas)',
            border: '1px solid var(--ef-border)',
            borderLeft: '2px solid var(--ef-ink)',
          }}
        >
          <ShieldCheck size={14} strokeWidth={1.5} style={{ color: 'var(--ef-ink)', marginTop: 1, flexShrink: 0 }} />
          <div>
            <p className="text-xs font-medium" style={{ color: 'var(--ef-ink)', letterSpacing: '0.04em' }}>
              Password change required
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
              You are signed in with a temporary password. Set a permanent password to continue.
            </p>
          </div>
        </div>

        {/* Form card */}
        <div
          className="bg-white px-5 py-7 sm:px-8 sm:py-8"
          style={{ border: '1px solid var(--ef-border)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}
        >
          <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
            SET NEW PASSWORD
          </p>
          <p className="text-sm mb-6" style={{ color: 'var(--ef-ink)' }}>
            {session.adminName}
          </p>

          <form onSubmit={handleSubmit} noValidate>
            {/* New password */}
            <div className="mb-4">
              <label className="block text-xs mb-2" style={{ color: 'var(--ef-text-subtle)', letterSpacing: '0.04em' }}>
                New password
              </label>
              <div className="relative">
                <input
                  type={showNew ? 'text' : 'password'}
                  autoFocus
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
                  disabled={loading}
                  placeholder="Min. 8 characters"
                  style={{ ...inputStyle, paddingRight: 40 }}
                  onFocus={onFocus}
                  onBlur={onBlur}
                />
                <button type="button" tabIndex={-1}
                  onClick={() => setShowNew((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: 'var(--ef-text-muted)' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)')}>
                  {showNew ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
                </button>
              </div>
              <StrengthBar password={newPassword} />
            </div>

            {/* Confirm password */}
            <div className="mb-6">
              <label className="block text-xs mb-2" style={{ color: 'var(--ef-text-subtle)', letterSpacing: '0.04em' }}>
                Confirm new password
              </label>
              <div className="relative">
                <input
                  type={showConfirm ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
                  disabled={loading}
                  placeholder="Repeat password"
                  style={{ ...inputStyle, paddingRight: 40 }}
                  onFocus={onFocus}
                  onBlur={onBlur}
                />
                <button type="button" tabIndex={-1}
                  onClick={() => setShowConfirm((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: 'var(--ef-text-muted)' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)')}>
                  {showConfirm ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
                </button>
              </div>
              {/* Match indicator */}
              {confirmPassword && newPassword && (
                <p className="text-xs mt-1.5" style={{
                  color: confirmPassword === newPassword ? 'var(--ef-success)' : 'var(--ef-danger)',
                }}>
                  {confirmPassword === newPassword ? 'Passwords match' : 'Passwords do not match'}
                </p>
              )}
            </div>

            {/* Error */}
            {error && (
              <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="text-xs mb-4 -mt-2" style={{ color: 'var(--ef-danger)' }}>
                {error}
              </motion.p>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full py-2.5 text-sm flex items-center justify-center gap-2 transition-opacity"
              style={{
                background: canSubmit ? 'var(--ef-ink)' : 'var(--ef-track)',
                color: 'var(--ef-surface)',
                borderRadius: 2,
                letterSpacing: '0.04em',
                cursor: canSubmit ? 'pointer' : 'not-allowed',
              }}
            >
              {loading ? (
                <><Loader2 size={14} className="animate-spin" /><span>Saving…</span></>
              ) : 'Set password & continue'}
            </button>
          </form>
        </div>
      </motion.div>
    </div>
  );
}
