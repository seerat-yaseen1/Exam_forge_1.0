import { useState, useRef, useEffect } from 'react';
import { Outlet, useNavigate, Navigate, Link, useLocation } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { User, Shield, LogOut, Building2, BookOpen, ClipboardList, Flag, FolderTree, Menu, X, Palette } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { PlatformLogo } from '../components/PlatformLogo';
import { ThemeButton } from '../components/console/ThemeMenu';
import { useIsMobile } from '../hooks/useIsMobile';
import { RouteFallback } from '../components/RouteFallback';

// ── Profile dropdown ──────────────────────────────────────────────────────────

function ProfileDropdown({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleNav = (path: string) => {
    onClose();
    navigate(path);
  };

  const handleLogout = () => {
    onClose();
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="absolute right-0 top-full mt-2 w-48 bg-white z-50"
      style={{
        border: '1px solid var(--ef-border)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)',
        borderRadius: 3,
      }}
    >
      {/* Account info */}
      <div className="px-4 py-3" style={{ borderBottom: '1px solid #F0EFEBdd' }}>
        <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>
          {user?.name}
        </p>
        <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--ef-text-muted)' }}>
          {user?.email}
        </p>
      </div>

      {/* Menu items */}
      <div className="py-1">
        <button
          onClick={() => handleNav('/dashboard/profile')}
          className="w-full flex items-center gap-2.5 px-4 py-2 text-xs text-left transition-colors"
          style={{ color: 'var(--ef-ink)' }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas)')
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLElement).style.background = 'transparent')
          }
        >
          <User size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          Profile
        </button>
        <button
          onClick={() => handleNav('/dashboard/appearance')}
          className="w-full flex items-center gap-2.5 px-4 py-2 text-xs text-left transition-colors"
          style={{ color: 'var(--ef-text-subtle)' }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas)')
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLElement).style.background = 'transparent')
          }
        >
          <Palette size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          Appearance
        </button>
        <button
          onClick={() => handleNav('/dashboard/security')}
          className="w-full flex items-center gap-2.5 px-4 py-2 text-xs text-left transition-colors"
          style={{ color: 'var(--ef-ink)' }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas)')
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLElement).style.background = 'transparent')
          }
        >
          <Shield size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          Security
        </button>
      </div>

      {/* Separator + logout */}
      <div style={{ borderTop: '1px solid var(--ef-border-subtle)' }} className="py-1">
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2.5 px-4 py-2 text-xs text-left transition-colors"
          style={{ color: 'var(--ef-ink)' }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas)')
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLElement).style.background = 'transparent')
          }
        >
          <LogOut size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          Sign out
        </button>
      </div>
    </motion.div>
  );
}

// ── Sidebar nav item ──────────────────────────────────────────────────────────

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  isActive: boolean;
}

function SidebarNavItem({ to, icon, label, isActive }: NavItemProps) {
  return (
    <Link
      to={to}
      style={{ textDecoration: 'none' }}
    >
      <div
        className="flex items-center gap-2.5 text-xs py-2 cursor-pointer transition-all select-none"
        style={{
          paddingLeft: isActive ? 18 : 20,
          paddingRight: 16,
          color: isActive ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
          background: isActive ? 'var(--ef-canvas)' : 'transparent',
          borderLeft: isActive ? '2px solid var(--ef-ink)' : '2px solid transparent',
          letterSpacing: '0.01em',
        }}
        onMouseEnter={(e) => {
          if (!isActive) {
            (e.currentTarget as HTMLElement).style.color = 'var(--ef-ink)';
            (e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isActive) {
            (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)';
            (e.currentTarget as HTMLElement).style.background = 'transparent';
          }
        }}
      >
        {icon}
        {label}
      </div>
    </Link>
  );
}

// ── Dashboard Layout ──────────────────────────────────────────────────────────

const SIDEBAR_W = 180;

export function DashboardLayout() {
  const { user, loading } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const isMobile = useIsMobile();

  // Auto-close mobile drawer on route change
  useEffect(() => { setNavOpen(false); }, [location.pathname]);
  // If user resizes from phone → desktop while drawer is open, close it
  useEffect(() => { if (!isMobile) setNavOpen(false); }, [isMobile]);

  // Auth rehydration guard. Firebase restores the session from IndexedDB
  // ASYNCHRONOUSLY, so on a page refresh the first render always has
  // {user/session: null, loading: true}. Redirecting on the null alone raced
  // that restore and bounced the user to the login page on refresh —
  // intermittently, because whether it happened depended on which resolved
  // first. Wait for the answer before acting on it.
  if (loading) return <RouteFallback />;
  if (!user) return <Navigate to="/login" replace />;

  const initials = user.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const isUserMgmt = location.pathname.startsWith('/dashboard/user-management');
  const isQuestions = location.pathname.startsWith('/dashboard/questions');
  const isSubjects = location.pathname.startsWith('/dashboard/subjects');
  const isAssignments = location.pathname.startsWith('/dashboard/assignments');
  const isReports = location.pathname.startsWith('/dashboard/reports');
  const isSebDiag = location.pathname.startsWith('/dashboard/seb');

  return (
    <div className="min-h-screen" style={{ background: 'var(--ef-canvas)' }}>
      {/* ── Topbar ── */}
      <header
        className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-4 md:px-6"
        style={{
          height: 56,
          background: 'var(--ef-surface)',
          borderBottom: '1px solid var(--ef-border)',
        }}
      >
        {/* Left: Hamburger (phone) + Logo */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setNavOpen((v) => !v)}
            className="md:hidden p-1.5 -ml-1.5 transition-opacity hover:opacity-70"
            style={{ color: 'var(--ef-ink)', outline: 'none' }}
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={navOpen}
          >
            {navOpen ? <X size={18} strokeWidth={1.5} /> : <Menu size={18} strokeWidth={1.5} />}
          </button>
          <Link
            to="/dashboard"
            style={{ textDecoration: 'none', color: 'var(--ef-ink)' }}
          >
            <PlatformLogo size="md" />
          </Link>
        </div>

        {/* Right: theme control, then profile */}
        <div className="flex items-center gap-2">
        {/* In the chrome rather than three clicks deep in a settings page: the
            point of letting someone choose is that changing their mind is
            cheap. */}
        <ThemeButton onOpen={() => setMenuOpen(false)} />

        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 transition-opacity"
            style={{ outline: 'none' }}
            aria-label="Open profile menu"
            aria-expanded={menuOpen}
          >
            <div
              className="flex items-center justify-center text-xs font-medium select-none"
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: 'var(--ef-ink)',
                color: 'var(--ef-surface)',
                letterSpacing: '0.04em',
              }}
            >
              {initials}
            </div>
          </button>

          <AnimatePresence>
            {menuOpen && <ProfileDropdown onClose={() => setMenuOpen(false)} />}
          </AnimatePresence>
        </div>
        </div>
      </header>

      {/* ── Backdrop (phone only, when drawer is open) ── */}
      <AnimatePresence>
        {navOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-20 md:hidden"
            style={{ top: 56, background: 'rgba(12,12,11,0.32)' }}
          />
        )}
      </AnimatePresence>

      {/* ── Sidebar ── */}
      <nav
        className={`fixed z-30 transition-transform duration-200 ease-out md:translate-x-0 ${navOpen ? 'translate-x-0' : '-translate-x-full'}`}
        style={{
          top: 56,
          left: 0,
          bottom: 0,
          width: SIDEBAR_W,
          background: 'var(--ef-surface)',
          borderRight: '1px solid var(--ef-border)',
        }}
      >
        {/* Section label */}
        <div className="pt-5 pb-2 px-5">
          <p
            className="text-xs"
            style={{
              color: 'var(--ef-text-muted)',
              letterSpacing: '0.1em',
              marginBottom: 6,
            }}
          >
            MODULES
          </p>
        </div>

        {/* Nav items */}
        <SidebarNavItem
          to="/dashboard/user-management"
          icon={<Building2 size={13} strokeWidth={1.5} />}
          label="User Management"
          isActive={isUserMgmt}
        />
        <SidebarNavItem
          to="/dashboard/questions"
          icon={<BookOpen size={13} strokeWidth={1.5} />}
          label="Questions"
          isActive={isQuestions}
        />
        <SidebarNavItem
          to="/dashboard/subjects"
          icon={<FolderTree size={13} strokeWidth={1.5} />}
          label="Subjects"
          isActive={isSubjects}
        />
        <SidebarNavItem
          to="/dashboard/assignments"
          icon={<ClipboardList size={13} strokeWidth={1.5} />}
          label="Assessments"
          isActive={isAssignments}
        />
        <SidebarNavItem
          to="/dashboard/reports"
          icon={<Flag size={13} strokeWidth={1.5} />}
          label="Reports"
          isActive={isReports}
        />
        {/* Phase 3 (Stage 4): SEB settings — Config Key management and
            rotation. The Stage-1 diagnostics page remains routable and is
            linked from inside this page. Active state covers both paths. */}
        <SidebarNavItem
          to="/dashboard/seb"
          icon={<Shield size={13} strokeWidth={1.5} />}
          label="Safe Exam Browser"
          isActive={isSebDiag}
        />
      </nav>

      {/* ── Page content ── */}
      <main
        className="md:pl-[180px]"
        style={{ paddingTop: 56 }}
      >
        <Outlet />
      </main>
    </div>
  );
}