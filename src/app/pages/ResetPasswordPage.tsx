import { useState } from 'react';
import { Link, useNavigate, useLocation, Navigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { usePlatformSettings } from '../context/PlatformSettingsContext';
import { LogoMark } from '../components/PlatformLogo';

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { resetPassword } = useAuth();
  const { platformSettings } = usePlatformSettings();

  // Pre-filled from forgot password page via route state
  const prefillEmail: string = location.state?.email ?? '';
  const prefillCode: string = location.state?.code ?? '';

  const [email, setEmail] = useState(prefillEmail);
  const [code, setCode] = useState(prefillCode);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const passwordsMatch = newPassword && confirmPassword && newPassword === confirmPassword;
  const passwordLongEnough = newPassword.length >= 8;
  const canSubmit =
    email.trim() &&
    code.trim().length === 10 &&
    passwordLongEnough &&
    passwordsMatch &&
    !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    if (!passwordsMatch) {
      setError('Passwords do not match.');
      return;
    }

    setError('');
    setLoading(true);
    const result = await resetPassword(email, code, newPassword);
    setLoading(false);

    if (!result.success) {
      setError(result.error ?? 'An error occurred.');
      return;
    }

    setSuccess(true);
    setTimeout(() => navigate('/login', { replace: true }), 2600);
  };

  if (success) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center px-4"
        style={{ background: 'var(--ef-canvas)' }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4 }}
          className="flex flex-col items-center gap-4"
        >
          <ShieldCheck size={32} style={{ color: 'var(--ef-success)' }} strokeWidth={1.5} />
          <p className="text-sm" style={{ color: 'var(--ef-ink)' }}>
            Password updated. Redirecting…
          </p>
        </motion.div>
      </div>
    );
  }

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
              <img
                src={platformSettings.logoUrl}
                alt={platformSettings.name}
                style={{ width: 36, height: 36, objectFit: 'contain' }}
              />
            ) : (
              <LogoMark px={36} />
            )}
          </div>
          <span
            className="text-sm font-medium"
            style={{ letterSpacing: '0.2em', color: 'var(--ef-ink)' }}
          >
            {platformSettings.name}
          </span>
          <div
            className="mt-5"
            style={{ height: '1px', width: 32, background: 'var(--ef-border-muted)' }}
          />
        </div>

        <div
          className="bg-white px-5 py-7 sm:px-8 sm:py-8"
          style={{
            border: '1px solid var(--ef-border)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
          }}
        >
          <p
            className="text-xs mb-1"
            style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}
          >
            SET NEW PASSWORD
          </p>
          <p className="text-xs mb-6" style={{ color: '#6B6B65' }}>
            Enter your 10-character reset code and choose a new password.
          </p>

          <form onSubmit={handleSubmit} noValidate>
            {/* Email */}
            <div className="mb-4">
              <label
                htmlFor="r-email"
                className="block text-xs mb-2"
                style={{ color: 'var(--ef-text-subtle)', letterSpacing: '0.04em' }}
              >
                Email address
              </label>
              <input
                id="r-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError('');
                }}
                placeholder="you@platform.com"
                className="w-full px-3.5 py-2.5 text-sm outline-none"
                style={{
                  background: 'var(--ef-canvas-raised)',
                  border: '1px solid var(--ef-border)',
                  color: 'var(--ef-ink)',
                  borderRadius: 2,
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = 'var(--ef-ink)';
                  e.target.style.background = 'var(--ef-surface)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = 'var(--ef-border)';
                  e.target.style.background = 'var(--ef-canvas-raised)';
                }}
              />
            </div>

            {/* Reset code */}
            <div className="mb-4">
              <label
                htmlFor="r-code"
                className="block text-xs mb-2"
                style={{ color: 'var(--ef-text-subtle)', letterSpacing: '0.04em' }}
              >
                Reset code{' '}
                <span style={{ color: 'var(--ef-text-muted)' }}>(10 characters)</span>
              </label>
              <input
                id="r-code"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10));
                  setError('');
                }}
                placeholder="XXXXXXXXXXXX"
                className="w-full px-3.5 py-2.5 text-sm outline-none tracking-widest"
                style={{
                  background: 'var(--ef-canvas-raised)',
                  border: '1px solid var(--ef-border)',
                  color: 'var(--ef-ink)',
                  borderRadius: 2,
                  fontFamily: 'monospace',
                  letterSpacing: '0.22em',
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = 'var(--ef-ink)';
                  e.target.style.background = 'var(--ef-surface)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = 'var(--ef-border)';
                  e.target.style.background = 'var(--ef-canvas-raised)';
                }}
              />
              {code.length > 0 && code.length < 10 && (
                <p className="mt-1 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                  {10 - code.length} character{10 - code.length !== 1 ? 's' : ''} remaining
                </p>
              )}
            </div>

            {/* New password */}
            <div className="mb-4">
              <label
                htmlFor="r-new"
                className="block text-xs mb-2"
                style={{ color: 'var(--ef-text-subtle)', letterSpacing: '0.04em' }}
              >
                New password{' '}
                <span style={{ color: 'var(--ef-text-muted)' }}>(min. 8 characters)</span>
              </label>
              <div className="relative">
                <input
                  id="r-new"
                  type={showNew ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    setError('');
                  }}
                  placeholder="••••••••••"
                  className="w-full px-3.5 py-2.5 pr-10 text-sm outline-none"
                  style={{
                    background: 'var(--ef-canvas-raised)',
                    border: '1px solid var(--ef-border)',
                    color: 'var(--ef-ink)',
                    borderRadius: 2,
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = 'var(--ef-ink)';
                    e.target.style.background = 'var(--ef-surface)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'var(--ef-border)';
                    e.target.style.background = 'var(--ef-canvas-raised)';
                  }}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowNew((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--ef-text-muted)' }}
                >
                  {showNew ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
                </button>
              </div>
            </div>

            {/* Confirm password */}
            <div className="mb-6">
              <label
                htmlFor="r-confirm"
                className="block text-xs mb-2"
                style={{ color: 'var(--ef-text-subtle)', letterSpacing: '0.04em' }}
              >
                Confirm password
              </label>
              <div className="relative">
                <input
                  id="r-confirm"
                  type={showConfirm ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    setError('');
                  }}
                  placeholder="••••••••••"
                  className="w-full px-3.5 py-2.5 pr-10 text-sm outline-none"
                  style={{
                    background: 'var(--ef-canvas-raised)',
                    border: '1px solid var(--ef-border)',
                    color: 'var(--ef-ink)',
                    borderRadius: 2,
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = 'var(--ef-ink)';
                    e.target.style.background = 'var(--ef-surface)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'var(--ef-border)';
                    e.target.style.background = 'var(--ef-canvas-raised)';
                  }}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowConfirm((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--ef-text-muted)' }}
                >
                  {showConfirm ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
                </button>
              </div>
              {confirmPassword && newPassword && confirmPassword !== newPassword && (
                <p className="mt-1 text-xs" style={{ color: 'var(--ef-danger)' }}>
                  Passwords do not match.
                </p>
              )}
            </div>

            {error && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-xs mb-4 -mt-2"
                style={{ color: 'var(--ef-danger)' }}
              >
                {error}
              </motion.p>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full py-2.5 text-sm flex items-center justify-center gap-2 mb-4"
              style={{
                background: canSubmit ? 'var(--ef-ink)' : 'var(--ef-track)',
                color: 'var(--ef-surface)',
                borderRadius: 2,
                letterSpacing: '0.04em',
                cursor: canSubmit ? 'pointer' : 'not-allowed',
              }}
            >
              {loading ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>Updating…</span>
                </>
              ) : (
                'Update password'
              )}
            </button>
          </form>

          <Link
            to="/forgot-password"
            className="flex items-center gap-1.5 text-xs transition-colors"
            style={{ color: 'var(--ef-text-muted)', textDecoration: 'none' }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = 'var(--ef-ink)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)';
            }}
          >
            <ArrowLeft size={12} strokeWidth={1.5} />
            Request a new code
          </Link>
        </div>
      </motion.div>
    </div>
  );
}
