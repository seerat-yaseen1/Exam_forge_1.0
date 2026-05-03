import { useState } from 'react';
import { motion } from 'motion/react';
import { Shield, Loader2, Check, AlertTriangle } from 'lucide-react';
import { initializeWebOwner } from '../../lib/initializeWebOwner';
import { useNavigate } from 'react-router';

export function InitializeWebOwnerPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
    credentials?: { email: string; password: string };
  } | null>(null);

  const handleInitialize = async () => {
    setLoading(true);
    setResult(null);
    
    try {
      const res = await initializeWebOwner();
      setResult(res);
    } catch (error: any) {
      setResult({
        success: false,
        message: error.message || 'An unexpected error occurred.',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: '#F7F6F3' }}
    >
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-md"
        style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 4 }}
      >
        {/* Header */}
        <div
          className="px-6 py-5 flex items-center gap-3"
          style={{ borderBottom: '1px solid #E3E1DB' }}
        >
          <Shield size={18} strokeWidth={1.5} style={{ color: '#0C0C0B' }} />
          <div>
            <h1 className="text-base" style={{ color: '#0C0C0B', fontWeight: 500 }}>
              Initialize Web Owner
            </h1>
            <p className="text-xs mt-0.5" style={{ color: '#9A9891' }}>
              Set up the default administrator account
            </p>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-6">
          {!result && (
            <>
              <div
                className="flex items-start gap-2.5 px-4 py-3 mb-6"
                style={{ background: '#F0F7F2', border: '1px solid #C6DECE', borderRadius: 2 }}
              >
                <Shield size={13} strokeWidth={1.5} style={{ color: '#2A6B3A', marginTop: 1, flexShrink: 0 }} />
                <div>
                  <p className="text-xs" style={{ color: '#2A6B3A', lineHeight: 1.6 }}>
                    This will create the default Web Owner account with the following credentials:
                  </p>
                  <div className="mt-2 text-xs" style={{ color: '#2A6B3A' }}>
                    <p><strong>Email:</strong> owner@platform.com</p>
                    <p className="mt-1"><strong>Password:</strong> admin123</p>
                  </div>
                  <p className="text-xs mt-2" style={{ color: '#2A6B3A' }}>
                    ⚠️ <strong>Change this password immediately after first login!</strong>
                  </p>
                </div>
              </div>

              <button
                onClick={handleInitialize}
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 text-sm px-4 py-3 transition-opacity"
                style={{
                  background: loading ? '#C8C7C2' : '#0C0C0B',
                  color: '#FFFFFF',
                  borderRadius: 2,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  letterSpacing: '0.02em',
                }}
              >
                {loading ? (
                  <>
                    <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
                    Initializing...
                  </>
                ) : (
                  <>
                    <Shield size={14} strokeWidth={1.5} />
                    Initialize Web Owner Account
                  </>
                )}
              </button>
            </>
          )}

          {result && result.success && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              <div
                className="flex items-start gap-2.5 px-4 py-3 mb-6"
                style={{ background: '#F0F7F2', border: '1px solid #C6DECE', borderRadius: 2 }}
              >
                <Check size={13} strokeWidth={1.5} style={{ color: '#2A6B3A', marginTop: 1, flexShrink: 0 }} />
                <div>
                  <p className="text-xs font-medium mb-2" style={{ color: '#2A6B3A' }}>
                    {result.message}
                  </p>
                  {result.credentials && (
                    <div className="text-xs" style={{ color: '#2A6B3A' }}>
                      <p><strong>Email:</strong> {result.credentials.email}</p>
                      <p className="mt-1"><strong>Password:</strong> {result.credentials.password}</p>
                      <p className="mt-3 text-xs" style={{ color: '#2A6B3A' }}>
                        ⚠️ <strong>Please save these credentials and change the password after login!</strong>
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <button
                onClick={() => navigate('/auth/webowner')}
                className="w-full text-sm px-4 py-3 transition-colors"
                style={{
                  background: '#0C0C0B',
                  color: '#FFFFFF',
                  borderRadius: 2,
                  letterSpacing: '0.02em',
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.opacity = '0.85')}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.opacity = '1')}
              >
                Go to Login
              </button>
            </motion.div>
          )}

          {result && !result.success && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              <div
                className="flex items-start gap-2.5 px-4 py-3 mb-6"
                style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}
              >
                <AlertTriangle size={13} strokeWidth={1.5} style={{ color: '#9B2828', marginTop: 1, flexShrink: 0 }} />
                <div>
                  <p className="text-xs" style={{ color: '#9B2828' }}>
                    {result.message}
                  </p>
                </div>
              </div>

              <button
                onClick={handleInitialize}
                className="w-full text-sm px-4 py-3 transition-colors"
                style={{
                  background: '#0C0C0B',
                  color: '#FFFFFF',
                  borderRadius: 2,
                  letterSpacing: '0.02em',
                }}
              >
                Try Again
              </button>
            </motion.div>
          )}
        </div>

        {/* Footer */}
        <div
          className="px-6 py-4 text-center"
          style={{ borderTop: '1px solid #E3E1DB', background: '#FAFAF8' }}
        >
          <p className="text-xs" style={{ color: '#9A9891' }}>
            Already initialized?{' '}
            <button
              onClick={() => navigate('/auth/webowner')}
              className="underline hover:no-underline"
              style={{ color: '#0C0C0B' }}
            >
              Go to Login
            </button>
          </p>
        </div>
      </motion.div>
    </div>
  );
}
