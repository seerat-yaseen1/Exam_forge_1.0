/**
 * studentProgress — the numbers behind the Progress page.
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────
 * The Results tab answers "what did I get on this paper". Nobody could ask the
 * platform the next question — "am I getting better, and where am I weakest" —
 * because the answer needs every sitting at once and the tab renders them one
 * row at a time.
 *
 * Everything here is derived from the two things the assessment page already
 * fetches — the student's assessments and their attempts. No new reads, no new
 * collection, nothing for staff to configure. `buildProgress` is the entry
 * point; the pieces are exported for their tests.
 *
 * ── THE RULES IT INHERITS, AND THE ONE IT ADDS ────────────────────
 * Withheld rows are absent from every figure, because a mark a student is not
 * allowed to see cannot appear in an average they are shown. Provisional marks
 * are absent from averages for the reason `summariseResults` gives: a
 * half-marked paper counted at its current floor makes a student's average
 * fall while nothing about their work has changed.
 *
 * The rule this module adds is about VOIDED sittings. A terminated attempt is
 * excluded from the trend and from every subject average — `pickBestAttempt`
 * already refuses to call one "best", and a line chart that dips to 12%
 * because a sitting was ended for an integrity violation would be describing
 * the invigilation, not the student's performance. It stays visible as a
 * count, so it is never silently dropped.
 *
 * PURE. No Firestore, no React, no clock.
 */

import type { Assessment } from './assessmentService';
import type { Attempt } from './submissionService';
import {
  buildResultRows,
  finishedAttempts,
  isProvisional,
  studentResultVisibility,
  type StudentResultRow,
} from './studentResults';

// ══════════════════════════════════════════════════════════════════
// §1 — ONE POINT ON THE TREND
// ══════════════════════════════════════════════════════════════════

export type TrendPoint = {
  assessmentId: string;
  attemptId: string;
  title: string;
  subject: string | null;
  /** 0–100. */
  percentage: number;
  passed: boolean | null;
  /** Epoch ms of the sitting, for the x-axis. */
  at: number;
  /** ISO, for labels. */
  atIso: string;
};

/**
 * Every released, settled, non-voided sitting, oldest first.
 *
 * ── WHY THIS TAKES ATTEMPTS AND NOT RESULT ROWS ───────────────────
 * A `StudentResultRow` exposes two sittings — the latest and the best — which
 * is exactly right for a results card and wrong for a chronology. A student
 * who sat a paper three times, improving each time, has one row whose latest
 * IS its best, so a trend built from rows would plot their final mark and
 * silently drop the two attempts that show them improving. The chart's whole
 * subject is the sittings in between.
 *
 * So it walks the attempts, and takes its VISIBILITY decision from the
 * assessment via the same helper the Results tab uses — a mark the examiner
 * has not released cannot appear here, in a chart, having been refused on the
 * card.
 */
export function buildTrend(
  assessments: Assessment[],
  attemptsByAssessment: Record<string, Attempt[]>,
): TrendPoint[] {
  const points: TrendPoint[] = [];

  for (const assessment of assessments) {
    if (studentResultVisibility(assessment) === 'withheld') continue;

    for (const attempt of finishedAttempts(attemptsByAssessment[assessment.id] ?? [])) {
      if (attempt.status === 'terminated') continue;
      if (isProvisional(attempt)) continue;
      const pct = attempt.scores?.percentage;
      if (pct == null) continue;
      const iso = attempt.submittedAt;
      if (!iso) continue;
      const at = Date.parse(iso);
      if (Number.isNaN(at)) continue;

      points.push({
        assessmentId: assessment.id,
        attemptId: attempt.id,
        title: assessment.title || 'Untitled Assessment',
        subject: assessment.subject ?? null,
        percentage: pct,
        passed: attempt.scores?.passed ?? null,
        at,
        atIso: iso,
      });
    }
  }

  return points.sort((a, b) => a.at - b.at);
}

// ══════════════════════════════════════════════════════════════════
// §2 — BY SUBJECT
// ══════════════════════════════════════════════════════════════════

export type SubjectStat = {
  subject: string;
  /** Mean of the BEST sitting in each assessment of this subject, one decimal. */
  average: number;
  /** How many assessments the average is over. */
  papers: number;
  best: number;
  worst: number;
};

/**
 * Average per subject, strongest first.
 *
 * Best-per-assessment rather than every sitting, deliberately: a student who
 * retook one paper four times would otherwise have that paper count four times
 * towards their subject average, so practising a weak topic would drag the
 * subject down. The staff roster's Latest/Best toggle exists for the same
 * reason and this uses the same `best`.
 *
 * An assessment with no subject is left out entirely rather than bucketed as
 * "Other" — a bar labelled Other, sitting between Physics and Chemistry,
 * asserts a subject that does not exist.
 */
export function buildSubjectStats(rows: StudentResultRow[]): SubjectStat[] {
  const bySubject = new Map<string, number[]>();

  for (const row of rows) {
    if (row.visibility === 'withheld') continue;
    const subject = row.assessment.subject?.trim();
    if (!subject) continue;

    const entry = row.best ?? row.latest;
    if (entry.provisional) continue;
    if (entry.attempt.status === 'terminated') continue;
    const pct = entry.attempt.scores?.percentage;
    if (pct == null) continue;

    if (!bySubject.has(subject)) bySubject.set(subject, []);
    bySubject.get(subject)!.push(pct);
  }

  return [...bySubject.entries()]
    .map(([subject, marks]) => ({
      subject,
      average: Math.round((marks.reduce((s, m) => s + m, 0) / marks.length) * 10) / 10,
      papers: marks.length,
      best: Math.max(...marks),
      worst: Math.min(...marks),
    }))
    .sort((a, b) => b.average - a.average || a.subject.localeCompare(b.subject));
}

// ══════════════════════════════════════════════════════════════════
// §3 — THE HEADLINE FIGURES
// ══════════════════════════════════════════════════════════════════

export type ProgressSummary = {
  /** Released, settled, non-voided sittings — the population every figure below is over. */
  marked: number;
  /** Assessments with at least one such sitting. */
  papers: number;
  /** Mean of the best mark per assessment, one decimal, or null. */
  average: number | null;
  /** Highest single mark, or null. */
  best: TrendPoint | null;
  /** Passed ÷ (passed + failed), as a percentage. Null when no sitting carries a verdict. */
  passRate: number | null;
  passed: number;
  failed: number;
  /**
   * Change from the first half of the trend to the second, in percentage
   * points. Null until there are four points — two points is a line, not a
   * direction, and calling it "improving" would be reading noise aloud.
   */
  momentum: number | null;
  /** Sittings the institution voided. Counted, never averaged. */
  terminated: number;
  /** Papers whose marks the student may not see. */
  withheld: number;
};

export function summariseProgress(rows: StudentResultRow[], trend: TrendPoint[]): ProgressSummary {
  let terminated = 0;
  let withheld = 0;
  const bestPerPaper: number[] = [];

  for (const row of rows) {
    if (row.visibility === 'withheld') {
      withheld += 1;
      continue;
    }
    terminated += row.latest.attempt.status === 'terminated' ? 1 : 0;

    const entry = row.best ?? row.latest;
    if (entry.provisional) continue;
    if (entry.attempt.status === 'terminated') continue;
    const pct = entry.attempt.scores?.percentage;
    if (pct != null) bestPerPaper.push(pct);
  }

  const passed = trend.filter((p) => p.passed === true).length;
  const failed = trend.filter((p) => p.passed === false).length;

  let best: TrendPoint | null = null;
  for (const p of trend) if (!best || p.percentage > best.percentage) best = p;

  const average = bestPerPaper.length
    ? Math.round((bestPerPaper.reduce((s, m) => s + m, 0) / bestPerPaper.length) * 10) / 10
    : null;

  return {
    marked: trend.length,
    papers: bestPerPaper.length,
    average,
    best,
    passRate: passed + failed > 0 ? Math.round((passed / (passed + failed)) * 100) : null,
    passed,
    failed,
    momentum: computeMomentum(trend),
    terminated,
    withheld,
  };
}

/**
 * First half versus second half, in percentage points.
 *
 * A halves comparison rather than a regression slope: the slope of four points
 * is dominated by whichever end happens to be extreme, and the number has to
 * be explainable to a student in one line — "your recent papers average nine
 * points above your earlier ones" is that line. An odd number of points puts
 * the middle one in neither half rather than in both.
 */
export function computeMomentum(trend: TrendPoint[]): number | null {
  if (trend.length < 4) return null;
  const half = Math.floor(trend.length / 2);
  const mean = (xs: TrendPoint[]) => xs.reduce((s, p) => s + p.percentage, 0) / xs.length;
  const earlier = mean(trend.slice(0, half));
  const recent = mean(trend.slice(trend.length - half));
  return Math.round((recent - earlier) * 10) / 10;
}

// ══════════════════════════════════════════════════════════════════
// §4 — EVERYTHING THE PAGE NEEDS, FROM WHAT IT ALREADY FETCHED
// ══════════════════════════════════════════════════════════════════

export type Progress = {
  rows: StudentResultRow[];
  trend: TrendPoint[];
  subjects: SubjectStat[];
  summary: ProgressSummary;
};

/**
 * One call, so a caller cannot pair a trend with a summary computed from a
 * different slice of the same data — the two take different inputs (attempts
 * for the chronology, rows for the per-paper bests) and getting one of them
 * from the wrong place is the defect this function exists to make impossible.
 */
export function buildProgress(
  assessments: Assessment[],
  attemptsByAssessment: Record<string, Attempt[]>,
): Progress {
  const rows = buildResultRows(assessments, attemptsByAssessment);
  const trend = buildTrend(assessments, attemptsByAssessment);
  return {
    rows,
    trend,
    subjects: buildSubjectStats(rows),
    summary: summariseProgress(rows, trend),
  };
}
