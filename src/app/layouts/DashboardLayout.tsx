import { useNavigate, Navigate, Outlet } from 'react-router';
import {
  BookOpen, Building2, ClipboardList, Flag, FolderTree, Palette, Shield, ShieldCheck, User,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { usePlatformSettings } from '../context/PlatformSettingsContext';
import { LogoMark } from '../components/PlatformLogo';
import { RouteFallback } from '../components/RouteFallback';
import { ConsoleShell, type NavItem } from '../components/console/Shell';

/**
 * The Web Owner console's frame.
 *
 * Structural everything — app bar, sidebar, mobile drawer, account menu —
 * is ConsoleShell. This file is the nav and the guard.
 *
 * The Safe Exam Browser entry sits last on purpose. Serial position: the ends
 * of a list are what people remember, and of the six sections it is both the
 * least visited and the one with the widest blast radius when it is wrong, so
 * it gets the end rather than the middle where things go unread.
 */

export function DashboardLayout() {
  const { user, logout, loading } = useAuth();
  const { platformSettings } = usePlatformSettings();
  const navigate = useNavigate();

  // Auth rehydration guard. Firebase restores the session from IndexedDB
  // ASYNCHRONOUSLY, so on a page refresh the first render always has
  // {user: null, loading: true}. Redirecting on the null alone raced that
  // restore and bounced the user to the login page on refresh — intermittently,
  // because whether it happened depended on which resolved first. Wait for the
  // answer before acting on it.
  if (loading) return <RouteFallback />;
  if (!user) return <Navigate to="/login" replace />;

  const nav: NavItem[] = [
    { to: '/dashboard/user-management', label: 'User management', icon: <Building2 size={15} strokeWidth={1.6} /> },
    { to: '/dashboard/questions', label: 'Questions', icon: <BookOpen size={15} strokeWidth={1.6} /> },
    { to: '/dashboard/subjects', label: 'Subjects', icon: <FolderTree size={15} strokeWidth={1.6} /> },
    { to: '/dashboard/assignments', label: 'Assessments', icon: <ClipboardList size={15} strokeWidth={1.6} /> },
    { to: '/dashboard/reports', label: 'Reports', icon: <Flag size={15} strokeWidth={1.6} /> },
    { to: '/dashboard/seb', label: 'Safe Exam Browser', icon: <ShieldCheck size={15} strokeWidth={1.6} /> },
  ];

  return (
    <ConsoleShell
      brand={{
        name: platformSettings.name,
        logoUrl: platformSettings.logoUrl,
        mark: <LogoMark px={22} />,
        to: '/dashboard',
      }}
      nav={nav}
      account={{
        name: user.name,
        subtitle: user.email,
        role: 'Web owner',
        actions: [
          { label: 'Profile', icon: <User size={14} strokeWidth={1.6} />, to: '/dashboard/profile' },
          { label: 'Appearance', icon: <Palette size={14} strokeWidth={1.6} />, to: '/dashboard/appearance' },
          { label: 'Security', icon: <Shield size={14} strokeWidth={1.6} />, to: '/dashboard/security' },
        ],
      }}
      onSignOut={() => {
        logout();
        navigate('/login', { replace: true });
      }}
    >
      <Outlet />
    </ConsoleShell>
  );
}
