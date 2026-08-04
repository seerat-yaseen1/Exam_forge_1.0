import { useState } from 'react';
import { Link } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, Loader2, Mail } from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
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

type Stage = 'input' | 'sent';

export function StudentForgotPasswordPage() {
  const { requestPasswordReset } = useStudentAuth();

  const [stage, setStage]           = useState<Stage>('input');
  const [instituteCode, setInstituteCode] = useState('');
  const [email, setEmail]           = useState('');
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [emailSent, setEmailSent]   = useState(false);

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
            Platform Name
          </span>
          <div className="mt-5 w-8" style={{ height: 1, background: '#DDDBD5' }} />
        </div>

        <div className="bg-white px-5 py-7 sm:px-8 sm:py-8"
          style={{ border: '1px solid #E3E1DB', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <AnimatePresence mode="wait">
            {stage === 'input' ? (
              <motion.div key="input" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                <p className="text-xs mb-1" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
                  PASSWORD RECOVERY
                </p>
                <p className="text-xs mb-6" style={{ color: '#6B6B66', lineHeight: 1.6 }}>
                  Provide your Institute Code and email. A password-reset link will be sent to your inbox.
                </p>

                <form onSubmit={handleSubmit} noValidate>
                  <div className="mb-4">
                    <label className="block text-xs mb-2" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
                      Institute Code
                    </label>
                    <input type="text" autoFocus autoComplete="off" autoCapitalize="characters"
                      value={instituteCode}
                      onChange={(e) => { setInstituteCode(e.target.value.toUpperCase()); setError(''); }}
                      disabled={loading} placeholder="e.g. A3B7C2"
                      style={{ ...inputStyle, fontFamily: 'monospace', letterSpacing: '0.16em' }}
                      onFocus={onFocus} onBlur={onBlur} />
                  </div>

                  <div className="mb-5">
                    <label className="block text-xs mb-2" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
                      Email address
                    </label>
                    <input type="email" autoComplete="email"
                      value={email}
                      onChange={(e) => { setEmail(e.target.value); setError(''); }}
                      disabled={loading} placeholder="you@institute.edu"
                      style={inputStyle}
                      onFocus={onFocus} onBlur={onBlur} />
                  </div>

                  {error && (
                    <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                      className="text-xs mb-4 -mt-1" style={{ color: '#9B2828' }}>
                      {error}
                    </motion.p>
                  )}

                  <button type="submit" disabled={!canSubmit}
                    className="w-full py-2.5 text-sm flex items-center justify-center gap-2 mb-3"
                    style={{
                      background: canSubmit ? '#0C0C0B' : '#C8C7C2',
                      color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.04em',
                      cursor: canSubmit ? 'pointer' : 'not-allowed',
                    }}>
                    {loading
                      ? <><Loader2 size={14} className="animate-spin" /><span>Sending…</span></>
                      : 'Send reset code'}
                  </button>
                </form>
              </motion.div>
            ) : (
              <motion.div key="sent" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                transition={{ duration: 0.25 }}>
                <p className="text-xs mb-1" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
                  RESET CODE DISPATCHED
                </p>

                {/* Email delivery status */}
                <div className="flex items-start gap-2.5 px-3 py-3 mb-5"
                  style={{
                    background: emailSent ? '#F0F7F2' : '#F7F6F3',
                    border: `1px solid ${emailSent ? '#C6DECE' : '#E3E1DB'}`,
                    borderRadius: 2,
                  }}>
                  <Mail size={12} strokeWidth={1.5} style={{ color: emailSent ? '#2A6B3A' : '#6B6B66', marginTop: 1, flexShrink: 0 }} />
                  <p className="text-xs" style={{ color: emailSent ? '#2A6B3A' : '#6B6B66', lineHeight: 1.6 }}>
                    {emailSent
                      ? `If an account matches ${email}, a password-reset link has been sent. Open it from your inbox to set a new password. The link expires in 1 hour and can be used once.`
                      : `If you don't receive an email shortly, check your spam folder or contact your administrator.`}
                  </p>
                </div>

                <Link to="/student/login"
                  className="block w-full py-2.5 text-sm mb-3 text-center"
                  style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.04em', textDecoration: 'none' }}>
                  Back to sign in
                </Link>
              </motion.div>
            )}
          </AnimatePresence>

          <Link to="/student/login"
            className="flex items-center gap-1.5 text-xs transition-colors"
            style={{ color: '#6B6B66', textDecoration: 'none' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#0C0C0B')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#6B6B66')}>
            <ArrowLeft size={12} strokeWidth={1.5} />Back to sign in
          </Link>
        </div>
      </motion.div>
    </div>
  );
}