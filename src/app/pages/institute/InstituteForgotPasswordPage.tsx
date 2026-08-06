import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, Loader2, Mail } from 'lucide-react';
import { useInstituteAuth } from '../../context/InstituteAuthContext';
import { usePlatformSettings } from '../../context/PlatformSettingsContext';
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
  const { platformSettings } = usePlatformSettings();

  const [stage, setStage]                   = useState<Stage>('input');
  const [adminEmail, setAdminEmail]         = useState('');
  const [error, setError]                   = useState('');
  const [loading, setLoading]               = useState(false);
  const [emailSent, setEmailSent]           = useState(false);

  const canSubmit = adminEmail.trim().length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setLoading(true);
    const result = await requestPasswordReset(adminEmail.trim());
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
                <p className="text-xs mb-1" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
                  PASSWORD RECOVERY
                </p>
                <p className="text-xs mb-6" style={{ color: '#6B6B66', lineHeight: 1.6 }}>
                  Enter the registered admin email. If an account exists, a password-reset link will be sent to it.
                </p>

                <form onSubmit={handleSubmit} noValidate>
                  <div className="mb-5">
                    <label className="block text-xs mb-2" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
                      Admin Email
                    </label>
                    <input type="email" autoFocus autoComplete="email"
                      value={adminEmail}
                      onChange={(e) => { setAdminEmail(e.target.value); setError(''); }}
                      disabled={loading} placeholder="admin@institute.com"
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
                      ? `If an account exists for that email, a password-reset link has been sent. Open the link from your inbox to set a new password, then sign in.`
                      : `Email delivery encountered an issue. Please try again or contact the platform administrator.`}
                  </p>
                </div>

                <button onClick={() => navigate('/institute/login')}
                  className="w-full py-2.5 text-sm mb-3"
                  style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.04em', cursor: 'pointer' }}>
                  Back to sign in
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <Link to="/institute/login"
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
