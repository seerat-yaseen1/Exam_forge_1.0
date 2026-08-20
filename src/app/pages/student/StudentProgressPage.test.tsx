/**
 * The Progress page, mounted.
 *
 * studentProgress.test.ts proves the arithmetic and the exclusions. This proves
 * the page states them — because the exclusions are only defensible if the
 * student is told about them. A page that silently drops a withheld paper from
 * an average looks identical to one that forgot it existed.
 *
 * The trend chart declines to draw at zero width and jsdom reports zero for
 * everything, so the chart's own rendering is covered in Charts.test.tsx. What
 * is checked here is the figures around it, and the table view — which is the
 * accessible twin every chart owes its reader, and which must therefore work
 * whether the chart drew or not.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import type { Assessment } from '../../../lib/assessmentService';
import type { Attempt, AttemptStatus } from '../../../lib/submissionService';

const getAssessmentsForStudent = vi.fn<() => Promise<Assessment[]>>(async () => []);
const getAttemptsByStudent = vi.fn<() => Promise<Attempt[]>>(async () => []);

vi.mock('../../../lib/assessmentService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAssessmentsForStudent: () => getAssessmentsForStudent(),
}));
vi.mock('../../../lib/submissionService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAttemptsByStudent: () => getAttemptsByStudent(),
}));
vi.mock('../../context/StudentAuthContext', () => ({
  useStudentAuth: () => ({
    session: { studentId: 's1', name: 'Priya Menon', email: 'priya@x.edu', instituteName: 'Northwind' },
    loading: false,
  }),
}));

const { StudentProgressPage } = await import('./StudentProgressPage');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Fixtures ──────────────────────────────────────────────────────

function assessment(over: Partial<Assessment> = {}): Assessment {
  return {
    id: 'a1',
    title: 'Thermodynamics',
    subject: 'Physics',
    totalMarks: 100,
    passingScore: 40,
    showResults: true,
    allowReview: true,
    questions: [],
    ...over,
  } as unknown as Assessment;
}

function attempt(over: {
  id: string;
  assessmentId?: string;
  day: number;
  percentage?: number | null;
  status?: AttemptStatus;
  requiresManualReview?: boolean;
}): Attempt {
  const at = `2026-08-${String(over.day).padStart(2, '0')}T09:00:00.000Z`;
  const pct = over.percentage;
  return {
    id: over.id,
    assessmentId: over.assessmentId ?? 'a1',
    studentId: 's1',
    status: over.status ?? 'submitted',
    createdAt: at,
    startedAt: at,
    submittedAt: at,
    scores: pct == null ? undefined : {
      total: pct,
      available: 100,
      percentage: pct,
      passed: over.requiresManualReview ? null : pct >= 40,
      bySection: [],
      requiresManualReview: over.requiresManualReview ?? false,
    },
  } as unknown as Attempt;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  getAssessmentsForStudent.mockResolvedValue([]);
  getAttemptsByStudent.mockResolvedValue([]);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter>
        <StudentProgressPage />
      </MemoryRouter>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return host!;
}

const buttonSaying = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text))!;

// ══════════════════════════════════════════════════════════════════

describe('StudentProgressPage', () => {
  it('explains what would appear, rather than showing an empty chart', async () => {
    const el = await mount();
    expect(el.textContent).toContain('Nothing to chart yet');
    expect(el.textContent).toContain('Go to assessments');
  });

  it('distinguishes "nothing marked" from "nothing released to you"', async () => {
    getAssessmentsForStudent.mockResolvedValue([
      assessment({ showResults: false, allowReview: false }),
    ]);
    getAttemptsByStudent.mockResolvedValue([attempt({ id: 'x', day: 2, percentage: 91 })]);
    const el = await mount();

    expect(el.textContent).toContain('no marks have been released');
    // And never the mark itself.
    expect(el.textContent).not.toContain('91');
  });

  it('reports the average, the best and the pass rate over released sittings', async () => {
    getAssessmentsForStudent.mockResolvedValue([
      assessment({ id: 'a', title: 'Thermodynamics', subject: 'Physics' }),
      assessment({ id: 'b', title: 'Algebra', subject: 'Mathematics' }),
    ]);
    getAttemptsByStudent.mockResolvedValue([
      attempt({ id: '1', assessmentId: 'a', day: 2, percentage: 30 }),
      attempt({ id: '2', assessmentId: 'b', day: 6, percentage: 90 }),
    ]);
    const el = await mount();

    expect(el.textContent).toContain('60%');            // average
    expect(el.textContent).toContain('90%');            // best
    expect(el.textContent).toContain('Algebra');        // …and which paper it was
    expect(el.textContent).toContain('50%');            // pass rate
    expect(el.textContent).toContain('1 passed · 1 not');
  });

  it('withholds a momentum verdict until there is enough to compare', async () => {
    getAssessmentsForStudent.mockResolvedValue([assessment()]);
    getAttemptsByStudent.mockResolvedValue([attempt({ id: '1', day: 2, percentage: 55 })]);
    const el = await mount();
    expect(el.textContent).toContain('needs four marked sittings');
  });

  it('offers a table view carrying every value the chart plots', async () => {
    getAssessmentsForStudent.mockResolvedValue([
      assessment({ title: 'Thermodynamics', maxAttempts: 3 }),
    ]);
    getAttemptsByStudent.mockResolvedValue([
      attempt({ id: '1', day: 2, percentage: 41 }),
      attempt({ id: '2', day: 9, percentage: 76 }),
    ]);
    const el = await mount();

    expect(el.querySelector('table')).toBeNull();
    act(() => { buttonSaying(el, 'Table view').click(); });

    const table = el.querySelector('table')!;
    expect(table).not.toBeNull();
    expect(table.textContent).toContain('41%');
    expect(table.textContent).toContain('76%');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('breaks performance down by subject', async () => {
    getAssessmentsForStudent.mockResolvedValue([
      assessment({ id: 'a', title: 'Thermodynamics', subject: 'Physics' }),
      assessment({ id: 'b', title: 'Algebra', subject: 'Mathematics' }),
    ]);
    getAttemptsByStudent.mockResolvedValue([
      attempt({ id: '1', assessmentId: 'a', day: 2, percentage: 60 }),
      attempt({ id: '2', assessmentId: 'b', day: 6, percentage: 95 }),
    ]);
    const el = await mount();

    expect(el.textContent).toContain('By subject');
    expect(el.textContent).toContain('Mathematics');
    expect(el.textContent).toContain('Physics');
    expect(el.textContent).toContain('retaking one to improve it never');
  });

  it('names what it left out, instead of quietly dropping it', async () => {
    getAssessmentsForStudent.mockResolvedValue([
      assessment({ id: 'shown', title: 'Thermodynamics' }),
      assessment({ id: 'hidden', title: 'Optics', showResults: false, allowReview: false }),
      assessment({ id: 'void', title: 'Statics' }),
    ]);
    getAttemptsByStudent.mockResolvedValue([
      attempt({ id: '1', assessmentId: 'shown', day: 2, percentage: 80 }),
      attempt({ id: '2', assessmentId: 'hidden', day: 4, percentage: 10 }),
      attempt({ id: '3', assessmentId: 'void', day: 6, percentage: 5, status: 'terminated' }),
    ]);
    const el = await mount();

    expect(el.textContent).toContain('Not counted above');
    expect(el.textContent).toContain('1 paper withheld');
    expect(el.textContent).toContain('1 sitting ended early');
    // The average is the released, non-voided sitting alone.
    expect(el.textContent).toContain('80%');
  });

  it('refuses to say which sitting counts — that is the institution\'s call', async () => {
    getAssessmentsForStudent.mockResolvedValue([assessment()]);
    getAttemptsByStudent.mockResolvedValue([attempt({ id: '1', day: 2, percentage: 55 })]);
    const el = await mount();
    expect(el.textContent).toContain('decided by your institution');
  });
});
