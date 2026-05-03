import { useState } from 'react';
import { useNavigate, Navigate, Link } from 'react-router';
import { motion } from 'motion/react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useInstituteAuth } from '../../context/InstituteAuthContext';
import { useAuth } from '../../context/AuthContext';
import { LogoMark } from '../../components/PlatformLogo';

const inputStyle: React.CSSProperties = {
  background: '#FAFAF8',
  border: '1px solid #E3E1DB',
  color: '#0C0C0B',
  borderRadius: 2,
  width: '100%',
  outline: 'none',
  fontSize: 13,
  padding: '10px 14px',
};

export function InstituteLoginPage() {
  const navigate = useNavigate();
  const { session, login } = useInstituteAuth();
  const { platformSettings } = useAuth();

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
    e.target.style.borderColor = '#0C0C0B';
    e.target.style.background = '#FFFFFF';
  };
  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = '#E3E1DB';
    e.target.style.background = '#FAFAF8';
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
          <div className="mt-5 w-8" style={{ height: 1, background: '#DDDBD5' }} />
        </div>

        {/* Form card */}
        <div
          className="bg-white px-8 py-8"
          style={{
            border: '1px solid #E3E1DB',
            boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
          }}
        >
          <p className="text-xs mb-6" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>
            INSTITUTE ADMIN ACCESS
          </p>

          <form onSubmit={handleSubmit} noValidate>
            {/* Email */}
            <div className="mb-4">
              <label className="block text-xs mb-2" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
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
              <label className="block text-xs mb-2" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
                Password
              </label>
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
                  style={{ color: '#B0AEA8' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#4A4A45')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#B0AEA8')}
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
                style={{ color: '#9B2828' }}
              >
                {error}
              </motion.p>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full py-2.5 text-sm flex items-center justify-center gap-2 transition-opacity"
              style={{
                background: canSubmit ? '#0C0C0B' : '#C8C7C2',
                color: '#FFFFFF',
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
            style={{ color: '#C4C3BD', textDecoration: 'none' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#9A9891')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#C4C3BD')}
          >
            Web Owner
          </Link>
          <span style={{ color: '#E3E1DB' }}>·</span>
          <Link
            to="/faculty/login"
            className="text-xs transition-colors"
            style={{ color: '#C4C3BD', textDecoration: 'none' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#9A9891')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#C4C3BD')}
          >
            Faculty
          </Link>
          <span style={{ color: '#E3E1DB' }}>·</span>
          <Link
            to="/student/login"
            className="text-xs transition-colors"
            style={{ color: '#C4C3BD', textDecoration: 'none' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#9A9891')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#C4C3BD')}
          >
            Student
          </Link>
        </div>
      </motion.div>
    </div>
  );
}