import { useState } from 'react';
import { useNavigate, Navigate, Link } from 'react-router';
import { motion } from 'motion/react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useInstituteAuth } from '../../context/InstituteAuthContext';
import { usePlatformSettings } from '../../context/PlatformSettingsContext';
import { LogoMark } from '../../components/PlatformLogo';

const inputStyle: React.CSSProperties = {
  background: 'var(--ef-canvas-raised)',
  border: '1px solid var(--ef-border)',
  color: 'var(--ef-ink)',
  borderRadius: 2,
  width: '100%',
  outline: 'none',
  fontSize: 13,
  padding: '10px 14px',
};

export function InstituteLoginPage() {
  const navigate = useNavigate();
  const { session, login } = useInstituteAuth();
  const { platformSettings } = usePlatformSettings();

  const [email, setEmail]               = useState('');
  const [password, setPassword]         = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError]               = useState('');
  const [loading, setLoading]           = useState(false);

  // Already logged in
  if (session) {
    return session.firstLoginRequired
      ? <Navigate to="/institute/change-password" replace />
      : <Navigate to="/institute/dashboard" replace />;
  }

  const canSubmit = email.trim().length > 0 && password.length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setLoading(true);
    const result = await login(email.trim(), password);
    setLoading(false);
    if (!result.success) {
      setError(result.error ?? 'An error occurred.');
      return;
    }
    if (result.firstLoginRequired) {
      navigate('/institute/change-password', { replace: true });
    } else {
      navigate('/institute/dashboard', { replace: true });
    }
  };

  const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = 'var(--ef-ink)';
    e.target.style.background = 'var(--ef-surface)';
  };
  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = 'var(--ef-border)';
    e.target.style.background = 'var(--ef-canvas-raised)';
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
          <div className="mt-5 w-8" style={{ height: 1, background: 'var(--ef-border-muted)' }} />
        </div>

        {/* Form card */}
        <div
          className="bg-white px-5 py-7 sm:px-8 sm:py-8"
          style={{
            border: '1px solid var(--ef-border)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
          }}
        >
          <p className="text-xs mb-6" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
            INSTITUTE ADMIN ACCESS
          </p>

          <form onSubmit={handleSubmit} noValidate>
            {/* Email */}
            <div className="mb-4">
              <label className="block text-xs mb-2" style={{ color: 'var(--ef-text-subtle)', letterSpacing: '0.04em' }}>
                Email address
              </label>
              <input
                type="email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(''); }}
                disabled={loading}
                placeholder="admin@institute.edu"
                style={inputStyle}
                onFocus={onFocus}
                onBlur={onBlur}
              />
            </div>

            {/* Password */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs" style={{ color: 'var(--ef-text-subtle)', letterSpacing: '0.04em' }}>
                  Password
                </label>
                <Link to="/institute/forgot-password"
                  className="text-xs transition-colors"
                  style={{ color: 'var(--ef-text-muted)', textDecoration: 'none' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-ink)')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)')}>
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(''); }}
                  disabled={loading}
                  placeholder="••••••••••"
                  style={{ ...inputStyle, paddingRight: 40 }}
                  onFocus={onFocus}
                  onBlur={onBlur}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: 'var(--ef-text-muted)' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)')}
                >
                  {showPassword ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
                </button>
              </div>
            </div>

            {/* Error */}
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
              className="w-full py-2.5 text-sm flex items-center justify-center gap-2 transition-opacity"
              style={{
                background: canSubmit ? 'var(--ef-ink)' : 'var(--ef-track)',
                color: 'var(--ef-surface)',
                borderRadius: 2,
                letterSpacing: '0.04em',
                cursor: canSubmit ? 'pointer' : 'not-allowed',
              }}
            >
              {loading ? (
                <><Loader2 size={14} className="animate-spin" /><span>Signing in…</span></>
              ) : (
                'Sign in'
              )}
            </button>
          </form>
        </div>

        {/* Role links */}
        <div className="flex items-center justify-center gap-4 mt-6">
          <Link
            to="/login"
            className="text-xs transition-colors"
            style={{ color: 'var(--ef-text-muted)', textDecoration: 'none' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)')}
          >
            Web Owner
          </Link>
          <span style={{ color: 'var(--ef-border)' }}>·</span>
          <Link
            to="/faculty/login"
            className="text-xs transition-colors"
            style={{ color: 'var(--ef-text-muted)', textDecoration: 'none' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)')}
          >
            Faculty
          </Link>
          <span style={{ color: 'var(--ef-border)' }}>·</span>
          <Link
            to="/student/login"
            className="text-xs transition-colors"
            style={{ color: 'var(--ef-text-muted)', textDecoration: 'none' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)')}
          >
            Student
          </Link>
        </div>
      </motion.div>
    </div>
  );
}