/**
 * The two account screens every role has: who you are, and your password.
 *
 * ── WHY SHARED ────────────────────────────────────────────────────
 * There were six of these — a Profile and a Security page per staff role,
 * plus the student's — and they were the same two screens written out four
 * times each. Three of the four password forms carried their own private copy
 * of the same `StrengthBar`, each with its own colour list.
 *
 * Nothing about "change my password" differs by role. What differs is one
 * sentence: who maintains the details you are looking at, which is the only
 * thing a person on a profile page actually needs to be told that they do not
 * already know. So that is a prop and the rest is one component.
 *
 * ── THE PSYCHOLOGY OF THE PASSWORD FORM ───────────────────────────
 * The strength meter is advisory and never blocks: the platform's real rule
 * is eight characters, enforced at submit. A meter that refuses a password it
 * called "fair" teaches people that the meter is the obstacle rather than the
 * advice, and the next thing they do is append "1!" to whatever they had.
 * Guidance that never says no is guidance people read.
 */

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, KeyRound, ShieldCheck } from 'lucide-react';
import { MatchNote, PasswordField, StrengthBar } from './fields';
import { Button, Card, Chip, PageHeader, PageShell, SectionHeading } from './ui';
import { Avatar, Fact, Facts } from './data';

// ══════════════════════════════════════════════════════════════════
// PROFILE
// ══════════════════════════════════════════════════════════════════

export type ProfileField = {
  label: string;
  value: React.ReactNode;
  /** Codes and addresses — anything read character by character. */
  mono?: boolean;
};

export function AccountProfile({
  name,
  role,
  subtitle,
  status,
  fields,
  managedBy,
  actions,
  children,
}: {
  name: string;
  role: string;
  subtitle?: string;
  status?: { label: string; ok: boolean };
  fields: ProfileField[];
  /**
   * Who can change these details. Every role's answer is different and every
   * role's users ask, so it is stated rather than left to be discovered by
   * clicking a field and finding it inert.
   */
  managedBy: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <PageShell narrow>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Profile
          </>
        }
        title={name}
        subtitle={subtitle}
        actions={actions}
      >
        <div className="flex items-center gap-3 flex-wrap">
          <Avatar name={name} size={44} />
          <div className="flex items-center gap-2 flex-wrap">
            <Chip tone="accent">{role}</Chip>
            {status && <Chip tone={status.ok ? 'success' : 'muted'}>{status.label}</Chip>}
          </div>
        </div>
      </PageHeader>

      <div className="flex flex-col" style={{ gap: 26 }}>
        <section>
          <SectionHeading label="Account" />
          <Card>
            <Facts>
              {fields.map((f) => (
                <Fact key={f.label} label={f.label} value={f.value ?? '—'} mono={f.mono} />
              ))}
            </Facts>
          </Card>
        </section>

        {children}

        <p className="ef-t-xs ef-muted" style={{ lineHeight: 'var(--ef-leading-relaxed)' }}>
          {managedBy}
        </p>
      </div>
    </PageShell>
  );
}

// ══════════════════════════════════════════════════════════════════
// PASSWORD
// ══════════════════════════════════════════════════════════════════

export function ChangePassword({
  onSubmit,
  email,
  intro,
  requireCurrent = false,
  children,
}: {
  /**
   * One signature, always both values — the caller adapts it to whatever its
   * own auth context takes. The alternative, a union type covering both
   * arities, cannot accept a one-argument function without a cast, and the
   * cast is exactly where the argument order gets swapped unnoticed.
   */
  onSubmit: (next: string, current: string) => Promise<{ success: boolean; error?: string }>;
  email?: string;
  /** One line under the title. What this password opens differs by role. */
  intro?: React.ReactNode;
  /**
   * Ask for the current password before allowing a change.
   *
   * Only the Web Owner does today. It is the stronger flow — it stops someone
   * who finds an unlocked laptop from locking the real owner out — and the
   * other three roles arguably should adopt it, but that is a change to what
   * the product DOES rather than to how it looks, so it is left as it is and
   * flagged rather than quietly switched on here.
   */
  requireCurrent?: boolean;
  /** Anything else the role's security page owns — 2FA, sessions. */
  children?: React.ReactNode;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  // The success note clears itself. A confirmation that stays forever stops
  // being a confirmation and becomes part of the furniture, so the next one
  // is not noticed.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 5000);
    return () => clearTimeout(t);
  }, [done]);

  const canSubmit =
    next.length >= 8 && confirm.length > 0 && (!requireCurrent || current.length > 0) && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (next !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setError('');
    setBusy(true);
    const result = await onSubmit(next, current);
    setBusy(false);
    if (!result.success) {
      setError(result.error ?? 'Could not update your password.');
      return;
    }
    setDone(true);
    setCurrent('');
    setNext('');
    setConfirm('');
  };

  return (
    <PageShell narrow>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Security
          </>
        }
        title="Change your password"
        subtitle={intro}
      />

      <div className="flex flex-col" style={{ gap: 'var(--ef-gap)' }}>
        <Card>
          <AnimatePresence>
            {done && (
              <motion.div
                role="status"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                style={{ overflow: 'hidden' }}
              >
                <div
                  className="flex items-center gap-2.5"
                  style={{
                    padding: '12px 14px',
                    marginBottom: 20,
                    background: 'var(--ef-success-bg)',
                    border: '1px solid var(--ef-success-border)',
                    borderRadius: 'var(--ef-radius-sm)',
                  }}
                >
                  <Check size={14} strokeWidth={2.2} style={{ color: 'var(--ef-success)', flexShrink: 0 }} />
                  <p className="ef-t-sm" style={{ color: 'var(--ef-success)' }}>
                    Password updated.
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <form onSubmit={submit} noValidate className="flex flex-col" style={{ gap: 18 }}>
            {requireCurrent && (
              <PasswordField
                label="Current password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => {
                  setCurrent(e.target.value);
                  setError('');
                  setDone(false);
                }}
                disabled={busy}
                placeholder="The one you signed in with"
              />
            )}

            <PasswordField
              label="New password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => {
                setNext(e.target.value);
                setError('');
                setDone(false);
              }}
              disabled={busy}
              placeholder="At least 8 characters"
              footer={<StrengthBar password={next} />}
            />

            <PasswordField
              label="Confirm new password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                setError('');
                setDone(false);
              }}
              disabled={busy}
              placeholder="Repeat it"
              footer={<MatchNote password={next} confirm={confirm} />}
            />

            {error && (
              <motion.p
                role="alert"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="ef-t-sm"
                style={{ color: 'var(--ef-danger)' }}
              >
                {error}
              </motion.p>
            )}

            <Button type="submit" variant="primary" size="lg" block disabled={!canSubmit} loading={busy}>
              <KeyRound size={14} strokeWidth={1.7} />
              {busy ? 'Updating…' : 'Update password'}
            </Button>
          </form>
        </Card>

        <Card variant="inset">
          <div className="flex items-start gap-3">
            <ShieldCheck
              size={16}
              strokeWidth={1.6}
              style={{ color: 'var(--ef-text-muted)', flexShrink: 0, marginTop: 1 }}
            />
            <div>
              <p className="ef-t-sm ef-ink" style={{ fontWeight: 500 }}>
                What makes a good one
              </p>
              <p className="ef-t-xs ef-muted" style={{ marginTop: 6, lineHeight: 'var(--ef-leading-relaxed)' }}>
                Eight characters is the floor; twelve is meaningfully better. Mix cases, add a number
                and a symbol. Above all do not reuse a password from another site — a breach
                somewhere else becomes a breach here, and that is how most accounts are actually
                lost.
                {email && (
                  <>
                    {' '}
                    You are signed in as{' '}
                    <strong className="ef-subtle" style={{ fontWeight: 500 }}>
                      {email}
                    </strong>
                    .
                  </>
                )}
              </p>
            </div>
          </div>
        </Card>

        {children}
      </div>
    </PageShell>
  );
}
