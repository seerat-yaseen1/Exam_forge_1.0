import { useRef, useState, useEffect } from 'react';
import { Outlet, useNavigate, Navigate, Link, useLocation } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { User, Upload, LogOut, Building2, Loader2, LayoutDashboard, BookOpen, ClipboardList, Flag, Palette } from 'lucide-react';
import { useInstituteAuth } from '../context/InstituteAuthContext';
import { usePlatformSettings } from '../context/PlatformSettingsContext';
import { LogoMark } from '../components/PlatformLogo';
import { ThemeButton } from '../components/console/ThemeMenu';
import { RouteFallback } from '../components/RouteFallback';

// ── Institute logo / avatar ───────────────────────────────────────────────────

function InstituteMark({
  logo,
  name,
  size = 32,
}: {
  logo: string | null;
  name: string;
  size?: number;
}) {
  const initials = name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  if (logo) {
    return (
      <img
        src={logo}
        alt={name}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          border: '1px solid var(--ef-border)',
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'var(--ef-border-subtle)',
        border: '1px solid var(--ef-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <Building2 size={size * 0.44} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
    </div>
  );
}

// ── Profile dropdown ──────────────────────────────────────────────────────────

function InstituteProfileDropdown({
  onClose,
  onUploadLogo,
}: {
  onClose: () => void;
  onUploadLogo: () => void;
}) {
  const navigate = useNavigate();
  const { session, logout, logo } = useInstituteAuth();
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
    navigate('/institute/login', { replace: true });
  };

  const menuItem =
    'w-full flex items-center gap-2.5 px-4 py-2.5 text-xs text-left transition-colors';
  const menuItemStyle: React.CSSProperties = { color: '#2C2C2A' };

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="absolute right-0 top-full mt-2 z-50"
      style={{
        width: 220,
        background: 'var(--ef-surface)',
        border: '1px solid var(--ef-border)',
        boxShadow: '0 6px 24px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)',
        borderRadius: 3,
      }}
    >
      {/* Account info */}
      <div className="flex items-center gap-3 px-4 py-3.5" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
        <InstituteMark logo={logo} name={session?.instituteName ?? ''} size={28} />
        <div className="min-w-0">
          <p className="text-xs font-medium truncate" style={{ color: 'var(--ef-ink)' }}>
            {session?.adminName}
          </p>
          <p className="text-xs truncate mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>
            {session?.instituteName}
          </p>
        </div>
      </div>

      {/* Menu items */}
      <div className="py-1">
        <button
          onClick={() => handleNav('/institute/profile')}
          className={menuItem}
          style={menuItemStyle}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas)')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
        >
          <User size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          Profile
        </button>

        <button
          onClick={() => handleNav('/institute/appearance')}
          className={menuItem}
          style={menuItemStyle}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas)')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
        >
          <Palette size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          Appearance
        </button>

        <button
          onClick={() => { onClose(); onUploadLogo(); }}
          className={menuItem}
          style={menuItemStyle}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas)')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
        >
          <Upload size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          {logo ? 'Change institute logo' : 'Upload institute logo'}
        </button>
      </div>

      {/* Logout */}
      <div style={{ borderTop: '1px solid var(--ef-border-subtle)' }} className="py-1">
        <button
          onClick={handleLogout}
          className={menuItem}
          style={menuItemStyle}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas)')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
        >
          <LogOut size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          Sign out
        </button>
      </div>
    </motion.div>
  );
}

// ── Sidebar nav item ──────────────────────────────────────────────────────────

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
          color:      isActive ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
          background: isActive ? 'var(--ef-canvas)' : 'transparent',
          borderLeft: isActive ? '2px solid var(--ef-ink)' : '2px solid transparent',
          letterSpacing: '0.01em',
        }}
        onMouseEnter={(e) => {
          if (!isActive) {
            (e.currentTarget as HTMLElement).style.color      = '#2C2C2A';
            (e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isActive) {
            (e.currentTarget as HTMLElement).style.color      = 'var(--ef-text-muted)';
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

// ── Main layout ───────────────────────────────────────────────────────────────

const SIDEBAR_W = 180;

export function InstituteDashboardLayout() {
  const { session, logo, logoLoading, uploadLogo, loading } = useInstituteAuth();
  const { platformSettings } = usePlatformSettings();
  const location = useLocation();

  const [menuOpen, setMenuOpen]       = useState(false);
  const [uploading, setUploading]     = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef                  = useRef<HTMLInputElement>(null);

  // Guards
  // Auth rehydration guard. Firebase restores the session from IndexedDB
  // ASYNCHRONOUSLY, so on a page refresh the first render always has
  // {user/session: null, loading: true}. Redirecting on the null alone raced
  // that restore and bounced the user to the login page on refresh —
  // intermittently, because whether it happened depended on which resolved
  // first. Wait for the answer before acting on it.
  if (loading) return <RouteFallback />;
  if (!session) return <Navigate to="/institute/login" replace />;
  if (session.firstLoginRequired) return <Navigate to="/institute/change-password" replace />;

  const isDashboard  = location.pathname === '/institute/dashboard';
  const isQuestions  = location.pathname.startsWith('/institute/questions');
  const isAssignments = location.pathname.startsWith('/institute/assignments');
  const isReports = location.pathname.startsWith('/institute/reports');

  const triggerLogoUpload = () => {
    setUploadError('');
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    if (!file.type.startsWith('image/')) {
      setUploadError('Please select an image file.');
      return;
    }
    setUploading(true);
    setUploadError('');
    const result = await uploadLogo(file);
    setUploading(false);
    if (!result.success) setUploadError(result.error ?? 'Upload failed.');
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--ef-canvas)' }}>
      {/* ── Header ── */}
      <header
        className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-6"
        style={{ height: 56, background: 'var(--ef-surface)', borderBottom: '1px solid var(--ef-border)' }}
      >
        {/* Left: Platform logo + name */}
        <Link to="/institute/dashboard" style={{ textDecoration: 'none', color: 'var(--ef-ink)' }}>
          <div className="flex items-center gap-2.5 select-none">
            {platformSettings.logoUrl ? (
              <img src={platformSettings.logoUrl} alt={platformSettings.name}
                style={{ width: 20, height: 20, objectFit: 'contain' }} />
            ) : (
              <LogoMark px={20} />
            )}
            <span className="text-sm font-medium" style={{ letterSpacing: '0.145em' }}>
              {platformSettings.name}
            </span>
          </div>
        </Link>

        {/* Right: theme control, then institute logo + name + profile menu */}
        <div className="flex items-center gap-2">
          {/* In the chrome rather than three clicks deep in a settings page:
              the point of letting someone choose is that changing their mind
              is cheap. */}
          <ThemeButton onOpen={() => setMenuOpen(false)} />

          <div className="relative flex items-center">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2.5 transition-opacity select-none"
            style={{ outline: 'none' }}
            aria-label="Open institute menu"
            aria-expanded={menuOpen}
          >
            <span className="text-xs" style={{ color: 'var(--ef-text-subtle)', letterSpacing: '0.02em' }}>
              {session.instituteName}
            </span>
            <div className="relative">
              {uploading || logoLoading ? (
                <div style={{
                  width: 32, height: 32, borderRadius: '50%',
                  background: 'var(--ef-border-subtle)', border: '1px solid var(--ef-border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Loader2 size={14} strokeWidth={1.5} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
                </div>
              ) : (
                <InstituteMark logo={logo} name={session.instituteName} size={32} />
              )}
            </div>
          </button>

          <AnimatePresence>
            {menuOpen && (
              <InstituteProfileDropdown
                onClose={() => setMenuOpen(false)}
                onUploadLogo={triggerLogoUpload}
              />
            )}
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
          background: 'var(--ef-surface)',
          borderRight: '1px solid var(--ef-border)',
        }}
      >
        <div className="pt-5 pb-2 px-5">
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em', marginBottom: 6 }}>
            MODULES
          </p>
        </div>

        <SidebarNavItem
          to="/institute/dashboard"
          icon={<LayoutDashboard size={13} strokeWidth={1.5} />}
          label="Dashboard"
          isActive={isDashboard}
        />

        {session.canAdminCreateQuestions && (
          <SidebarNavItem
            to="/institute/questions"
            icon={<BookOpen size={13} strokeWidth={1.5} />}
            label="Questions"
            isActive={isQuestions}
          />
        )}

        {session.canAdminManageExamRosters && (
          <SidebarNavItem
            to="/institute/assignments"
            icon={<ClipboardList size={13} strokeWidth={1.5} />}
            label="Assignments"
            isActive={isAssignments}
          />
        )}

        {session.canAdminManageExamRosters && (
          <SidebarNavItem
            to="/institute/reports"
            icon={<Flag size={13} strokeWidth={1.5} />}
            label="Reports"
            isActive={isReports}
          />
        )}
      </nav>

      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />

      {/* Upload error toast */}
      <AnimatePresence>
        {uploadError && (
          <motion.div
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            className="fixed top-16 right-4 z-50 px-4 py-2.5"
            style={{
              background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)',
              borderRadius: 2, boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
            }}
          >
            <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{uploadError}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Content ── */}
      <main style={{ paddingTop: 56, paddingLeft: SIDEBAR_W }}>
        <Outlet />
      </main>
    </div>
  );
}