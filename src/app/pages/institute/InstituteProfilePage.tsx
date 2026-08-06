import { useRef } from 'react';
import { motion } from 'motion/react';
import { Building2, Mail, Hash, CalendarDays, Upload, Loader2 } from 'lucide-react';
import { useInstituteAuth } from '../../context/InstituteAuthContext';

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div
      className="flex items-start gap-4 py-4"
      style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}
    >
      <div style={{ color: 'var(--ef-text-muted)', marginTop: 1, flexShrink: 0 }}>{icon}</div>
      <div>
        <p className="text-xs mb-0.5" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>
          {label}
        </p>
        <p className="text-sm" style={{ color: 'var(--ef-ink)' }}>
          {value}
        </p>
      </div>
    </div>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

function validityStatus(activeUntil: string) {
  const days = Math.ceil((new Date(activeUntil).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (days < 0) return ` · Expired`;
  if (days === 0) return ` · Expires today`;
  if (days <= 7) return ` · ${days}d remaining`;
  return '';
}

export function InstituteProfilePage() {
  const { session, logo, logoLoading, uploadLogo } = useInstituteAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!session) return null;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    if (!file.type.startsWith('image/')) return;
    await uploadLogo(file);
  };

  const validUntilStr =
    formatDate(session.activeUntil) + validityStatus(session.activeUntil);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="px-4 py-6 sm:px-8 sm:py-10"
      style={{ maxWidth: 680, margin: '0 auto' }}
    >
      {/* ── Page header ── */}
      <div className="mb-8" style={{ borderBottom: '1px solid var(--ef-border)', paddingBottom: 20 }}>
        <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
          INSTITUTE ADMIN
        </p>
        <h1 className="text-base" style={{ color: 'var(--ef-ink)' }}>Profile</h1>
      </div>

      {/* ── Logo section ── */}
      <div
        className="flex flex-wrap sm:flex-nowrap items-center gap-4 sm:gap-5 p-4 sm:p-5 mb-6"
        style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
      >
        {/* Logo preview */}
        <div
          style={{
            width: 72, height: 72, borderRadius: '50%',
            border: '1px solid var(--ef-border)',
            overflow: 'hidden',
            flexShrink: 0,
            background: 'var(--ef-border-subtle)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          {logoLoading ? (
            <Loader2 size={20} strokeWidth={1.5} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
          ) : logo ? (
            <img src={logo} alt={session.instituteName}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <Building2 size={28} strokeWidth={1} style={{ color: 'var(--ef-text-muted)' }} />
          )}
        </div>

        <div className="min-w-0">
          <p className="text-sm font-medium mb-0.5 break-words" style={{ color: 'var(--ef-ink)' }}>
            Institute Logo
          </p>
          <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
            {logo ? 'Displayed across all institute screens.' : 'No logo uploaded yet.'}
            {' '}PNG or JPG, max 2 MB.
          </p>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 text-xs px-3 py-2 transition-colors"
            style={{
              border: '1px solid var(--ef-border)',
              color: 'var(--ef-text-subtle)',
              borderRadius: 2,
              background: 'var(--ef-surface)',
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-ink)')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-border)')}
          >
            <Upload size={12} strokeWidth={1.5} />
            {logo ? 'Change logo' : 'Upload logo'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      </div>

      {/* ── Info rows ── */}
      <div
        className="px-5"
        style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
      >
        <InfoRow
          icon={<Building2 size={14} strokeWidth={1.5} />}
          label="INSTITUTE NAME"
          value={session.instituteName}
        />
        <InfoRow
          icon={<Hash size={14} strokeWidth={1.5} />}
          label="INSTITUTE ID"
          value={session.instituteCode}
        />
        <InfoRow
          icon={<Mail size={14} strokeWidth={1.5} />}
          label="ADMINISTRATOR EMAIL"
          value={session.adminEmail}
        />
        <InfoRow
          icon={<CalendarDays size={14} strokeWidth={1.5} />}
          label="ACCESS VALID UNTIL"
          value={validUntilStr}
        />
      </div>
    </motion.div>
  );
}
