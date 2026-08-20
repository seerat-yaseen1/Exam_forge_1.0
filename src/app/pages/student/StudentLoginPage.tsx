import { useState } from 'react';
import { useNavigate, Navigate, Link } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { usePlatformSettings } from '../../context/PlatformSettingsContext';
import { LogoMark } from '../../components/PlatformLogo';
import { AuthShell, Field, PasswordField } from '../../components/student/fields';
import { Button } from '../../components/student/ui';

export function StudentLoginPage() {
  const navigate = useNavigate();
  const { session, login } = useStudentAuth();
  // The wordmark used to be the string "STRATUM", hardcoded, while every other
  // student screen renders `platformSettings.name`. An institute that had set
  // its own product name saw it everywhere except on the page where a student
  // arrives first.
  const { platformSettings } = usePlatformSettings();

  const [instituteCode, setInstituteCode] = useState('');
  const [email, setEmail]                 = useState('');
  const [password, setPassword]           = useState('');
  const [error, setError]                 = useState('');
  const [loading, setLoading]             = useState(false);

  // Already logged in
  if (session) {
    return session.firstLoginRequired
      ? <Navigate to="/student/change-password" replace />
      : <Navigate to="/student/dashboard" replace />;
  }

  const canSubmit =
    instituteCode.trim().length > 0 && email.trim().length > 0 && password.length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setLoading(true);
    const result = await login(instituteCode.trim(), email.trim(), password);
    setLoading(false);
    if (!result.success) {
      setError(result.error ?? 'An error occurred.');
      return;
    }
    navigate(result.firstLoginRequired ? '/student/change-password' : '/student/dashboard', {
      replace: true,
    });
  };

  const roleLink = (to: string, label: string) => (
    <Link
      to={to}
      style={{ fontSize: 11.5, color: 'var(--ef-text-muted)', textDecoration: 'none' }}
    >
      {label}
    </Link>
  );

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
        footer={
          <div className="flex items-center justify-center gap-3 mt-6">
            {roleLink('/login', 'Web Owner')}
            <span style={{ color: 'var(--ef-border)' }}>·</span>
            {roleLink('/institute/login', 'Institute Admin')}
            <span style={{ color: 'var(--ef-border)' }}>·</span>
            {roleLink('/faculty/login', 'Faculty')}
          </div>
        }
      >
        <p className="ef-eyebrow mb-1.5">Student access</p>
        <p className="mb-6" style={{ fontSize: 12.5, color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
          Your Institute Code was provided in your registration email.
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

          <PasswordField
            label="Password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            disabled={loading}
            placeholder="••••••••••"
            footer={
              <div className="flex justify-end mt-2">
                <Link
                  to="/student/forgot-password"
                  style={{ fontSize: 11.5, color: 'var(--ef-text-muted)', textDecoration: 'none' }}
                >
                  Forgot password?
                </Link>
              </div>
            }
          />

          <AnimatePresence>
            {error && (
              <motion.p
                role="alert"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                style={{ fontSize: 12, color: 'var(--ef-danger)' }}
              >
                {error}
              </motion.p>
            )}
          </AnimatePresence>

          <Button type="submit" variant="primary" size="lg" block disabled={!canSubmit} loading={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </AuthShell>
    </motion.div>
  );
}
