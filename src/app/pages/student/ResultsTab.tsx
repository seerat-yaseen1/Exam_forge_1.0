/**
 * ResultsTab — the fourth tab on the student's assessment list.
 *
 * The other three answer "what can I do": sit it, I missed it, I handed it in.
 * This one answers "what happened": what this exam released to me, and which
 * sitting the number describes.
 *
 * IT IS A VIEW, NOT A BUCKET. Available / Missed / Submitted partition the
 * list — every assessment lands in exactly one. Results cuts across all three:
 * an exam with a submitted attempt AND a retake still open appears in
 * Available and here, which is correct in both places. Making it a fourth
 * bucket would have meant a student with a reattempt left had to choose
 * between seeing the mark they already have and seeing the button that lets
 * them improve it.
 *
 * WHAT IT NEVER DOES is decide which attempt counts. That is an institutional
 * policy this platform does not encode — the roster offers staff a Latest/Best
 * toggle and the export offers three scopes, precisely because the answer
 * differs by institution. So both sittings are shown, plainly, and the note
 * under them says who decides.
 *
 * The selection logic is in lib/studentResults.ts and is tested there; this
 * file is rendering.
 */

import { useMemo } from 'react';
import { motion } from 'motion/react';
import { useNavigate } from 'react-router';
import {
  Award, BarChart2, BookOpen, CheckCircle2, ChevronRight, Eye,
  EyeOff, Layers, ShieldAlert, TrendingUp, AlertCircle, GraduationCap,
} from 'lucide-react';
import { formatDayMonthTime } from '../../../lib/dateFormat';
import type { Attempt } from '../../../lib/submissionService';
import {
  summariseResults,
  type ResultEntry,
  type ResultVisibility,
  type StudentResultRow,
} from '../../../lib/studentResults';

// ── Small shared bits ─────────────────────────────────────────────

function Chip({
  label, tone, icon, title,
}: {
  label: string;
  tone: 'pass' | 'fail' | 'pending' | 'muted';
  icon?: React.ReactNode;
  title?: string;
}) {
  // G-02, restated on this surface: pass/fail is THREE-STATE. Amber is not a
  // softer red — it means nobody has reached a verdict yet, and painting that
  // as a failure is the one thing a results screen must never do.
  const palette = {
    pass:    { bg: 'var(--ef-success-bg)', fg: 'var(--ef-success-strong)', bd: 'var(--ef-success-border)' },
    fail:    { bg: 'var(--ef-danger-bg)',  fg: 'var(--ef-danger)',         bd: 'var(--ef-danger-border)' },
    pending: { bg: '#FDF8EC',              fg: 'var(--ef-warning)',        bd: '#EBD9A8' },
    muted:   { bg: 'var(--ef-canvas)',     fg: 'var(--ef-text-muted)',     bd: 'var(--ef-border-muted)' },
  }[tone];

  return (
    <span
      className="text-xs px-2 py-0.5 flex items-center gap-1"
      style={{ background: palette.bg, color: palette.fg, border: `1px solid ${palette.bd}`, borderRadius: 2 }}
      title={title}
    >
      {icon}
      {label}
    </span>
  );
}

function passTone(attempt: Attempt): 'pass' | 'fail' | 'pending' {
  const p = attempt.scores?.passed;
  return p === true ? 'pass' : p === false ? 'fail' : 'pending';
}

function passLabel(attempt: Attempt): string {
  const p = attempt.scores?.passed;
  return p === true ? 'Passed' : p === false ? 'Did not pass' : 'Awaiting marking';
}

// ── One sitting's marks ───────────────────────────────────────────

function ScorePanel({
  entry, label, totalAttempts, visibility, onOpen, deltaPoints,
}: {
  entry: ResultEntry;
  label: string;
  /**
   * EVERY sitting on this paper, not just the finished ones — the attempt
   * number is an ordinal over all of them, so a denominator counting only
   * finished sittings could print "Attempt 3 of 2" to a student who has a
   * retake open.
   */
  totalAttempts: number;
  visibility: ResultVisibility;
  onOpen: () => void;
  /**
   * Percentage points this panel is ahead of the other one. Only ever passed
   * to the BEST panel, and only when both sittings carry a mark — a gap
   * measured against a sitting that was never scored is not a gap.
   */
  deltaPoints?: number | null;
}) {
  const { attempt } = entry;
  const scores = attempt.scores;
  const terminated = attempt.status === 'terminated';

  return (
    <div
      className="flex-1 px-4 py-3"
      style={{
        background: 'var(--ef-canvas-raised)',
        border: '1px solid var(--ef-border)',
        borderRadius: 3,
        minWidth: 200,
      }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
          {label}
        </p>
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
          Attempt {entry.attemptNumber} of {totalAttempts}
        </span>
      </div>

      {scores ? (
        <>
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-2xl font-light" style={{ color: 'var(--ef-ink)', letterSpacing: '0.01em' }}>
              {scores.percentage}%
            </span>
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
              {scores.total}/{scores.available} marks
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap mb-2">
            {/* A voided sitting gets no pass/fail verdict, even though the
                scorer computed one. "Passed" on a sitting the institution
                ended for an integrity violation is the platform contradicting
                the decision — the marks are shown, the verdict is not. */}
            {terminated
              ? <Chip label="Terminated" tone="fail" icon={<ShieldAlert size={9} strokeWidth={1.5} />} />
              : <Chip label={passLabel(attempt)} tone={passTone(attempt)} />}
            {entry.provisional && (
              <Chip
                label="Not final"
                tone="pending"
                icon={<AlertCircle size={9} strokeWidth={1.5} />}
                title="Some answers are still being marked — this score can still change."
              />
            )}
            {deltaPoints != null && deltaPoints > 0 && (
              <Chip
                label={`+${deltaPoints} pts`}
                tone="muted"
                icon={<TrendingUp size={9} strokeWidth={1.5} />}
                title="Percentage points ahead of your latest sitting."
              />
            )}
          </div>
        </>
      ) : (
        // A finished sitting with no scores document. Rare — grading runs at
        // submission — but it happens to a sitting cut off before any section
        // was marked, and "no marks recorded" is the honest thing to print
        // rather than a 0% the student did not earn.
        <p className="text-sm mb-2" style={{ color: 'var(--ef-text-muted)' }}>
          No marks recorded
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
          {terminated && 'Ended early'}
          {terminated && attempt.submittedAt && ' · '}
          {attempt.submittedAt ? formatDayMonthTime(attempt.submittedAt) : ''}
        </span>
        <button
          onClick={onOpen}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 transition-opacity hover:opacity-75"
          style={{
            background: 'var(--ef-surface)',
            color: 'var(--ef-text-subtle)',
            border: '1px solid var(--ef-border)',
            borderRadius: 2,
            cursor: 'pointer',
          }}
        >
          {visibility === 'review'
            ? <><Eye size={11} strokeWidth={1.5} />Review</>
            : <><BarChart2 size={11} strokeWidth={1.5} />Results</>}
          <ChevronRight size={10} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}

// ── One assessment ────────────────────────────────────────────────

function ResultRow({ row, index }: { row: StudentResultRow; index: number }) {
  const navigate = useNavigate();
  const a = row.assessment;

  // The attempt id rides in the query string so a link can name a SPECIFIC
  // sitting. Without it the results page always resolves to the most recent
  // one, which would make the Best panel's button open the Latest panel's
  // marks — the exact confusion this tab exists to remove.
  const open = (attemptId: string) =>
    navigate(`/student/exam/${a.id}/results?attempt=${encodeURIComponent(attemptId)}`);

  const deltaPoints = useMemo(() => {
    if (!row.best || row.latestIsBest) return null;
    const b = row.best.attempt.scores?.percentage;
    const l = row.latest.attempt.scores?.percentage;
    if (b == null || l == null) return null;
    return Math.round((b - l) * 10) / 10;
  }, [row]);

  const withheld = row.visibility === 'withheld';

  // The bar reports the row's HEADLINE sitting — their best where they have
  // one, otherwise the latest. `best` is never terminated (see
  // pickBestAttempt), so the terminated arm is reached only when every
  // finished sitting was voided, and a green "passed" bar over that row would
  // be the worst possible summary of it.
  const headline = (row.best ?? row.latest).attempt;
  const barColor =
    withheld ? 'var(--ef-text-muted)'
    : headline.status === 'terminated' ? 'var(--ef-danger)'
    : passTone(headline) === 'pass' ? 'var(--ef-success-strong)'
    : passTone(headline) === 'fail' ? 'var(--ef-danger)'
    : 'var(--ef-warning)';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: index * 0.05, ease: [0.16, 1, 0.3, 1] }}
      style={{
        background: 'var(--ef-surface)',
        border: '1px solid var(--ef-border)',
        borderRadius: 3,
        overflow: 'hidden',
        display: 'flex',
      }}
    >
      <div style={{ width: 3, background: barColor, flexShrink: 0 }} />

      <div className="flex-1 px-4 py-4">
        {/* Title + what this exam releases */}
        <div className="flex items-start justify-between gap-3 mb-2">
          <p className="text-sm" style={{ color: 'var(--ef-ink)', lineHeight: 1.5, flex: 1 }}>
            {a.title || <em style={{ color: 'var(--ef-text-muted)' }}>Untitled Assessment</em>}
          </p>
          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
            {a.securityTier === 'mock' && (
              <Chip
                label="Practice"
                tone="muted"
                icon={<GraduationCap size={9} strokeWidth={1.5} />}
                title="A practice exam. The result does not count."
              />
            )}
            {withheld && (
              <Chip
                label="Results withheld"
                tone="muted"
                icon={<EyeOff size={9} strokeWidth={1.5} />}
                title="Your examiner has not released marks for this assessment to students."
              />
            )}
            {row.finishedCount > 1 && (
              <Chip label={`${row.finishedCount} sittings`} tone="muted" />
            )}
          </div>
        </div>

        {/* Meta */}
        <div className="flex items-center gap-3 flex-wrap mb-3">
          {a.subject && (
            <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
              <BookOpen size={10} strokeWidth={1.5} />
              {a.subject}
            </span>
          )}
          <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
            <Award size={10} strokeWidth={1.5} />
            {a.totalMarks} marks
          </span>
          {(a.sections?.length ?? 0) > 0 && (
            <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
              <Layers size={10} strokeWidth={1.5} />
              {a.sections!.length} section{a.sections!.length !== 1 ? 's' : ''}
            </span>
          )}
          {a.passingScore !== undefined && (
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
              · Pass: {a.passingScore}%
            </span>
          )}
        </div>

        {withheld ? (
          /* No marks, and the reason for it — the whole point of the tab is
             that "nothing shown" is never left to be guessed at. */
          <div
            className="flex items-start gap-2.5 px-4 py-3"
            style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
          >
            <EyeOff size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <p className="text-xs" style={{ color: 'var(--ef-text-subtle)', lineHeight: 1.6 }}>
                Your submission was recorded
                {row.latest.attempt.submittedAt ? ` on ${formatDayMonthTime(row.latest.attempt.submittedAt)}` : ''}.
                Marks for this assessment are not released to students.
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                Your examiner has your paper and will share feedback separately.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex gap-3 flex-wrap">
              <ScorePanel
                entry={row.latest}
                label={row.latestIsBest ? 'LATEST · BEST' : 'LATEST'}
                totalAttempts={row.attemptCount}
                visibility={row.visibility}
                onOpen={() => open(row.latest.attempt.id)}
              />
              {/* Only when it is a DIFFERENT sitting. Two identical panels
                  under two headings reads as a rendering fault. */}
              {row.best && !row.latestIsBest && (
                <ScorePanel
                  entry={row.best}
                  label="BEST"
                  totalAttempts={row.attemptCount}
                  visibility={row.visibility}
                  onOpen={() => open(row.best!.attempt.id)}
                  deltaPoints={deltaPoints}
                />
              )}
            </div>

            {/* Which one counts is not ours to say — see the module header. */}
            {row.best && !row.latestIsBest && (
              <p className="text-xs mt-3" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                You sat this {row.finishedCount} times. Both your latest and your best sitting are shown —
                which one counts towards your record is decided by your institution.
              </p>
            )}

            {/* Every finished sitting was voided. Said plainly, because the
                absence of a Best panel is otherwise indistinguishable from a
                layout that only ever shows one. */}
            {!row.best && (
              <div className="flex items-start gap-2 mt-3">
                <ShieldAlert size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0, marginTop: 2 }} />
                <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                  No sitting counts as your best: your finished attempts on this assessment were ended early.
                  Speak to your examiner if you think that is wrong.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}

// ── Summary strip ─────────────────────────────────────────────────

function SummaryStrip({ rows }: { rows: StudentResultRow[] }) {
  const s = useMemo(() => summariseResults(rows), [rows]);

  const tiles: Array<{ label: string; value: string; sub?: string; hint?: string }> = [
    { label: 'Released', value: String(s.released), hint: 'Assessments whose marks you can see.' },
  ];
  if (s.awaitingMarking > 0) {
    tiles.push({
      label: 'Being marked',
      value: String(s.awaitingMarking),
      hint: 'Shown, but the score can still change.',
    });
  }
  if (s.withheld > 0) {
    tiles.push({
      label: 'Withheld',
      value: String(s.withheld),
      hint: 'Submitted; marks not released to students.',
    });
  }
  if (s.averageBestPercentage !== null) {
    tiles.push({
      label: 'Average best',
      value: `${s.averageBestPercentage}%`,
      // The denominator is printed rather than left to a tooltip. An average
      // whose population is invisible invites the reader to assume it covers
      // everything they have sat, which it does not — half-marked papers are
      // deliberately out of it.
      sub: `across ${s.settledCount} fully marked`,
      hint: 'Mean of your best sitting in each fully marked assessment. Papers still being marked are left out.',
    });
  }

  return (
    <div
      className="flex items-stretch flex-wrap mb-5"
      style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
    >
      {tiles.map((t, i) => (
        <div
          key={t.label}
          className="px-4 py-3"
          style={{
            borderLeft: i === 0 ? 'none' : '1px solid var(--ef-border-subtle)',
            minWidth: 130,
          }}
          title={t.hint}
        >
          <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>
            {t.label}
          </p>
          <p className="text-sm" style={{ color: 'var(--ef-ink)' }}>{t.value}</p>
          {t.sub && (
            <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>{t.sub}</p>
          )}
        </div>
      ))}
    </div>
  );
}

// ── The tab ───────────────────────────────────────────────────────

export function ResultsTab({ rows }: { rows: StudentResultRow[] }) {
  if (rows.length === 0) {
    return (
      <div
        className="flex flex-col items-center py-10"
        style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border-subtle)', borderRadius: 3 }}
      >
        <CheckCircle2 size={20} strokeWidth={1} style={{ color: 'var(--ef-border-muted)' }} />
        <p className="text-xs mt-3" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>
          No results yet
        </p>
        <p className="text-xs mt-1 text-center" style={{ color: 'var(--ef-border-muted)', maxWidth: 320, lineHeight: 1.7 }}>
          Once you finish an assessment, whatever your examiner releases to you — your marks, and your
          answers where review is allowed — appears here.
        </p>
      </div>
    );
  }

  return (
    <div>
      <SummaryStrip rows={rows} />
      <div className="space-y-3">
        {rows.map((row, i) => (
          <ResultRow key={row.assessment.id} row={row} index={i} />
        ))}
      </div>
    </div>
  );
}
