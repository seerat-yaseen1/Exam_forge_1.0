import { useRef, useState, useEffect } from 'react';
import { Outlet, useNavigate, Navigate, useLocation } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { User, Lock, LogOut, Building2, LayoutDashboard, ClipboardList } from 'lucide-react';
import { useStudentAuth } from '../context/StudentAuthContext';
import { usePlatformSettings } from '../context/PlatformSettingsContext';
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
      <Building2 size={size * 0.42} strokeWidth={1.5} style={{ color: '#6B6B66' }} />
    </div>
  );
}

// ── Student profile avatar ────────────────────────────────────────

function StudentAvatar({ name, size = 28 }: { name: string; size?: number }) {
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

function StudentProfileDropdown({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { session, instituteLogo, logout } = useStudentAuth();
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
    navigate('/student/login', { replace: true });
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
        <StudentAvatar name={session?.name ?? ''} size={30} />
        <div className="min-w-0">
          <p className="text-xs font-medium truncate" style={{ color: '#0C0C0B' }}>{session?.name}</p>
          <p className="text-xs truncate mt-0.5" style={{ color: '#6B6B66' }}>{session?.instituteName}</p>
          <p className="text-xs truncate mt-0.5" style={{ color: '#6B6B66', letterSpacing: '0.06em' }}>
            STUDENT
          </p>
        </div>
      </div>

      {/* Menu items */}
      <div className="py-1">
        <button
          onClick={() => handleNav('/student/profile')}
          className={menuItem}
          style={{ color: '#4A4A45' }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = '#F7F6F3')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
        >
          <User size={14} strokeWidth={1.5} />
          Profile
        </button>
        <button
          onClick={() => handleNav('/student/security')}
          className={menuItem}
          style={{ color: '#4A4A45' }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = '#F7F6F3')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
        >
          <Lock size={14} strokeWidth={1.5} />
          Security
        </button>
      </div>

      {/* Logout */}
      <div style={{ borderTop: '1px solid #F0EFEB' }}>
        <button
          onClick={handleLogout}
          className={menuItem}
          style={{ color: '#9B2828' }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = '#FEF6F5')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
        >
          <LogOut size={14} strokeWidth={1.5} />
          Sign out
        </button>
      </div>
    </motion.div>
  );
}

// ── Main layout ───────────────────────────────────────────────────

export function StudentDashboardLayout() {
  const { session, instituteLogo, logoLoading, loading } = useStudentAuth();
  const { platformSettings } = usePlatformSettings();
  const navigate = useNavigate();
  const location = useLocation();
  const [profileOpen, setProfileOpen] = useState(false);

  // Auth rehydration guard. Firebase restores the session from IndexedDB
  // ASYNCHRONOUSLY, so on a page refresh the first render always has
  // {user/session: null, loading: true}. Redirecting on the null alone raced
  // that restore and bounced the user to the login page on refresh —
  // intermittently, because whether it happened depended on which resolved
  // first. Wait for the answer before acting on it.
  if (loading) return <RouteFallback />;
  if (!session) return <Navigate to="/student/login" replace />;
  if (session.firstLoginRequired) return <Navigate to="/student/change-password" replace />;

  // Nav items
  const navItems = [
    { path: '/student/dashboard',    label: 'Overview',    icon: <LayoutDashboard size={13} strokeWidth={1.5} /> },
    { path: '/student/assessments',  label: 'Assessments', icon: <ClipboardList   size={13} strokeWidth={1.5} /> },
  ];

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F6F3' }}>
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white" style={{ borderBottom: '1px solid #E3E1DB' }}>
        {/* Top bar */}
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          {/* Platform branding */}
          {/* Audit 2026-08-06: a click-to-navigate div reachable only by
              mouse. Given a button role it also needs to be focusable and to
              answer Enter/Space, which is what a real button would have done
              for free — the element stays a div only because it wraps the
              logo mark and the wordmark as one target. */}
          <div
            className="flex items-center gap-3 cursor-pointer"
            role="button"
            tabIndex={0}
            aria-label="Go to dashboard"
            onClick={() => navigate('/student/dashboard')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigate('/student/dashboard');
              }
            }}
          >
            <div style={{ color: '#0C0C0B' }}>
              {platformSettings.logoUrl
                ? <img src={platformSettings.logoUrl} alt={platformSettings.name}
                    style={{ width: 24, height: 24, objectFit: 'contain' }} />
                : <LogoMark px={24} />}
            </div>
            <span className="text-xs font-medium" style={{ color: '#0C0C0B', letterSpacing: '0.16em' }}>
              {platformSettings.name}
            </span>
          </div>

          {/* Institute + Profile */}
          <div className="flex items-center gap-3">
            {!logoLoading && (
              <div className="flex items-center gap-2.5 px-3 py-1.5 rounded"
                style={{ background: '#F7F6F3', border: '1px solid #E3E1DB' }}>
                <InstituteMark logo={instituteLogo} name={session.instituteName} size={20} />
                <span className="text-xs" style={{ color: '#6B6B66' }}>{session.instituteName}</span>
              </div>
            )}
            <div className="relative">
              <button
                onClick={() => setProfileOpen((v) => !v)}
                className="flex items-center gap-2 px-2 py-1 rounded transition-colors"
                style={{ background: profileOpen ? '#F7F6F3' : 'transparent' }}
                onMouseEnter={(e) => { if (!profileOpen) (e.currentTarget as HTMLElement).style.background = '#F7F6F3'; }}
                onMouseLeave={(e) => { if (!profileOpen) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                <StudentAvatar name={session.name} size={26} />
              </button>
              <AnimatePresence>
                {profileOpen && <StudentProfileDropdown onClose={() => setProfileOpen(false)} />}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Navigation tab bar */}
        <div style={{ borderTop: '1px solid #F0EFEB' }}>
          <div className="max-w-7xl mx-auto px-4 flex items-center gap-1">
            {navItems.map((item) => {
              const isActive = location.pathname === item.path;
              return (
                <button
                  key={item.path}
                  onClick={() => navigate(item.path)}
                  className="flex items-center gap-1.5 text-xs px-3 py-2.5 relative transition-colors"
                  style={{ color: isActive ? '#0C0C0B' : '#6B6B66', background: 'transparent', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.color = '#4A4A45'; }}
                  onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.color = '#6B6B66'; }}
                >
                  {item.icon}
                  {item.label}
                  {/* Active underline */}
                  {isActive && (
                    <span
                      style={{
                        position: 'absolute', bottom: 0, left: 0, right: 0,
                        height: 2, background: '#0C0C0B', borderRadius: '2px 2px 0 0',
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}