/**
 * The Results tab makes two promises, and both are the kind that fail
 * silently: that it shows a student only what their exam released to them,
 * and that "best" means the same thing to them as it does to the person
 * marking their paper. Neither produces an error when it breaks — one
 * over-shares a mark, the other quietly disagrees with the roster.
 */

import { describe, it, expect } from 'vitest';
import type { Assessment } from './assessmentService';
import type { Attempt, AttemptStatus } from './submissionService';
import type { Student } from './firebaseService';
import { selectExportRows } from './resultsExport';
import {
  buildResultRow,
  buildResultRows,
  isProvisional,
  pickBestAttempt,
  pickLatestFinishedAttempt,
  studentResultVisibility,
  summariseResults,
  visibleAttempts,
} from './studentResults';

// ── Fixtures ──────────────────────────────────────────────────────
//
// Cast rather than fully built: Attempt carries ~40 fields describing
// integrity, timing and freeze state, and none of them are inputs to any
// function under test. Spelling them all out would hide which four fields
// each case is actually about.

type AttemptSpec = {
  id: string;
  status?: AttemptStatus;
  /** Hour offset — attempts are ordered by start time, not by id. */
  hour?: number;
  percentage?: number | null;
  manual?: boolean;
  judgePending?: boolean;
  deleted?: boolean;
};

function attempt(spec: AttemptSpec): Attempt {
  const started = `2026-08-01T${String(spec.hour ?? 9).padStart(2, '0')}:00:00.000Z`;
  const status = spec.status ?? 'submitted';
  const pct = spec.percentage;
  return {
    id: spec.id,
    assessmentId: 'a1',
    studentId: 's1',
    status,
    startedAt: started,
    createdAt: started,
    submittedAt: status === 'in_progress' ? undefined : started,
    isDeleted: spec.deleted,
    codeJudgePending: spec.judgePending,
    scores: pct == null ? undefined : {
      total: pct,
      available: 100,
      percentage: pct,
      passed: spec.manual ? null : pct >= 40,
      bySection: [],
      requiresManualReview: spec.manual === true,
    },
  } as unknown as Attempt;
}

function assessment(over: Partial<Assessment> = {}): Assessment {
  return {
    id: 'a1',
    title: 'Paper 1',
    showResults: true,
    allowReview: false,
    ...over,
  } as unknown as Assessment;
}

// ══════════════════════════════════════════════════════════════════
// VISIBILITY
// ══════════════════════════════════════════════════════════════════

describe('studentResultVisibility', () => {
  it('reads the audience arrays when the exam carries them', () => {
    expect(studentResultVisibility(assessment({
      showResults: false, allowReview: false,
      showResultsTo: ['students', 'faculty'], allowReviewTo: ['students'],
    }))).toBe('review');
  });

  it('falls back to the legacy booleans when it does not', () => {
    expect(studentResultVisibility(assessment({ showResults: true, allowReview: true })))
      .toBe('review');
    expect(studentResultVisibility(assessment({ showResults: true, allowReview: false })))
      .toBe('score');
    expect(studentResultVisibility(assessment({ showResults: false, allowReview: true })))
      .toBe('withheld');
  });

  it('withholds when results are staff-only, even if review lists students', () => {
    // The combination is legal — the two fields are independent — and
    // ExamResultsPage renders nothing for it, because its review block is
    // gated on showResults as well. A tab that offered "Review" here would
    // link to a page that shows the student an empty screen.
    expect(studentResultVisibility(assessment({
      showResults: false, allowReview: true,
      showResultsTo: ['faculty'], allowReviewTo: ['students'],
    }))).toBe('withheld');
  });
});

// ══════════════════════════════════════════════════════════════════
// WHICH SITTING
// ══════════════════════════════════════════════════════════════════

describe('pickBestAttempt', () => {
  it('takes the highest percentage, not the most recent', () => {
    const list = [
      attempt({ id: 'first',  hour: 9,  percentage: 78 }),
      attempt({ id: 'retake', hour: 14, percentage: 41 }),
    ];
    expect(pickBestAttempt(list)?.id).toBe('first');
    expect(pickLatestFinishedAttempt(list)?.id).toBe('retake');
  });

  it('breaks ties towards the more recent sitting', () => {
    const list = [
      attempt({ id: 'early', hour: 9,  percentage: 60 }),
      attempt({ id: 'late',  hour: 14, percentage: 60 }),
    ];
    expect(pickBestAttempt(list)?.id).toBe('late');
  });

  it('never promotes a terminated sitting over a clean one', () => {
    const list = [
      attempt({ id: 'voided', hour: 9,  percentage: 95, status: 'terminated' }),
      attempt({ id: 'clean',  hour: 14, percentage: 52 }),
    ];
    expect(pickBestAttempt(list)?.id).toBe('clean');
  });

  it('returns null when every finished sitting was terminated', () => {
    // The student still has a latest — they are owed the record of it — but
    // they have no best, and inventing one out of a voided sitting would put
    // the platform on the wrong side of their institution's decision.
    const list = [attempt({ id: 'voided', percentage: 95, status: 'terminated' })];
    expect(pickBestAttempt(list)).toBeNull();
    expect(pickLatestFinishedAttempt(list)?.id).toBe('voided');
  });

  it('ignores a sitting that is still running', () => {
    const list = [
      attempt({ id: 'done',    hour: 9,  percentage: 55 }),
      attempt({ id: 'ongoing', hour: 14, percentage: 90, status: 'in_progress' }),
    ];
    expect(pickBestAttempt(list)?.id).toBe('done');
    expect(pickLatestFinishedAttempt(list)?.id).toBe('done');
  });

  it('ignores soft-deleted attempts everywhere', () => {
    const list = [
      attempt({ id: 'kept',    hour: 9,  percentage: 50 }),
      attempt({ id: 'removed', hour: 14, percentage: 99, deleted: true }),
    ];
    expect(visibleAttempts(list).map((a) => a.id)).toEqual(['kept']);
    expect(pickBestAttempt(list)?.id).toBe('kept');
    expect(pickLatestFinishedAttempt(list)?.id).toBe('kept');
  });
});

describe('isProvisional', () => {
  it('is true while a human still owes the paper marks', () => {
    expect(isProvisional(attempt({ id: 'x', percentage: 30, manual: true }))).toBe(true);
  });

  it('is true while the code judge has not finished', () => {
    expect(isProvisional(attempt({ id: 'x', percentage: 30, judgePending: true }))).toBe(true);
  });

  it('is false for a settled mark', () => {
    expect(isProvisional(attempt({ id: 'x', percentage: 30 }))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// ROWS
// ══════════════════════════════════════════════════════════════════

describe('buildResultRow', () => {
  it('is null for an assessment the student never finished', () => {
    expect(buildResultRow(assessment(), [])).toBeNull();
    expect(buildResultRow(assessment(), [attempt({ id: 'x', status: 'in_progress' })]))
      .toBeNull();
  });

  it('numbers attempts by start order across every visible sitting', () => {
    const row = buildResultRow(assessment(), [
      attempt({ id: 'one',   hour: 9,  percentage: 80 }),
      attempt({ id: 'two',   hour: 12, percentage: 45 }),
      attempt({ id: 'three', hour: 15, percentage: 61 }),
    ])!;
    expect(row.latest.attemptNumber).toBe(3);
    expect(row.best?.attemptNumber).toBe(1);
    expect(row.latestIsBest).toBe(false);
    expect(row.finishedCount).toBe(3);
  });

  it('marks a single sitting as its own best', () => {
    const row = buildResultRow(assessment(), [attempt({ id: 'only', percentage: 70 })])!;
    expect(row.latestIsBest).toBe(true);
    expect(row.best?.attempt.id).toBe('only');
  });

  it('carries the exam visibility onto the row', () => {
    const row = buildResultRow(
      assessment({ showResults: false, allowReview: false }),
      [attempt({ id: 'only', percentage: 70 })],
    )!;
    expect(row.visibility).toBe('withheld');
  });

  it('orders rows by most recently finished', () => {
    const rows = buildResultRows(
      [assessment({ id: 'old' }), assessment({ id: 'new' })],
      {
        old: [attempt({ id: 'o', hour: 9, percentage: 50 })],
        new: [attempt({ id: 'n', hour: 18, percentage: 50 })],
      },
    );
    expect(rows.map((r) => r.assessment.id)).toEqual(['new', 'old']);
  });
});

describe('summariseResults', () => {
  it('averages only settled marks, and counts what it left out', () => {
    const rows = buildResultRows(
      [assessment({ id: 'p1' }), assessment({ id: 'p2' }), assessment({ id: 'p3' })],
      {
        p1: [attempt({ id: '1', percentage: 80 })],
        p2: [attempt({ id: '2', percentage: 40, manual: true })],
        p3: [attempt({ id: '3', percentage: 60 })],
      },
    );
    const s = summariseResults(rows);
    expect(s.released).toBe(3);
    expect(s.awaitingMarking).toBe(1);
    // 40% is a floor, not a result: averaging it in would make the student's
    // record improve on its own as the marking finishes.
    expect(s.averageBestPercentage).toBe(70);
    expect(s.settledCount).toBe(2);
  });

  it('counts withheld rows without reading their marks', () => {
    const rows = buildResultRows(
      [assessment({ id: 'p1', showResults: false })],
      { p1: [attempt({ id: '1', percentage: 90 })] },
    );
    const s = summariseResults(rows);
    expect(s).toMatchObject({
      released: 0, withheld: 1, settledCount: 0, averageBestPercentage: null,
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// THE TWIN — the student's "best" and the examiner's "best"
// ══════════════════════════════════════════════════════════════════
//
// resultsExport picks the attempt that is EXPORTED as the counted one; this
// module picks the attempt shown to the student as theirs. Two copies of one
// rule, in two files, with nothing but a comment holding them together —
// exactly the shape twinSync.test.ts exists to catch elsewhere in this repo.
//
// Drift here is silent and lands on a person: the student's screen says their
// best was the 78%, the exported mark sheet counts the 41%, and the first
// anyone hears of it is an appeal.
//
// The agreement is asserted only where a clean graded sitting exists. Outside
// that the two rules diverge ON PURPOSE — an export row must exist for every
// student, so it falls back to a terminated or an unfinished attempt, while
// this module returns null and the tab says "no best sitting" instead.

describe('best-attempt rule agrees with the results export', () => {
  const cases: Array<{ name: string; attempts: Attempt[] }> = [
    {
      name: 'a retake that scored worse',
      attempts: [
        attempt({ id: 'first',  hour: 9,  percentage: 78 }),
        attempt({ id: 'retake', hour: 14, percentage: 41 }),
      ],
    },
    {
      name: 'a tie',
      attempts: [
        attempt({ id: 'early', hour: 9,  percentage: 60 }),
        attempt({ id: 'late',  hour: 14, percentage: 60 }),
      ],
    },
    {
      name: 'a terminated sitting alongside a clean one',
      attempts: [
        attempt({ id: 'voided', hour: 9,  percentage: 95, status: 'terminated' }),
        attempt({ id: 'clean',  hour: 14, percentage: 52 }),
      ],
    },
    {
      name: 'an auto-submitted sitting that beat a manual one',
      attempts: [
        attempt({ id: 'manual', hour: 9,  percentage: 55 }),
        attempt({ id: 'auto',   hour: 14, percentage: 71, status: 'auto_submitted' }),
      ],
    },
  ];

  const student = { id: 's1', name: 'A Student' } as unknown as Student;

  for (const { name, attempts } of cases) {
    it(name, () => {
      const { exported } = selectExportRows([student], attempts, 'best');
      expect(exported).toHaveLength(1);
      expect(pickBestAttempt(attempts)?.id).toBe(exported[0].attempt.id);
    });
  }
});
