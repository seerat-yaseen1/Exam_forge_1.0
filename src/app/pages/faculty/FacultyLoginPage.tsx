import { useState } from 'react';
import { useNavigate, Navigate, Link } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useFacultyAuth } from '../../context/FacultyAuthContext';
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
const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = '#0C0C0B';
  e.target.style.background = '#FFFFFF';
};
const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = '#E3E1DB';
  e.target.style.background = '#FAFAF8';
};

export function FacultyLoginPage() {
  const navigate = useNavigate();
  const { session, login } = useFacultyAuth();

  const [instituteCode, setInstituteCode] = useState('');
  const [email, setEmail]                 = useState('');
  const [password, setPassword]           = useState('');
  const [showPassword, setShowPassword]   = useState(false);
  const [error, setError]                 = useState('');
  const [loading, setLoading]             = useState(false);

  // Already logged in
  if (session) {
    return session.firstLoginRequired
      ? <Navigate to="/faculty/change-password" replace />
      : <Navigate to="/faculty/dashboard" replace />;
  }

  const canSubmit = instituteCode.trim().length > 0 && email.trim().length > 0 && password.length > 0 && !loading;

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
    if (result.firstLoginRequired) {
      navigate('/faculty/change-password', { replace: true });
    } else {
      navigate('/faculty/dashboard', { replace: true });
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4"
      style={{ background: '#F7F6F3' }}>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[380px]"
      >
        {/* Platform identity */}
        <div className="flex flex-col items-center mb-10">
          <div className="mb-4" style={{ color: '#0C0C0B' }}>
            <LogoMark px={36} />
          </div>
          <span className="text-sm font-medium" style={{ letterSpacing: '0.2em', color: '#0C0C0B' }}>
            STRATUM
          </span>
          <div className="mt-5 w-8" style={{ height: 1, background: '#DDDBD5' }} />
        </div>

        {/* Form card */}
        <div className="bg-white px-5 py-7 sm:px-8 sm:py-8"
          style={{ border: '1px solid #E3E1DB', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <p className="text-xs mb-1" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
            FACULTY ACCESS
          </p>
          <p className="text-xs mb-6" style={{ color: '#6B6B66', lineHeight: 1.6 }}>
            Your Institute Code was provided in your registration email.
          </p>

          <form onSubmit={handleSubmit} noValidate>
            {/* Institute Code */}
            <div className="mb-4">
              <label className="block text-xs mb-2" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
                Institute Code
              </label>
              <input
                type="text"
                autoFocus
                autoComplete="off"
                autoCapitalize="characters"
                value={instituteCode}
                onChange={(e) => { setInstituteCode(e.target.value.toUpperCase()); setError(''); }}
                disabled={loading}
                placeholder="e.g. A3B7C2"
                style={{ ...inputStyle, fontFamily: 'monospace', letterSpacing: '0.16em' }}
                onFocus={onFocus}
                onBlur={onBlur}
              />
            </div>

            {/* Email */}
            <div className="mb-4">
              <label className="block text-xs mb-2" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
                Email address
              </label>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(''); }}
                disabled={loading}
                placeholder="you@institute.edu"
                style={inputStyle}
                onFocus={onFocus}
                onBlur={onBlur}
              />
            </div>

            {/* Password */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
                  Password
                </label>
                <Link to="/faculty/forgot-password"
                  className="text-xs transition-colors"
                  style={{ color: '#6B6B66', textDecoration: 'none' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#0C0C0B')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#6B6B66')}>
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
                <button type="button" tabIndex={-1}
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: '#6B6B66' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#4A4A45')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#6B6B66')}>
                  {showPassword ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
                </button>
              </div>
            </div>

            <AnimatePresence>
              {error && (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="text-xs mb-4 -mt-2" style={{ color: '#9B2828' }}>
                  {error}
                </motion.p>
              )}
            </AnimatePresence>

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
              }}>
              {loading
                ? <><Loader2 size={14} className="animate-spin" /><span>Signing in…</span></>
                : 'Sign in'}
            </button>
          </form>
        </div>

        {/* Role links */}
        <div className="flex items-center justify-center gap-4 mt-6">
          <Link to="/login" className="text-xs transition-colors"
            style={{ color: '#6B6B66', textDecoration: 'none' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#6B6B66')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#6B6B66')}>
            Web Owner
          </Link>
          <span style={{ color: '#E3E1DB' }}>·</span>
          <Link to="/institute/login" className="text-xs transition-colors"
            style={{ color: '#6B6B66', textDecoration: 'none' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#6B6B66')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#6B6B66')}>
            Institute Admin
          </Link>
          <span style={{ color: '#E3E1DB' }}>·</span>
          <Link to="/student/login" className="text-xs transition-colors"
            style={{ color: '#6B6B66', textDecoration: 'none' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#6B6B66')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#6B6B66')}>
            Student
          </Link>
        </div>
      </motion.div>
    </div>
  );
}