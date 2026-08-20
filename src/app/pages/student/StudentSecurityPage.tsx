import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, KeyRound, ShieldCheck } from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { MatchNote, PasswordField, StrengthBar } from '../../components/student/fields';
import { Button, Card, PageHeader, PageShell } from '../../components/student/ui';

export function StudentSecurityPage() {
  const { session, changePassword } = useStudentAuth();

  const [newPassword, setNewPassword]         = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError]                     = useState('');
  const [success, setSuccess]                 = useState(false);
  const [loading, setLoading]                 = useState(false);

  const canSubmit = newPassword.length >= 8 && confirmPassword.length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
    setError('');
    setLoading(true);
    const result = await changePassword(newPassword);
    setLoading(false);
    if (!result.success) { setError(result.error ?? 'Failed to update password.'); return; }
    setSuccess(true);
    setNewPassword('');
    setConfirmPassword('');
    setTimeout(() => setSuccess(false), 5000);
  };

  return (
    <PageShell narrow>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Security
          </>
        }
        title="Change your password"
        subtitle="Your password is the only thing standing between your account and someone sitting an exam as you."
      />

      <div className="flex flex-col" style={{ gap: 'var(--ef-gap)' }}>
        <Card>
          <AnimatePresence>
            {success && (
              <motion.div
                role="status"
                initial={{ opacity: 0, y: -6, height: 0 }}
                animate={{ opacity: 1, y: 0, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div
                  className="flex items-center gap-2.5 px-3.5 py-3 mb-5"
                  style={{
                    background: 'var(--ef-success-bg)',
                    border: '1px solid var(--ef-success-border)',
                    borderRadius: 'var(--ef-radius-sm)',
                  }}
                >
                  <Check size={13} strokeWidth={2.2} style={{ color: 'var(--ef-success)', flexShrink: 0 }} />
                  <p style={{ fontSize: 12.5, color: 'var(--ef-success)' }}>Password updated.</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <form onSubmit={handleSubmit} noValidate className="flex flex-col" style={{ gap: 18 }}>
            <PasswordField
              label="New password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => { setNewPassword(e.target.value); setError(''); setSuccess(false); }}
              disabled={loading}
              placeholder="Min. 8 characters"
              footer={<StrengthBar password={newPassword} />}
            />

            <PasswordField
              label="Confirm new password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => { setConfirmPassword(e.target.value); setError(''); setSuccess(false); }}
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
              <KeyRound size={13} strokeWidth={1.7} />
              {loading ? 'Updating…' : 'Update password'}
            </Button>
          </form>
        </Card>

        <Card variant="inset">
          <div className="flex items-start gap-3">
            <ShieldCheck size={15} strokeWidth={1.6} style={{ color: 'var(--ef-text-muted)', flexShrink: 0, marginTop: 1 }} />
            <div>
              <p style={{ fontSize: 12.5, color: 'var(--ef-ink)', fontWeight: 500 }}>
                What makes a good one
              </p>
              <p className="mt-1.5" style={{ fontSize: 11.5, color: 'var(--ef-text-muted)', lineHeight: 1.7 }}>
                At least eight characters — twelve is better — with upper and lower case, a number and a
                symbol. Do not reuse the password from another site: a breach somewhere else becomes a
                breach here.
                {session && (
                  <>
                    {' '}Your account is <strong style={{ color: 'var(--ef-text-subtle)', fontWeight: 500 }}>{session.email}</strong>.
                  </>
                )}
              </p>
            </div>
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
