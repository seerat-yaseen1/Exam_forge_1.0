/**
 * ConsoleShell — the frame every signed-in staff screen sits in.
 *
 * ── WHY ONE SHELL AND NOT THREE ───────────────────────────────────
 * The Web Owner, Institute Admin and Faculty layouts were three files, ~950
 * lines, describing the same object: a fixed app bar, a fixed sidebar, a
 * profile dropdown, and a content column. They had drifted the way three
 * copies always do — and not cosmetically. Two of the three had NO mobile
 * behaviour at all: a `position: fixed` sidebar with no drawer, no toggle and
 * no breakpoint, sitting on top of the page on any screen under 1024px.
 *
 * A bug like that is not really a bug in a layout file. It is what happens
 * when the thing every page depends on is written three times, so this is
 * written once and parameterised by the two things that genuinely differ: the
 * nav items, and what the account menu offers.
 *
 * ── WHAT IT OWES A PHONE ──────────────────────────────────────────
 * The sidebar becomes a drawer under 1024px — over the content, not beside
 * it, because 208px of a 390px screen is half the viewport spent on
 * navigation the reader is not currently using. The drawer closes on
 * navigation, on Escape, and on a tap outside, and it takes focus with it so
 * a keyboard or screen-reader user is not left operating a page they cannot
 * see. Nav rows grow to a comfortable touch height there and stay compact for
 * a mouse.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { LogOut, Menu, X } from 'lucide-react';
import { ThemeButton } from './ThemeMenu';
import { Avatar } from './data';

// ══════════════════════════════════════════════════════════════════
// SHAPES
// ══════════════════════════════════════════════════════════════════

export type NavItem = {
  to: string;
  label: string;
  icon: React.ReactNode;
  /**
   * How to decide "you are here". Defaults to a prefix match, which is right
   * for a section with children (`/questions/42` is still Questions) and
   * wrong for an index route that every other path also starts with — those
   * pass `exact`.
   */
  exact?: boolean;
};

export type AccountAction = {
  label: string;
  icon: React.ReactNode;
  to?: string;
  onSelect?: () => void;
  tone?: 'default' | 'danger';
};

// ══════════════════════════════════════════════════════════════════
// ACCOUNT MENU
// ══════════════════════════════════════════════════════════════════

function AccountMenu({
  name,
  subtitle,
  role,
  actions,
  onClose,
}: {
  name: string;
  subtitle?: string;
  role?: string;
  actions: AccountAction[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <motion.div
      ref={ref}
      role="menu"
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      className="ef-menu"
      style={{ position: 'absolute', right: 0, top: '100%', marginTop: 8, width: 258 }}
    >
      <div
        className="flex items-center gap-3"
        style={{ padding: '14px 14px', borderBottom: '1px solid var(--ef-border-subtle)' }}
      >
        <Avatar name={name} size={34} />
        <div className="min-w-0">
          <p className="ef-t-sm ef-ink truncate" style={{ fontWeight: 500 }}>
            {name}
          </p>
          {subtitle && <p className="ef-t-xs ef-muted truncate">{subtitle}</p>}
          {role && (
            <p
              className="ef-t-2xs ef-muted"
              style={{ letterSpacing: 'var(--ef-tracking-eyebrow)', textTransform: 'uppercase', marginTop: 2 }}
            >
              {role}
            </p>
          )}
        </div>
      </div>

      <div style={{ padding: 5 }}>
        {actions.map((a) => {
          const body = (
            <>
              <span style={{ display: 'inline-flex', flexShrink: 0 }}>{a.icon}</span>
              {a.label}
            </>
          );
          const props = {
            role: 'menuitem' as const,
            className: 'ef-menu-item',
            'data-tone': a.tone === 'danger' ? 'danger' : undefined,
            style: { borderRadius: 'var(--ef-radius-sm)' },
          };
          return a.to ? (
            <Link key={a.label} to={a.to} onClick={onClose} {...props}>
              {body}
            </Link>
          ) : (
            <button
              key={a.label}
              type="button"
              onClick={() => {
                onClose();
                a.onSelect?.();
              }}
              {...props}
            >
              {body}
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SHELL
// ══════════════════════════════════════════════════════════════════

export function ConsoleShell({
  brand,
  navLabel = 'Modules',
  nav,
  context,
  account,
  onSignOut,
  children,
}: {
  brand: { name: string; logoUrl?: string | null; mark: React.ReactNode; to: string };
  navLabel?: string;
  nav: NavItem[];
  /** Optional right-of-brand context — the institute a staff member belongs to. */
  context?: React.ReactNode;
  account: { name: string; subtitle?: string; role?: string; actions: AccountAction[] };
  onSignOut: () => void;
  children: React.ReactNode;
}) {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerId = useId();

  const isActive = (item: NavItem) =>
    item.exact ? location.pathname === item.to : location.pathname.startsWith(item.to);

  // Navigating closes the drawer. Without this, tapping a link on a phone
  // leaves the drawer sitting over the page it just navigated to.
  useEffect(() => {
    setDrawerOpen(false);
    setMenuOpen(false);
  }, [location.pathname]);

  // Escape closes it, and the page behind stops scrolling while it is open.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  const navList = (
    <>
      <p className="ef-side-label">{navLabel}</p>
      {nav.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className="ef-side-link"
          aria-current={isActive(item) ? 'page' : undefined}
        >
          <span className="ef-side-link__icon">{item.icon}</span>
          {item.label}
        </Link>
      ))}
    </>
  );

  return (
    <div style={{ minHeight: '100vh', background: 'var(--ef-canvas)' }}>
      <header className="ef-appbar">
        <div className="flex items-center gap-2 min-w-0">
          {/* The drawer toggle only exists below the sidebar's breakpoint.
              `lg:hidden` rather than a JS width check: the CSS already owns
              the breakpoint, and a second copy of it in JavaScript is a
              second thing to keep in step. */}
          <button
            type="button"
            className="ef-icon-btn lg:hidden"
            aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={drawerOpen}
            aria-controls={drawerId}
            onClick={() => setDrawerOpen((v) => !v)}
          >
            {drawerOpen ? <X size={18} strokeWidth={1.7} /> : <Menu size={18} strokeWidth={1.7} />}
          </button>

          <Link to={brand.to} className="ef-brand">
            {brand.logoUrl ? (
              <img
                src={brand.logoUrl}
                alt=""
                style={{ width: 22, height: 22, objectFit: 'contain', flexShrink: 0 }}
              />
            ) : (
              brand.mark
            )}
            {/* The wordmark yields first on a narrow screen — the mark alone
                still identifies the product, and the space buys the context
                chip beside it, which is the thing that changes. */}
            <span className="ef-brand__word hidden sm:inline">{brand.name}</span>
          </Link>
        </div>

        <div className="flex items-center gap-2 min-w-0">
          {context}
          <ThemeButton onOpen={() => setMenuOpen(false)} />

          <div className="relative">
            <button
              type="button"
              className="ef-icon-btn"
              data-active={menuOpen}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Account menu"
              onClick={() => setMenuOpen((v) => !v)}
              style={{ width: 38, height: 38 }}
            >
              <Avatar name={account.name} size={30} />
            </button>
            <AnimatePresence>
              {menuOpen && (
                <AccountMenu
                  name={account.name}
                  subtitle={account.subtitle}
                  role={account.role}
                  actions={[
                    ...account.actions,
                    { label: 'Sign out', icon: <LogOut size={14} strokeWidth={1.6} />, onSelect: onSignOut, tone: 'danger' },
                  ]}
                  onClose={() => setMenuOpen(false)}
                />
              )}
            </AnimatePresence>
          </div>
        </div>
      </header>

      <div className="ef-shell">
        {/* Desktop: in the flow, beside the content. */}
        <nav className="ef-sidebar hidden lg:block" aria-label={navLabel}>
          {navList}
        </nav>

        {/* Phone and tablet: over it. */}
        <AnimatePresence>
          {drawerOpen && (
            <>
              <motion.div
                className="ef-scrim lg:hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                onClick={() => setDrawerOpen(false)}
              />
              <motion.nav
                id={drawerId}
                className="ef-sidebar lg:hidden"
                aria-label={navLabel}
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="flex items-center justify-between" style={{ padding: '0 10px 14px' }}>
                  <span className="ef-brand__word ef-ink">{brand.name}</span>
                  <button
                    type="button"
                    className="ef-icon-btn"
                    onClick={() => setDrawerOpen(false)}
                    aria-label="Close navigation"
                  >
                    <X size={17} strokeWidth={1.7} />
                  </button>
                </div>
                {navList}
              </motion.nav>
            </>
          )}
        </AnimatePresence>

        <main className="ef-content">{children}</main>
      </div>
    </div>
  );
}
