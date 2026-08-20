import { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, ImageOff, Upload } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { usePlatformSettings } from '../context/PlatformSettingsContext';
import { LogoMark } from '../components/PlatformLogo';
import { AccountProfile } from '../components/console/account';
import { Button, Card, SectionHeading } from '../components/console/ui';
import { Field } from '../components/student/fields';

/**
 * The Web Owner's profile — and the platform's own identity.
 *
 * ── WHY THE TWO ARE ON ONE PAGE ───────────────────────────────────
 * They were already, and it is right: this is the only account that can
 * change the product's name and mark, so the person and the platform are the
 * same settings screen for exactly one user. Splitting them would create a
 * second page that only ever holds two fields.
 *
 * They are separated visibly instead. The account block is read-only facts;
 * branding is a form that changes what every other user sees. A change with
 * that reach should not look like the same kind of thing as your own email
 * address sitting there being unchangeable.
 */

export function ProfilePage() {
  const { user } = useAuth();
  const { platformSettings, updatePlatformSettings } = usePlatformSettings();

  const [name, setName] = useState(platformSettings.name);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const dirty = name.trim() !== platformSettings.name && name.trim().length > 0;

  const onPickLogo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      // Applied immediately rather than on a Save: the header updates as you
      // watch, which is the only honest preview of a logo — it is a 22px mark
      // in a bar, not the 200px file you selected.
      updatePlatformSettings({ logoUrl: ev.target?.result as string });
    };
    reader.readAsDataURL(file);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setSaving(true);
    await new Promise((r) => setTimeout(r, 400));
    updatePlatformSettings({ name: name.trim() });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  if (!user) return null;

  return (
    <AccountProfile
      name={user.name}
      role="Web owner"
      subtitle="You administer the platform itself."
      fields={[
        { label: 'Full name', value: user.name },
        { label: 'Email', value: user.email, mono: true },
        { label: 'Scope', value: 'Every institute on the platform' },
      ]}
      managedBy={
        <>
          Your name and email are fixed on this account. Everything below is the product's own
          identity, and changing it changes what every institute, faculty member and student sees.
        </>
      }
    >
      <section>
        <SectionHeading
          label="Platform identity"
          hint="Seen by everyone, everywhere in the product."
        />
        <Card>
          <form onSubmit={save} className="flex flex-col" style={{ gap: 22 }}>
            {/* ── The mark ── */}
            <div className="flex items-center gap-4 flex-wrap">
              <span
                className="flex items-center justify-center flex-shrink-0"
                style={{
                  width: 62,
                  height: 62,
                  borderRadius: 'var(--ef-radius)',
                  background: 'var(--ef-canvas-raised)',
                  border: '1px solid var(--ef-border)',
                  color: 'var(--ef-ink)',
                  overflow: 'hidden',
                }}
              >
                {platformSettings.logoUrl ? (
                  <img
                    src={platformSettings.logoUrl}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 8 }}
                  />
                ) : (
                  <LogoMark px={26} />
                )}
              </span>

              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <p className="ef-t-sm ef-ink" style={{ fontWeight: 500 }}>
                  Logo
                </p>
                <p className="ef-t-xs ef-muted" style={{ marginTop: 4, lineHeight: 'var(--ef-leading-relaxed)' }}>
                  Square, on a transparent background. It renders at 22px in the header, so anything
                  with fine detail will disappear.
                </p>
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <Button size="sm" onClick={() => fileInputRef.current?.click()}>
                    <Upload size={12} strokeWidth={1.7} />
                    {platformSettings.logoUrl ? 'Replace' : 'Upload'}
                  </Button>
                  {platformSettings.logoUrl && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => updatePlatformSettings({ logoUrl: null })}
                    >
                      <ImageOff size={12} strokeWidth={1.7} />
                      Remove
                    </Button>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onPickLogo}
                />
              </div>
            </div>

            <div style={{ borderTop: '1px solid var(--ef-border-subtle)' }} />

            {/* ── The name ── */}
            <div style={{ maxWidth: 380 }}>
              <Field
                label="Product name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving}
                placeholder="e.g. Stratum"
                hint="Appears in the header of every console and on every sign-in screen."
              />
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <Button type="submit" variant="primary" disabled={!dirty || saving} loading={saving}>
                {saving ? 'Saving…' : 'Save name'}
              </Button>

              <AnimatePresence>
                {saved && (
                  <motion.span
                    role="status"
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    className="ef-t-sm flex items-center gap-1.5"
                    style={{ color: 'var(--ef-success)' }}
                  >
                    <Check size={14} strokeWidth={2.2} />
                    Saved
                  </motion.span>
                )}
              </AnimatePresence>

              {dirty && !saving && !saved && (
                <span className="ef-t-xs ef-muted">Unsaved change</span>
              )}
            </div>
          </form>
        </Card>
      </section>
    </AccountProfile>
  );
}
