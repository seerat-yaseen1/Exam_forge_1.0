import { useState } from 'react';
import { useNavigate, Link, Navigate } from 'react-router';
import { motion } from 'motion/react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { LogoMark } from '../components/PlatformLogo';

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

export function LoginPage() {
  const navigate = useNavigate();
  const { user, login, platformSettings } = useAuth();

  const [email, setEmail]               = useState('');
  const [password, setPassword]         = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError]               = useState('');
  const [loading, setLoading]           = useState(false);

  if (user) return <Navigate to="/dashboard" replace />;

  const canSubmit = email.trim().length > 0 && password.length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setLoading(true);
    const result = await login(email, password);
    setLoading(false);
    if (!result.success) {
      setError(result.error ?? 'An error occurred.');
      return;
    }
    navigate('/dashboard', { replace: true });
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
            WEB OWNER ACCESS
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
                placeholder="you@platform.com"
                style={inputStyle}
                onFocus={onFocus}
                onBlur={onBlur}
              />
            </div>

            {/* Password */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
                  Password
                </label>
                <Link
                  to="/forgot-password"
                  className="text-xs transition-colors"
                  style={{ color: '#9A9891', textDecoration: 'none' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#0C0C0B')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#9A9891')}
                >
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
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mb-4 -mt-2"
              >
                <p className="text-xs" style={{ color: '#9B2828' }}>{error}</p>
                {error.includes('Account not found') && (
                  <Link
                    to="/initialize"
                    className="text-xs mt-1.5 inline-block transition-colors"
                    style={{ color: '#0C0C0B', textDecoration: 'underline' }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.textDecoration = 'none')}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.textDecoration = 'underline')}
                  >
                    → Initialize Web Owner account
                  </Link>
                )}
              </motion.div>
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
            to="/institute/login"
            className="text-xs transition-colors"
            style={{ color: '#C4C3BD', textDecoration: 'none' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#9A9891')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#C4C3BD')}
          >
            Institute
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
