import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, Loader2, Mail } from 'lucide-react';
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
const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = '#0C0C0B';
  e.target.style.background = '#FFFFFF';
};
const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = '#E3E1DB';
  e.target.style.background = '#FAFAF8';
};

type Stage = 'input' | 'sent';

export function InstituteForgotPasswordPage() {
  const navigate = useNavigate();
  const { requestPasswordReset } = useInstituteAuth();
  const { platformSettings } = useAuth();

  const [stage, setStage]                   = useState<Stage>('input');
  const [instituteCode, setInstituteCode]   = useState('');
  const [error, setError]                   = useState('');
  const [loading, setLoading]               = useState(false);
  const [emailSent, setEmailSent]           = useState(false);

  const canSubmit = instituteCode.trim().length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setLoading(true);
    const result = await requestPasswordReset(instituteCode.trim());
    setLoading(false);
    if (!result.success) { setError(result.error ?? 'An error occurred.'); return; }
    setEmailSent(result.emailSent ?? false);
    setStage('sent');
  };

  const handleProceed = () => {
    navigate('/institute/reset-password', {
      state: { instituteCode: instituteCode.trim() },
    });
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
            {platformSettings.logoUrl
              ? <img src={platformSettings.logoUrl} alt={platformSettings.name}
                  style={{ width: 36, height: 36, objectFit: 'contain' }} />
              : <LogoMark px={36} />}
          </div>
          <span className="text-sm font-medium" style={{ letterSpacing: '0.2em', color: '#0C0C0B' }}>
            {platformSettings.name}
          </span>
          <div className="mt-5 w-8" style={{ height: 1, background: '#DDDBD5' }} />
        </div>

        <div className="bg-white px-5 py-7 sm:px-8 sm:py-8"
          style={{ border: '1px solid #E3E1DB', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <AnimatePresence mode="wait">
            {stage === 'input' ? (
              <motion.div key="input" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                <p className="text-xs mb-1" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>
                  PASSWORD RECOVERY
                </p>
                <p className="text-xs mb-6" style={{ color: '#B0AEA8', lineHeight: 1.6 }}>
                  Enter your Institute Code. A 16-character reset code will be sent to the registered admin email.
                </p>

                <form onSubmit={handleSubmit} noValidate>
                  <div className="mb-5">
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
                <p className="text-xs mb-1" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>
                  RESET CODE DISPATCHED
                </p>

                {/* Email delivery status */}
                <div className="flex items-start gap-2.5 px-3 py-3 mb-5"
                  style={{
                    background: emailSent ? '#F0F7F2' : '#F7F6F3',
                    border: `1px solid ${emailSent ? '#C6DECE' : '#E3E1DB'}`,
                    borderRadius: 2,
                  }}>
                  <Mail size={12} strokeWidth={1.5} style={{ color: emailSent ? '#2A6B3A' : '#9A9891', marginTop: 1, flexShrink: 0 }} />
                  <p className="text-xs" style={{ color: emailSent ? '#2A6B3A' : '#9A9891', lineHeight: 1.6 }}>
                    {emailSent
                      ? `A 16-character reset code has been sent to your registered admin email. It is valid for 1 hour and can only be used once.`
                      : `Email delivery encountered an issue. Please contact the platform administrator or proceed and enter the code directly.`}
                  </p>
                </div>

                <p className="text-xs mb-5" style={{ color: '#9A9891' }}>
                  Institute Code: <span style={{ color: '#4A4A45', fontFamily: 'monospace', letterSpacing: '0.12em' }}>{instituteCode}</span>
                </p>

                <button onClick={handleProceed}
                  className="w-full py-2.5 text-sm mb-3"
                  style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.04em', cursor: 'pointer' }}>
                  Enter reset code
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <Link to="/institute/login"
            className="flex items-center gap-1.5 text-xs transition-colors"
            style={{ color: '#9A9891', textDecoration: 'none' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#0C0C0B')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#9A9891')}>
            <ArrowLeft size={12} strokeWidth={1.5} />Back to sign in
          </Link>
        </div>
      </motion.div>
    </div>
  );
}
