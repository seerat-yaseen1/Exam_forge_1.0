import { useState } from 'react';
import { Link } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, Mail } from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { usePlatformSettings } from '../../context/PlatformSettingsContext';
import { LogoMark } from '../../components/PlatformLogo';
import { AuthShell, Field } from '../../components/student/fields';
import { Button } from '../../components/console/ui';

type Stage = 'input' | 'sent';

export function StudentForgotPasswordPage() {
  const { requestPasswordReset } = useStudentAuth();
  // This page's wordmark was the literal string "Platform Name" — a
  // placeholder that shipped. It is the configured product name now, as on
  // every other student screen.
  const { platformSettings } = usePlatformSettings();

  const [stage, setStage]                 = useState<Stage>('input');
  const [instituteCode, setInstituteCode] = useState('');
  const [email, setEmail]                 = useState('');
  const [error, setError]                 = useState('');
  const [loading, setLoading]             = useState(false);
  const [emailSent, setEmailSent]         = useState(false);

  const canSubmit = instituteCode.trim().length > 0 && email.trim().length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setLoading(true);
    const result = await requestPasswordReset(instituteCode.trim(), email.trim());
    setLoading(false);
    if (!result.success) { setError(result.error ?? 'An error occurred.'); return; }
    setEmailSent(result.emailSent ?? false);
    setStage('sent');
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <AuthShell
        mark={
          platformSettings.logoUrl
            ? <img src={platformSettings.logoUrl} alt={platformSettings.name}
                style={{ width: 34, height: 34, objectFit: 'contain' }} />
            : <LogoMark px={34} />
        }
        wordmark={platformSettings.name}
      >
        <AnimatePresence mode="wait">
          {stage === 'input' ? (
            <motion.div key="input" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              <p className="ef-eyebrow mb-1.5">Password recovery</p>
              <p className="mb-6" style={{ fontSize: 12.5, color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                Give your Institute Code and email. A password-reset link goes to your inbox.
              </p>

              <form onSubmit={handleSubmit} noValidate className="flex flex-col" style={{ gap: 16 }}>
                <Field
                  label="Institute Code"
                  autoFocus
                  autoComplete="off"
                  autoCapitalize="characters"
                  value={instituteCode}
                  onChange={(e) => { setInstituteCode(e.target.value.toUpperCase()); setError(''); }}
                  disabled={loading}
                  placeholder="e.g. A3B7C2"
                  style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: '0.16em' }}
                />

                <Field
                  label="Email address"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(''); }}
                  disabled={loading}
                  placeholder="you@institute.edu"
                />

                {error && (
                  <motion.p
                    role="alert"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    style={{ fontSize: 12, color: 'var(--ef-danger)' }}
                  >
                    {error}
                  </motion.p>
                )}

                <Button type="submit" variant="primary" size="lg" block disabled={!canSubmit} loading={loading}>
                  {loading ? 'Sending…' : 'Send reset link'}
                </Button>
              </form>
            </motion.div>
          ) : (
            <motion.div key="sent" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
              <p className="ef-eyebrow mb-3">Check your inbox</p>

              <div
                className="flex items-start gap-2.5 px-3.5 py-3 mb-5"
                style={{
                  background: emailSent ? 'var(--ef-success-bg)' : 'var(--ef-canvas-raised)',
                  border: `1px solid ${emailSent ? 'var(--ef-success-border)' : 'var(--ef-border)'}`,
                  borderRadius: 'var(--ef-radius-sm)',
                }}
              >
                <Mail
                  size={13}
                  strokeWidth={1.6}
                  style={{ color: emailSent ? 'var(--ef-success)' : 'var(--ef-text-muted)', marginTop: 2, flexShrink: 0 }}
                />
                <p style={{ fontSize: 12, color: emailSent ? 'var(--ef-success)' : 'var(--ef-text-muted)', lineHeight: 1.65 }}>
                  {emailSent
                    ? `If an account matches ${email}, a password-reset link has been sent. Open it from your inbox to set a new password. The link expires in 1 hour and can be used once.`
                    : "If you don't receive an email shortly, check your spam folder or contact your administrator."}
                </p>
              </div>

              <Link to="/student/login" style={{ textDecoration: 'none' }}>
                <Button variant="primary" size="lg" block>Back to sign in</Button>
              </Link>
            </motion.div>
          )}
        </AnimatePresence>

        <Link
          to="/student/login"
          className="flex items-center gap-1.5 mt-5"
          style={{ fontSize: 11.5, color: 'var(--ef-text-muted)', textDecoration: 'none' }}
        >
          <ArrowLeft size={12} strokeWidth={1.6} />
          Back to sign in
        </Link>
      </AuthShell>
    </motion.div>
  );
}
