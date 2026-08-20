import { useRef, useState, useEffect } from 'react';
import { Outlet, useNavigate, Navigate, useLocation } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import {
  User, Lock, LogOut, Building2, LayoutDashboard, ClipboardList,
  Palette, TrendingUp, Menu, X, Check,
} from 'lucide-react';
import { useStudentAuth } from '../context/StudentAuthContext';
import { usePlatformSettings } from '../context/PlatformSettingsContext';
import { useAppearance } from '../context/AppearanceContext';
import { LogoMark } from '../components/PlatformLogo';
import { RouteFallback } from '../components/RouteFallback';
import { ThemeButton } from '../components/console/ThemeMenu';

// ── Institute logo mark ───────────────────────────────────────────

function InstituteMark({ logo, name, size = 28 }: { logo: string | null; name: string; size?: number }) {
  if (logo) {
    return (
      <img src={logo} alt={name}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover',
          border: '1px solid var(--ef-border)', flexShrink: 0 }} />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', background: 'var(--ef-border-subtle)',
      border: '1px solid var(--ef-border)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', flexShrink: 0,
    }}>
      <Building2 size={size * 0.42} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
    </div>
  );
}

// ── Student profile avatar ────────────────────────────────────────

/**
 * The initials disc.
 *
 * Its background is the ACCENT rather than the ink it used to be, which is
 * what makes the chrome carry the student's chosen theme at the one place
 * their eye returns to. `--ef-accent-text` is the paired foreground, so the
 * initials stay legible on a gold accent and on a near-black one alike — the
 * old hardcoded white worked for exactly one of those.
 */
function StudentAvatar({ name, size = 28 }: { name: string; size?: number }) {
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: 'var(--ef-accent)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>
      <span style={{
        fontSize: size * 0.36, color: 'var(--ef-accent-text)', fontWeight: 500,
        letterSpacing: '0.04em', lineHeight: 1,
      }}>
        {initials}
      </span>
    </div>
  );
}

// ── Profile dropdown ──────────────────────────────────────────────

function StudentProfileDropdown({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { session, logout } = useStudentAuth();
  const { theme } = useAppearance();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const go = (path: string) => { onClose(); navigate(path); };
  const handleLogout = () => {
    onClose();
    logout();
    navigate('/student/login', { replace: true });
  };

  return (
    <motion.div
      ref={ref}
      role="menu"
      initial={{ opacity: 0, y: -6, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.985 }}
      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      className="ef-menu absolute right-0 top-full mt-2 z-50"
      style={{ width: 252 }}
    >
      <div className="flex items-center gap-3 px-4 py-3.5" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
        <StudentAvatar name={session?.name ?? ''} size={34} />
        <div className="min-w-0">
          <p className="truncate" style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ef-ink)' }}>{session?.name}</p>
          <p className="truncate mt-0.5" style={{ fontSize: 11.5, color: 'var(--ef-text-muted)' }}>{session?.email}</p>
        </div>
      </div>

      <div className="py-1">
        <button onClick={() => go('/student/profile')} className="ef-menu-item" role="menuitem">
          <User size={14} strokeWidth={1.5} />
          Profile
        </button>
        <button onClick={() => go('/student/appearance')} className="ef-menu-item" role="menuitem">
          <Palette size={14} strokeWidth={1.5} />
          Appearance
          {/* The current theme, named here as well as in the theme menu: this
              is where a student looks when the console has come up in an
              unexpected palette on a shared machine. */}
          <span className="ml-auto truncate" style={{ fontSize: 11, color: 'var(--ef-text-muted)', maxWidth: 92 }}>
            {theme.label}
          </span>
        </button>
        <button onClick={() => go('/student/security')} className="ef-menu-item" role="menuitem">
          <Lock size={14} strokeWidth={1.5} />
          Security
        </button>
      </div>

      <div style={{ borderTop: '1px solid var(--ef-border-subtle)' }}>
        <button onClick={handleLogout} className="ef-menu-item" data-tone="danger" role="menuitem">
          <LogOut size={14} strokeWidth={1.5} />
          Sign out
        </button>
      </div>
    </motion.div>
  );
}

// ── Main layout ───────────────────────────────────────────────────

const NAV_ITEMS = [
  { path: '/student/dashboard',   label: 'Overview',    icon: LayoutDashboard },
  { path: '/student/assessments', label: 'Assessments', icon: ClipboardList },
  { path: '/student/progress',    label: 'Progress',    icon: TrendingUp },
];

export function StudentDashboardLayout() {
  const { session, instituteLogo, logoLoading, loading } = useStudentAuth();
  const { platformSettings } = usePlatformSettings();
  const navigate = useNavigate();
  const location = useLocation();
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Any navigation closes the mobile sheet. Without this, tapping a link
  // navigates behind a menu that is still covering the page.
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  // Auth rehydration guard. Firebase restores the session from IndexedDB
  // ASYNCHRONOUSLY, so on a page refresh the first render always has
  // {user/session: null, loading: true}. Redirecting on the null alone raced
  // that restore and bounced the user to the login page on refresh —
  // intermittently, because whether it happened depended on which resolved
  // first. Wait for the answer before acting on it.
  if (loading) return <RouteFallback />;
  if (!session) return <Navigate to="/student/login" replace />;
  if (session.firstLoginRequired) return <Navigate to="/student/change-password" replace />;

  // `startsWith` rather than equality: the roster and results pages live under
  // /student/assessments-adjacent paths, and a tab that unhighlights when the
  // student drills into a detail view suggests they have left the section.
  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(`${path}/`);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--ef-canvas)' }}>
      <header
        className="sticky top-0 z-40"
        style={{
          background: 'var(--ef-surface)',
          borderBottom: '1px solid var(--ef-border)',
        }}
      >
        {/* ── Top bar ── */}
        <div className="max-w-[1080px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              className="ef-icon-btn md:hidden"
              aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen((v) => !v)}
            >
              {mobileOpen ? <X size={17} strokeWidth={1.6} /> : <Menu size={17} strokeWidth={1.6} />}
            </button>

            <button
              type="button"
              className="flex items-center gap-2.5 min-w-0"
              style={{ background: 'transparent', border: 0, cursor: 'pointer', padding: 0 }}
              aria-label="Go to overview"
              onClick={() => navigate('/student/dashboard')}
            >
              <span style={{ color: 'var(--ef-ink)', display: 'flex' }}>
                {platformSettings.logoUrl
                  ? <img src={platformSettings.logoUrl} alt={platformSettings.name}
                      style={{ width: 22, height: 22, objectFit: 'contain' }} />
                  : <LogoMark px={22} />}
              </span>
              <span
                className="truncate hidden sm:block"
                style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ef-ink)', letterSpacing: '0.15em' }}
              >
                {platformSettings.name}
              </span>
            </button>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2">
            {!logoLoading && (
              <div
                className="hidden sm:flex items-center gap-2 pl-1.5 pr-3 py-1.5"
                style={{
                  background: 'var(--ef-canvas-raised)',
                  border: '1px solid var(--ef-border)',
                  borderRadius: 'var(--ef-radius-pill)',
                }}
                title={session.instituteName}
              >
                <InstituteMark logo={instituteLogo} name={session.instituteName} size={20} />
                <span className="truncate" style={{ fontSize: 11.5, color: 'var(--ef-text-muted)', maxWidth: 180 }}>
                  {session.instituteName}
                </span>
              </div>
            )}

            {/* Theme. A first-class control in the chrome rather than a
                setting buried three clicks deep — the whole point of letting
                someone choose is that changing their mind is cheap. */}
            <ThemeButton onOpen={() => setProfileOpen(false)} />

            <div className="relative">
              <button
                type="button"
                onClick={() => setProfileOpen((v) => !v)}
                className="ef-icon-btn"
                data-active={profileOpen}
                aria-haspopup="menu"
                aria-expanded={profileOpen}
                aria-label="Account menu"
              >
                <StudentAvatar name={session.name} size={26} />
              </button>
              <AnimatePresence>
                {profileOpen && <StudentProfileDropdown onClose={() => setProfileOpen(false)} />}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* ── Tab bar (desktop) ── */}
        <nav
          className="hidden md:block"
          style={{ borderTop: '1px solid var(--ef-border-subtle)' }}
          aria-label="Student sections"
        >
          <div className="max-w-[1080px] mx-auto px-4 sm:px-6 flex items-center gap-1">
            {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
              <button
                key={path}
                type="button"
                onClick={() => navigate(path)}
                className="ef-nav-link"
                aria-current={isActive(path) ? 'page' : undefined}
              >
                <Icon size={13} strokeWidth={1.6} />
                {label}
              </button>
            ))}
          </div>
        </nav>
      </header>

      {/* ── Mobile sheet ── */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.nav
            key="mobile-nav"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="md:hidden sticky top-14 z-30 overflow-hidden"
            style={{ background: 'var(--ef-surface)', borderBottom: '1px solid var(--ef-border)' }}
            aria-label="Student sections"
          >
            <div className="px-3 py-2">
              {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => navigate(path)}
                  className="ef-menu-item"
                  style={{ borderRadius: 'var(--ef-radius-sm)' }}
                  aria-current={isActive(path) ? 'page' : undefined}
                >
                  <Icon size={15} strokeWidth={1.6} />
                  {label}
                  {isActive(path) && (
                    <Check size={14} strokeWidth={2} className="ml-auto" style={{ color: 'var(--ef-accent)' }} />
                  )}
                </button>
              ))}
            </div>
          </motion.nav>
        )}
      </AnimatePresence>

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
