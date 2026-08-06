/**
 * AudienceSelector — "who may see this" control for assessment visibility
 * settings (N5 final form). Used in the builder's Settings step and in the
 * post-publish Behaviour panel, replacing the old boolean toggles for
 * Show Results / Allow Review with per-audience checkboxes.
 *
 * Pure controlled component: value in, onChange out. The caller owns
 * persistence (including keeping the legacy showResults/allowReview booleans
 * synced to the 'students' entry for older code paths).
 */

import { Check } from 'lucide-react';
import type { VisibilityAudience } from '../../../lib/visibility';

const AUDIENCE_LABELS: Array<{ key: VisibilityAudience; label: string }> = [
  { key: 'students',  label: 'Students' },
  { key: 'institute', label: 'Institute admins' },
  { key: 'faculty',   label: 'Faculty' },
];

export function AudienceSelector({
  icon,
  label,
  hint,
  value,
  onChange,
  locked,
  lockReason,
}: {
  icon?: React.ReactNode;
  label: string;
  hint: string;
  value: VisibilityAudience[];
  onChange: (next: VisibilityAudience[]) => void;
  locked?: boolean;
  lockReason?: string;
}) {
  const toggle = (aud: VisibilityAudience) => {
    if (locked) return;
    onChange(value.includes(aud) ? value.filter((a) => a !== aud) : [...value, aud]);
  };

  return (
    <div
      className="px-3 py-2.5"
      style={{
        border: '1px solid var(--ef-border)', borderRadius: 2,
        background: locked ? 'var(--ef-canvas-raised)' : 'var(--ef-surface)',
        opacity: locked ? 0.7 : 1,
      }}
    >
      <div className="flex items-start gap-2">
        {icon}
        <div className="flex-1 min-w-0">
          <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>{label}</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>{hint}</p>
          {locked && lockReason && (
            <p className="text-xs mt-1" style={{ color: 'var(--ef-warning)' }}>{lockReason}</p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-2.5" style={{ paddingLeft: icon ? 20 : 0 }}>
        {AUDIENCE_LABELS.map(({ key, label: audLabel }) => {
          const active = value.includes(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggle(key)}
              disabled={locked}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 transition-colors"
              style={{
                border: `1px solid ${active ? 'var(--ef-ink)' : 'var(--ef-border)'}`,
                background: active ? 'var(--ef-ink)' : 'transparent',
                color: active ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
                borderRadius: 2,
                cursor: locked ? 'not-allowed' : 'pointer',
              }}
            >
              {active && <Check size={10} strokeWidth={2} />}
              {audLabel}
            </button>
          );
        })}
        {value.length === 0 && (
          <span className="text-xs" style={{ color: 'var(--ef-warning)' }}>No one — hidden from every audience</span>
        )}
      </div>
    </div>
  );
}