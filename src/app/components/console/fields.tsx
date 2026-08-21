/**
 * Form fields for every credential screen in the product.
 *
 * Login, first-login change, reset and the security page each carried their own
 * copy of the same `inputStyle` object, the same pair of focus/blur handlers
 * that repainted the border by hand, and — in most of them — the same
 * `StrengthBar`. Written once per screen, per role, that came to sixteen
 * copies of one text field: sixteen places for a theme token to be missed,
 * and the hand-rolled focus handling meant `:focus-visible` never applied to
 * any of them.
 *
 * The styling now lives in `.ef-input` (styles/console.css). These components
 * are what is left once it does: a label, a field, and the one piece of real
 * logic — the strength score.
 */

import { useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

// ── Labelled text field ───────────────────────────────────────────

type FieldProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  /** Sits under the field, in muted text. For a format hint, not for an error. */
  hint?: React.ReactNode;
};

export function Field({ label, hint, id, className = '', ...rest }: FieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div>
      <label
        htmlFor={fieldId}
        className="block mb-2"
        style={{ fontSize: 11.5, color: 'var(--ef-text-subtle)', letterSpacing: '0.04em' }}
      >
        {label}
      </label>
      <input id={fieldId} className={`ef-input ${className}`} {...rest} />
      {hint && (
        <p className="mt-1.5" style={{ fontSize: 11, color: 'var(--ef-text-muted)' }}>
          {hint}
        </p>
      )}
    </div>
  );
}

// ── Labelled select ───────────────────────────────────────────────

/**
 * A `<select>`, not a custom listbox.
 *
 * The native control gets the platform's own picker on a phone — a
 * full-height wheel that beats any div a web app can build at that size —
 * and it is already themed: palette.css styles `select` alongside the text
 * inputs, so the two match without this component doing anything.
 */
export function SelectField({
  label,
  hint,
  id,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: React.ReactNode }) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div>
      <label
        htmlFor={fieldId}
        className="block mb-2"
        style={{ fontSize: 11.5, color: 'var(--ef-text-subtle)', letterSpacing: '0.04em' }}
      >
        {label}
      </label>
      <select id={fieldId} style={{ width: '100%' }} {...rest}>
        {children}
      </select>
      {hint && (
        <p className="mt-1.5" style={{ fontSize: 11, color: 'var(--ef-text-muted)' }}>
          {hint}
        </p>
      )}
    </div>
  );
}

// ── Password, with a reveal toggle ────────────────────────────────

type PasswordFieldProps = Omit<FieldProps, 'type'> & {
  /** Rendered under the field — the strength bar, or a match/mismatch note. */
  footer?: React.ReactNode;
};

export function PasswordField({ label, hint, footer, id, ...rest }: PasswordFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <label
        htmlFor={fieldId}
        className="block mb-2"
        style={{ fontSize: 11.5, color: 'var(--ef-text-subtle)', letterSpacing: '0.04em' }}
      >
        {label}
      </label>
      <div className="relative">
        <input
          id={fieldId}
          type={visible ? 'text' : 'password'}
          className="ef-input"
          style={{ paddingRight: 44 }}
          {...rest}
        />
        <button
          type="button"
          // Out of the tab order on purpose: it is a convenience for a mouse,
          // and a keyboard user tabbing from the password field expects to
          // land on the submit button, not on a reveal control.
          tabIndex={-1}
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          // `ef-reveal` widens it to a real target under a coarse pointer.
          // The global touch rule sets a min-HEIGHT only, which left this one
          // 22px wide — tall enough and too narrow to hit.
          className="ef-reveal absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center"
          style={{
            background: 'transparent',
            border: 0,
            color: 'var(--ef-text-muted)',
            cursor: 'pointer',
            padding: 4,
          }}
        >
          {visible ? <EyeOff size={14} strokeWidth={1.6} /> : <Eye size={14} strokeWidth={1.6} />}
        </button>
      </div>
      {hint && (
        <p className="mt-1.5" style={{ fontSize: 11, color: 'var(--ef-text-muted)' }}>
          {hint}
        </p>
      )}
      {footer}
    </div>
  );
}

// ── Strength ──────────────────────────────────────────────────────

/**
 * Five checks, four segments.
 *
 * The score is advisory — the platform's actual rule is the eight-character
 * minimum enforced at submit. This says "you could do better" without ever
 * being the thing that refuses a password, which is why a red bar does not
 * disable the button.
 */
export function passwordScore(password: string): number {
  return [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
    password.length >= 12,
  ].filter(Boolean).length;
}

const STRENGTH_COLOURS = [
  'var(--ef-border)',
  'var(--ef-danger)',
  'var(--ef-warning)',
  'var(--ef-success)',
  'var(--ef-success)',
];
const STRENGTH_LABELS = ['', 'Weak', 'Fair', 'Good', 'Strong'];

export function StrengthBar({ password }: { password: string }) {
  if (!password) return null;
  const score = passwordScore(password);
  const colour = STRENGTH_COLOURS[Math.min(score, 4)];

  return (
    <div className="mt-2.5">
      <div className="flex gap-1 mb-1.5">
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className="flex-1"
            style={{
              height: 3,
              borderRadius: 'var(--ef-radius-pill)',
              background: i <= score ? colour : 'var(--ef-border-subtle)',
              transition: 'background-color 220ms ease',
            }}
          />
        ))}
      </div>
      {score > 0 && (
        <p style={{ fontSize: 11, color: colour }} aria-live="polite">
          {STRENGTH_LABELS[Math.min(score, 4)]}
        </p>
      )}
    </div>
  );
}

/** The "passwords match" line under a confirm field. */
export function MatchNote({ password, confirm }: { password: string; confirm: string }) {
  if (!confirm || !password) return null;
  const ok = password === confirm;
  return (
    <p
      className="mt-2"
      style={{ fontSize: 11, color: ok ? 'var(--ef-success)' : 'var(--ef-danger)' }}
      aria-live="polite"
    >
      {ok ? 'Passwords match' : 'Passwords do not match'}
    </p>
  );
}

// ── The card these screens sit in ─────────────────────────────────

/**
 * The centred card shared by login, first-login and reset.
 *
 * It is here rather than in ui.tsx because it is not a general surface: it
 * carries the platform mark and the full-height centring that only the
 * signed-out screens want.
 */
export function AuthShell({
  mark,
  wordmark,
  children,
  footer,
}: {
  mark: React.ReactNode;
  wordmark: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-4 py-10"
      style={{ background: 'var(--ef-canvas)' }}
    >
      <div className="w-full" style={{ maxWidth: 392 }}>
        <div className="flex flex-col items-center mb-8">
          <span style={{ color: 'var(--ef-ink)' }}>{mark}</span>
          <span
            className="mt-3.5 truncate"
            style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: '0.2em', color: 'var(--ef-ink)' }}
          >
            {wordmark}
          </span>
          <span className="mt-5" style={{ width: 32, height: 1, background: 'var(--ef-border-muted)' }} />
        </div>

        <div
          className="px-5 py-7 sm:px-8 sm:py-8"
          style={{
            background: 'var(--ef-surface)',
            border: '1px solid var(--ef-border)',
            borderRadius: 'var(--ef-radius-lg)',
            boxShadow: 'var(--ef-shadow-md)',
          }}
        >
          {children}
        </div>

        {footer}
      </div>
    </div>
  );
}
