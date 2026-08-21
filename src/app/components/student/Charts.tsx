/**
 * The two charts on the Progress page.
 *
 * ── WHY HAND-WRITTEN SVG ──────────────────────────────────────────
 * Both charts are one series over ≤ a few dozen points. A charting library
 * would add ~50KB to a student's bundle and then have to be fought to accept
 * the theme: every colour here is a CSS custom property, so a palette change
 * repaints the chart with no JavaScript running at all. That property is worth
 * more than the library's features, none of which these two forms need.
 *
 * ── THE SPECS THEY FOLLOW ─────────────────────────────────────────
 *   • one series → one colour, and no legend (the heading names it)
 *   • 2px line, round caps; markers ≥8px with a 2px surface ring
 *   • area fill is the same hue at ~10%, a wash rather than a block
 *   • gridlines are solid hairlines one step off the surface, never dashed
 *   • bars are capped at 22px, rounded at the data end, square at the baseline,
 *     all in one colour — a value-ramp would double-encode length as hue
 *   • labels are selective: the endpoint and the extreme, never every point
 *   • text wears text tokens; the mark beside it carries the colour
 *   • every value is also in the table view, so no number is behind a hover
 *
 * ── ONE AXIS, ALWAYS ──────────────────────────────────────────────
 * Both plot a percentage, fixed 0–100. A y-axis scaled to the data would make
 * a student who scored 71, 72, 73 look like they were climbing a cliff.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SubjectStat, TrendPoint } from '../../../lib/studentProgress';
import { formatDayMonth } from '../../../lib/dateFormat';

// ── Responsive width ──────────────────────────────────────────────

/**
 * The rendered width of an element, tracked.
 *
 * An SVG `viewBox` would scale to the container for free, and would scale the
 * TYPE with it — 11px axis labels become 8px on a phone and 15px on a wide
 * screen. Measuring instead keeps every text size the one that was chosen.
 */
function useMeasuredWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

// ══════════════════════════════════════════════════════════════════
// TREND
// ══════════════════════════════════════════════════════════════════

const PLOT_HEIGHT = 200;
const PAD = { top: 18, right: 20, bottom: 30, left: 34 };
const Y_TICKS = [0, 25, 50, 75, 100];

export function TrendChart({
  points,
  passMark,
}: {
  points: TrendPoint[];
  /** Drawn as a reference line when every paper in the set shares one. */
  passMark?: number | null;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = PLOT_HEIGHT - PAD.top - PAD.bottom;

  // x is the INDEX, not the date. Sittings are irregularly spaced in time and
  // a true time axis puts four papers from one week in a 3px huddle with two
  // months of white space beside it. The date is on the axis label and in the
  // tooltip, where it is read rather than measured.
  const xAt = useCallback(
    (i: number) => (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW),
    [points.length, innerW],
  );
  const yAt = useCallback((pct: number) => innerH - (pct / 100) * innerH, [innerH]);

  const path = useMemo(() => {
    if (points.length === 0 || innerW <= 0) return '';
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(2)},${yAt(p.percentage).toFixed(2)}`).join(' ');
  }, [points, xAt, yAt, innerW]);

  const areaPath = useMemo(() => {
    if (!path) return '';
    return `${path} L${xAt(points.length - 1).toFixed(2)},${innerH} L${xAt(0).toFixed(2)},${innerH} Z`;
  }, [path, xAt, points.length, innerH]);

  // Selective labels only: the last point, and the highest one when it is not
  // already the last. Everything else is on the axis and in the table.
  const bestIndex = useMemo(() => {
    let bi = 0;
    points.forEach((p, i) => { if (p.percentage > points[bi].percentage) bi = i; });
    return bi;
  }, [points]);

  if (points.length === 0) return null;

  const active = hover !== null ? points[hover] : null;

  return (
    <div ref={ref} style={{ width: '100%' }}>
      {width > 0 && (
        <svg
          width={width}
          height={PLOT_HEIGHT}
          role="img"
          aria-label={`Your marks across ${points.length} sittings, oldest to most recent. Latest ${points[points.length - 1].percentage} percent.`}
          style={{ display: 'block', overflow: 'visible' }}
          onMouseLeave={() => setHover(null)}
        >
          <g transform={`translate(${PAD.left},${PAD.top})`}>
            {/* Gridlines + y ticks. Solid hairlines, one step off the surface. */}
            {Y_TICKS.map((t) => (
              <g key={t}>
                <line
                  x1={0} x2={innerW} y1={yAt(t)} y2={yAt(t)}
                  strokeWidth={1} shapeRendering="crispEdges"
                  style={{ stroke: 'var(--ef-border-subtle)' }}
                />
                <text
                  x={-8} y={yAt(t)} dy="0.32em" textAnchor="end"
                  style={{ fontSize: 12, fill: 'var(--ef-text-muted)', fontVariantNumeric: 'tabular-nums' }}
                >
                  {t}
                </text>
              </g>
            ))}

            {/* The pass mark, when the set agrees on one. A second meaning for
                a line needs to look different from a gridline without becoming
                louder than the data — hence the same hairline in the warning
                hue rather than a dash. */}
            {passMark != null && passMark > 0 && passMark < 100 && (
              <>
                <line
                  x1={0} x2={innerW} y1={yAt(passMark)} y2={yAt(passMark)}
                  strokeWidth={1}
                  style={{ stroke: 'var(--ef-warning-border)' }}
                />
                <text
                  x={innerW} y={yAt(passMark) - 5} textAnchor="end"
                  style={{ fontSize: 11, fill: 'var(--ef-warning)' }}
                >
                  pass {passMark}%
                </text>
              </>
            )}

            <path d={areaPath} opacity={0.1} style={{ fill: 'var(--ef-accent)' }} />
            <path
              d={path}
              fill="none"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ stroke: 'var(--ef-accent)' }}
            />

            {points.map((p, i) => {
              const cx = xAt(i);
              const cy = yAt(p.percentage);
              const isActive = hover === i;
              return (
                <g key={p.attemptId}>
                  {/* The hit area is a full-height column, so a student never
                      has to land on a 4px dot — the nearest point wins. */}
                  <rect
                    x={cx - Math.max(12, innerW / (points.length * 2))}
                    y={0}
                    width={Math.max(24, innerW / points.length)}
                    height={innerH}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    tabIndex={0}
                    role="button"
                    aria-label={`${p.title}, ${p.percentage} percent, ${formatDayMonth(p.atIso)}`}
                    style={{ outline: 'none', cursor: 'default' }}
                  />
                  {isActive && (
                    <line
                      x1={cx} x2={cx} y1={0} y2={innerH} strokeWidth={1}
                      style={{ stroke: 'var(--ef-border-muted)' }}
                    />
                  )}
                  <circle
                    cx={cx} cy={cy}
                    r={isActive ? 5.5 : 4}
                    strokeWidth={2}
                    // Colour goes through `style`, not the presentation
                    // attributes: var() is reliably resolved in a CSS
                    // declaration and is not in every browser's parsing of
                    // fill="" / stroke="". The 2px ring is the surface colour
                    // so a marker stays legible where it crosses the line.
                    style={{ fill: 'var(--ef-accent)', stroke: 'var(--ef-surface)', pointerEvents: 'none' }}
                  />
                </g>
              );
            })}

            {/* Direct labels — the extreme and the endpoint, and only when they
                are far enough apart to not collide. */}
            {points.length > 1 && bestIndex !== points.length - 1 && (
              <text
                x={xAt(bestIndex)} y={yAt(points[bestIndex].percentage) - 11} textAnchor="middle"
                style={{ fontSize: 12, fill: 'var(--ef-text-muted)', fontVariantNumeric: 'tabular-nums' }}
              >
                {points[bestIndex].percentage}%
              </text>
            )}
            <text
              x={xAt(points.length - 1)}
              y={yAt(points[points.length - 1].percentage) - 11}
              textAnchor={points.length > 1 ? 'end' : 'middle'}
              style={{ fontSize: 12, fill: 'var(--ef-ink)', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}
            >
              {points[points.length - 1].percentage}%
            </text>

            {/* x labels: first and last only. Every sitting's date is in the
                table below, and a date under each of twenty points is a
                smudge. */}
            <text
              x={0} y={innerH + 18} textAnchor="start"
              style={{ fontSize: 12, fill: 'var(--ef-text-muted)' }}
            >
              {formatDayMonth(points[0].atIso)}
            </text>
            {points.length > 1 && (
              <text
                x={innerW} y={innerH + 18} textAnchor="end"
                style={{ fontSize: 12, fill: 'var(--ef-text-muted)' }}
              >
                {formatDayMonth(points[points.length - 1].atIso)}
              </text>
            )}
          </g>
        </svg>
      )}

      {/* The tooltip is HTML rather than SVG so it can wrap, use the type
          scale, and never be clipped by the plot's own box. */}
      <div style={{ minHeight: 44, marginTop: 8 }}>
        {active ? (
          <div
            className="flex items-center gap-2.5 px-3 py-2"
            style={{
              background: 'var(--ef-canvas-raised)',
              border: '1px solid var(--ef-border)',
              borderRadius: 'var(--ef-radius-sm)',
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--ef-accent)', flexShrink: 0 }} />
            <span className="truncate" style={{ fontSize: 13, color: 'var(--ef-ink)' }}>{active.title}</span>
            <span style={{ fontSize: 13, color: 'var(--ef-text-muted)' }}>{formatDayMonth(active.atIso)}</span>
            <span
              className="ml-auto"
              style={{ fontSize: 13, color: 'var(--ef-ink)', fontVariantNumeric: 'tabular-nums' }}
            >
              {active.percentage}%
            </span>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--ef-text-muted)' }}>
            Hover or tab through the line to see each sitting. Every mark is listed in the table below.
          </p>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SUBJECTS
// ══════════════════════════════════════════════════════════════════

/**
 * Horizontal bars, one colour.
 *
 * Horizontal because subject names are words: vertical columns would either
 * rotate the labels or truncate them, and a chart you have to tilt your head
 * to read has spent its whole budget on the axis.
 */
export function SubjectBars({ stats, passMark }: { stats: SubjectStat[]; passMark?: number | null }) {
  if (stats.length === 0) return null;

  return (
    <div className="flex flex-col" style={{ gap: 14 }}>
      {stats.map((s) => (
        <div key={s.subject}>
          <div className="flex items-baseline justify-between gap-3 mb-1.5">
            <span className="truncate" style={{ fontSize: 13, color: 'var(--ef-ink)' }}>
              {s.subject}
            </span>
            <span className="flex items-baseline gap-2 flex-shrink-0">
              <span style={{ fontSize: 12, color: 'var(--ef-text-muted)' }}>
                {s.papers} paper{s.papers !== 1 ? 's' : ''}
              </span>
              <span
                style={{ fontSize: 14, color: 'var(--ef-ink)', fontVariantNumeric: 'tabular-nums' }}
              >
                {s.average}%
              </span>
            </span>
          </div>

          {/* The track is the same shape as the fill so the remaining distance
              is legible, which is what makes this a meter rather than a bar
              floating in space. */}
          <div
            style={{
              position: 'relative',
              height: 10,
              borderRadius: 'var(--ef-radius-pill)',
              background: 'var(--ef-border-subtle)',
              overflow: 'hidden',
            }}
            title={`${s.subject}: average ${s.average}%, best ${s.best}%, lowest ${s.worst}%`}
          >
            <div
              style={{
                position: 'absolute',
                inset: '0 auto 0 0',
                width: `${Math.max(1.5, s.average)}%`,
                background: 'var(--ef-accent)',
                // Square where it meets the baseline, rounded at the data end.
                borderRadius: '0 4px 4px 0',
                transition: 'width 560ms cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            />
            {passMark != null && passMark > 0 && passMark < 100 && (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: `${passMark}%`,
                  top: 0,
                  bottom: 0,
                  width: 1,
                  background: 'var(--ef-warning)',
                  opacity: 0.75,
                }}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
