/**
 * The Results tab, rendered.
 *
 * studentResults.test.ts proves the SELECTION is right — which sitting is the
 * best one, what the exam released. This file proves the tab actually puts
 * that on the screen, because the two failures that matter here are both
 * rendering failures and neither throws:
 *
 *   • a withheld result rendering its marks anyway (the panel is shown by a
 *     boolean; getting the boolean backwards is silent), and
 *   • a student with two sittings seeing only one of them.
 *
 * Mounted into jsdom rather than rendered to a string. The string renderer is
 * simpler, but it warns on every useLayoutEffect it meets — motion and the
 * router both use them — and a suite that prints a screenful of warnings on a
 * passing run is one people stop reading.
 */

import { describe, it, expect } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import type { Assessment } from '../../../lib/assessmentService';
import type { Attempt, AttemptStatus } from '../../../lib/submissionService';
import { buildResultRows } from '../../../lib/studentResults';
import { ResultsTab } from './ResultsTab';

function attempt(
  id: string,
  hour: number,
  percentage: number | null,
  status: AttemptStatus = 'submitted',
): Attempt {
  const at = `2026-08-01T${String(hour).padStart(2, '0')}:00:00.000Z`;
  return {
    id,
    assessmentId: 'a1',
    studentId: 's1',
    status,
    startedAt: at,
    createdAt: at,
    submittedAt: at,
    scores: percentage == null ? undefined : {
      total: percentage,
      available: 100,
      percentage,
      passed: percentage >= 40,
      bySection: [],
      requiresManualReview: false,
    },
  } as unknown as Attempt;
}

function assessment(over: Partial<Assessment> = {}): Assessment {
  return {
    id: 'a1',
    title: 'Thermodynamics',
    subject: 'Physics',
    totalMarks: 100,
    passingScore: 40,
    showResults: true,
    allowReview: true,
    ...over,
  } as unknown as Assessment;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Mount the tab and hand back the text a student would be looking at. */
function render(assessments: Assessment[], attempts: Record<string, Attempt[]>): string {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <MemoryRouter>
        <ResultsTab rows={buildResultRows(assessments, attempts)} />
      </MemoryRouter>,
    );
  });
  const html = host.innerHTML;
  act(() => root.unmount());
  host.remove();
  return html;
}

describe('ResultsTab', () => {
  it('shows both sittings when the latest is not the best', () => {
    const html = render([assessment()], {
      a1: [attempt('first', 9, 78), attempt('retake', 14, 41)],
    });
    expect(html).toContain('LATEST');
    expect(html).toContain('BEST');
    expect(html).toContain('78%');
    expect(html).toContain('41%');
    // The gap, so the better sitting is not just present but legible as better.
    expect(html).toContain('+37 pts');
  });

  it('collapses to one panel when the latest sitting IS the best', () => {
    const html = render([assessment()], {
      a1: [attempt('first', 9, 41), attempt('retake', 14, 78)],
    });
    expect(html).toContain('LATEST · BEST');
    // One panel, not two: the string appears once because there is one heading.
    expect(html.match(/Attempt \d of 2/g)).toHaveLength(1);
  });

  it('never prints a mark the exam withholds from students', () => {
    const html = render([assessment({ showResults: false, allowReview: false })], {
      a1: [attempt('only', 9, 93)],
    });
    expect(html).toContain('Results withheld');
    expect(html).not.toContain('93%');
    // …and says why, rather than leaving an unexplained gap where a score was.
    expect(html).toContain('not released to students');
  });

  it('says so when every finished sitting was terminated', () => {
    const html = render([assessment()], {
      a1: [attempt('voided', 9, 95, 'terminated')],
    });
    expect(html).toContain('No sitting counts as your best');
  });

  it('has an empty state that explains what will appear', () => {
    const html = render([assessment()], { a1: [] });
    expect(html).toContain('No results yet');
  });
});
