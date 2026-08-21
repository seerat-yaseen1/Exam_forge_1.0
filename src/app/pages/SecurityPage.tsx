import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import QRCode from 'qrcode';
import { Check, Copy, ShieldCheck, Smartphone } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ChangePassword } from '../components/console/account';
import { Button, Card, Chip, SectionHeading } from '../components/console/ui';
import { Field } from '../components/console/fields';

/**
 * The Web Owner's security page: password, then two-factor.
 *
 * The password form is the shared one every role uses, with the extra
 * current-password step this role already required. Two-factor is below it
 * and is the only part of this screen that is genuinely Web-Owner-only.
 *
 * ── WHY 2FA COMES SECOND ──────────────────────────────────────────
 * Reading order is priority order, and the page's title is "change your
 * password" because that is why people arrive. But the enrolment panel is
 * where the security of this account is actually decided, so it is a full
 * card with its own heading rather than a footnote — near the bottom, and
 * unmissable when you get there.
 */

export function SecurityPage() {
  const { changePassword } = useAuth();

  return (
    <ChangePassword
      onSubmit={(next, current) => changePassword(current, next)}
      requireCurrent
      intro="This password administers the whole platform — every institute on it, and everyone inside them."
    >
      <TwoFactor />
    </ChangePassword>
  );
}

// ══════════════════════════════════════════════════════════════════
// TWO-FACTOR (TOTP)
//
// Enrolment: verify password → generate secret → show QR and key →
// confirm a 6-digit code → enrolled. Plus a disable path.
//
// The flow is unchanged from the original implementation; what changed is
// that each step is now visibly a step, with the state it is in stated at the
// top rather than inferred from which controls happen to be on screen.
// ══════════════════════════════════════════════════════════════════

type MfaStep = 'idle' | 'show_qr' | 'done';

function TwoFactor() {
  const { isMfaEnrolled, verifyPassword, startMfaEnrollment, confirmMfaEnrollment, disableMfa } =
    useAuth();

  const [enrolled, setEnrolled] = useState(isMfaEnrolled());
  const [step, setStep] = useState<MfaStep>('idle');
  const [password, setPassword] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [copied, setCopied] = useState(false);

  // Auth state can settle after mount, so the flag is re-read rather than
  // captured once.
  useEffect(() => {
    setEnrolled(isMfaEnrolled());
  }, [isMfaEnrolled]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const reset = () => {
    setStep('idle');
    setPassword('');
    setQrDataUrl('');
    setSecretKey('');
    setCode('');
    setError('');
    setLoading(false);
  };

  const beginEnroll = async () => {
    setError('');
    if (!password) {
      setError('Enter your password to continue.');
      return;
    }
    setLoading(true);
    const ok = await verifyPassword(password);
    if (!ok) {
      setLoading(false);
      setError('Incorrect password.');
      return;
    }
    const res = await startMfaEnrollment();
    if (!res.success || !res.qrUri) {
      setLoading(false);
      setError(res.error ?? 'Could not start two-factor setup.');
      return;
    }
    try {
      setQrDataUrl(await QRCode.toDataURL(res.qrUri, { margin: 1, width: 200 }));
    } catch {
      /* A QR that fails to render is not fatal — the key below it is the same
         secret, typed instead of scanned. */
    }
    setSecretKey(res.secretKey ?? '');
    setStep('show_qr');
    setPassword('');
    setLoading(false);
  };

  const confirm = async () => {
    setError('');
    if (code.trim().length < 6) {
      setError('Enter the 6-digit code from your app.');
      return;
    }
    setLoading(true);
    const res = await confirmMfaEnrollment(code);
    setLoading(false);
    if (!res.success) {
      setError(res.error ?? 'That code was not accepted.');
      return;
    }
    setEnrolled(true);
    setStep('done');
    setTimeout(reset, 2500);
  };

  const disable = async () => {
    setError('');
    setDisabling(true);
    const res = await disableMfa();
    setDisabling(false);
    if (!res.success) {
      setError(res.error ?? 'Could not turn off two-factor.');
      return;
    }
    setEnrolled(false);
    reset();
  };

  return (
    <section>
      <SectionHeading
        label="Two-factor authentication"
        hint={enrolled ? 'On for this account.' : 'Off.'}
      />

      <Card>
        <div className="flex items-start gap-3">
          <ShieldCheck
            size={18}
            strokeWidth={1.6}
            style={{ color: enrolled ? 'var(--ef-success)' : 'var(--ef-text-muted)', flexShrink: 0, marginTop: 1 }}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="ef-t-md ef-ink" style={{ fontWeight: 500 }}>
                Authenticator app
              </p>
              <Chip small tone={enrolled ? 'success' : 'muted'}>
                {enrolled ? 'Enabled' : 'Not set up'}
              </Chip>
            </div>
            <p className="ef-t-sm ef-muted" style={{ marginTop: 6, lineHeight: 'var(--ef-leading-relaxed)' }}>
              {enrolled
                ? 'You enter a six-digit code from your authenticator app each time you sign in. A stolen password alone will not open this account.'
                : 'A second factor at sign-in, from an app like Google Authenticator or Authy. It is the single largest improvement available to this account: a password can be phished, and a code that changes every thirty seconds cannot be reused.'}
            </p>
          </div>
        </div>

        {/* ── Enrolled ── */}
        {enrolled && step === 'idle' && (
          <div
            className="flex items-center justify-between gap-3 flex-wrap"
            style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--ef-border-subtle)' }}
          >
            <span className="ef-t-sm flex items-center gap-2" style={{ color: 'var(--ef-success)' }}>
              <Check size={14} strokeWidth={2.2} />
              Protecting this account
            </span>
            <Button variant="danger" size="sm" onClick={disable} loading={disabling}>
              {disabling ? 'Turning off…' : 'Turn off'}
            </Button>
          </div>
        )}

        {/* ── Not enrolled: confirm identity first ── */}
        {!enrolled && step === 'idle' && (
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--ef-border-subtle)' }}>
            <div className="flex flex-col" style={{ gap: 14, maxWidth: 380 }}>
              <Field
                label="Confirm your password to begin"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError('');
                }}
                disabled={loading}
                placeholder="Your current password"
              />
              <Button variant="primary" onClick={beginEnroll} loading={loading} disabled={loading}>
                <Smartphone size={14} strokeWidth={1.7} />
                {loading ? 'Checking…' : 'Set up two-factor'}
              </Button>
            </div>
          </div>
        )}

        {/* ── Scan, then confirm ── */}
        {step === 'show_qr' && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--ef-border-subtle)' }}
          >
            <div className="flex flex-wrap items-start" style={{ gap: 22 }}>
              {qrDataUrl && (
                <img
                  src={qrDataUrl}
                  alt="Two-factor setup QR code"
                  width={168}
                  height={168}
                  style={{
                    borderRadius: 'var(--ef-radius-sm)',
                    border: '1px solid var(--ef-border)',
                    // The code has to stay black-on-white to be scannable —
                    // a themed QR is an unreadable QR.
                    background: '#FFFFFF',
                    padding: 8,
                    flexShrink: 0,
                  }}
                />
              )}

              <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                <p className="ef-t-sm ef-ink">
                  1. Scan this with your authenticator app.
                </p>
                <p className="ef-t-xs ef-muted" style={{ marginTop: 6 }}>
                  Cannot scan? Enter this key by hand instead:
                </p>

                <div
                  className="flex items-center gap-2 mt-2"
                  style={{
                    padding: '9px 11px',
                    background: 'var(--ef-canvas-raised)',
                    border: '1px solid var(--ef-border)',
                    borderRadius: 'var(--ef-radius-sm)',
                  }}
                >
                  <code
                    className="ef-t-xs flex-1"
                    style={{ wordBreak: 'break-all', letterSpacing: '0.08em', color: 'var(--ef-ink)' }}
                  >
                    {secretKey || '—'}
                  </code>
                  {secretKey && (
                    <button
                      type="button"
                      className="ef-icon-btn"
                      style={{ width: 28, height: 28 }}
                      aria-label={copied ? 'Copied' : 'Copy setup key'}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(secretKey);
                          setCopied(true);
                        } catch {
                          /* Clipboard blocked. The key is on screen and
                             selectable, so there is nothing to recover from. */
                        }
                      }}
                    >
                      {copied ? (
                        <Check size={13} strokeWidth={2.2} style={{ color: 'var(--ef-success)' }} />
                      ) : (
                        <Copy size={13} strokeWidth={1.7} />
                      )}
                    </button>
                  )}
                </div>

                <p className="ef-t-sm ef-ink" style={{ marginTop: 16 }}>
                  2. Enter the six-digit code it shows.
                </p>
                <div className="flex items-end gap-2 mt-2 flex-wrap">
                  <div style={{ width: 150 }}>
                    <Field
                      label=""
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={code}
                      onChange={(e) => {
                        setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                        setError('');
                      }}
                      placeholder="000000"
                      style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.3em', fontSize: 16 }}
                    />
                  </div>
                  <Button variant="primary" onClick={confirm} loading={loading} disabled={loading}>
                    {loading ? 'Confirming…' : 'Confirm'}
                  </Button>
                  <Button variant="ghost" onClick={reset} disabled={loading}>
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── Done ── */}
        {step === 'done' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center gap-2.5"
            style={{
              marginTop: 18,
              padding: '12px 14px',
              background: 'var(--ef-success-bg)',
              border: '1px solid var(--ef-success-border)',
              borderRadius: 'var(--ef-radius-sm)',
            }}
          >
            <Check size={15} strokeWidth={2.2} style={{ color: 'var(--ef-success)' }} />
            <p className="ef-t-sm" style={{ color: 'var(--ef-success)' }}>
              Two-factor is on. You will be asked for a code at your next sign-in.
            </p>
          </motion.div>
        )}

        {error && (
          <p role="alert" className="ef-t-sm" style={{ color: 'var(--ef-danger)', marginTop: 12 }}>
            {error}
          </p>
        )}
      </Card>
    </section>
  );
}
