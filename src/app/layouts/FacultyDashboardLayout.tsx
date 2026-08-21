import { useNavigate, Navigate, Outlet } from 'react-router';
import {
  BookOpen, Building2, ClipboardList, Flag, LayoutDashboard, Lock, Palette, User,
} from 'lucide-react';
import { useFacultyAuth } from '../context/FacultyAuthContext';
import { usePlatformSettings } from '../context/PlatformSettingsContext';
import { LogoMark } from '../components/PlatformLogo';
import { RouteFallback } from '../components/RouteFallback';
import { ConsoleShell, type NavItem } from '../components/console/Shell';

/**
 * The faculty console's frame.
 *
 * Everything structural — app bar, sidebar, drawer, account menu, and the
 * mobile behaviour all three staff consoles were missing — lives in
 * ConsoleShell. What is left here is the two things that are actually about
 * faculty: which sections this person may see, and what their account menu
 * offers. That is the whole file, which is the point of the shell.
 */

function InstituteMark({ logo, name, size = 24 }: { logo: string | null; name: string; size?: number }) {
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
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
    <span
      className="ef-avatar ef-avatar--muted"
      style={{ width: size, height: size }}
      title={name}
      aria-hidden="true"
    >
      <Building2 size={size * 0.44} strokeWidth={1.6} />
    </span>
  );
}

export function FacultyDashboardLayout() {
  const { session, instituteLogo, logout, loading } = useFacultyAuth();
  const { platformSettings } = usePlatformSettings();
  const navigate = useNavigate();

  // Auth rehydration guard. Firebase restores the session from IndexedDB
  // ASYNCHRONOUSLY, so on a page refresh the first render always has
  // {session: null, loading: true}. Redirecting on the null alone raced that
  // restore and bounced the user to the login page on refresh — intermittently,
  // because whether it happened depended on which resolved first. Wait for the
  // answer before acting on it.
  if (loading) return <RouteFallback />;
  if (!session) return <Navigate to="/faculty/login" replace />;

  const nav: NavItem[] = [
    { to: '/faculty/dashboard', label: 'Dashboard', icon: <LayoutDashboard size={15} strokeWidth={1.6} /> },
    { to: '/faculty/questions', label: 'Questions', icon: <BookOpen size={15} strokeWidth={1.6} /> },
    ...(session.canManageExamRosters
      ? [
          { to: '/faculty/assignments', label: 'Assignments', icon: <ClipboardList size={15} strokeWidth={1.6} /> },
          { to: '/faculty/reports', label: 'Reports', icon: <Flag size={15} strokeWidth={1.6} /> },
        ]
      : []),
  ];

  return (
    <ConsoleShell
      brand={{
        name: platformSettings.name,
        logoUrl: platformSettings.logoUrl,
        mark: <LogoMark px={22} />,
        to: '/faculty/dashboard',
      }}
      nav={nav}
      context={
        // The institute this faculty member belongs to. Hidden on the
        // narrowest screens: it is context rather than a control, and it never
        // changes within a session, so it is the first thing to yield when the
        // bar has to choose.
        <span
          className="hidden md:flex items-center gap-2.5 px-2.5 py-1.5"
          style={{
            background: 'var(--ef-canvas-raised)',
            border: '1px solid var(--ef-border)',
            borderRadius: 'var(--ef-radius-pill)',
            maxWidth: 260,
          }}
        >
          <InstituteMark logo={instituteLogo} name={session.instituteName} size={20} />
          <span className="ef-t-xs ef-muted truncate">{session.instituteName}</span>
        </span>
      }
      account={{
        name: session.name,
        subtitle: session.email,
        role: 'Faculty',
        actions: [
          { label: 'Profile', icon: <User size={14} strokeWidth={1.6} />, to: '/faculty/profile' },
          { label: 'Appearance', icon: <Palette size={14} strokeWidth={1.6} />, to: '/faculty/appearance' },
          { label: 'Security', icon: <Lock size={14} strokeWidth={1.6} />, to: '/faculty/security' },
        ],
      }}
      onSignOut={() => {
        logout();
        navigate('/faculty/login', { replace: true });
      }}
    >
      <Outlet />
    </ConsoleShell>
  );
}
