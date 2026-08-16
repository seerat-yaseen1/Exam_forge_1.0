/**
 * A choice between a handful of options, each of which deserves a sentence.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────
 * The builder's two most consequential decisions — the security tier and the
 * delivery mode — were three-segment button groups with a single line of grey
 * text underneath that changed as you clicked. To compare "Normal" against
 * "High-stake" an author had to click one, read the line, click the other,
 * read that line, and hold both in their head. Nothing showed what the choice
 * actually bought them, so in practice nobody moved off the default.
 *
 * That is an expensive failure. The tier decides whether a paper is proctored
 * at all; the delivery mode decides whether a student can go back to a
 * question. Both are real capabilities the product already has, and both were
 * presented as though they were a font setting.
 *
 * Cards show every option at once with its consequences spelled out, so the
 * comparison happens by reading rather than by clicking. `points` is the part
 * that does the work: two or three concrete facts per option, not adjectives.
 *
 * ── WHY NOT A DROPDOWN ────────────────────────────────────────────
 * A select hides the alternatives behind an interaction, which is exactly the
 * failure being fixed. These sets are small and closed; they can afford the
 * space, and the space is what makes them legible.
 */

import { Check, Lock } from 'lucide-react';

export type CapabilityOption<T extends string> = {
  value: T;
  label: string;
  /** One line. What this option IS. */
  summary: string;
  /** Two or three concrete consequences. Facts, not adjectives. */
  points?: string[];
  /** Set when the option cannot be picked right now, and why. */
  disabledReason?: string;
};

export function CapabilityChoice<T extends string>({
  label,
  value,
  options,
  onChange,
  locked,
  lockReason,
}: {
  label: string;
  value: T;
  options: readonly CapabilityOption<T>[];
  onChange: (v: T) => void;
  /** The whole control is read-only — a published exam, usually. */
  locked?: boolean;
  lockReason?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{label}</p>
        {locked && lockReason && (
          <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
            <Lock size={9} strokeWidth={1.5} /> {lockReason}
          </span>
        )}
      </div>

      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((opt) => {
          const selected = opt.value === value;
          const unavailable = locked || !!opt.disabledReason;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={unavailable && !selected}
              onClick={() => !unavailable && onChange(opt.value)}
              className="flex flex-col items-start gap-1.5 px-3.5 py-3 text-left transition-colors"
              style={{
                // The selected card is outlined, not filled. A filled card
                // would win the page against the fields beside it, and this is
                // a setting rather than the subject of the screen.
                border: selected ? '1.5px solid var(--ef-ink)' : '1px solid var(--ef-border)',
                background: selected ? 'var(--ef-canvas-raised)' : 'var(--ef-surface)',
                borderRadius: 3,
                cursor: unavailable && !selected ? 'not-allowed' : 'pointer',
                opacity: unavailable && !selected ? 0.5 : 1,
                minHeight: 0,
              }}
            >
              <div className="flex items-center gap-1.5 w-full">
                <span className="text-xs flex-1" style={{ color: 'var(--ef-ink)', fontWeight: selected ? 500 : 400 }}>
                  {opt.label}
                </span>
                {selected && <Check size={11} strokeWidth={2} style={{ color: 'var(--ef-ink)', flexShrink: 0 }} />}
              </div>

              <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.55 }}>
                {opt.summary}
              </p>

              {opt.points && opt.points.length > 0 && (
                <ul className="space-y-0.5 mt-0.5">
                  {opt.points.map((pt) => (
                    <li key={pt} className="flex items-start gap-1.5 text-xs"
                      style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
                      <span style={{ color: 'var(--ef-border-muted)', flexShrink: 0 }}>·</span>
                      <span>{pt}</span>
                    </li>
                  ))}
                </ul>
              )}

              {opt.disabledReason && !selected && (
                <p className="text-xs mt-0.5" style={{ color: 'var(--ef-warning)', lineHeight: 1.5 }}>
                  {opt.disabledReason}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
