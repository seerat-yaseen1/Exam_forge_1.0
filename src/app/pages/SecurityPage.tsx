import { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Eye, EyeOff, Loader2, Check, ShieldCheck, Smartphone, Lock } from 'lucide-react';
import QRCode from 'qrcode';
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
    background: 'var(--ef-canvas-raised)',
    border: '1px solid var(--ef-border)',
    color: 'var(--ef-ink)',
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
      <div className="mb-8" style={{ borderBottom: '1px solid var(--ef-border)', paddingBottom: 20 }}>
        <p
          className="text-xs mb-1"
          style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}
        >
          WEB OWNER
        </p>
        <h1 className="text-base" style={{ color: 'var(--ef-ink)' }}>
          Security
        </h1>
      </div>

      <p
        className="text-xs mb-6"
        style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}
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
            background: 'var(--ef-success-bg-alt)',
            border: '1px solid var(--ef-success-border-alt)',
            borderRadius: 2,
          }}
        >
          <ShieldCheck size={14} style={{ color: 'var(--ef-success)' }} strokeWidth={1.5} />
          <p className="text-xs" style={{ color: 'var(--ef-success)' }}>
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
            style={{ color: 'var(--ef-text-subtle)' }}
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
              onClick={() => setShowCurrent((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--ef-text-muted)' }}
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
        <div style={{ borderTop: '1px solid var(--ef-border-subtle)', margin: '20px 0' }} />

        {/* New password */}
        <div className="mb-4">
          <label
            htmlFor="sec-new"
            className="block text-xs mb-2"
            style={{ color: 'var(--ef-text-subtle)' }}
          >
            New password{' '}
            <span style={{ color: 'var(--ef-text-muted)' }}>(min. 8 characters)</span>
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
            style={{ color: 'var(--ef-text-subtle)' }}
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
              {showConfirm ? (
                <EyeOff size={14} strokeWidth={1.5} />
              ) : (
                <Eye size={14} strokeWidth={1.5} />
              )}
            </button>
          </div>
          {confirmPassword && newPassword && confirmPassword !== newPassword && (
            <p className="mt-1.5 text-xs" style={{ color: 'var(--ef-danger)' }}>
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
          className="flex items-center gap-2 px-5 py-2.5 text-xs"
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
              <Loader2 size={12} className="animate-spin" />
              Updating…
            </>
          ) : (
            'Update password'
          )}
        </button>
      </form>

      <TwoFactorSection />
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// Two-factor authentication (TOTP) — webOwner only.
// Enrollment: verify password → generate secret → show QR + key →
// confirm 6-digit code → enrolled. Plus a disable path.
// ══════════════════════════════════════════════════════════════════

type MfaStep = 'idle' | 'reauth' | 'show_qr' | 'done';

function TwoFactorSection() {
  const {
    isMfaEnrolled, verifyPassword,
    startMfaEnrollment, confirmMfaEnrollment, disableMfa,
  } = useAuth();

  const [enrolled, setEnrolled]     = useState(isMfaEnrolled());
  const [step, setStep]             = useState<MfaStep>('idle');
  const [password, setPassword]     = useState('');
  const [qrDataUrl, setQrDataUrl]   = useState('');
  const [secretKey, setSecretKey]   = useState('');
  const [code, setCode]             = useState('');
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [disabling, setDisabling]   = useState(false);

  // Keep the enrolled flag fresh (auth state can settle after mount).
  useEffect(() => { setEnrolled(isMfaEnrolled()); }, [isMfaEnrolled]);

  const inputStyle = {
    background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', color: 'var(--ef-ink)', borderRadius: 2,
  };

  const reset = () => {
    setStep('idle'); setPassword(''); setQrDataUrl(''); setSecretKey('');
    setCode(''); setError(''); setLoading(false);
  };

  // Step 1 → reauthenticate, then generate the secret + QR
  const handleBeginEnroll = async () => {
    setError('');
    if (!password) { setError('Enter your password to continue.'); return; }
    setLoading(true);
    const ok = await verifyPassword(password);
    if (!ok) { setLoading(false); setError('Incorrect password.'); return; }
    const res = await startMfaEnrollment();
    if (!res.success || !res.qrUri) {
      setLoading(false); setError(res.error ?? 'Could not start 2FA setup.'); return;
    }
    try {
      const dataUrl = await QRCode.toDataURL(res.qrUri, { margin: 1, width: 200 });
      setQrDataUrl(dataUrl);
    } catch { /* QR render failure is non-fatal; key is still shown */ }
    setSecretKey(res.secretKey ?? '');
    setStep('show_qr');
    setPassword('');
    setLoading(false);
  };

  // Step 2 → confirm the 6-digit code
  const handleConfirm = async () => {
    setError('');
    if (code.trim().length < 6) { setError('Enter the 6-digit code.'); return; }
    setLoading(true);
    const res = await confirmMfaEnrollment(code);
    setLoading(false);
    if (!res.success) { setError(res.error ?? 'Could not confirm the code.'); return; }
    setEnrolled(true);
    setStep('done');
    setTimeout(reset, 2500);
  };

  const handleDisable = async () => {
    setError('');
    setDisabling(true);
    const res = await disableMfa();
    setDisabling(false);
    if (!res.success) { setError(res.error ?? 'Could not disable 2FA.'); return; }
    setEnrolled(false);
    reset();
  };

  return (
    <div className="mt-12" style={{ borderTop: '1px solid var(--ef-border)', paddingTop: 28 }}>
      <div className="flex items-start gap-3 mb-2">
        <ShieldCheck size={18} strokeWidth={1.5} style={{ color: enrolled ? 'var(--ef-success)' : 'var(--ef-text-muted)', marginTop: 1 }} />
        <div>
          <h2 className="text-sm" style={{ color: 'var(--ef-ink)' }}>Two-factor authentication</h2>
          <p className="text-xs mt-1" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
            {enrolled
              ? 'Your account is protected with an authenticator app. You\u2019ll enter a 6-digit code at each sign-in.'
              : 'Add a second layer of security. You\u2019ll enter a code from an authenticator app (Google Authenticator, Authy) at sign-in.'}
          </p>
        </div>
      </div>

      {/* ENROLLED STATE */}
      {enrolled && step === 'idle' && (
        <div className="mt-4 flex items-center justify-between px-4 py-3"
          style={{ background: 'var(--ef-success-bg-alt)', border: '1px solid var(--ef-success-border-alt)', borderRadius: 2 }}>
          <span className="text-xs flex items-center gap-2" style={{ color: 'var(--ef-success)' }}>
            <Check size={13} /> Enabled
          </span>
          <button onClick={handleDisable} disabled={disabling}
            className="text-xs px-3 py-1.5" style={{ color: 'var(--ef-danger)', cursor: 'pointer' }}>
            {disabling ? 'Disabling…' : 'Disable'}
          </button>
        </div>
      )}

      {/* NOT ENROLLED — idle: show enable button */}
      {!enrolled && step === 'idle' && (
        <button onClick={() => setStep('reauth')}
          className="mt-4 flex items-center gap-2 px-5 py-2.5 text-xs"
          style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, letterSpacing: '0.04em', cursor: 'pointer' }}>
          <Lock size={12} /> Enable 2FA
        </button>
      )}

      {/* STEP: reauth */}
      {step === 'reauth' && (
        <div className="mt-4">
          <label className="block text-xs mb-2" style={{ color: 'var(--ef-text-subtle)' }}>Confirm your password</label>
          <input type="password" autoFocus value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            placeholder="Your current password"
            className="w-full px-3 py-2 text-xs mb-3" style={inputStyle} />
          <div className="flex gap-2">
            <button onClick={handleBeginEnroll} disabled={loading}
              className="flex items-center gap-2 px-4 py-2 text-xs"
              style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: 'pointer' }}>
              {loading ? <><Loader2 size={12} className="animate-spin" /> Continue…</> : 'Continue'}
            </button>
            <button onClick={reset} className="px-4 py-2 text-xs" style={{ color: 'var(--ef-text-muted)', cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}

      {/* STEP: show QR + confirm code */}
      {step === 'show_qr' && (
        <div className="mt-4">
          <div className="flex items-start gap-2 mb-3">
            <Smartphone size={14} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', marginTop: 2 }} />
            <p className="text-xs" style={{ color: '#6B6B65', lineHeight: 1.6 }}>
              Scan this QR code with your authenticator app, then enter the 6-digit code it shows.
            </p>
          </div>
          {qrDataUrl && (
            <div className="flex justify-center mb-3">
              <img src={qrDataUrl} alt="2FA QR code" width={180} height={180}
                style={{ border: '1px solid var(--ef-border)', borderRadius: 4 }} />
            </div>
          )}
          {secretKey && (
            <div className="mb-4 px-3 py-2 text-center" style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
              <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)' }}>Or enter this key manually:</p>
              <code className="text-xs" style={{ color: 'var(--ef-ink)', letterSpacing: '0.05em', wordBreak: 'break-all' }}>{secretKey}</code>
            </div>
          )}
          <label className="block text-xs mb-2" style={{ color: 'var(--ef-text-subtle)' }}>Verification code</label>
          <input type="text" inputMode="numeric" autoFocus maxLength={6} value={code}
            onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setError(''); }}
            placeholder="000000"
            className="w-full px-3 py-2 text-sm mb-3"
            style={{ ...inputStyle, letterSpacing: '0.3em', textAlign: 'center' }} />
          <div className="flex gap-2">
            <button onClick={handleConfirm} disabled={loading || code.length < 6}
              className="flex items-center gap-2 px-4 py-2 text-xs"
              style={{ background: code.length === 6 && !loading ? 'var(--ef-ink)' : 'var(--ef-track)', color: 'var(--ef-surface)', borderRadius: 2, cursor: code.length === 6 && !loading ? 'pointer' : 'not-allowed' }}>
              {loading ? <><Loader2 size={12} className="animate-spin" /> Verifying…</> : 'Verify & enable'}
            </button>
            <button onClick={reset} className="px-4 py-2 text-xs" style={{ color: 'var(--ef-text-muted)', cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}

      {/* STEP: done */}
      {step === 'done' && (
        <div className="mt-4 flex items-center gap-2 px-4 py-3"
          style={{ background: 'var(--ef-success-bg-alt)', border: '1px solid var(--ef-success-border-alt)', borderRadius: 2 }}>
          <Check size={14} style={{ color: 'var(--ef-success)' }} />
          <span className="text-xs" style={{ color: 'var(--ef-success)' }}>Two-factor authentication is now enabled.</span>
        </div>
      )}

      {error && step !== 'idle' && (
        <p className="text-xs mt-3" style={{ color: 'var(--ef-danger)' }}>{error}</p>
      )}
    </div>
  );
}
