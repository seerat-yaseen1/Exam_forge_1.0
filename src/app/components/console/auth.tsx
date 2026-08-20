/**
 * The signed-out screens, shared by all four roles.
 *
 * ── WHY THIS IS ONE COMPONENT ─────────────────────────────────────
 * There are twelve of them — sign in, recover, reset, and first-login for
 * four roles — and they are three screens, written twelve times. They differ
 * in exactly two ways that matter: whether an institute code is part of the
 * credential, and where the "forgot password" link goes. Everything else was
 * copy-paste that had drifted: two of the twelve rendered the literal string
 * "Platform Name" as the wordmark, one rendered a hardcoded product name, and
 * the button-disabled colour was written four different ways.
 *
 * ── THE FIRST SCREEN IS THE PRODUCT ───────────────────────────────
 * For most people this is the only page they see before deciding whether the
 * software is any good, and they decide in about a second — the
 * aesthetic-usability effect is strongest exactly here, where there is no
 * function yet to judge. So it gets the care: one column, generous space, the
 * mark at a size that reads as confidence rather than decoration, and one
 * obvious action.
 *
 * ── WHAT THE ERROR DOES NOT SAY ───────────────────────────────────
 * Sign-in failures are deliberately vague — "check your details" rather than
 * "no such user" — because the specific version tells someone probing the
 * form which addresses are real. The recovery screen is vague for the same
 * reason: it reports that a mail WOULD have been sent, never whether the
 * account exists.
 */

import React, { useState } from 'react';
import { Link } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft } from 'lucide-react';
import { usePlatformSettings } from '../../context/PlatformSettingsContext';
import { LogoMark } from '../PlatformLogo';
import { AuthShell, Field, PasswordField } from './fields';
import { Button } from './ui';

// ══════════════════════════════════════════════════════════════════
// SHARED CHROME
// ══════════════════════════════════════════════════════════════════

/** The platform mark and wordmark, from settings rather than from a literal. */
export function useBrand() {
  const { platformSettings } = usePlatformSettings();
  return {
    wordmark: platformSettings.name,
    mark: platformSettings.logoUrl ? (
      <img
        src={platformSettings.logoUrl}
        alt=""
        style={{ width: 34, height: 34, objectFit: 'contain' }}
      />
    ) : (
      <LogoMark px={34} />
    ),
  };
}

export function FormError({ message }: { message: string }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.p
          role="alert"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="ef-t-sm"
          style={{ color: 'var(--ef-danger)' }}
        >
          {message}
        </motion.p>
      )}
    </AnimatePresence>
  );
}

export function BackToSignIn({ to }: { to: string }) {
  return (
    <Link
      to={to}
      className="ef-t-xs ef-muted flex items-center gap-1.5 mt-5"
      style={{ textDecoration: 'none' }}
    >
      <ArrowLeft size={12} strokeWidth={1.7} />
      Back to sign in
    </Link>
  );
}

/** The row of "…or sign in as" links under a login card. */
export function RoleSwitcher({ links }: { links: Array<{ to: string; label: string }> }) {
  return (
    <div className="flex items-center justify-center gap-3 mt-6 flex-wrap">
      {links.map((l, i) => (
        <React.Fragment key={l.to}>
          {i > 0 && <span style={{ color: 'var(--ef-border)' }}>·</span>}
          <Link to={l.to} className="ef-t-xs ef-muted" style={{ textDecoration: 'none' }}>
            {l.label}
          </Link>
        </React.Fragment>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SIGN IN
// ══════════════════════════════════════════════════════════════════

export function SignIn({
  audience,
  hint,
  withInstituteCode = false,
  forgotTo,
  otherRoles,
  onSubmit,
  extra,
}: {
  /** "Student access", "Faculty access" — who this door is for. */
  audience: string;
  /** One line under it. What they need in hand before they start. */
  hint?: React.ReactNode;
  withInstituteCode?: boolean;
  forgotTo: string;
  otherRoles?: Array<{ to: string; label: string }>;
  onSubmit: (creds: { code: string; email: string; password: string }) => Promise<{
    success: boolean;
    error?: string;
  }>;
  /** Anything after the form — the Web Owner's second-factor step. */
  extra?: React.ReactNode;
}) {
  const brand = useBrand();
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const canSubmit =
    (!withInstituteCode || code.trim().length > 0) &&
    email.trim().length > 0 &&
    password.length > 0 &&
    !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setBusy(true);
    const result = await onSubmit({ code: code.trim(), email: email.trim(), password });
    setBusy(false);
    if (!result.success) setError(result.error ?? 'Check your details and try again.');
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
        footer={otherRoles && otherRoles.length > 0 ? <RoleSwitcher links={otherRoles} /> : undefined}
      >
        <p className="ef-eyebrow mb-1.5">{audience}</p>
        {hint && (
          <p className="ef-t-sm ef-muted mb-6" style={{ lineHeight: 'var(--ef-leading-normal)' }}>
            {hint}
          </p>
        )}

        <form onSubmit={submit} noValidate className="flex flex-col" style={{ gap: 16 }}>
          {withInstituteCode && (
            <Field
              label="Institute code"
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              value={code}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setError('');
              }}
              disabled={busy}
              placeholder="e.g. A3B7C2"
              style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: '0.16em' }}
            />
          )}

          <Field
            label="Email address"
            type="email"
            autoFocus={!withInstituteCode}
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError('');
            }}
            disabled={busy}
            placeholder="you@institute.edu"
          />

          <PasswordField
            label="Password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError('');
            }}
            disabled={busy}
            placeholder="••••••••••"
            footer={
              <div className="flex justify-end mt-2">
                <Link to={forgotTo} className="ef-t-xs ef-muted" style={{ textDecoration: 'none' }}>
                  Forgot password?
                </Link>
              </div>
            }
          />

          <FormError message={error} />

          <Button type="submit" variant="primary" size="lg" block disabled={!canSubmit} loading={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        {extra}
      </AuthShell>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// RECOVER
// ══════════════════════════════════════════════════════════════════

export function ForgotPassword({
  audience,
  withInstituteCode = false,
  backTo,
  onSubmit,
}: {
  audience: string;
  withInstituteCode?: boolean;
  backTo: string;
  onSubmit: (input: { code: string; email: string }) => Promise<{
    success: boolean;
    error?: string;
    emailSent?: boolean;
  }>;
}) {
  const brand = useBrand();
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<null | { emailSent: boolean }>(null);

  const canSubmit = (!withInstituteCode || code.trim().length > 0) && email.trim().length > 0 && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setBusy(true);
    const result = await onSubmit({ code: code.trim(), email: email.trim() });
    setBusy(false);
    if (!result.success) {
      setError(result.error ?? 'Something went wrong. Try again.');
      return;
    }
    setSent({ emailSent: result.emailSent ?? false });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <AuthShell mark={brand.mark} wordmark={brand.wordmark}>
        <AnimatePresence mode="wait">
          {sent ? (
            <motion.div key="sent" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <p className="ef-eyebrow mb-3">Check your inbox</p>
              <div
                className="flex items-start gap-2.5 px-3.5 py-3 mb-5"
                style={{
                  background: 'var(--ef-success-bg)',
                  border: '1px solid var(--ef-success-border)',
                  borderRadius: 'var(--ef-radius-sm)',
                }}
              >
                <p className="ef-t-sm" style={{ color: 'var(--ef-success)', lineHeight: 'var(--ef-leading-relaxed)' }}>
                  {/* Never confirms whether the address exists — that would
                      turn this form into an account-enumeration oracle. */}
                  If an account matches {email}, a reset link is on its way. It expires in an hour
                  and works once.
                </p>
              </div>
              <Link to={backTo} style={{ textDecoration: 'none' }}>
                <Button variant="primary" size="lg" block>
                  Back to sign in
                </Button>
              </Link>
            </motion.div>
          ) : (
            <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <p className="ef-eyebrow mb-1.5">Password recovery</p>
              <p className="ef-t-sm ef-muted mb-6" style={{ lineHeight: 'var(--ef-leading-normal)' }}>
                {audience} — we will email you a link to set a new password.
              </p>

              <form onSubmit={submit} noValidate className="flex flex-col" style={{ gap: 16 }}>
                {withInstituteCode && (
                  <Field
                    label="Institute code"
                    autoFocus
                    autoComplete="off"
                    autoCapitalize="characters"
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value.toUpperCase());
                      setError('');
                    }}
                    disabled={busy}
                    placeholder="e.g. A3B7C2"
                    style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: '0.16em' }}
                  />
                )}

                <Field
                  label="Email address"
                  type="email"
                  autoFocus={!withInstituteCode}
                  autoComplete="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError('');
                  }}
                  disabled={busy}
                  placeholder="you@institute.edu"
                />

                <FormError message={error} />

                <Button type="submit" variant="primary" size="lg" block disabled={!canSubmit} loading={busy}>
                  {busy ? 'Sending…' : 'Send reset link'}
                </Button>
              </form>
            </motion.div>
          )}
        </AnimatePresence>

        <BackToSignIn to={backTo} />
      </AuthShell>
    </motion.div>
  );
}
