import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router';
import { motion } from 'motion/react';
import { ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { BackToSignIn, FormError, RoleSwitcher, SignIn, useBrand } from '../components/console/auth';
import { AuthShell, Field } from '../components/console/fields';
import { Button } from '../components/console/ui';

/**
 * The Web Owner's sign-in.
 *
 * The credential half is the shared SignIn every role uses. What is only true
 * here is the second factor: this account can hold a TOTP enrolment, so a
 * correct password may be answered with a challenge rather than a session.
 *
 * That challenge REPLACES the form rather than appearing beside it. Two
 * credential forms on one screen is a screen people fill in wrongly under
 * time pressure, and this one always arrives under time pressure — the code
 * on the phone is already counting down.
 */

const OTHER_ROLES = [
  { to: '/institute/login', label: 'Institute Admin' },
  { to: '/faculty/login', label: 'Faculty' },
  { to: '/student/login', label: 'Student' },
];

export function LoginPage() {
  const navigate = useNavigate();
  const { user, login, mfaPending, resolveMfaSignIn } = useAuth();

  if (user) return <Navigate to="/dashboard" replace />;

  // `mfaPending` is owned by the auth context — it is set when Firebase
  // answers the password with a multi-factor resolver, and cleared when the
  // code is accepted. Reading it here rather than keeping a second copy is
  // what stops the two from disagreeing after a failed code.
  if (mfaPending) return <SecondFactor onResolve={resolveMfaSignIn} />;

  return (
    <SignIn
      audience="Web owner access"
      hint="The account that administers every institute on the platform."
      forgotTo="/forgot-password"
      otherRoles={OTHER_ROLES}
      onSubmit={async ({ email, password }) => {
        const result = await login(email, password);
        // On success the context either signs in — and the redirect above
        // takes over on the next render — or raises the second factor.
        return result;
      }}
    />
  );
}

function SecondFactor({
  onResolve,
}: {
  onResolve: (code: string) => Promise<{ success: boolean; error?: string }>;
}) {
  const navigate = useNavigate();
  const brand = useBrand();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.trim().length < 6 || busy) return;
    setError('');
    setBusy(true);
    const result = await onResolve(code);
    setBusy(false);
    if (!result.success) {
      setError(result.error ?? 'That code was not accepted.');
      setCode('');
      return;
    }
    navigate('/dashboard', { replace: true });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <AuthShell
        mark={brand.mark}
        wordmark={brand.wordmark}
        footer={<RoleSwitcher links={OTHER_ROLES} />}
      >
        <p className="ef-eyebrow mb-3">
          <ShieldCheck size={12} strokeWidth={1.8} />
          Two-factor required
        </p>
        <p className="ef-t-sm ef-muted mb-6" style={{ lineHeight: 'var(--ef-leading-normal)' }}>
          Your password was accepted. Enter the six-digit code from your authenticator app to
          finish signing in.
        </p>

        <form onSubmit={submit} noValidate className="flex flex-col" style={{ gap: 16 }}>
          <Field
            label="Authentication code"
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
              setError('');
            }}
            disabled={busy}
            placeholder="000000"
            style={{
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.4em',
              fontSize: 18,
              textAlign: 'center',
            }}
          />

          <FormError message={error} />

          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            disabled={code.length < 6 || busy}
            loading={busy}
          >
            {busy ? 'Verifying…' : 'Verify and sign in'}
          </Button>
        </form>

        <BackToSignIn to="/login" />
      </AuthShell>
    </motion.div>
  );
}
