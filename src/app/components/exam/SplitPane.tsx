/**
 * SPLIT PANE — two things a candidate needs at once, side by side
 *
 * Used by two surfaces that had the same problem for the same reason:
 *
 *   • a GROUPED SET, where the stimulus (a chart, a passage, a caselet) is
 *     read repeatedly while the questions under it change;
 *   • a CODING question, where the input format, the output format and the
 *     worked example are re-read continuously while the program is written.
 *
 * Both were stacked in one scroller once, and both cost the candidate the same
 * thing: scrolling the reference material back into view, over and over, and
 * losing their place each time. The panes scroll INDEPENDENTLY, which is the
 * whole point of the arrangement.
 *
 * Grouped sets already had a split at a fixed 44%. This replaces it rather
 * than sitting beside it — two side-by-side layouts in one exam that behave
 * differently (one draggable, one not) is a difference a candidate has to
 * learn mid-paper for no reason, and it is two places to fix anything wrong
 * with either.
 *
 * ── WHY THE DRAG IS CLAMPED ───────────────────────────────────────
 *
 * An unclamped divider can be dragged to zero. In an exam that is not an
 * inconvenience — it is a candidate who can no longer see the question, or no
 * longer reach the editor, with a clock running and no obvious way back.
 * MIN_PCT and MAX_PCT are not aesthetic; they are the guarantee that every
 * drag leaves both halves usable. Double-clicking the divider restores the
 * default, for the candidate who has already made a mess of it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export const DEFAULT_LEFT_PCT = 44;
export const MIN_PCT = 25;
export const MAX_PCT = 75;

/** Keep a split usable whatever the pointer did. Exported for the suite. */
export function clampSplit(pct: number, min = MIN_PCT, max = MAX_PCT): number {
  if (!Number.isFinite(pct)) return DEFAULT_LEFT_PCT;
  return Math.min(max, Math.max(min, pct));
}

/**
 * Read a remembered split, falling back rather than throwing.
 *
 * Storage can be unavailable — Safari private mode, and a kiosk browser is
 * entitled to restrict it. A layout preference is never worth an exception on
 * the path that renders a question, so every failure here resolves to the
 * default.
 */
export function readStoredPct(key: string | undefined, fallback = DEFAULT_LEFT_PCT): number {
  if (!key) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? clampSplit(n) : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredPct(key: string | undefined, pct: number): void {
  if (!key) return;
  try {
    window.localStorage.setItem(key, String(Math.round(pct)));
  } catch {
    // Preference lost, exam unaffected. Never surfaced.
  }
}

export function SplitPane({
  left,
  right,
  storageKey,
  defaultLeftPct = DEFAULT_LEFT_PCT,
  leftLabel = 'Question',
  rightLabel = 'Answer',
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  /** Where to remember the divider. Omitted means do not remember it. */
  storageKey?: string;
  defaultLeftPct?: number;
  /** For the separator's accessible name — a screen reader needs to know what moves. */
  leftLabel?: string;
  rightLabel?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [pct, setPct] = useState(() => readStoredPct(storageKey, defaultLeftPct));
  const [dragging, setDragging] = useState(false);

  // A different question may have a different remembered split.
  useEffect(() => {
    setPct(readStoredPct(storageKey, defaultLeftPct));
  }, [storageKey, defaultLeftPct]);

  const pctFromClientX = useCallback((clientX: number): number | null => {
    const host = hostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return clampSplit(((clientX - rect.left) / rect.width) * 100);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Pointer CAPTURE, not a window listener. The right pane contains a
    // CodeMirror instance with its own pointer handling, and without capture a
    // drag that crosses into it is swallowed by the editor — the divider
    // sticks halfway and the candidate is left fighting the UI.
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const next = pctFromClientX(e.clientX);
    if (next !== null) setPct(next);
  }, [dragging, pctFromClientX]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    writeStoredPct(storageKey, pct);
  }, [dragging, pct, storageKey]);

  const reset = useCallback(() => {
    setPct(defaultLeftPct);
    writeStoredPct(storageKey, defaultLeftPct);
  }, [defaultLeftPct, storageKey]);

  // Keyboard. A divider that only responds to a mouse is a divider a candidate
  // using a keyboard cannot move, on the one control that decides how much of
  // their own answer they can see.
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === 'ArrowLeft')  next = clampSplit(pct - 2);
    if (e.key === 'ArrowRight') next = clampSplit(pct + 2);
    if (e.key === 'Home')       next = defaultLeftPct;
    if (next === null) return;
    e.preventDefault();
    setPct(next);
    writeStoredPct(storageKey, next);
  }, [pct, defaultLeftPct, storageKey]);

  return (
    <div
      ref={hostRef}
      className="flex h-full"
      style={{
        minHeight: 0,
        // Both only while dragging. A permanent col-resize cursor over the
        // whole exam, or permanently unselectable text, would be worse than
        // the problem they solve.
        ...(dragging ? { userSelect: 'none' as const, cursor: 'col-resize' } : {}),
      }}
    >
      <div
        className="overflow-y-auto px-8 py-6"
        style={{
          flex: `0 0 ${pct}%`,
          minWidth: 0,
          background: 'var(--ef-canvas-raised)',
        }}
      >
        {left}
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${leftLabel} and ${rightLabel}`}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={MIN_PCT}
        aria-valuemax={MAX_PCT}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
        title="Drag to resize · double-click to reset"
        style={{
          // Narrow line, wider grab target. A 1px divider is correct visually
          // and nearly unhittable with a mouse.
          flex: '0 0 9px',
          margin: '0 -4px',
          zIndex: 1,
          cursor: 'col-resize',
          background: 'transparent',
          borderLeft: '4px solid transparent',
          borderRight: '4px solid transparent',
          backgroundClip: 'padding-box',
          borderImage: 'none',
          position: 'relative',
        }}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: '0 4px',
            background: dragging ? 'var(--ef-ink)' : 'var(--ef-border)',
          }}
        />
      </div>

      <div className="flex-1 overflow-y-auto" style={{ minWidth: 0 }}>
        {right}
      </div>
    </div>
  );
}
