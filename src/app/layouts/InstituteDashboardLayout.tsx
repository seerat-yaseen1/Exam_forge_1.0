import { useRef, useState } from 'react';
import { useNavigate, Navigate, Outlet } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import {
  BookOpen, Building2, ClipboardList, Flag, LayoutDashboard, Loader2, Palette, Upload, User,
} from 'lucide-react';
import { useInstituteAuth } from '../context/InstituteAuthContext';
import { usePlatformSettings } from '../context/PlatformSettingsContext';
import { LogoMark } from '../components/PlatformLogo';
import { RouteFallback } from '../components/RouteFallback';
import { ConsoleShell, type NavItem } from '../components/console/Shell';

/**
 * The institute admin console's frame.
 *
 * The structural half is ConsoleShell. What stays here is what is genuinely
 * about an institute: the permission flags that decide which sections exist,
 * and the logo upload — which lives in this layout rather than on a settings
 * page because the logo is IN the chrome, and the shortest path between
 * seeing it and changing it is the one people actually take.
 */

function InstituteMark({
  logo,
  name,
  size = 28,
  busy = false,
}: {
  logo: string | null;
  name: string;
  size?: number;
  busy?: boolean;
}) {
  if (busy) {
    return (
      <span className="ef-avatar ef-avatar--muted" style={{ width: size, height: size }}>
        <Loader2 size={size * 0.45} strokeWidth={1.6} className="animate-spin" />
      </span>
    );
  }
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

export function InstituteDashboardLayout() {
  const { session, logo, logoLoading, uploadLogo, logout, loading } = useInstituteAuth();
  const { platformSettings } = usePlatformSettings();
  const navigate = useNavigate();

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auth rehydration guard — see FacultyDashboardLayout for the full note.
  if (loading) return <RouteFallback />;
  if (!session) return <Navigate to="/institute/login" replace />;

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

  const nav: NavItem[] = [
    { to: '/institute/dashboard', label: 'Dashboard', icon: <LayoutDashboard size={15} strokeWidth={1.6} /> },
    ...(session.canAdminCreateQuestions
      ? [{ to: '/institute/questions', label: 'Questions', icon: <BookOpen size={15} strokeWidth={1.6} /> }]
      : []),
    ...(session.canAdminManageExamRosters
      ? [
          { to: '/institute/assignments', label: 'Assignments', icon: <ClipboardList size={15} strokeWidth={1.6} /> },
          { to: '/institute/reports', label: 'Reports', icon: <Flag size={15} strokeWidth={1.6} /> },
        ]
      : []),
  ];

  return (
    <>
      <ConsoleShell
        brand={{
          name: platformSettings.name,
          logoUrl: platformSettings.logoUrl,
          mark: <LogoMark px={22} />,
          to: '/institute/dashboard',
        }}
        nav={nav}
        context={
          <span
            className="hidden md:flex items-center gap-2.5 px-2.5 py-1.5"
            style={{
              background: 'var(--ef-canvas-raised)',
              border: '1px solid var(--ef-border)',
              borderRadius: 'var(--ef-radius-pill)',
              maxWidth: 280,
            }}
          >
            <InstituteMark
              logo={logo}
              name={session.instituteName}
              size={20}
              busy={uploading || logoLoading}
            />
            <span className="ef-t-xs ef-muted truncate">{session.instituteName}</span>
          </span>
        }
        account={{
          name: session.adminName,
          subtitle: session.adminEmail,
          role: 'Institute admin',
          actions: [
            { label: 'Profile', icon: <User size={14} strokeWidth={1.6} />, to: '/institute/profile' },
            {
              label: logo ? 'Change institute logo' : 'Upload institute logo',
              icon: <Upload size={14} strokeWidth={1.6} />,
              onSelect: () => {
                setUploadError('');
                fileInputRef.current?.click();
              },
            },
            { label: 'Appearance', icon: <Palette size={14} strokeWidth={1.6} />, to: '/institute/appearance' },
          ],
        }}
        onSignOut={() => {
          logout();
          navigate('/institute/login', { replace: true });
        }}
      >
        <Outlet />
      </ConsoleShell>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* An upload failure has to be seen wherever the admin happens to be —
          the control that started it is in a menu that has since closed. */}
      <AnimatePresence>
        {uploadError && (
          <motion.div
            role="alert"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="fixed z-50 flex items-start gap-3"
            style={{
              left: 16,
              right: 16,
              bottom: 'calc(16px + env(safe-area-inset-bottom))',
              maxWidth: 420,
              marginInline: 'auto',
              padding: '12px 14px',
              background: 'var(--ef-danger-bg)',
              border: '1px solid var(--ef-danger-border)',
              borderRadius: 'var(--ef-radius)',
              boxShadow: 'var(--ef-shadow-md)',
            }}
          >
            <p className="ef-t-sm" style={{ color: 'var(--ef-danger)', flex: 1 }}>
              {uploadError}
            </p>
            <button
              type="button"
              className="ef-t-xs"
              onClick={() => setUploadError('')}
              style={{ color: 'var(--ef-danger)', background: 'none', border: 0, cursor: 'pointer' }}
            >
              Dismiss
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
