import { useState } from 'react';
import { useNavigate, Link, Navigate } from 'react-router';
import { motion } from 'motion/react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { LogoMark } from '../components/PlatformLogo';

export function LoginPage() {
  const navigate = useNavigate();
  const { user, login, platformSettings } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // If already authenticated, redirect
  if (user) return <Navigate to="/dashboard" replace />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;

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

  const canSubmit = email.trim().length > 0 && password.length > 0 && !loading;

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
            className="mt-5 mb-0 w-8"
            style={{ height: '1px', background: '#DDDBD5' }}
          />
        </div>

        {/* Form card */}
        <div
          className="bg-white px-8 py-8"
          style={{
            border: '1px solid #E3E1DB',
            boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.04)',
          }}
        >
          <p
            className="text-xs mb-6"
            style={{ color: '#9A9891', letterSpacing: '0.08em' }}
          >
            WEB OWNER ACCESS
          </p>

          <form onSubmit={handleSubmit} noValidate>
            <div className="mb-4">
              <label
                htmlFor="email"
                className="block text-xs mb-2"
                style={{ color: '#4A4A45', letterSpacing: '0.04em' }}
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                autoFocus
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

            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <label
                  htmlFor="password"
                  className="block text-xs"
                  style={{ color: '#4A4A45', letterSpacing: '0.04em' }}
                >
                  Password
                </label>
                <Link
                  to="/forgot-password"
                  className="text-xs transition-colors"
                  style={{ color: '#9A9891', textDecoration: 'none' }}
                  onMouseEnter={(e) => {
                    (e.target as HTMLElement).style.color = '#0C0C0B';
                  }}
                  onMouseLeave={(e) => {
                    (e.target as HTMLElement).style.color = '#9A9891';
                  }}
                >
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError('');
                  }}
                  disabled={loading}
                  placeholder="••••••••••"
                  className="w-full px-3.5 py-2.5 pr-10 text-sm outline-none transition-colors"
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
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: '#B0AEA8' }}
                  tabIndex={-1}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.color = '#4A4A45';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.color = '#B0AEA8';
                  }}
                >
                  {showPassword ? (
                    <EyeOff size={14} strokeWidth={1.5} />
                  ) : (
                    <Eye size={14} strokeWidth={1.5} />
                  )}
                </button>
              </div>
            </div>

            {/* Error message */}
            {error && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2 }}
                className="mb-4 -mt-2"
              >
                <p className="text-xs" style={{ color: '#9B2828' }}>
                  {error}
                </p>
                {error.includes('Account not found') && (
                  <Link
                    to="/initialize"
                    className="text-xs mt-1.5 inline-block transition-colors"
                    style={{ color: '#0C0C0B', textDecoration: 'underline' }}
                    onMouseEnter={(e) => {
                      (e.target as HTMLElement).style.textDecoration = 'none';
                    }}
                    onMouseLeave={(e) => {
                      (e.target as HTMLElement).style.textDecoration = 'underline';
                    }}
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
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>Signing in…</span>
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>
        </div>

        {/* Demo credentials — styled as system documentation */}
        <div
          className="mt-6 px-4 py-3"
          style={{
            border: '1px solid #E3E1DB',
            borderLeft: '2px solid #C8C7C2',
            background: '#F0EFEBaa',
          }}
        >
          <p className="text-xs mb-1" style={{ color: '#6B6B65', letterSpacing: '0.06em' }}>
            DEMO CREDENTIALS
          </p>
          <p className="text-xs" style={{ color: '#9A9891' }}>
            <span style={{ color: '#6B6B65' }}>Email:</span> owner@platform.com
          </p>
          <p className="text-xs" style={{ color: '#9A9891' }}>
            <span style={{ color: '#6B6B65' }}>Password:</span> Authority2026!
          </p>
        </div>
      </motion.div>
    </div>
  );
}