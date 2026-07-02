import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, Loader2, Copy, Check } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { LogoMark } from '../components/PlatformLogo';

type Stage = 'input' | 'sent';

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const { requestPasswordReset, platformSettings } = useAuth();

  const [stage, setStage] = useState<Stage>('input');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetCode, setResetCode] = useState('');
  const [copied, setCopied] = useState(false);

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

    setResetCode(result.code ?? '');
    setStage('sent');
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(resetCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleProceed = () => {
    navigate('/reset-password', { state: { email, code: resetCode } });
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-4"
      style={{ background: '#F7F6F3' }}
    >
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[380px]"
      >
        {/* Platform identity */}
        <div className="flex flex-col items-center mb-10">
          <div className="mb-4" style={{ color: '#0C0C0B' }}>
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
            style={{ letterSpacing: '0.2em', color: '#0C0C0B' }}
          >
            {platformSettings.name}
          </span>
          <div
            className="mt-5"
            style={{ height: '1px', width: 32, background: '#DDDBD5' }}
          />
        </div>

        <div
          className="bg-white px-5 py-7 sm:px-8 sm:py-8"
          style={{
            border: '1px solid #E3E1DB',
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
                  style={{ color: '#9A9891', letterSpacing: '0.08em' }}
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
                      style={{ color: '#4A4A45', letterSpacing: '0.04em' }}
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
                        background: '#FAFAF8',
                        border: '1px solid #E3E1DB',
                        color: '#0C0C0B',
                        borderRadius: 2,
                      }}
                      onFocus={(e) => {
                        e.target.style.borderColor = '#0C0C0B';
                        e.target.style.background = '#FFFFFF';
                      }}
                      onBlur={(e) => {
                        e.target.style.borderColor = '#E3E1DB';
                        e.target.style.background = '#FAFAF8';
                      }}
                    />
                  </div>

                  {error && (
                    <motion.p
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="text-xs mb-4 -mt-1"
                      style={{ color: '#9B2828' }}
                    >
                      {error}
                    </motion.p>
                  )}

                  <button
                    type="submit"
                    disabled={!email.trim() || loading}
                    className="w-full py-2.5 text-sm flex items-center justify-center gap-2 transition-opacity mb-3"
                    style={{
                      background: email.trim() && !loading ? '#0C0C0B' : '#C8C7C2',
                      color: '#FFFFFF',
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
                  style={{ color: '#9A9891', letterSpacing: '0.08em' }}
                >
                  RESET CODE ISSUED
                </p>
                <p className="text-xs mb-5" style={{ color: '#6B6B65' }}>
                  In production, this code is sent securely to your email.
                  It is valid for{' '}
                  <span style={{ color: '#0C0C0B' }}>15 minutes</span> and
                  can only be used once.
                </p>

                {/* Code display */}
                <div
                  className="mb-5 flex items-center justify-between px-4 py-3"
                  style={{
                    background: '#F7F6F3',
                    border: '1px solid #E3E1DB',
                    borderRadius: 2,
                  }}
                >
                  <span
                    className="text-sm font-medium tracking-widest"
                    style={{ color: '#0C0C0B', fontFamily: 'monospace', letterSpacing: '0.25em' }}
                  >
                    {resetCode}
                  </span>
                  <button
                    onClick={handleCopy}
                    className="ml-3 transition-colors"
                    style={{ color: '#9A9891' }}
                    onMouseEnter={(e) =>
                      ((e.currentTarget as HTMLElement).style.color = '#0C0C0B')
                    }
                    onMouseLeave={(e) =>
                      ((e.currentTarget as HTMLElement).style.color = '#9A9891')
                    }
                    aria-label="Copy reset code"
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>

                <p className="text-xs mb-5" style={{ color: '#9A9891' }}>
                  Account:{' '}
                  <span style={{ color: '#4A4A45' }}>{email}</span>
                </p>

                <button
                  onClick={handleProceed}
                  className="w-full py-2.5 text-sm mb-3"
                  style={{
                    background: '#0C0C0B',
                    color: '#FFFFFF',
                    borderRadius: 2,
                    letterSpacing: '0.04em',
                    cursor: 'pointer',
                  }}
                >
                  Enter reset code
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Back to login */}
          <Link
            to="/login"
            className="flex items-center gap-1.5 text-xs transition-colors"
            style={{ color: '#9A9891', textDecoration: 'none' }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = '#0C0C0B';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = '#9A9891';
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
