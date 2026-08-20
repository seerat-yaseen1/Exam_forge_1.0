import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { motion } from 'motion/react';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { usePlatformSettings } from '../../context/PlatformSettingsContext';
import { LogoMark } from '../../components/PlatformLogo';
import {
  AuthShell, Field, MatchNote, PasswordField, StrengthBar,
} from '../../components/console/fields';
import { Button } from '../../components/console/ui';

type Stage = 'form' | 'success';

export function StudentResetPasswordPage() {
  const navigate = useNavigate();
  const { resetPassword } = useStudentAuth();
  // Was the literal placeholder "Platform Name", as on the recovery page.
  const { platformSettings } = usePlatformSettings();

  const [code, setCode]                       = useState('');
  const [newPassword, setNewPassword]         = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError]                     = useState('');
  const [loading, setLoading]                 = useState(false);
  const [stage, setStage]                     = useState<Stage>('form');

  const canSubmit =
    code.trim().length === 16 && newPassword.length >= 8 && confirmPassword.length > 0 && !loading;

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
        {stage === 'success' ? (
          <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
            <div className="flex flex-col items-center py-5 text-center">
              <CheckCircle2 size={30} strokeWidth={1.2} style={{ color: 'var(--ef-success)' }} />
              <p className="ef-display mt-4" style={{ fontSize: 17, color: 'var(--ef-ink)' }}>
                Password updated
              </p>
              <p className="mt-2" style={{ fontSize: 12.5, color: 'var(--ef-text-muted)', lineHeight: 1.65 }}>
                Your password has been set. You can sign in with it now.
              </p>
              <div className="mt-6 w-full">
                <Button
                  variant="primary"
                  size="lg"
                  block
                  onClick={() => navigate('/student/login', { replace: true })}
                >
                  Sign in
                </Button>
              </div>
            </div>
          </motion.div>
        ) : (
          <>
            <p className="ef-eyebrow mb-1.5">Reset password</p>
            <p className="mb-6" style={{ fontSize: 12.5, color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
              Enter the 16-character code from your email, then choose a new password.
            </p>

            <form onSubmit={handleSubmit} noValidate className="flex flex-col" style={{ gap: 16 }}>
              <Field
                label="Reset code"
                autoFocus
                autoComplete="off"
                autoCapitalize="characters"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16));
                  setError('');
                }}
                disabled={loading}
                placeholder="16 characters"
                style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: '0.14em', fontSize: 12.5 }}
                hint={
                  code.length === 16 ? (
                    <span style={{ color: 'var(--ef-success)' }}>Code format valid</span>
                  ) : code.length > 0 ? (
                    `${code.length} of 16`
                  ) : undefined
                }
              />

              <PasswordField
                label="New password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
                disabled={loading}
                placeholder="Min. 8 characters"
                footer={<StrengthBar password={newPassword} />}
              />

              <PasswordField
                label="Confirm new password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
                disabled={loading}
                placeholder="Repeat password"
                footer={<MatchNote password={newPassword} confirm={confirmPassword} />}
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
                {loading ? 'Resetting…' : 'Reset password'}
              </Button>
            </form>

            <Link
              to="/student/login"
              className="flex items-center gap-1.5 mt-5"
              style={{ fontSize: 11.5, color: 'var(--ef-text-muted)', textDecoration: 'none' }}
            >
              <ArrowLeft size={12} strokeWidth={1.6} />
              Back to sign in
            </Link>
          </>
        )}
      </AuthShell>
    </motion.div>
  );
}
