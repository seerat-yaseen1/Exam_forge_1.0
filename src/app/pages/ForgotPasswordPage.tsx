import { useState } from 'react';
import { Link } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { usePlatformSettings } from '../context/PlatformSettingsContext';
import { LogoMark } from '../components/PlatformLogo';

type Stage = 'input' | 'sent';

export function ForgotPasswordPage() {
  const { requestPasswordReset } = useAuth();
  const { platformSettings } = usePlatformSettings();

  const [stage, setStage] = useState<Stage>('input');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setError('');
    setLoading(true);
    const result = await requestPasswordReset(email);
    setLoading(false);

    if (!result.success) {
      setError(result.error ?? 'An error occurred.');
      return;
    }
    setStage('sent');
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
          <AnimatePresence mode="wait">
            {stage === 'input' ? (
              <motion.div
                key="input"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <p
                  className="text-xs mb-1"
                  style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}
                >
                  PASSWORD RECOVERY
                </p>
                <p className="text-xs mb-6" style={{ color: '#6B6B65' }}>
                  Enter your account email. A secure reset code will be dispatched.
                </p>

                <form onSubmit={handleSubmit} noValidate>
                  <div className="mb-5">
                    <label
                      htmlFor="reset-email"
                      className="block text-xs mb-2"
                      style={{ color: 'var(--ef-text-subtle)', letterSpacing: '0.04em' }}
                    >
                      Email address
                    </label>
                    <input
                      id="reset-email"
                      type="email"
                      autoFocus
                      autoComplete="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setError('');
                      }}
                      disabled={loading}
                      placeholder="you@platform.com"
                      className="w-full px-3.5 py-2.5 text-sm outline-none transition-colors"
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

                  {error && (
                    <motion.p
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="text-xs mb-4 -mt-1"
                      style={{ color: 'var(--ef-danger)' }}
                    >
                      {error}
                    </motion.p>
                  )}

                  <button
                    type="submit"
                    disabled={!email.trim() || loading}
                    className="w-full py-2.5 text-sm flex items-center justify-center gap-2 transition-opacity mb-3"
                    style={{
                      background: email.trim() && !loading ? 'var(--ef-ink)' : 'var(--ef-track)',
                      color: 'var(--ef-surface)',
                      borderRadius: 2,
                      letterSpacing: '0.04em',
                      cursor: email.trim() && !loading ? 'pointer' : 'not-allowed',
                    }}
                  >
                    {loading ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        <span>Sending…</span>
                      </>
                    ) : (
                      'Send reset code'
                    )}
                  </button>
                </form>
              </motion.div>
            ) : (
              <motion.div
                key="sent"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.25 }}
              >
                <p
                  className="text-xs mb-1"
                  style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}
                >
                  CHECK YOUR INBOX
                </p>
                <p className="text-xs mb-6" style={{ color: '#6B6B65', lineHeight: 1.6 }}>
                  If an account exists for{' '}
                  <span style={{ color: 'var(--ef-ink)' }}>{email}</span>, a
                  password-reset link has been sent. Open it from your inbox to
                  set a new password. The link expires in 1 hour and can be used
                  once. If it doesn’t arrive, check your spam folder.
                </p>

                <Link
                  to="/login"
                  className="block w-full py-2.5 text-sm mb-3 text-center"
                  style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, letterSpacing: '0.04em', textDecoration: 'none' }}
                >
                  Back to sign in
                </Link>              </motion.div>
            )}
          </AnimatePresence>

          {/* Back to login */}
          <Link
            to="/login"
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
            Back to sign in
          </Link>
        </div>
      </motion.div>
    </div>
  );
}
