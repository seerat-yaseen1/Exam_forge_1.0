import { useRef, useState, useEffect } from 'react';
import { Outlet, useNavigate, Navigate, Link, useLocation } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { User, Lock, LogOut, Building2, LayoutDashboard, BookOpen, ClipboardList, Flag } from 'lucide-react';
import { useFacultyAuth } from '../context/FacultyAuthContext';
import { useAuth } from '../context/AuthContext';
import { LogoMark } from '../components/PlatformLogo';
import { RouteFallback } from '../components/RouteFallback';

// ── Institute logo mark ───────────────────────────────────────────

function InstituteMark({ logo, name, size = 28 }: { logo: string | null; name: string; size?: number }) {
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  if (logo) {
    return (
      <img src={logo} alt={name}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover',
          border: '1px solid #E3E1DB', flexShrink: 0 }} />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', background: '#F0EFEB',
      border: '1px solid #E3E1DB', display: 'flex', alignItems: 'center',
      justifyContent: 'center', flexShrink: 0,
    }}>
      <Building2 size={size * 0.42} strokeWidth={1.5} style={{ color: '#9A9891' }} />
    </div>
  );
}

// ── Faculty profile avatar ────────────────────────────────────────

function FacultyAvatar({ name, size = 28 }: { name: string; size?: number }) {
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: '#0C0C0B', border: '1px solid #2C2C2A',
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>
      <span style={{ fontSize: size * 0.34, color: '#FFFFFF', fontWeight: 500, letterSpacing: '0.04em' }}>
        {initials}
      </span>
    </div>
  );
}

// ── Profile dropdown ──────────────────────────────────────────────

function FacultyProfileDropdown({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { session, instituteLogo, logout } = useFacultyAuth();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleNav = (path: string) => { onClose(); navigate(path); };
  const handleLogout = () => {
    onClose();
    logout();
    navigate('/faculty/login', { replace: true });
  };

  const menuItem = 'w-full flex items-center gap-2.5 px-4 py-2.5 text-xs text-left transition-colors';

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="absolute right-0 top-full mt-2 z-50"
      style={{
        width: 240,
        background: '#FFFFFF',
        border: '1px solid #E3E1DB',
        boxShadow: '0 6px 24px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)',
        borderRadius: 3,
      }}
    >
      {/* Account info */}
      <div className="flex items-center gap-3 px-4 py-3.5" style={{ borderBottom: '1px solid #F0EFEB' }}>
        <FacultyAvatar name={session?.name ?? ''} size={30} />
        <div className="min-w-0">
          <p className="text-xs font-medium truncate" style={{ color: '#0C0C0B' }}>{session?.name}</p>
          <p className="text-xs truncate mt-0.5" style={{ color: '#9A9891' }}>{session?.instituteName}</p>
          <p className="text-xs truncate mt-0.5" style={{ color: '#C4C3BD', letterSpacing: '0.06em' }}>
            FACULTY
          </p>
        </div>
      </div>

      {/* Menu items */}
      <div className="py-1">
        <button onClick={() => handleNav('/faculty/profile')} className={menuItem}
          style={{ color: '#2C2C2A' }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = '#F7F6F3')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}>
          <User size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />
          Profile
        </button>
        <button onClick={() => handleNav('/faculty/security')} className={menuItem}
          style={{ color: '#2C2C2A' }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = '#F7F6F3')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}>
          <Lock size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />
          Security
        </button>
      </div>

      {/* Logout */}
      <div style={{ borderTop: '1px solid #F0EFEB' }} className="py-1">
        <button onClick={handleLogout} className={menuItem}
          style={{ color: '#2C2C2A' }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = '#F7F6F3')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}>
          <LogOut size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />
          Sign out
        </button>
      </div>
    </motion.div>
  );
}

// ── Sidebar nav item ──────────────────────────────────────────────

function SidebarNavItem({
  to, icon, label, isActive,
}: {
  to: string; icon: React.ReactNode; label: string; isActive: boolean;
}) {
  return (
    <Link to={to} style={{ textDecoration: 'none' }}>
      <div
        className="flex items-center gap-2.5 text-xs py-2 cursor-pointer transition-all select-none"
        style={{
          paddingLeft:  isActive ? 18 : 20,
          paddingRight: 16,
          color:      isActive ? '#0C0C0B' : '#9A9891',
          background: isActive ? '#F7F6F3' : 'transparent',
          borderLeft: isActive ? '2px solid #0C0C0B' : '2px solid transparent',
          letterSpacing: '0.01em',
        }}
        onMouseEnter={(e) => {
          if (!isActive) {
            (e.currentTarget as HTMLElement).style.color      = '#2C2C2A';
            (e.currentTarget as HTMLElement).style.background = '#F7F6F3';
          }
        }}
        onMouseLeave={(e) => {
          if (!isActive) {
            (e.currentTarget as HTMLElement).style.color      = '#9A9891';
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

// ── Main layout ───────────────────────────────────────────────────

const SIDEBAR_W = 180;

export function FacultyDashboardLayout() {
  const { session, instituteLogo, logoLoading, loading } = useFacultyAuth();
  const { platformSettings } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // Auth rehydration guard. Firebase restores the session from IndexedDB
  // ASYNCHRONOUSLY, so on a page refresh the first render always has
  // {user/session: null, loading: true}. Redirecting on the null alone raced
  // that restore and bounced the user to the login page on refresh —
  // intermittently, because whether it happened depended on which resolved
  // first. Wait for the answer before acting on it.
  if (loading) return <RouteFallback />;
  if (!session) return <Navigate to="/faculty/login" replace />;
  if (session.firstLoginRequired) return <Navigate to="/faculty/change-password" replace />;

  const isDashboard   = location.pathname === '/faculty/dashboard';
  const isQuestions   = location.pathname.startsWith('/faculty/questions');
  const isAssignments = location.pathname.startsWith('/faculty/assignments');
  const isReports = location.pathname.startsWith('/faculty/reports');

  return (
    <div className="min-h-screen" style={{ background: '#F7F6F3' }}>
      {/* ── Header ── */}
      <header
        className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-6"
        style={{ height: 56, background: '#FFFFFF', borderBottom: '1px solid #E3E1DB' }}
      >
        {/* Left: Platform logo + name */}
        <Link to="/faculty/dashboard" style={{ textDecoration: 'none', color: '#0C0C0B' }}>
          <div className="flex items-center gap-2.5 select-none">
            {platformSettings.logoUrl
              ? <img src={platformSettings.logoUrl} alt={platformSettings.name}
                  style={{ width: 20, height: 20, objectFit: 'contain' }} />
              : <LogoMark px={20} />}
            <span className="text-sm font-medium" style={{ letterSpacing: '0.145em' }}>
              {platformSettings.name}
            </span>
          </div>
        </Link>

        {/* Right: Institute logo + faculty profile icon */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2"
            style={{ borderRight: '1px solid #E3E1DB', paddingRight: 12 }}>
            <span className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.04em' }}>
              {session.instituteName}
            </span>
            <InstituteMark logo={instituteLogo} name={session.instituteName} size={26} />
          </div>

          <div className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-2 transition-opacity select-none"
              style={{ outline: 'none' }}
              aria-label="Open faculty menu"
              aria-expanded={menuOpen}
            >
              <FacultyAvatar name={session.name} size={28} />
            </button>

            <AnimatePresence>
              {menuOpen && <FacultyProfileDropdown onClose={() => setMenuOpen(false)} />}
            </AnimatePresence>
          </div>
        </div>
      </header>

      {/* ── Sidebar ── */}
      <nav
        className="fixed z-30"
        style={{
          top: 56, left: 0, bottom: 0,
          width: SIDEBAR_W,
          background: '#FFFFFF',
          borderRight: '1px solid #E3E1DB',
        }}
      >
        <div className="pt-5 pb-2 px-5">
          <p className="text-xs" style={{ color: '#C4C3BD', letterSpacing: '0.1em', marginBottom: 6 }}>
            MODULES
          </p>
        </div>

        <SidebarNavItem
          to="/faculty/dashboard"
          icon={<LayoutDashboard size={13} strokeWidth={1.5} />}
          label="Dashboard"
          isActive={isDashboard}
        />

        <SidebarNavItem
          to="/faculty/questions"
          icon={<BookOpen size={13} strokeWidth={1.5} />}
          label="Questions"
          isActive={isQuestions}
        />

        {session.canManageExamRosters && (
          <SidebarNavItem
            to="/faculty/assignments"
            icon={<ClipboardList size={13} strokeWidth={1.5} />}
            label="Assignments"
            isActive={isAssignments}
          />
        )}

        {session.canManageExamRosters && (
          <SidebarNavItem
            to="/faculty/reports"
            icon={<Flag size={13} strokeWidth={1.5} />}
            label="Reports"
            isActive={isReports}
          />
        )}
      </nav>

      {/* ── Content ── */}
      <main style={{ paddingTop: 56, paddingLeft: SIDEBAR_W }}>
        <Outlet />
      </main>
    </div>
  );
}