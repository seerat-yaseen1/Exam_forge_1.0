/**
 * ThemeMenu — the theme picker that lives in the header.
 *
 * The full gallery is on the Appearance page; this is the version for someone
 * who just walked from a bright room into a dark one. Two properties make it
 * worth having as well as the page:
 *
 *   • It never leaves the current screen, so a student judges a theme against
 *     the assessment list they were reading rather than against a preview.
 *   • Hovering a row applies it for real. Nothing is saved until the click, and
 *     leaving the menu puts back what was there — so trying all seventeen costs
 *     nothing and commits nothing.
 */

import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { Check, Monitor, Moon, Sliders, Sun } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useAppearance } from '../../context/AppearanceContext';
import {
  GROUP_LABELS,
  SYSTEM_CHOICE,
  THEMES,
  themesInGroup,
  type ThemeGroup,
} from '../../../lib/themes';
import { ThemeSwatch } from './ui';

const GROUPS: ThemeGroup[] = ['base', 'light', 'dark'];

export function ThemeMenu({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { choice, theme, setTheme, preview } = useAppearance();
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss on an outside click or on Escape. Both, because a menu that only
  // answers one of them is a menu a keyboard user cannot get out of.
  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Whatever happens — a click, Escape, an outside dismiss, this component
  // being unmounted by a route change — the previewed theme must not outlive
  // the menu. One cleanup covers every exit, which is the only way to be sure.
  useEffect(() => () => preview(null), [preview]);

  const pick = (id: string) => {
    setTheme(id);
    onClose();
  };

  return (
    <motion.div
      ref={ref}
      role="menu"
      aria-label="Theme"
      initial={{ opacity: 0, y: -6, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.985 }}
      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      className="ef-menu absolute right-0 top-full mt-2 z-50"
      style={{ width: 288 }}
    >
      <div
        className="flex items-center justify-between px-3.5 py-3"
        style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}
      >
        <span className="ef-eyebrow">Theme</span>
        <span style={{ fontSize: 11.5, color: 'var(--ef-text-muted)' }}>
          {choice === SYSTEM_CHOICE ? `System · ${theme.label}` : theme.label}
        </span>
      </div>

      <div style={{ maxHeight: 340, overflowY: 'auto', padding: 6 }}>
        {/* Follow the OS — first, and set apart, because it is a different
            KIND of answer from the seventeen below it: a rule rather than a
            colour. */}
        <ThemeRow
          id={SYSTEM_CHOICE}
          label="Match system"
          caption={`Currently ${THEMES[theme.id].mode}`}
          selected={choice === SYSTEM_CHOICE}
          icon={<Monitor size={15} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />}
          onPick={() => pick(SYSTEM_CHOICE)}
          onPreview={preview}
        />

        {GROUPS.map((group) => {
          const themes = themesInGroup(group).filter((t) => group !== 'base' || t.id !== SYSTEM_CHOICE);
          if (themes.length === 0) return null;
          return (
            <div key={group} className="mt-1.5">
              <p
                className="px-2.5 pt-2 pb-1.5 flex items-center gap-1.5"
                style={{ fontSize: 10.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ef-text-muted)' }}
              >
                {group === 'light' && <Sun size={10} strokeWidth={1.6} />}
                {group === 'dark' && <Moon size={10} strokeWidth={1.6} />}
                {GROUP_LABELS[group].title}
              </p>
              {themes.map((t) => (
                <ThemeRow
                  key={t.id}
                  id={t.id}
                  label={t.label}
                  caption={t.blurb}
                  selected={choice === t.id}
                  icon={<ThemeSwatch theme={t} size={22} />}
                  onPick={() => pick(t.id)}
                  onPreview={preview}
                />
              ))}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="ef-menu-item"
        style={{ borderTop: '1px solid var(--ef-border-subtle)' }}
        onClick={() => {
          onClose();
          navigate('/student/appearance');
        }}
      >
        <Sliders size={14} strokeWidth={1.5} />
        Appearance settings
      </button>
    </motion.div>
  );
}

function ThemeRow({
  id,
  label,
  caption,
  selected,
  icon,
  onPick,
  onPreview,
}: {
  id: string;
  label: string;
  caption: string;
  selected: boolean;
  icon: React.ReactNode;
  onPick: () => void;
  onPreview: (id: string | null) => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onPick}
      onMouseEnter={() => onPreview(id)}
      onMouseLeave={() => onPreview(null)}
      // Keyboard users get the same preview: arrowing through the menu moves
      // focus, and a preview that only answers the mouse would make this a
      // worse control for them than for anybody else.
      onFocus={() => onPreview(id)}
      onBlur={() => onPreview(null)}
      className="ef-menu-item"
      style={{ borderRadius: 'var(--ef-radius-sm)', gap: 10 }}
    >
      <span style={{ display: 'flex', flexShrink: 0 }}>{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block truncate" style={{ color: 'var(--ef-ink)', fontSize: 12.5 }}>
          {label}
        </span>
        <span className="block truncate" style={{ color: 'var(--ef-text-muted)', fontSize: 11 }}>
          {caption}
        </span>
      </span>
      {selected && <Check size={14} strokeWidth={2} style={{ color: 'var(--ef-accent)', flexShrink: 0 }} />}
    </button>
  );
}
