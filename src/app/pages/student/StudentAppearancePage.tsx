/**
 * Appearance — where a student chooses how their account looks.
 *
 * ── THE PAGE IS THE PREVIEW ───────────────────────────────────────
 * Picking a theme applies it immediately to everything, including this page.
 * There is no Save button and no "apply" step, for the same reason a paint
 * shop hands you the tin rather than a photograph of the tin: the only honest
 * preview of a theme is the interface you actually use, at the size you
 * actually use it.
 *
 * The specimen panel below the gallery exists anyway, and does a different
 * job — it puts the pieces a theme is easy to get wrong (a primary button, a
 * danger chip, a muted timestamp, a disabled control) side by side, where the
 * page around it would only show them one at a time.
 *
 * ── WHAT IT DOES NOT OFFER ────────────────────────────────────────
 * A custom colour picker. A fixed catalog whose every palette was checked for
 * contrast (themes.test.ts asserts each one clears WCAG AA on body text,
 * secondary text, accents and status tints) beats an infinite space in which a
 * student can, in about four seconds, make their own exam results unreadable.
 */

import { useState } from 'react';
import {
  Check, Info, Monitor, Moon, RotateCcw, Sun, Zap, Rows3, AlertTriangle,
  Sparkles, Cloud, CloudOff,
} from 'lucide-react';
import { useAppearance } from '../../context/AppearanceContext';
import {
  GROUP_LABELS,
  SYSTEM_CHOICE,
  THEME_LIST,
  themesInGroup,
  type Theme,
  type ThemeGroup,
} from '../../../lib/themes';
import {
  Button, Card, Chip, Meter, PageHeader, PageShell, SectionHeading, ThemeSwatch,
} from '../../components/student/ui';

// ── Segmented control ─────────────────────────────────────────────

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: React.ReactNode; hint?: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex p-1"
      style={{
        background: 'var(--ef-canvas-raised)',
        border: '1px solid var(--ef-border)',
        borderRadius: 'var(--ef-radius-sm)',
        gap: 2,
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.hint}
            onClick={() => onChange(o.value)}
            className="flex items-center gap-1.5"
            style={{
              padding: '6px 12px',
              borderRadius: 'calc(var(--ef-radius-sm) - 2px)',
              border: 0,
              cursor: 'pointer',
              fontSize: 12.5,
              background: active ? 'var(--ef-surface)' : 'transparent',
              color: active ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
              boxShadow: active ? 'var(--ef-shadow-sm)' : 'none',
              transition: 'background-color 160ms ease, color 160ms ease',
            }}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── One theme in the gallery ──────────────────────────────────────

function ThemeTile({
  theme,
  selected,
  onSelect,
  onPreview,
}: {
  theme: Theme;
  selected: boolean;
  onSelect: () => void;
  onPreview: (id: string | null) => void;
}) {
  return (
    <button
      type="button"
      className="ef-theme-tile"
      style={{ alignItems: 'flex-start' }}
      aria-pressed={selected}
      onClick={onSelect}
      onMouseEnter={() => onPreview(theme.id)}
      onMouseLeave={() => onPreview(null)}
      onFocus={() => onPreview(theme.id)}
      onBlur={() => onPreview(null)}
    >
      <ThemeSwatch theme={theme} size={44} />
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="truncate" style={{ fontSize: 13, color: 'var(--ef-ink)', fontWeight: 500 }}>
            {theme.label}
          </span>
          {theme.mode === 'dark'
            ? <Moon size={10} strokeWidth={1.8} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
            : <Sun size={10} strokeWidth={1.8} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />}
        </span>
        <span
          className="block mt-0.5"
          style={{
            fontSize: 11.5,
            color: 'var(--ef-text-muted)',
            lineHeight: 1.4,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {theme.blurb}
        </span>
      </span>
      {selected && (
        <span
          className="flex items-center justify-center flex-shrink-0"
          style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--ef-accent)' }}
        >
          <Check size={12} strokeWidth={2.5} style={{ color: 'var(--ef-accent-text)' }} />
        </span>
      )}
    </button>
  );
}

// ── The specimen panel ────────────────────────────────────────────

function Specimen() {
  return (
    <Card padded={false} style={{ overflow: 'hidden' }}>
      {/* A miniature of the console's own chrome. */}
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: '1px solid var(--ef-border-subtle)', background: 'var(--ef-surface)' }}
      >
        <span className="flex items-center gap-2">
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--ef-accent)' }} />
          <span style={{ fontSize: 11, letterSpacing: '0.14em', color: 'var(--ef-ink)', fontWeight: 600 }}>
            SPECIMEN
          </span>
        </span>
        <span style={{ fontSize: 11, color: 'var(--ef-text-muted)' }}>every piece, at once</span>
      </div>

      <div style={{ background: 'var(--ef-canvas)', padding: 'var(--ef-pad-card)' }}>
        <div className="flex flex-col" style={{ gap: 14 }}>
          <Card>
            <p className="ef-display" style={{ fontSize: 17, color: 'var(--ef-ink)' }}>
              Statistics · Paper 2
            </p>
            <p className="mt-1.5" style={{ fontSize: 12, color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
              Secondary text carries most of this interface — timestamps, labels, the quiet
              half of every row. It is the first thing a palette gets wrong.
            </p>

            <div className="flex items-center gap-1.5 flex-wrap mt-3">
              <Chip tone="success" icon={<Check size={9} strokeWidth={2} />}>Passed</Chip>
              <Chip tone="warning" icon={<AlertTriangle size={9} strokeWidth={1.8} />}>Awaiting marking</Chip>
              <Chip tone="danger">Terminated</Chip>
              <Chip tone="info">Semester 4</Chip>
              <Chip>Practice</Chip>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between mb-1.5">
                <span style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ef-text-muted)' }}>
                  Progress
                </span>
                <span className="ef-display" style={{ fontSize: 14, color: 'var(--ef-ink)' }}>72%</span>
              </div>
              <Meter value={72} />
            </div>

            <div className="flex items-center gap-2 flex-wrap mt-4">
              <Button variant="primary" size="sm">Begin</Button>
              <Button size="sm">Review</Button>
              <Button variant="ghost" size="sm">Later</Button>
              <Button size="sm" disabled>Locked</Button>
            </div>
          </Card>

          <div
            className="flex items-start gap-2.5 px-3.5 py-3"
            style={{
              background: 'var(--ef-danger-bg)',
              border: '1px solid var(--ef-danger-border)',
              borderRadius: 'var(--ef-radius-sm)',
            }}
          >
            <AlertTriangle size={13} strokeWidth={1.6} style={{ color: 'var(--ef-danger)', flexShrink: 0, marginTop: 1 }} />
            <p style={{ fontSize: 12, color: 'var(--ef-danger)', lineHeight: 1.55 }}>
              Warnings have to stay legible in every theme — this banner is checked against each
              palette's own surface, not against white.
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// PAGE
// ══════════════════════════════════════════════════════════════════

const GROUPS: ThemeGroup[] = ['base', 'light', 'dark'];

export function StudentAppearancePage() {
  const {
    choice, theme, motion, density, syncing,
    setTheme, setMotion, setDensity, reset, preview,
  } = useAppearance();

  // Purely informational: it says whether the choice made here will follow the
  // student to another device, which is the one thing about a preference page
  // people are actually unsure of.
  const [showSyncNote, setShowSyncNote] = useState(false);

  const isDefault = choice === SYSTEM_CHOICE && motion === 'system' && density === 'comfortable';

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Appearance
          </>
        }
        title="Make it yours."
        subtitle={
          <>
            {THEME_LIST.length} palettes, applied the moment you pick one. Your choice is saved to
            your account, so it follows you to any device you sign in on.
          </>
        }
        actions={
          <Button size="sm" onClick={reset} disabled={isDefault} title="Back to the platform default">
            <RotateCcw size={11} strokeWidth={1.6} />
            Reset
          </Button>
        }
      >
        <div className="flex items-center gap-2 flex-wrap">
          <Chip tone="accent" icon={<Sparkles size={10} strokeWidth={1.8} />}>
            {choice === SYSTEM_CHOICE ? `Matching system · ${theme.label}` : theme.label}
          </Chip>
          <button
            type="button"
            className="ef-chip"
            onClick={() => setShowSyncNote((v) => !v)}
            style={{ cursor: 'pointer' }}
            aria-expanded={showSyncNote}
          >
            {syncing
              ? <><Cloud size={10} strokeWidth={1.8} /> Syncing…</>
              : <><Cloud size={10} strokeWidth={1.8} /> Saved to your account</>}
          </button>
        </div>
        {showSyncNote && (
          <div
            className="flex items-start gap-2.5 mt-3 px-3.5 py-3"
            style={{
              background: 'var(--ef-canvas-raised)',
              border: '1px solid var(--ef-border)',
              borderRadius: 'var(--ef-radius-sm)',
            }}
          >
            <Info size={13} strokeWidth={1.6} style={{ color: 'var(--ef-text-muted)', flexShrink: 0, marginTop: 1 }} />
            <p style={{ fontSize: 12, color: 'var(--ef-text-muted)', lineHeight: 1.65 }}>
              Your choice is stored on this device and against your account. Signing in somewhere
              else brings it with you; the local copy is what makes the theme correct on the very
              first frame after a refresh, before the account has finished loading. Nobody else can
              change it — not your institute, not your examiner.
              {' '}
              <strong style={{ color: 'var(--ef-text-subtle)', fontWeight: 500 }}>
                Exams are the one exception:
              </strong>{' '}
              the exam shell always renders in the platform's standard palette, so that what an
              invigilator sees over your shoulder is what they expect to see.
            </p>
          </div>
        )}
      </PageHeader>

      <div className="flex flex-col" style={{ gap: 32 }}>
        {/* ── Gallery ── */}
        {GROUPS.map((group) => {
          const themes = themesInGroup(group);
          if (themes.length === 0) return null;
          return (
            <section key={group}>
              <SectionHeading label={GROUP_LABELS[group].title} count={group === 'base' ? undefined : themes.length} />
              <p className="-mt-2 mb-3.5" style={{ fontSize: 12, color: 'var(--ef-text-muted)' }}>
                {GROUP_LABELS[group].caption}
              </p>

              <div
                className="grid gap-2.5"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
              >
                {/* Follow-the-OS sits with the base themes, because that is
                    what it resolves to — but it is a rule rather than a
                    palette, so it gets its own tile shape. */}
                {group === 'base' && (
                  <button
                    type="button"
                    className="ef-theme-tile"
                    style={{ alignItems: 'flex-start' }}
                    aria-pressed={choice === SYSTEM_CHOICE}
                    onClick={() => setTheme(SYSTEM_CHOICE)}
                  >
                    <span
                      className="ef-swatch flex items-center justify-center"
                      style={{ width: 44, height: 44, background: 'var(--ef-canvas-raised)' }}
                    >
                      <Monitor size={18} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block truncate" style={{ fontSize: 13, color: 'var(--ef-ink)', fontWeight: 500 }}>
                        Match system
                      </span>
                      <span className="block mt-0.5" style={{ fontSize: 11.5, color: 'var(--ef-text-muted)', lineHeight: 1.4 }}>
                        Follows your device, light or dark.
                      </span>
                    </span>
                    {choice === SYSTEM_CHOICE && (
                      <span
                        className="flex items-center justify-center flex-shrink-0"
                        style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--ef-accent)' }}
                      >
                        <Check size={12} strokeWidth={2.5} style={{ color: 'var(--ef-accent-text)' }} />
                      </span>
                    )}
                  </button>
                )}

                {themes.map((t) => (
                  <ThemeTile
                    key={t.id}
                    theme={t}
                    selected={choice === t.id}
                    onSelect={() => setTheme(t.id)}
                    onPreview={preview}
                  />
                ))}
              </div>
            </section>
          );
        })}

        {/* ── Specimen ── */}
        <section>
          <SectionHeading label="How it looks" />
          <p className="-mt-2 mb-3.5" style={{ fontSize: 12, color: 'var(--ef-text-muted)' }}>
            Hover any theme above to try it here — and everywhere else on the page. Nothing is
            saved until you click.
          </p>
          <Specimen />
        </section>

        {/* ── Comfort ── */}
        <section>
          <SectionHeading label="Comfort" />
          <Card>
            <div className="flex flex-col" style={{ gap: 22 }}>
              <div className="flex items-start justify-between gap-6 flex-wrap">
                <div style={{ maxWidth: '46ch' }}>
                  <p className="flex items-center gap-2" style={{ fontSize: 13, color: 'var(--ef-ink)', fontWeight: 500 }}>
                    <Rows3 size={13} strokeWidth={1.7} style={{ color: 'var(--ef-text-muted)' }} />
                    Density
                  </p>
                  <p className="mt-1.5" style={{ fontSize: 12, color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                    Compact tightens the space around and inside cards so more of a long list fits on
                    screen. Text size is not affected — less scrolling should not cost legibility.
                  </p>
                </div>
                <Segmented
                  label="Density"
                  value={density}
                  onChange={setDensity}
                  options={[
                    { value: 'comfortable', label: 'Comfortable' },
                    { value: 'compact', label: 'Compact' },
                  ]}
                />
              </div>

              <div style={{ borderTop: '1px solid var(--ef-border-subtle)' }} />

              <div className="flex items-start justify-between gap-6 flex-wrap">
                <div style={{ maxWidth: '46ch' }}>
                  <p className="flex items-center gap-2" style={{ fontSize: 13, color: 'var(--ef-ink)', fontWeight: 500 }}>
                    <Zap size={13} strokeWidth={1.7} style={{ color: 'var(--ef-text-muted)' }} />
                    Motion
                  </p>
                  <p className="mt-1.5" style={{ fontSize: 12, color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                    Cards fade and slide in as they arrive. <em>Match system</em> already honours a
                    reduced-motion setting on your device; choose <em>Reduced</em> to switch the
                    animation off for this account only — useful on a shared machine.
                  </p>
                </div>
                <Segmented
                  label="Motion"
                  value={motion}
                  onChange={setMotion}
                  options={[
                    { value: 'system', label: 'Match system', icon: <Monitor size={12} strokeWidth={1.7} /> },
                    { value: 'reduced', label: 'Reduced' },
                  ]}
                />
              </div>
            </div>
          </Card>
        </section>

        <p
          className="flex items-start gap-2"
          style={{ fontSize: 11.5, color: 'var(--ef-text-muted)', lineHeight: 1.7 }}
        >
          <CloudOff size={12} strokeWidth={1.6} style={{ flexShrink: 0, marginTop: 3 }} />
          If your connection drops, the theme still applies — it is remembered on this device too, and
          the account copy catches up the next time you are online.
        </p>
      </div>
    </PageShell>
  );
}
