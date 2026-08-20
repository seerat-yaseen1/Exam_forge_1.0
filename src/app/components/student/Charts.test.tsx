/**
 * The trend chart, rendered.
 *
 * studentProgress.test.ts proves the right sittings reach the chart. This
 * proves the chart draws them, and draws them to the specs the Progress page
 * depends on — a marker per sitting, a line rather than a scatter, labels on
 * the endpoint and the extreme rather than on every point, and an axis that is
 * always 0–100 so three marks a point apart do not look like a cliff.
 *
 * jsdom reports `clientWidth` as 0 for everything, and the chart declines to
 * draw at zero width (correctly — the alternative is an SVG of NaNs). The
 * measurement is stubbed here, which is also the only thing standing between
 * these components and a browser.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TrendPoint } from '../../../lib/studentProgress';
import { SubjectBars, TrendChart } from './Charts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WIDTH = 620;
let originalClientWidth: PropertyDescriptor | undefined;

beforeAll(() => {
  originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => WIDTH });
  // The hook prefers ResizeObserver and falls back to a resize listener; jsdom
  // has neither, and the fallback path is the one that works here.
  // @ts-expect-error — deliberately removing it to take the fallback.
  delete globalThis.ResizeObserver;
});

afterAll(() => {
  if (originalClientWidth) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
  }
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(node: React.ReactElement): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(node); });
  return host;
}

function point(i: number, percentage: number, title = `Paper ${i}`): TrendPoint {
  const iso = `2026-0${(i % 9) + 1}-01T09:00:00.000Z`;
  return {
    assessmentId: `a${i}`,
    attemptId: `at${i}`,
    title,
    subject: 'Physics',
    percentage,
    passed: percentage >= 40,
    at: Date.parse(iso),
    atIso: iso,
  };
}

// ══════════════════════════════════════════════════════════════════

describe('TrendChart', () => {
  it('draws one line and one marker per sitting', () => {
    const el = render(<TrendChart points={[point(1, 40), point(2, 65), point(3, 82)]} />);
    // Two paths: the area wash and the line over it.
    expect(el.querySelectorAll('svg path')).toHaveLength(2);
    expect(el.querySelectorAll('svg circle')).toHaveLength(3);
  });

  it('uses the mark specs the dataviz rules fix — 2px line, ringed markers', () => {
    const el = render(<TrendChart points={[point(1, 40), point(2, 65)]} />);
    const line = el.querySelectorAll('svg path')[1];
    expect(line.getAttribute('stroke-width')).toBe('2');
    expect(line.getAttribute('stroke-linecap')).toBe('round');

    const marker = el.querySelector('svg circle')!;
    // The 2px ring in the surface colour is what keeps a marker legible where
    // it crosses the line it sits on.
    expect(marker.getAttribute('stroke-width')).toBe('2');
    expect((marker as SVGElement).style.stroke).toBe('var(--ef-surface)');
  });

  it('scales to a fixed 0–100 axis, never to the data', () => {
    // Three marks one point apart must not fill the plot.
    const el = render(<TrendChart points={[point(1, 71), point(2, 72), point(3, 73)]} />);
    const ys = [...el.querySelectorAll('svg circle')].map((c) => Number(c.getAttribute('cy')));
    const spread = Math.max(...ys) - Math.min(...ys);
    expect(spread).toBeLessThan(6);
    // …and the axis still carries its full range.
    expect(el.textContent).toContain('100');
    expect(el.textContent).toContain('0');
  });

  it('labels the endpoint and the extreme, and nothing else', () => {
    const el = render(<TrendChart points={[point(1, 30), point(2, 95), point(3, 60)]} />);
    const labels = [...el.querySelectorAll('svg text')]
      .map((t) => t.textContent ?? '')
      .filter((t) => t.endsWith('%'));
    // The high one and the last one — not the 30 in between.
    expect(labels).toEqual(expect.arrayContaining(['95%', '60%']));
    expect(labels).not.toContain('30%');
  });

  it('does not repeat the endpoint label when the endpoint IS the extreme', () => {
    const el = render(<TrendChart points={[point(1, 30), point(2, 88)]} />);
    const labels = [...el.querySelectorAll('svg text')]
      .map((t) => t.textContent ?? '')
      .filter((t) => t === '88%');
    expect(labels).toHaveLength(1);
  });

  it('draws the pass mark only when one was supplied', () => {
    expect(render(<TrendChart points={[point(1, 55)]} passMark={40} />).textContent).toContain('pass 40%');
    act(() => root!.unmount());
    root = null;
    host!.remove();
    expect(render(<TrendChart points={[point(1, 55)]} passMark={null} />).textContent).not.toContain('pass');
  });

  it('gives every point a hit target far larger than its marker', () => {
    const el = render(<TrendChart points={[point(1, 40), point(2, 65), point(3, 82)]} />);
    const targets = [...el.querySelectorAll('svg rect')];
    expect(targets).toHaveLength(3);
    for (const t of targets) {
      // A 4px dot is not a pointer target; the column is.
      expect(Number(t.getAttribute('width'))).toBeGreaterThanOrEqual(24);
    }
  });

  it('names each sitting for a screen reader rather than leaving it to the hover', () => {
    const el = render(<TrendChart points={[point(1, 61, 'Thermodynamics')]} />);
    const target = el.querySelector('svg rect')!;
    expect(target.getAttribute('aria-label')).toContain('Thermodynamics');
    expect(target.getAttribute('aria-label')).toContain('61 percent');
    expect(el.querySelector('svg')!.getAttribute('aria-label')).toContain('1 sittings');
  });

  it('renders nothing at all rather than an empty frame when there is no data', () => {
    const el = render(<TrendChart points={[]} />);
    expect(el.querySelector('svg')).toBeNull();
  });
});

describe('SubjectBars', () => {
  const stats = [
    { subject: 'Mathematics', average: 88, papers: 3, best: 95, worst: 80 },
    { subject: 'Physics', average: 61.5, papers: 2, best: 70, worst: 53 },
  ];

  it('shows the average, the paper count and a bar for each subject', () => {
    const el = render(<SubjectBars stats={stats} />);
    expect(el.textContent).toContain('Mathematics');
    expect(el.textContent).toContain('88%');
    expect(el.textContent).toContain('3 papers');
    expect(el.textContent).toContain('61.5%');
    expect(el.textContent).toContain('2 papers');
  });

  it('paints every bar in one colour rather than ramping by value', () => {
    // A value-ramp would double-encode bar length as hue, spending the only
    // free channel on information the length already carries.
    const el = render(<SubjectBars stats={stats} />);
    const fills = [...el.querySelectorAll<HTMLElement>('div[style*="--ef-accent"]')];
    expect(fills.length).toBe(2);
    for (const f of fills) expect(f.style.background).toBe('var(--ef-accent)');
  });

  it('keeps a zero-ish average visible instead of collapsing the bar to nothing', () => {
    const el = render(<SubjectBars stats={[{ subject: 'Latin', average: 0, papers: 1, best: 0, worst: 0 }]} />);
    const fill = el.querySelector<HTMLElement>('div[style*="--ef-accent"]')!;
    expect(parseFloat(fill.style.width)).toBeGreaterThan(0);
  });
});
