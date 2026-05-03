/**
 * SectionTimer
 *
 * Simple countdown timer for a section.
 * Remaining = timeLimitMinutes*60 - (elapsed since startedAt)
 * The timer always runs — freeze is purely an administrative flag
 * handled at the shell level and does NOT pause the clock.
 */

import { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';

// ── Helpers ───────────────────────────────────────────────────────

function calcSecondsLeft(timeLimitMinutes: number, startedAtISO: string): number {
  const now     = Date.now();
  const started = new Date(startedAtISO).getTime();
  const elapsed = (now - started) / 1000;
  return Math.max(0, Math.floor(timeLimitMinutes * 60 - elapsed));
}

function formatTime(totalSeconds: number): string {
  const h  = Math.floor(totalSeconds / 3600);
  const m  = Math.floor((totalSeconds % 3600) / 60);
  const s  = totalSeconds % 60;
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

// ── Component ─────────────────────────────────────────────────────

interface SectionTimerProps {
  timeLimitMinutes: number;
  startedAtISO: string;
  onExpire: () => void;
  onTick?: (secondsLeft: number) => void;
}

export function SectionTimer({
  timeLimitMinutes,
  startedAtISO,
  onExpire,
  onTick,
}: SectionTimerProps) {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    calcSecondsLeft(timeLimitMinutes, startedAtISO)
  );

  const expiredRef  = useRef(false);
  const onExpireRef = useRef(onExpire);
  const onTickRef   = useRef(onTick);

  useEffect(() => { onExpireRef.current = onExpire; }, [onExpire]);
  useEffect(() => { onTickRef.current   = onTick;   }, [onTick]);

  useEffect(() => {
    expiredRef.current = false;

    const tick = () => {
      const left = calcSecondsLeft(timeLimitMinutes, startedAtISO);
      setSecondsLeft(left);
      onTickRef.current?.(left);

      if (left <= 0 && !expiredRef.current) {
        expiredRef.current = true;
        onExpireRef.current();
      }
    };

    // Sync immediately then every second
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [timeLimitMinutes, startedAtISO]);

  // ── Colour logic ──────────────────────────────────────────────
  const totalSeconds = timeLimitMinutes * 60;
  const pct          = totalSeconds > 0 ? secondsLeft / totalSeconds : 0;
  const isUrgent     = pct < 0.2;
  const isCritical   = pct < 0.1;

  const color =
    isCritical ? '#9B2828' :
    isUrgent   ? '#92680A' :
                 '#1E7B3C';

  const bgColor =
    isCritical ? '#FDF5F5' :
    isUrgent   ? '#FEF9EC' :
                 '#F0F9F4';

  const borderColor =
    isCritical ? '#F2CECE' :
    isUrgent   ? '#F5DFA0' :
                 '#B8E6C8';

  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1.5 select-none"
      style={{
        background:   bgColor,
        border:       `1px solid ${borderColor}`,
        borderRadius: 2,
        transition:   'background 0.5s, border-color 0.5s',
      }}
    >
      <Clock
        size={12}
        strokeWidth={isCritical ? 2 : 1.5}
        style={{
          color,
          animation: isCritical ? 'pulse 1s ease-in-out infinite' : 'none',
        }}
      />
      <span
        className="text-xs tabular-nums"
        style={{
          color,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '0.04em',
        }}
      >
        {formatTime(secondsLeft)}
      </span>
    </div>
  );
}

// ── Pulse keyframe ────────────────────────────────────────────────
if (typeof document !== 'undefined') {
  const id = 'exam-timer-pulse';
  if (!document.getElementById(id)) {
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.4; }
      }
    `;
    document.head.appendChild(style);
  }
}
