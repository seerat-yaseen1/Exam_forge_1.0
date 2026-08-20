/**
 * Progress — "am I getting better, and where am I weakest".
 *
 * The platform could already answer "what did I get on this paper" (the
 * Results tab) and could not answer this, because the answer needs every
 * sitting at once. It is built entirely from the two fetches the assessment
 * list already makes — no new collection, nothing for staff to configure, and
 * nothing visible here that the student was not already allowed to see.
 *
 * ── WHAT IT REFUSES TO DO ─────────────────────────────────────────
 * Rank the student against anyone. The platform has no cohort statistics a
 * student may see, and inventing a percentile out of the papers that happen to
 * be readable from this account would be a number that looks authoritative and
 * means nothing. Every figure here is about them, over time.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Award, BarChart3, ChevronRight, Minus, RefreshCw, ShieldAlert, Table2,
  TrendingDown, TrendingUp, EyeOff, LineChart,
} from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { formatDayMonthTime } from '../../../lib/dateFormat';
import { getAssessmentsForStudent, type Assessment } from '../../../lib/assessmentService';
import { getAttemptsByStudent, type Attempt } from '../../../lib/submissionService';
import { buildProgress } from '../../../lib/studentProgress';
import { SubjectBars, TrendChart } from '../../components/student/Charts';
import {
  Button, Card, Chip, EmptyState, ErrorBanner, LoadingBlock,
  PageHeader, PageShell, SectionHeading, StatRow, StatTile,
} from '../../components/student/ui';

export function StudentProgressPage() {
  const { session } = useStudentAuth();
  const navigate = useNavigate();

  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [attempts, setAttempts]       = useState<Attempt[]>([]);
  const [loading, setLoading]         = useState(true);
  const [refreshing, setRefreshing]   = useState(false);
  const [error, setError]             = useState('');
  const [showTable, setShowTable]     = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (!session?.studentId) return;
    // A refetch holds the previous render rather than replacing it with a
    // skeleton — the numbers barely move, and a flash of empty chart on every
    // refresh reads as the data having been lost.
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const [aList, attemptList] = await Promise.all([
        getAssessmentsForStudent(),
        getAttemptsByStudent(session.studentId),
      ]);
      setAssessments(aList);
      setAttempts(attemptList);
    } catch (e: any) {
      console.error('[StudentProgressPage] load error:', e);
      setError(e?.message || 'Failed to load your results.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [session?.studentId]);

  useEffect(() => { load(); }, [load]);

  const { rows, trend, subjects, summary } = useMemo(() => {
    const byAssessment: Record<string, Attempt[]> = {};
    for (const at of attempts) (byAssessment[at.assessmentId] ??= []).push(at);
    return buildProgress(assessments, byAssessment);
  }, [assessments, attempts]);

  /**
   * The pass mark is drawn only when every paper in the set agrees on one.
   * A single reference line across papers that pass at 40% and at 60% would be
   * a line that is wrong for half the chart.
   */
  const sharedPassMark = useMemo(() => {
    const marks = new Set(
      rows
        .filter((r) => r.visibility !== 'withheld' && r.assessment.passingScore !== undefined)
        .map((r) => r.assessment.passingScore as number),
    );
    return marks.size === 1 ? [...marks][0] : null;
  }, [rows]);

  if (!session) return null;

  const momentumTone =
    summary.momentum === null ? undefined
    : summary.momentum > 1 ? 'success'
    : summary.momentum < -1 ? 'warning'
    : undefined;

  const MomentumIcon =
    summary.momentum === null ? Minus
    : summary.momentum > 1 ? TrendingUp
    : summary.momentum < -1 ? TrendingDown
    : Minus;

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Progress
          </>
        }
        title="How you're doing."
        subtitle="Built from the marks your examiners have released to you. Papers still being marked, and sittings that were ended early, are counted separately rather than averaged in."
        actions={
          <Button size="sm" onClick={() => load(true)} disabled={loading || refreshing}>
            <RefreshCw size={11} strokeWidth={1.6} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </Button>
        }
      />

      {error && (
        <div className="mb-6">
          <ErrorBanner message={error} onRetry={() => load(true)} />
        </div>
      )}

      {loading ? (
        <LoadingBlock label="Loading your results…" rows={3} />
      ) : summary.marked === 0 ? (
        <EmptyState
          icon={<LineChart size={28} strokeWidth={1} />}
          title="Nothing to chart yet"
          body={
            summary.withheld > 0
              ? 'You have submitted work, but no marks have been released to you yet. As soon as an examiner releases one, your trend starts here.'
              : 'Once you finish an assessment and its marks are released, your scores over time and your strongest subjects appear here.'
          }
          action={
            <Button onClick={() => navigate('/student/assessments')}>
              Go to assessments
              <ChevronRight size={12} strokeWidth={1.6} />
            </Button>
          }
        />
      ) : (
        <div
          className="flex flex-col"
          style={{ gap: 28, opacity: refreshing ? 0.6 : 1, transition: 'opacity 200ms ease' }}
        >
          {/* ── Headline ── */}
          <StatRow>
            <StatTile
              label="Average"
              value={summary.average !== null ? `${summary.average}%` : '—'}
              icon={<BarChart3 size={12} strokeWidth={1.6} />}
              sub={`best sitting in each of ${summary.papers} paper${summary.papers !== 1 ? 's' : ''}`}
              hint="The mean of your best mark on each assessment. A retake does not make a paper count twice."
            />
            <StatTile
              label="Best result"
              value={summary.best ? `${summary.best.percentage}%` : '—'}
              icon={<Award size={12} strokeWidth={1.6} />}
              tone="success"
              sub={summary.best?.title}
              hint="Your highest single mark across every released sitting."
            />
            <StatTile
              label="Pass rate"
              value={summary.passRate !== null ? `${summary.passRate}%` : '—'}
              sub={summary.passRate !== null ? `${summary.passed} passed · ${summary.failed} not` : 'no verdicts yet'}
              hint="Across sittings that carry a pass/fail verdict. Papers still being marked have none."
            />
            <StatTile
              label="Momentum"
              value={
                summary.momentum === null
                  ? '—'
                  : `${summary.momentum > 0 ? '+' : ''}${summary.momentum}`
              }
              icon={<MomentumIcon size={12} strokeWidth={1.6} />}
              tone={momentumTone}
              sub={
                summary.momentum === null
                  ? 'needs four marked sittings'
                  : 'points, recent half vs earlier'
              }
              hint="The difference between the average of your most recent half of sittings and your earliest half. Shown once there are enough sittings for the comparison to mean anything."
            />
          </StatRow>

          {/* ── Trend ── */}
          <section>
            <SectionHeading
              label="Score over time"
              count={trend.length}
              hint="Released, fully marked sittings."
              action={
                <Button size="sm" variant="ghost" onClick={() => setShowTable((v) => !v)}>
                  <Table2 size={11} strokeWidth={1.6} />
                  {showTable ? 'Hide table' : 'Table view'}
                </Button>
              }
            />
            <Card>
              {trend.length === 1 ? (
                <p style={{ fontSize: 12.5, color: 'var(--ef-text-muted)', lineHeight: 1.7 }}>
                  One marked sitting so far — {trend[0].title} at{' '}
                  <strong style={{ color: 'var(--ef-ink)', fontWeight: 500 }}>{trend[0].percentage}%</strong>.
                  A second one gives this chart something to draw a line between.
                </p>
              ) : (
                <TrendChart points={trend} passMark={sharedPassMark} />
              )}
            </Card>
          </section>

          {/* ── The table view every chart owes the reader ── */}
          {showTable && (
            <section>
              <SectionHeading label="Every marked sitting" count={trend.length} />
              <Card padded={false} style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--ef-border)' }}>
                      {['Assessment', 'Subject', 'Submitted', 'Mark', 'Verdict'].map((h, i) => (
                        <th
                          key={h}
                          scope="col"
                          style={{
                            padding: '10px 14px',
                            textAlign: i >= 3 ? 'right' : 'left',
                            fontSize: 10.5,
                            letterSpacing: '0.08em',
                            textTransform: 'uppercase',
                            color: 'var(--ef-text-muted)',
                            fontWeight: 500,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...trend].reverse().map((p) => (
                      <tr key={p.attemptId} style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
                        <td style={{ padding: '10px 14px', color: 'var(--ef-ink)' }}>{p.title}</td>
                        <td style={{ padding: '10px 14px', color: 'var(--ef-text-muted)' }}>{p.subject ?? '—'}</td>
                        <td style={{ padding: '10px 14px', color: 'var(--ef-text-muted)', whiteSpace: 'nowrap' }}>
                          {formatDayMonthTime(p.atIso)}
                        </td>
                        <td
                          style={{
                            padding: '10px 14px',
                            textAlign: 'right',
                            color: 'var(--ef-ink)',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {p.percentage}%
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                          {p.passed === true ? (
                            <Chip small tone="success">Passed</Chip>
                          ) : p.passed === false ? (
                            <Chip small tone="danger">Did not pass</Chip>
                          ) : (
                            <Chip small>No verdict</Chip>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </section>
          )}

          {/* ── Subjects ── */}
          {subjects.length > 0 && (
            <section>
              <SectionHeading
                label="By subject"
                count={subjects.length}
                hint="Your best sitting in each paper, averaged per subject."
              />
              <Card>
                <SubjectBars stats={subjects} passMark={sharedPassMark} />
                <p
                  className="mt-4 pt-3"
                  style={{ fontSize: 11, color: 'var(--ef-text-muted)', borderTop: '1px solid var(--ef-border-subtle)', lineHeight: 1.6 }}
                >
                  Averages use your best sitting on each paper, so retaking one to improve it never
                  counts against the subject.
                  {sharedPassMark != null && ' The vertical line is the pass mark.'}
                </p>
              </Card>
            </section>
          )}

          {/* ── What is not in the numbers ── */}
          {(summary.withheld > 0 || summary.terminated > 0) && (
            <section>
              <SectionHeading label="Not counted above" />
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
                {summary.withheld > 0 && (
                  <Card variant="inset">
                    <p className="flex items-center gap-2" style={{ fontSize: 12.5, color: 'var(--ef-ink)' }}>
                      <EyeOff size={13} strokeWidth={1.6} style={{ color: 'var(--ef-text-muted)' }} />
                      {summary.withheld} paper{summary.withheld !== 1 ? 's' : ''} withheld
                    </p>
                    <p className="mt-1.5" style={{ fontSize: 11.5, color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                      Your examiner has your work but has not released the marks to students. Nothing
                      from these papers is in any figure on this page.
                    </p>
                  </Card>
                )}
                {summary.terminated > 0 && (
                  <Card variant="inset">
                    <p className="flex items-center gap-2" style={{ fontSize: 12.5, color: 'var(--ef-ink)' }}>
                      <ShieldAlert size={13} strokeWidth={1.6} style={{ color: 'var(--ef-danger)' }} />
                      {summary.terminated} sitting{summary.terminated !== 1 ? 's' : ''} ended early
                    </p>
                    <p className="mt-1.5" style={{ fontSize: 11.5, color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                      A sitting the institution ended carries no verdict, so it is left out of your
                      average and your trend rather than counted as a low mark. Speak to your examiner
                      if you think that is wrong.
                    </p>
                  </Card>
                )}
              </div>
            </section>
          )}

          <p className="text-center" style={{ fontSize: 11.5, color: 'var(--ef-text-muted)', lineHeight: 1.7 }}>
            Which sitting counts towards your record is decided by your institution — this page shows
            you all of them.
          </p>
        </div>
      )}
    </PageShell>
  );
}
