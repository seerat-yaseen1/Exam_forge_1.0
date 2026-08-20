import { useState, useRef } from 'react';
import { motion } from 'motion/react';
import { Upload, X, Check, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { usePlatformSettings } from '../context/PlatformSettingsContext';

export function ProfilePage() {
  const { user } = useAuth();
  const { platformSettings, updatePlatformSettings } = usePlatformSettings();

  const [platformName, setPlatformName] = useState(platformSettings.name);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(platformSettings.logoUrl);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const url = ev.target?.result as string;
      setLogoPreview(url);
      // Immediate reflection across all screens — no refresh, no delay
      updatePlatformSettings({ logoUrl: url });
    };
    reader.readAsDataURL(file);
    // Reset input so same file can be re-selected
    e.target.value = '';
  };

  const handleRemoveLogo = () => {
    setLogoPreview(null);
    updatePlatformSettings({ logoUrl: null });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!platformName.trim()) return;

    setSaving(true);
    // Simulate save — in production this would persist to backend
    await new Promise((r) => setTimeout(r, 600));
    updatePlatformSettings({ name: platformName.trim() });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="max-w-[520px] mx-auto px-6 py-12"
    >
      {/* Section header */}
      <div className="mb-8" style={{ borderBottom: '1px solid var(--ef-border)', paddingBottom: 20 }}>
        <p
          className="text-xs mb-1"
          style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}
        >
          WEB OWNER
        </p>
        <h1 className="text-base" style={{ color: 'var(--ef-ink)' }}>
          Profile & Platform
        </h1>
      </div>

      {/* Account info */}
      <div className="mb-8">
        <p
          className="text-xs mb-4"
          style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}
        >
          ACCOUNT
        </p>
        <div className="grid gap-4">
          <div>
            <p className="text-xs mb-1.5" style={{ color: 'var(--ef-text-subtle)' }}>Name</p>
            <div
              className="px-3.5 py-2.5 text-sm"
              style={{
                background: 'var(--ef-canvas)',
                border: '1px solid var(--ef-border)',
                color: 'var(--ef-text-muted)',
                borderRadius: 2,
              }}
            >
              {user?.name}
            </div>
          </div>
          <div>
            <p className="text-xs mb-1.5" style={{ color: 'var(--ef-text-subtle)' }}>Email</p>
            <div
              className="px-3.5 py-2.5 text-sm"
              style={{
                background: 'var(--ef-canvas)',
                border: '1px solid var(--ef-border)',
                color: 'var(--ef-text-muted)',
                borderRadius: 2,
              }}
            >
              {user?.email}
            </div>
            <p className="mt-1.5 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
              Email address cannot be changed.
            </p>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div style={{ borderTop: '1px solid var(--ef-border)', marginBottom: 28 }} />

      {/* Platform settings */}
      <form onSubmit={handleSave}>
        <p
          className="text-xs mb-4"
          style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}
        >
          PLATFORM IDENTITY
        </p>

        {/* Logo */}
        <div className="mb-6">
          <p className="text-xs mb-3" style={{ color: 'var(--ef-text-subtle)' }}>
            Platform logo
          </p>

          <div className="flex items-start gap-4">
            {/* Preview */}
            <div
              className="flex items-center justify-center flex-shrink-0"
              style={{
                width: 64,
                height: 64,
                border: '1px solid var(--ef-border)',
                borderRadius: 3,
                background: 'var(--ef-canvas-raised)',
              }}
            >
              {logoPreview ? (
                <img
                  src={logoPreview}
                  alt="Platform logo"
                  style={{ width: 40, height: 40, objectFit: 'contain' }}
                />
              ) : (
                <div style={{ color: 'var(--ef-border-muted)' }}>
                  {/* Default mark placeholder */}
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                    <rect x="1" y="1" width="10" height="10" fill="currentColor" />
                    <rect x="13" y="1" width="10" height="10" fill="currentColor" fillOpacity="0.38" />
                    <rect x="1" y="13" width="10" height="10" fill="currentColor" fillOpacity="0.18" />
                    <rect x="13" y="13" width="10" height="10" fill="currentColor" fillOpacity="0.65" />
                  </svg>
                </div>
              )}
            </div>

            {/* Controls */}
            <div className="flex flex-col gap-2 pt-1">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleLogoUpload}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-colors"
                style={{
                  border: '1px solid var(--ef-border)',
                  color: 'var(--ef-ink)',
                  background: 'var(--ef-surface)',
                  borderRadius: 2,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-ink)')
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-border)')
                }
              >
                <Upload size={11} strokeWidth={1.5} />
                Upload logo
              </button>
              {logoPreview && (
                <button
                  type="button"
                  onClick={handleRemoveLogo}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-colors"
                  style={{
                    border: '1px solid var(--ef-border)',
                    color: 'var(--ef-danger)',
                    background: 'var(--ef-surface)',
                    borderRadius: 2,
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) =>
                    ((e.currentTarget as HTMLElement).style.background = 'var(--ef-danger-bg)')
                  }
                  onMouseLeave={(e) =>
                    ((e.currentTarget as HTMLElement).style.background = 'var(--ef-surface)')
                  }
                >
                  <X size={11} strokeWidth={1.5} />
                  Remove
                </button>
              )}
              <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                PNG, SVG, or JPG. Reflects immediately.
              </p>
            </div>
          </div>
        </div>

        {/* Platform name */}
        <div className="mb-6">
          <label
            htmlFor="platform-name"
            className="block text-xs mb-2"
            style={{ color: 'var(--ef-text-subtle)' }}
          >
            Platform name
          </label>
          <input
            id="platform-name"
            type="text"
            value={platformName}
            onChange={(e) => setPlatformName(e.target.value)}
            placeholder="e.g. STRATUM"
            maxLength={32}
            className="w-full px-3.5 py-2.5 text-sm outline-none"
            style={{
              background: 'var(--ef-canvas-raised)',
              border: '1px solid var(--ef-border)',
              color: 'var(--ef-ink)',
              borderRadius: 2,
            }}
            onFocus={(e) => {
              e.target.style.borderColor = 'var(--ef-ink)';
              e.target.style.background = 'var(--ef-surface)';
            }}
            onBlur={(e) => {
              e.target.style.borderColor = 'var(--ef-border)';
              e.target.style.background = 'var(--ef-canvas-raised)';
            }}
          />
        </div>

        <button
          type="submit"
          disabled={saving || !platformName.trim()}
          className="flex items-center gap-2 px-5 py-2.5 text-xs transition-colors"
          style={{
            background: saving || !platformName.trim() ? 'var(--ef-track)' : 'var(--ef-ink)',
            color: 'var(--ef-surface)',
            borderRadius: 2,
            letterSpacing: '0.04em',
            cursor: saving || !platformName.trim() ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              Saving…
            </>
          ) : saved ? (
            <>
              <Check size={12} />
              Saved
            </>
          ) : (
            'Save changes'
          )}
        </button>
      </form>
    </motion.div>
  );
}
