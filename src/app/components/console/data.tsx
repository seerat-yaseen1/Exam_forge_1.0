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
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { MoreHorizontal, Search, X } from 'lucide-react';
import { Button } from './ui';

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

/**
 * The search box every list page needs.
 *
 * ── WHY IT IS TYPE-TO-FILTER AND NOT A SUBMIT ─────────────────────
 * The lists it sits above are already in memory, so there is nothing to wait
 * for — a Search button would add a step to a result the page could have
 * shown on the first keystroke. What it does need is a way OUT: a filter with
 * no visible clear control is the most common way someone concludes their
 * data has disappeared, so the × appears as soon as there is anything to
 * clear, and Escape does the same from the keyboard.
 */
export function SearchField({
  value,
  onChange,
  placeholder = 'Search…',
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Names the field for a screen reader; no visible label in a toolbar. */
  label: string;
}) {
  const id = useId();
  return (
    <div className="ef-toolbar__grow" style={{ position: 'relative' }}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        size={14}
        strokeWidth={1.7}
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 11,
          top: '50%',
          transform: 'translateY(-50%)',
          color: 'var(--ef-text-muted)',
          pointerEvents: 'none',
        }}
      />
      <input
        id={id}
        type="search"
        className="ef-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            onChange('');
          }
        }}
        style={{ paddingLeft: 33, paddingRight: value ? 34 : undefined }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="ef-icon-btn"
          style={{ position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)', width: 28, height: 28 }}
        >
          <X size={13} strokeWidth={1.8} />
        </button>
      )}
    </div>
  );
}

/**
 * A wrapping row of filter chips, for a dimension with more values than a
 * segmented control can hold.
 *
 * `Segmented` is right for three or four mutually exclusive views. Question
 * types are a registry that grows, and the old pages rendered them as a row
 * of hand-styled buttons that repainted their own border, background and
 * text colour inline — three colours × two states × two pages.
 */
export function FilterChips<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: React.ReactNode; tone?: string }>;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-1.5 flex-wrap">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value || '_all'}
            type="button"
            role="radio"
            aria-checked={on}
            className="ef-chip"
            data-tone={on ? (o.tone ?? 'solid') : undefined}
            style={{ cursor: 'pointer' }}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
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
// CONFIRM
// ══════════════════════════════════════════════════════════════════

/**
 * "Are you sure?", in the product's own voice.
 *
 * ── WHY NOT window.confirm ────────────────────────────────────────
 * Because it is the browser's dialog, not ours: system chrome, system
 * typography, an OK/Cancel pair the user cannot be sure maps to the verbs
 * they were reading, and no room to say what the consequence actually is.
 * The subjects page had nine of these — `confirm("Delete topic \"X\" (t-1)?")`
 * and `alert("Merged. 12 question(s) re-pointed.")` — which is a designed
 * product asking questions through a 1995 dialog box.
 *
 * The button says the verb. "Delete subject", never "OK": the label is what
 * someone reads at the moment of committing, and it should name the act.
 */
export function ConfirmSheet({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  tone = 'danger',
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      variant="centre"
      title={title}
      footer={
        <div className="flex items-center gap-2.5">
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} size="lg" onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
          <Button size="lg" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="ef-t-sm ef-muted" style={{ lineHeight: 'var(--ef-leading-relaxed)' }}>
        {body}
      </div>
    </Sheet>
  );
}

// ══════════════════════════════════════════════════════════════════
// ROW MENU
// ══════════════════════════════════════════════════════════════════

export type RowAction = {
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
};

/**
 * The overflow menu at the end of a row.
 *
 * ── WHY NOT SIX ICON BUTTONS ──────────────────────────────────────
 * Because six 13px glyphs in a row is a guessing game. Each one needs a
 * tooltip to be understood, tooltips do not exist on a phone, and the two
 * that matter (edit, disable) end up the same size and weight as the one
 * that deletes an institute. Two named-on-hover buttons plus a menu of
 * labelled items says what each thing does, in words, on every device.
 *
 * ── WHY IT IS IN A PORTAL ─────────────────────────────────────────
 * `.ef-table-wrap` scrolls horizontally, and a scroll container clips its
 * children in BOTH axes — an absolutely-positioned menu inside one gets cut
 * off at the row. Fixed-positioning it onto the body sidesteps that; the
 * cost is that it must close when anything scrolls underneath it, which is
 * what the scroll listener is for.
 */
export function RowMenu({ actions, label = 'More actions' }: { actions: RowAction[]; label?: string }) {
  const [open, setOpen] = React.useState(false);
  const [at, setAt] = React.useState<{ top: number; right: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  /**
   * Below the button if it fits, above it if it does not.
   *
   * Without the flip, the menu on the last row of a long list opens off the
   * bottom of the screen — which on a phone is most rows, because the button
   * is wherever your thumb reached. The height is estimated from the item
   * count rather than measured, so the menu is positioned on its first paint
   * instead of appearing in the wrong place and jumping.
   */
  const place = useCallback(() => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    // A menu item is 34px with a mouse and 44px under a coarse pointer, where
    // the touch-target rule in palette.css grows it.
    const itemHeight = window.matchMedia?.('(pointer: coarse)').matches ? 44 : 34;
    const height = actions.length * itemHeight + 12;
    const room = window.innerHeight - r.bottom - 8;
    const top = room >= height ? r.bottom + 6 : Math.max(8, r.top - height - 6);
    setAt({ top, right: Math.max(8, window.innerWidth - r.right) });
  }, [actions.length]);

  useEffect(() => {
    if (!open) return;
    place();

    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    /**
     * A fixed menu does not move with its row, so it has to be told to.
     *
     * The obvious version of this closes the menu on any scroll. It looks
     * right on a laptop and is unusable on a phone: opening a popover there
     * routinely produces a scroll of its own (the address bar collapsing, the
     * tap's own momentum), so the menu shut itself the instant it opened —
     * reproducibly, under a touch-emulating browser. Following the button is
     * both the fix and the better behaviour; it only closes once the button
     * it belongs to has actually left the screen.
     */
    const follow = () => {
      const r = button.current?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > window.innerHeight) setOpen(false);
      else place();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    // `true` catches scrolls in any ancestor, including the table's own
    // horizontal one.
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="ef-icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={16} strokeWidth={1.8} />
      </button>

      {open &&
        at &&
        createPortal(
          <motion.div
            ref={menu}
            role="menu"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            className="ef-menu"
            style={{ position: 'fixed', top: at.top, right: at.right, zIndex: 60, minWidth: 196, padding: 5 }}
          >
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                role="menuitem"
                className="ef-menu-item"
                data-tone={a.tone === 'danger' ? 'danger' : undefined}
                disabled={a.disabled}
                style={{ borderRadius: 'var(--ef-radius-sm)', opacity: a.disabled ? 0.5 : 1 }}
                onClick={() => {
                  setOpen(false);
                  a.onSelect();
                }}
              >
                {a.icon && <span style={{ display: 'inline-flex', flexShrink: 0 }}>{a.icon}</span>}
                {a.label}
              </button>
            ))}
          </motion.div>,
          document.body,
        )}
    </>
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
  flush = false,
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
  /**
   * Hand the body over to the child, padding and scrolling included.
   *
   * For content that already owns a full-height layout — the question
   * editor is a scroll region with its own pinned footer. Nested inside a
   * padded, scrolling body it gets two scrollbars and double the inset.
   */
  flush?: boolean;
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

            <div className={`ef-sheet__body ${flush ? 'ef-sheet__body--flush' : ''}`}>{children}</div>

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
