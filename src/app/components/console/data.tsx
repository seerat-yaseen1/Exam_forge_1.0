/**
 * The pieces the staff consoles are made of: tables, toolbars, tabs, sheets.
 *
 * ── WHY THESE ARE COMPONENTS AND NOT JUST CLASSES ─────────────────
 * ui.tsx is deliberately thin — a `Card` is a div with a class, and the value
 * is the shared name rather than the abstraction. These are different. Each
 * one carries behaviour that every caller would otherwise reimplement, and
 * reimplement slightly differently:
 *
 *   • DataTable writes each cell's column name onto the cell, which is what
 *     lets the same table become a list of labelled cards on a phone. Doing
 *     that by hand means repeating every column heading twice per table and
 *     keeping the copies in step.
 *   • Sheet traps focus, closes on Escape and on an outside click, and locks
 *     the body scroll. A drawer missing any one of those is a drawer a
 *     keyboard user cannot leave.
 *   • Tabs owns the roving arrow-key behaviour that makes a tab strip a tab
 *     strip rather than a row of buttons.
 *
 * ── THE MOBILE POSITION ───────────────────────────────────────────
 * Stated once here because it drives most of the decisions below: a phone is
 * not a narrow laptop. The same data has to arrive in a different SHAPE, not
 * the same shape scaled down. A table becomes records; a right-hand drawer
 * becomes a bottom sheet; a toolbar's primary action goes full-width and
 * moves within thumb reach. Nothing is hidden on the way — a small screen is
 * a reason to reorganise, never a reason to show less.
 */

import React, { useCallback, useEffect, useId, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';

// ══════════════════════════════════════════════════════════════════
// TABLE
// ══════════════════════════════════════════════════════════════════

export type Column<T> = {
  /** Stable key — also the React key for the cell. */
  key: string;
  /** Column heading. Doubles as the per-cell label once the table becomes cards. */
  header: React.ReactNode;
  /** The cell's content for one row. */
  cell: (row: T, index: number) => React.ReactNode;
  align?: 'left' | 'right' | 'center';
  /**
   * The column that identifies the record — the name, the title, the code.
   * Exactly one per table should set it: on a phone this cell becomes the
   * card's heading instead of another labelled row, because a card with no
   * title is just a list of fields.
   */
  primary?: boolean;
  /** Fixed width on wide screens; ignored once the table becomes cards. */
  width?: number | string;
  /**
   * `header` as plain text, for the mobile label when the heading is a node
   * (an icon, a sort control). Required in that case — `attr()` cannot read
   * an element.
   */
  label?: string;
};

function labelOf<T>(c: Column<T>): string {
  if (c.label !== undefined) return c.label;
  return typeof c.header === 'string' ? c.header : '';
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  caption,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T, index: number) => void;
  /** Shown instead of an empty `<tbody>` — never render a table of nothing. */
  empty?: React.ReactNode;
  /** Announced to screen readers; not painted. */
  caption?: string;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;

  return (
    <div className="ef-table-wrap">
      <table className={`ef-table ${onRowClick ? 'ef-table--clickable' : ''}`}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} data-align={c.align} style={c.width ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              onClick={onRowClick ? () => onRowClick(row, i) : undefined}
              // A clickable row needs to be reachable and operable without a
              // mouse. The alternative — a button inside one cell — loses the
              // rest of the row as a target, which is most of its area.
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? 'button' : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick(row, i);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  data-align={c.align}
                  data-label={labelOf(c) || undefined}
                  data-primary={c.primary ? '' : undefined}
                >
                  {c.cell(row, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// TOOLBAR
// ══════════════════════════════════════════════════════════════════

export function Toolbar({
  children,
  end,
}: {
  /** Search and filters. Grows to fill. */
  children?: React.ReactNode;
  /** Actions, pinned right on a laptop and full-width on a phone. */
  end?: React.ReactNode;
}) {
  return (
    <div className="ef-toolbar">
      {children}
      {end && <div className="ef-toolbar__end">{end}</div>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// TABS
// ══════════════════════════════════════════════════════════════════

export type TabItem = {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  /** Rendered as a chip after the label. A count of zero still shows: "0" is an answer. */
  count?: number;
};

export function Tabs({
  items,
  active,
  onChange,
  label,
}: {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
  /** Names the tablist for a screen reader. */
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  /**
   * Arrow keys move between tabs, which is what makes this a tab strip rather
   * than a row of buttons — a keyboard user expects one Tab press to enter the
   * group and arrows to move within it.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const i = items.findIndex((t) => t.key === active);
    const next = items[(i + delta + items.length) % items.length];
    onChange(next.key);
    ref.current?.querySelector<HTMLButtonElement>(`[data-tab='${next.key}']`)?.focus();
  };

  return (
    <div ref={ref} className="ef-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((t) => {
        const selected = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            data-tab={t.key}
            aria-selected={selected}
            // Only the selected tab is in the tab order; the arrows reach the
            // rest. Otherwise a ten-tab strip costs ten Tab presses to pass.
            tabIndex={selected ? 0 : -1}
            className="ef-tab"
            onClick={() => onChange(t.key)}
          >
            {t.icon}
            {t.label}
            {t.count !== undefined && (
              <span className="ef-chip ef-chip--sm" data-tone={selected ? 'solid' : undefined}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SHEET
// ══════════════════════════════════════════════════════════════════

/**
 * A drawer on a laptop, a bottom sheet on a phone.
 *
 * One component for both because they are the same thing — a surface that
 * arrives over the page, holds one task, and leaves. Which edge it arrives
 * from is a property of the screen, so it belongs in the stylesheet
 * (`.ef-sheet`) rather than in a prop every caller would have to decide.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  variant = 'side',
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** `side` for a detail panel beside a list; `centre` for a decision. */
  variant?: 'side' | 'centre';
  labelledBy?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const restoreTo = useRef<HTMLElement | null>(null);

  // Escape closes, and the body stops scrolling behind the sheet — a page
  // that scrolls under an open drawer loses the reader's place in it.
  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus moves in, so the next Tab lands inside the sheet rather than
    // somewhere behind it.
    const first = panel.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (first ?? panel.current)?.focus();

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
      // …and back where it came from on close, so a keyboard user resumes
      // from the control they opened it with rather than from the top.
      restoreTo.current?.focus?.();
    };
  }, [open, onClose]);

  /** Keep Tab inside the panel while it is open. */
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !panel.current) return;
    const focusable = [
      ...panel.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  const reduced =
    typeof window !== 'undefined' &&
    (document.documentElement.dataset.efMotion === 'reduced' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  // A sheet slides from the edge it lives on; a centred one scales up in
  // place. Both cross-fade their scrim, so neither arrives as a hard cut.
  const enter =
    variant === 'centre'
      ? { initial: { opacity: 0, scale: 0.97 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: 0.97 } }
      : { initial: { opacity: 0, x: 24 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: 24 } };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="ef-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.18 }}
            onClick={onClose}
          />
          <motion.div
            ref={panel}
            className={`ef-sheet ef-sheet--${variant}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy ?? (title ? titleId : undefined)}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            initial={reduced ? false : enter.initial}
            animate={enter.animate}
            exit={reduced ? undefined : enter.exit}
            transition={{ duration: reduced ? 0 : 0.26, ease: [0.16, 1, 0.3, 1] }}
          >
            <span className="ef-sheet__grip" aria-hidden="true" />

            {(title || description) && (
              <div className="ef-sheet__head">
                <div style={{ minWidth: 0 }}>
                  {title && (
                    <h2 id={titleId} className="ef-t-lg ef-ink" style={{ fontWeight: 500 }}>
                      {title}
                    </h2>
                  )}
                  {description && (
                    <p className="ef-t-sm ef-muted" style={{ marginTop: 5 }}>
                      {description}
                    </p>
                  )}
                </div>
                <button type="button" className="ef-icon-btn" onClick={onClose} aria-label="Close">
                  <X size={16} strokeWidth={1.7} />
                </button>
              </div>
            )}

            <div className="ef-sheet__body">{children}</div>

            {footer && <div className="ef-sheet__foot">{footer}</div>}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ══════════════════════════════════════════════════════════════════
// SMALLER PIECES
// ══════════════════════════════════════════════════════════════════

export function Avatar({
  name,
  size = 32,
  muted = false,
}: {
  name: string;
  size?: number;
  muted?: boolean;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <span
      className={`ef-avatar ${muted ? 'ef-avatar--muted' : ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

export function Skeleton({
  width = '100%',
  height = 12,
  radius,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
}) {
  return (
    <span
      className="ef-skeleton"
      style={{ display: 'block', width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

/** Rows of shimmer shaped like the table that is coming. */
export function TableSkeleton({ rows = 4, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="ef-table-wrap" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex items-center gap-4"
          style={{
            padding: '15px var(--ef-pad-card)',
            borderBottom: r === rows - 1 ? undefined : '1px solid var(--ef-border-subtle)',
          }}
        >
          {Array.from({ length: columns }).map((__, c) => (
            <div key={c} style={{ flex: c === 0 ? 2 : 1 }}>
              <Skeleton width={c === 0 ? '70%' : '52%'} height={11} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: React.ReactNode; icon?: React.ReactNode; hint?: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="ef-segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.hint}
          className="ef-segmented__option"
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Label-and-value, the shape most detail panels are. */
export function Facts({ children }: { children: React.ReactNode }) {
  return <div className="ef-facts">{children}</div>;
}

export function Fact({
  label,
  value,
  mono = false,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="ef-fact__label">{label}</div>
      <div
        className="ef-fact__value"
        style={mono ? { fontFamily: 'ui-monospace, monospace', letterSpacing: '0.06em' } : undefined}
      >
        {value}
      </div>
    </div>
  );
}
