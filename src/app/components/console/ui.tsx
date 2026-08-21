/**
 * The student console's shared components.
 *
 * Thin wrappers over the classes in styles/console.css — thin on purpose. The
 * value is not abstraction, it is that "a card", "a chip", "the page header"
 * mean one thing across seven screens, and that adding a theme token to any of
 * them is one edit rather than seven.
 *
 * Anything genuinely page-specific stays on its page. A component here has to
 * be used somewhere other than where it was born.
 */

import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Check, ChevronRight, Copy, Loader2, RefreshCw } from 'lucide-react';
import type { Theme } from '../../../lib/themes';

// ══════════════════════════════════════════════════════════════════
// PAGE SCAFFOLDING
// ══════════════════════════════════════════════════════════════════

/**
 * Every student page's outermost element.
 *
 * Carries the enter animation as well as the width, because the two belong
 * together: a page that fades in at a different speed from the last one reads
 * as a slower page rather than as a different animation.
 */
export function PageShell({
  children,
  narrow = false,
  className = '',
}: {
  children: React.ReactNode;
  narrow?: boolean;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
      className={`ef-page ${narrow ? 'ef-page--narrow' : ''} ${className}`}
    >
      {children}
    </motion.div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  children,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  /** Anything that belongs under the subtitle — status pills, a meta row. */
  children?: React.ReactNode;
}) {
  return (
    <header
      style={{
        borderBottom: '1px solid var(--ef-border)',
        paddingBottom: 22,
        marginBottom: 28,
      }}
    >
      {eyebrow && <div className="ef-eyebrow mb-3">{eyebrow}</div>}
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div style={{ minWidth: 0 }}>
          <h1
            className="ef-display"
            style={{ fontSize: 'clamp(24px, 3.4vw, 32px)', lineHeight: 1.18, color: 'var(--ef-ink)' }}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="mt-2" style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--ef-text-muted)', maxWidth: '58ch' }}>
              {subtitle}
            </p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </header>
  );
}

export function SectionHeading({
  label,
  count,
  action,
  hint,
  description,
}: {
  label: string;
  count?: number;
  action?: React.ReactNode;
  /** A clarification for the count, as a tooltip. Not shown as text. */
  hint?: string;
  /** One line under the heading, always visible. For a rule the reader needs. */
  description?: React.ReactNode;
}) {
  return (
    <div className="mb-3.5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="ef-eyebrow">{label}</span>
          {count !== undefined && (
            <span className="ef-chip ef-chip--sm" title={hint}>
              {count}
            </span>
          )}
        </div>
        {action}
      </div>
      {description && (
        <p className="ef-t-xs ef-muted" style={{ marginTop: 6, maxWidth: '64ch' }}>
          {description}
        </p>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SURFACES
// ══════════════════════════════════════════════════════════════════

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: 'default' | 'flat' | 'inset';
  interactive?: boolean;
  padded?: boolean;
};

export function Card({
  variant = 'default',
  interactive = false,
  padded = true,
  className = '',
  style,
  children,
  ...rest
}: CardProps) {
  const variantClass =
    variant === 'flat' ? 'ef-card--flat' : variant === 'inset' ? 'ef-card--inset' : '';
  return (
    <div
      className={`ef-card ${variantClass} ${interactive ? 'ef-card--interactive' : ''} ${className}`}
      style={{ padding: padded ? 'var(--ef-pad-card)' : undefined, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * A section that is closed until asked for.
 *
 * ── WHAT IT IS FOR ────────────────────────────────────────────────
 * Controls that are important but consulted rarely — an erasure policy, a
 * trash can, an audit log. Left expanded they push the page's actual subject
 * below the fold and get skimmed past daily until they are invisible; hidden
 * behind a route they are forgotten entirely. Closed-but-named is the
 * position that survives both: the reader sees that it exists and what it is,
 * and pays for it only when they want it.
 *
 * Built on <details>, so it works before hydration, is findable by the
 * browser's own in-page search, and needs no state.
 */
export function Disclosure({
  label,
  description,
  icon,
  defaultOpen = false,
  children,
}: {
  label: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="ef-disclosure" open={defaultOpen}>
      <summary className="ef-disclosure__summary">
        <ChevronRight size={14} strokeWidth={1.8} className="ef-disclosure__chevron" aria-hidden="true" />
        {icon && <span style={{ display: 'flex', color: 'var(--ef-text-muted)' }}>{icon}</span>}
        <span style={{ minWidth: 0 }}>
          <span className="ef-t-sm ef-ink block" style={{ fontWeight: 500 }}>
            {label}
          </span>
          {description && (
            <span className="ef-t-xs ef-muted block" style={{ marginTop: 2 }}>
              {description}
            </span>
          )}
        </span>
      </summary>
      <div className="ef-disclosure__body">{children}</div>
    </details>
  );
}

// ══════════════════════════════════════════════════════════════════
// CONTROLS
// ══════════════════════════════════════════════════════════════════

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  /** Swaps the label for a spinner and disables the button. */
  loading?: boolean;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  block = false,
  loading = false,
  className = '',
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={[
        'ef-btn',
        `ef-btn--${variant}`,
        size === 'sm' ? 'ef-btn--sm' : size === 'lg' ? 'ef-btn--lg' : '',
        block ? 'ef-btn--block' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Loader2 size={13} strokeWidth={1.8} className="animate-spin" />}
      {children}
    </button>
  );
}

export type ChipTone = 'muted' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'solid';

export function Chip({
  tone = 'muted',
  icon,
  children,
  title,
  small = false,
}: {
  tone?: ChipTone;
  icon?: React.ReactNode;
  children: React.ReactNode;
  title?: string;
  small?: boolean;
}) {
  return (
    <span className={`ef-chip ${small ? 'ef-chip--sm' : ''}`} data-tone={tone} title={title}>
      {icon}
      {children}
    </span>
  );
}

/**
 * A short value that exists to be sent to someone — an institute code, an
 * exam code, an ID.
 *
 * ── WHY IT IS A BUTTON AND NOT TEXT ───────────────────────────────
 * These are read off the screen and typed into a message. Selecting six
 * monospace characters with a mouse without catching the label beside them is
 * fiddly on a laptop and genuinely hard on a phone, so every admin who has
 * ever shared an institute code has done it by squinting and retyping. One
 * tap is the whole feature.
 *
 * The confirmation replaces the icon rather than appearing next to it: the
 * control must not change width when it succeeds, or the thing under your
 * cursor moves at the moment you are looking at it.
 */
export function CopyChip({
  value,
  label,
  mono = true,
}: {
  value: string;
  /** What is being copied, for the screen reader and the tooltip. */
  label: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (insecure origin, denied permission).
      // Selecting the text still works, so there is nothing to report — an
      // error toast here would be louder than the feature.
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
      aria-label={`Copy ${label.toLowerCase()}: ${value}`}
      className="ef-chip"
      data-tone={copied ? 'success' : undefined}
      style={{
        cursor: 'pointer',
        fontFamily: mono ? 'ui-monospace, monospace' : undefined,
        letterSpacing: mono ? '0.1em' : undefined,
      }}
    >
      {value}
      {copied ? (
        <Check size={11} strokeWidth={2} />
      ) : (
        <Copy size={11} strokeWidth={1.7} style={{ opacity: 0.65 }} />
      )}
      <span className="sr-only" role="status">
        {copied ? 'Copied' : ''}
      </span>
    </button>
  );
}

// ══════════════════════════════════════════════════════════════════
// DATA DISPLAY
// ══════════════════════════════════════════════════════════════════

/**
 * One number and what it means.
 *
 * `hint` becomes a title attribute rather than a tooltip component because
 * every one of these is a clarification, not information the student needs to
 * act on — and a native title works on the keyboard focus a custom tooltip
 * usually forgets.
 */
export function StatTile({
  label,
  value,
  sub,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
  /** Colours the figure. Left off, it is ink — which is right for most counts. */
  tone?: 'accent' | 'success' | 'warning' | 'danger';
}) {
  const colour =
    tone === 'accent' ? 'var(--ef-accent)'
    : tone === 'success' ? 'var(--ef-success)'
    : tone === 'warning' ? 'var(--ef-warning)'
    : tone === 'danger' ? 'var(--ef-danger)'
    : 'var(--ef-ink)';

  return (
    <div title={hint} style={{ minWidth: 0 }}>
      <div className="flex items-center gap-1.5 mb-1.5">
        {icon && <span style={{ color: 'var(--ef-text-muted)', display: 'flex' }}>{icon}</span>}
        <p
          className="truncate"
          style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ef-text-muted)' }}
        >
          {label}
        </p>
      </div>
      <p className="ef-display" style={{ fontSize: 26, lineHeight: 1.1, color: colour }}>
        {value}
      </p>
      {sub && (
        <p className="mt-1" style={{ fontSize: 11.5, color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
          {sub}
        </p>
      )}
    </div>
  );
}

/** A row of stat tiles inside one card, divided rather than spaced apart. */
export function StatRow({ children }: { children: React.ReactNode }) {
  const items = React.Children.toArray(children);
  return (
    <Card padded={false} className="flex flex-wrap">
      {items.map((child, i) => (
        <div
          key={i}
          className="flex-1"
          style={{
            padding: 'var(--ef-pad-card)',
            minWidth: 150,
            borderLeft: i === 0 ? 'none' : '1px solid var(--ef-border-subtle)',
          }}
        >
          {child}
        </div>
      ))}
    </Card>
  );
}

export function Meter({ value, tone }: { value: number; tone?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="ef-meter" role="presentation">
      <div className="ef-meter-fill" style={{ width: `${pct}%`, background: tone }} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// STATES
// ══════════════════════════════════════════════════════════════════

export function LiveDot({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2 select-none">
      <span className="ef-pulse" />
      <span style={{ fontSize: 11.5, color: 'var(--ef-text-muted)' }}>{label}</span>
    </span>
  );
}

export function LoadingBlock({ label = 'Loading…', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="flex flex-col" style={{ gap: 'var(--ef-gap)' }}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="ef-skeleton" style={{ height: 84, opacity: 1 - i * 0.22 }} />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <Card variant="inset" className="flex flex-col items-center text-center" style={{ padding: '56px 24px' }}>
      <div style={{ color: 'var(--ef-border-strong)' }}>{icon}</div>
      <p className="ef-display mt-4" style={{ fontSize: 16, color: 'var(--ef-ink)' }}>
        {title}
      </p>
      <p className="mt-2" style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--ef-text-muted)', maxWidth: 380 }}>
        {body}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </Card>
  );
}

/**
 * The line that confirms something happened, then leaves.
 *
 * Bottom-centre rather than top-right: the action that produced it was
 * somewhere in the page, and a confirmation that appears in the far corner
 * is one the eye has to go looking for. Dismissal is the caller's — a toast
 * that owns its own timer cannot be extended by the next event.
 */
export function Toast({ message, tone = 'ink' }: { message: React.ReactNode; tone?: 'ink' | 'success' | 'danger' }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 14 }}
          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          className="fixed z-50"
          style={{
            left: 16,
            right: 16,
            bottom: 'calc(20px + env(safe-area-inset-bottom))',
            maxWidth: 440,
            marginInline: 'auto',
            padding: '11px 16px',
            textAlign: 'center',
            fontSize: 'var(--ef-text-sm)',
            borderRadius: 'var(--ef-radius)',
            boxShadow: 'var(--ef-shadow-lg)',
            background:
              tone === 'success' ? 'var(--ef-success)' : tone === 'danger' ? 'var(--ef-danger)' : 'var(--ef-ink)',
            color: 'var(--ef-surface)',
          }}
        >
          {message}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * A toast and the function that raises it, so a page does not carry the
 * timer, the state and the element in three places.
 *
 * Returns the element rather than rendering into a portal, because where a
 * page puts its confirmations is the page's business — and a provider at the
 * app root would be a lot of machinery for a line of text.
 */
export function useToast() {
  const [notice, setNotice] = React.useState<{ text: string; tone: 'ink' | 'success' | 'danger' } | null>(null);

  React.useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const say = React.useCallback((text: string, tone: 'ink' | 'success' | 'danger' = 'ink') => {
    setNotice({ text, tone });
  }, []);

  return {
    say,
    /** Render this once, anywhere in the page. */
    toast: <Toast message={notice?.text ?? ''} tone={notice?.tone} />,
  };
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 px-4 py-3"
      style={{
        background: 'var(--ef-danger-bg)',
        border: '1px solid var(--ef-danger-border)',
        borderRadius: 'var(--ef-radius-sm)',
      }}
    >
      <AlertTriangle size={14} strokeWidth={1.6} style={{ color: 'var(--ef-danger)', flexShrink: 0 }} />
      <p className="flex-1" style={{ fontSize: 12.5, color: 'var(--ef-danger)' }}>
        {message}
      </p>
      {onRetry && (
        <Button variant="danger" size="sm" onClick={onRetry}>
          <RefreshCw size={11} strokeWidth={1.6} />
          Retry
        </Button>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// THEME SWATCH
// ══════════════════════════════════════════════════════════════════

/**
 * A theme, drawn as the screen it produces.
 *
 * Three colours in the relationship they will actually have — page behind,
 * card on it, accent on the card — rather than three circles in a row. The
 * point is that a student can tell "this one is dark and warm" from a 40px
 * square without applying it.
 */
export function ThemeSwatch({ theme, size = 40 }: { theme: Theme; size?: number }) {
  return (
    <span
      className="ef-swatch"
      style={{ width: size, height: size, background: theme.canvas, display: 'block' }}
      aria-hidden="true"
    >
      <span
        className="ef-swatch-card"
        style={{ background: theme.surface, border: `1px solid ${theme.tokens['--ef-border']}` }}
      />
      <span className="ef-swatch-accent" style={{ background: theme.accent }} />
    </span>
  );
}
