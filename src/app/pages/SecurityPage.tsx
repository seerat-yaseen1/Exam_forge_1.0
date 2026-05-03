import { useState } from 'react';
import { motion } from 'motion/react';
import { Eye, EyeOff, Loader2, Check, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export function SecurityPage() {
  const { changePassword } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const passwordsMatch = newPassword && confirmPassword && newPassword === confirmPassword;
  const passwordLongEnough = newPassword.length >= 8;
  const canSubmit =
    currentPassword.length > 0 &&
    passwordLongEnough &&
    passwordsMatch &&
    !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setError('');
    setLoading(true);
    const result = await changePassword(currentPassword, newPassword);
    setLoading(false);

    if (!result.success) {
      setError(result.error ?? 'An error occurred.');
      return;
    }

    setSuccess(true);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setTimeout(() => setSuccess(false), 4000);
  };

  const inputStyle = {
    background: '#FAFAF8',
    border: '1px solid #E3E1DB',
    color: '#0C0C0B',
    borderRadius: 2,
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="max-w-[520px] mx-auto px-6 py-12"
    >
      {/* Section header */}
      <div className="mb-8" style={{ borderBottom: '1px solid #E3E1DB', paddingBottom: 20 }}>
        <p
          className="text-xs mb-1"
          style={{ color: '#9A9891', letterSpacing: '0.1em' }}
        >
          WEB OWNER
        </p>
        <h1 className="text-base" style={{ color: '#0C0C0B' }}>
          Security
        </h1>
      </div>

      <p
        className="text-xs mb-6"
        style={{ color: '#9A9891', letterSpacing: '0.08em' }}
      >
        CHANGE PASSWORD
      </p>

      {success && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="flex items-center gap-2 px-4 py-3 mb-6"
          style={{
            background: '#F0F7F2',
            border: '1px solid #C6DECE',
            borderRadius: 2,
          }}
        >
          <ShieldCheck size={14} style={{ color: '#2A6B3A' }} strokeWidth={1.5} />
          <p className="text-xs" style={{ color: '#2A6B3A' }}>
            Password updated successfully.
          </p>
        </motion.div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        {/* Current password */}
        <div className="mb-4">
          <label
            htmlFor="sec-current"
            className="block text-xs mb-2"
            style={{ color: '#4A4A45' }}
          >
            Current password
          </label>
          <div className="relative">
            <input
              id="sec-current"
              type={showCurrent ? 'text' : 'password'}
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => {
                setCurrentPassword(e.target.value);
                setError('');
              }}
              placeholder="••••••••••"
              className="w-full px-3.5 py-2.5 pr-10 text-sm outline-none"
              style={inputStyle}
              onFocus={(e) => {
                e.target.style.borderColor = '#0C0C0B';
                e.target.style.background = '#FFFFFF';
              }}
              onBlur={(e) => {
                e.target.style.borderColor = '#E3E1DB';
                e.target.style.background = '#FAFAF8';
              }}
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowCurrent((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2"
              style={{ color: '#B0AEA8' }}
            >
              {showCurrent ? (
                <EyeOff size={14} strokeWidth={1.5} />
              ) : (
                <Eye size={14} strokeWidth={1.5} />
              )}
            </button>
          </div>
        </div>

        {/* Divider */}
        <div style={{ borderTop: '1px solid #F0EFEB', margin: '20px 0' }} />

        {/* New password */}
        <div className="mb-4">
          <label
            htmlFor="sec-new"
            className="block text-xs mb-2"
            style={{ color: '#4A4A45' }}
          >
            New password{' '}
            <span style={{ color: '#9A9891' }}>(min. 8 characters)</span>
          </label>
          <div className="relative">
            <input
              id="sec-new"
              type={showNew ? 'text' : 'password'}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.target.value);
                setError('');
              }}
              placeholder="••••••••••"
              className="w-full px-3.5 py-2.5 pr-10 text-sm outline-none"
              style={inputStyle}
              onFocus={(e) => {
                e.target.style.borderColor = '#0C0C0B';
                e.target.style.background = '#FFFFFF';
              }}
              onBlur={(e) => {
                e.target.style.borderColor = '#E3E1DB';
                e.target.style.background = '#FAFAF8';
              }}
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowNew((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2"
              style={{ color: '#B0AEA8' }}
            >
              {showNew ? (
                <EyeOff size={14} strokeWidth={1.5} />
              ) : (
                <Eye size={14} strokeWidth={1.5} />
              )}
            </button>
          </div>
        </div>

        {/* Confirm password */}
        <div className="mb-6">
          <label
            htmlFor="sec-confirm"
            className="block text-xs mb-2"
            style={{ color: '#4A4A45' }}
          >
            Confirm new password
          </label>
          <div className="relative">
            <input
              id="sec-confirm"
              type={showConfirm ? 'text' : 'password'}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                setError('');
              }}
              placeholder="••••••••••"
              className="w-full px-3.5 py-2.5 pr-10 text-sm outline-none"
              style={inputStyle}
              onFocus={(e) => {
                e.target.style.borderColor = '#0C0C0B';
                e.target.style.background = '#FFFFFF';
              }}
              onBlur={(e) => {
                e.target.style.borderColor = '#E3E1DB';
                e.target.style.background = '#FAFAF8';
              }}
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowConfirm((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2"
              style={{ color: '#B0AEA8' }}
            >
              {showConfirm ? (
                <EyeOff size={14} strokeWidth={1.5} />
              ) : (
                <Eye size={14} strokeWidth={1.5} />
              )}
            </button>
          </div>
          {confirmPassword && newPassword && confirmPassword !== newPassword && (
            <p className="mt-1.5 text-xs" style={{ color: '#9B2828' }}>
              Passwords do not match.
            </p>
          )}
        </div>

        {error && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-xs mb-4 -mt-2"
            style={{ color: '#9B2828' }}
          >
            {error}
          </motion.p>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="flex items-center gap-2 px-5 py-2.5 text-xs"
          style={{
            background: canSubmit ? '#0C0C0B' : '#C8C7C2',
            color: '#FFFFFF',
            borderRadius: 2,
            letterSpacing: '0.04em',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {loading ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              Updating…
            </>
          ) : (
            'Update password'
          )}
        </button>
      </form>
    </motion.div>
  );
}
