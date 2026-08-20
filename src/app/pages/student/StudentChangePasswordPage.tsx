import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router';
import { motion } from 'motion/react';
import { ShieldCheck } from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { LogoMark } from '../../components/PlatformLogo';
import {
  AuthShell, MatchNote, PasswordField, StrengthBar,
} from '../../components/console/fields';
import { Button } from '../../components/console/ui';

export function StudentChangePasswordPage() {
  const navigate = useNavigate();
  // Audit L3 (2026-08-04): the logo comes from the CONTEXT, not the session.
  // This page read `session.logoUrl`, a field StudentSession has never had, so
  // it was always undefined and the institute's uploaded logo silently never
  // appeared here — the generic LogoMark fallback rendered every time.
  const { session, changePassword, instituteLogo } = useStudentAuth();

  const [newPassword, setNewPassword]         = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError]                     = useState('');
  const [loading, setLoading]                 = useState(false);

  if (!session) return <Navigate to="/student/login" replace />;
  if (!session.firstLoginRequired) return <Navigate to="/student/dashboard" replace />;

  const canSubmit = newPassword.length >= 8 && confirmPassword.length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
    if (newPassword.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setError('');
    setLoading(true);
    const result = await changePassword(newPassword);
    setLoading(false);
    if (!result.success) { setError(result.error ?? 'Failed to set password.'); return; }
    navigate('/student/dashboard', { replace: true });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <AuthShell
        mark={
          instituteLogo
            ? <img src={instituteLogo} alt={session.instituteName}
                style={{ width: 34, height: 34, objectFit: 'contain' }} />
            : <LogoMark px={34} />
        }
        wordmark={session.instituteName}
      >
        <div
          className="flex items-start gap-3 px-3.5 py-3 mb-6"
          style={{
            background: 'var(--ef-accent-soft)',
            border: '1px solid var(--ef-accent-border)',
            borderRadius: 'var(--ef-radius-sm)',
          }}
        >
          <ShieldCheck size={14} strokeWidth={1.6} style={{ color: 'var(--ef-accent)', marginTop: 1, flexShrink: 0 }} />
          <div>
            <p style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ef-ink)' }}>
              Password change required
            </p>
            <p className="mt-1" style={{ fontSize: 11.5, color: 'var(--ef-text-muted)', lineHeight: 1.55 }}>
              You are signed in with a temporary password. Set a permanent one to reach your workspace.
            </p>
          </div>
        </div>

        <p className="ef-eyebrow mb-2">Set new password</p>
        <p style={{ fontSize: 13.5, color: 'var(--ef-ink)' }}>{session.name}</p>
        <p className="mb-6" style={{ fontSize: 11.5, color: 'var(--ef-text-muted)' }}>{session.email}</p>

        <form onSubmit={handleSubmit} noValidate className="flex flex-col" style={{ gap: 16 }}>
          <PasswordField
            label="New password"
            autoFocus
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
            {loading ? 'Saving…' : 'Set password & enter workspace'}
          </Button>
        </form>
      </AuthShell>
    </motion.div>
  );
}
