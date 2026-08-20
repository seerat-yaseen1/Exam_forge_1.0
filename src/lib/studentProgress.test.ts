/**
 * studentProgress — the exclusions are the whole test.
 *
 * Averaging numbers is not hard. What this module has to get right is which
 * numbers are allowed into the average, and every one of those rules is a
 * silent failure if it goes wrong: a withheld mark leaking into a figure the
 * student is shown, a terminated sitting counted as a bad one, a half-marked
 * paper dragging an average down and then quietly recovering.
 */

import { describe, it, expect } from 'vitest';
import type { Assessment } from './assessmentService';
import type { Attempt, AttemptStatus } from './submissionService';
import { buildResultRows } from './studentResults';
import { buildProgress, buildSubjectStats, computeMomentum } from './studentProgress';

function attempt(over: {
  id: string;
  assessmentId?: string;
  day: number;
  percentage?: number | null;
  status?: AttemptStatus;
  passed?: boolean | null;
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
      passed: over.passed !== undefined ? over.passed : pct >= 40,
      bySection: [],
      requiresManualReview: over.requiresManualReview ?? false,
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

const rowsFor = (
  assessments: Assessment[],
  attempts: Record<string, Attempt[]>,
) => buildResultRows(assessments, attempts);

const trendFor = (
  assessments: Assessment[],
  attempts: Record<string, Attempt[]>,
) => buildProgress(assessments, attempts).trend;

const summaryFor = (
  assessments: Assessment[],
  attempts: Record<string, Attempt[]>,
) => buildProgress(assessments, attempts).summary;

// ══════════════════════════════════════════════════════════════════
// The trend
// ══════════════════════════════════════════════════════════════════

describe('buildTrend', () => {
  it('is a chronology — oldest first, both sittings of a retaken paper', () => {
    const trend = trendFor([assessment()], {
      a1: [attempt({ id: 'first', day: 1, percentage: 55 }), attempt({ id: 'retake', day: 9, percentage: 72 })],
    });
    expect(trend.map((p) => p.percentage)).toEqual([55, 72]);
  });

  it('keeps EVERY sitting of a paper, not just the latest and the best', () => {
    // The regression this file caught on its first run: an earlier trend was
    // built from result rows, which expose only two sittings. A student who
    // improved 40 → 60 → 85 had the two attempts that show the improvement
    // silently dropped, and the chart plotted the one mark it was drawn to
    // explain.
    const trend = trendFor([assessment()], {
      a1: [
        attempt({ id: 'one',   day: 1, percentage: 40 }),
        attempt({ id: 'two',   day: 5, percentage: 60 }),
        attempt({ id: 'three', day: 9, percentage: 85 }),
      ],
    });
    expect(trend.map((p) => p.percentage)).toEqual([40, 60, 85]);
  });

  it('leaves out a paper whose marks are withheld', () => {
    const trend = trendFor([assessment({ showResults: false, allowReview: false })], {
      a1: [attempt({ id: 'x', day: 1, percentage: 93 })],
    });
    expect(trend).toHaveLength(0);
  });

  it('leaves out a terminated sitting rather than plotting it as a low mark', () => {
    // A dip to 12% because a sitting was ended for a violation describes the
    // invigilation, not the student's work.
    const trend = trendFor([assessment()], {
      a1: [attempt({ id: 'void', day: 1, percentage: 12, status: 'terminated' })],
    });
    expect(trend).toHaveLength(0);
  });

  it('leaves out a mark that is still provisional', () => {
    const trend = trendFor([assessment()], {
      a1: [attempt({ id: 'part', day: 1, percentage: 30, passed: null, requiresManualReview: true })],
    });
    expect(trend).toHaveLength(0);
  });

  it('carries the assessment title and subject for the tooltip', () => {
    const [point] = trendFor([assessment()], {
      a1: [attempt({ id: 'x', day: 4, percentage: 61 })],
    });
    expect(point).toMatchObject({ title: 'Thermodynamics', subject: 'Physics', percentage: 61, passed: true });
  });
});

// ══════════════════════════════════════════════════════════════════
// Subjects
// ══════════════════════════════════════════════════════════════════

describe('buildSubjectStats', () => {
  const physics = assessment({ id: 'p1', subject: 'Physics' });
  const physics2 = assessment({ id: 'p2', subject: 'Physics', title: 'Optics' });
  const maths = assessment({ id: 'm1', subject: 'Mathematics', title: 'Algebra' });

  it('averages the BEST sitting per paper, so retaking never hurts a subject', () => {
    const stats = buildSubjectStats(rowsFor([physics], {
      p1: [
        attempt({ id: 'a', assessmentId: 'p1', day: 1, percentage: 40 }),
        attempt({ id: 'b', assessmentId: 'p1', day: 2, percentage: 50 }),
        attempt({ id: 'c', assessmentId: 'p1', day: 3, percentage: 90 }),
      ],
    }));
    // 90 alone — one paper contributes one number, not three.
    expect(stats).toEqual([{ subject: 'Physics', average: 90, papers: 1, best: 90, worst: 90 }]);
  });

  it('orders subjects strongest first', () => {
    const stats = buildSubjectStats(rowsFor([physics, physics2, maths], {
      p1: [attempt({ id: 'a', assessmentId: 'p1', day: 1, percentage: 60 })],
      p2: [attempt({ id: 'b', assessmentId: 'p2', day: 2, percentage: 70 })],
      m1: [attempt({ id: 'c', assessmentId: 'm1', day: 3, percentage: 95 })],
    }));
    expect(stats.map((s) => s.subject)).toEqual(['Mathematics', 'Physics']);
    expect(stats[1]).toMatchObject({ average: 65, papers: 2, best: 70, worst: 60 });
  });

  it('drops papers with no subject rather than inventing an "Other" one', () => {
    const stats = buildSubjectStats(rowsFor([assessment({ id: 'x', subject: undefined })], {
      x: [attempt({ id: 'a', assessmentId: 'x', day: 1, percentage: 88 })],
    }));
    expect(stats).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// The headline figures
// ══════════════════════════════════════════════════════════════════

describe('summariseProgress', () => {
  it('reports the average, the best, and the pass rate over released sittings', () => {
    const s = summaryFor(
      [assessment({ id: 'a', title: 'A' }), assessment({ id: 'b', title: 'B' })],
      {
        a: [attempt({ id: '1', assessmentId: 'a', day: 1, percentage: 30 })],
        b: [attempt({ id: '2', assessmentId: 'b', day: 2, percentage: 90 })],
      },
    );
    expect(s.average).toBe(60);
    expect(s.best?.percentage).toBe(90);
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.passRate).toBe(50);
    expect(s.papers).toBe(2);
  });

  it('counts withheld and terminated separately instead of averaging them', () => {
    const s = summaryFor(
      [
        assessment({ id: 'shown', title: 'Shown' }),
        assessment({ id: 'hidden', title: 'Hidden', showResults: false, allowReview: false }),
        assessment({ id: 'void', title: 'Void' }),
      ],
      {
        shown:  [attempt({ id: '1', assessmentId: 'shown', day: 1, percentage: 80 })],
        hidden: [attempt({ id: '2', assessmentId: 'hidden', day: 2, percentage: 10 })],
        void:   [attempt({ id: '3', assessmentId: 'void', day: 3, percentage: 5, status: 'terminated' })],
      },
    );
    expect(s.average).toBe(80);      // untouched by either exclusion
    expect(s.withheld).toBe(1);
    expect(s.terminated).toBe(1);
    expect(s.marked).toBe(1);
  });

  it('has no opinion at all when nothing is marked', () => {
    const s = summaryFor([], {});
    expect(s).toMatchObject({ average: null, best: null, passRate: null, momentum: null, marked: 0 });
  });
});

describe('computeMomentum', () => {
  const points = (...pcts: number[]) =>
    pcts.map((p, i) => ({
      assessmentId: 'a', attemptId: `x${i}`, title: 't', subject: null,
      percentage: p, passed: null, at: i, atIso: '',
    }));

  it('stays silent until there are four sittings', () => {
    expect(computeMomentum(points(10, 90))).toBeNull();
    expect(computeMomentum(points(10, 50, 90))).toBeNull();
  });

  it('compares the recent half against the earlier one', () => {
    // (70+80)/2 − (40+50)/2 = +30
    expect(computeMomentum(points(40, 50, 70, 80))).toBe(30);
  });

  it('goes negative when the recent half is worse', () => {
    expect(computeMomentum(points(80, 70, 50, 40))).toBe(-30);
  });

  it('leaves the middle sitting out of both halves on an odd count', () => {
    // Halves are [10,20] and [80,90]; the 50 belongs to neither.
    expect(computeMomentum(points(10, 20, 50, 80, 90))).toBe(70);
  });
});
