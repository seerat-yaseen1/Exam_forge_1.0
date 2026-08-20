/**
 * The student's Overview.
 *
 * ── WHAT CHANGED, AND WHY ─────────────────────────────────────────
 * This page used to list the student's academic mappings — which school, which
 * course, which section they had been placed in. Useful once, on the first
 * login, and never again: the information does not change, and it answers a
 * question nobody arrives at a dashboard asking.
 *
 * What they do arrive asking is "is there anything I have to do right now".
 * So the page now leads with the single most urgent assessment and a live
 * countdown to it, and the placement data has moved to the bottom, where it
 * still is when it is wanted.
 *
 * ── ONE RULE, THREE SCREENS ───────────────────────────────────────
 * The "most urgent" decision is `pickUpNext` in lib/studentSchedule, the same
 * module the assessment list sorts with. This page cannot lead with an exam
 * that the list does not have at the top, because both are reading the answer
 * out of one function rather than each deciding for itself.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion } from 'motion/react';
import { useNavigate } from 'react-router';
import {
  ArrowRight, BookOpen, Calendar, CheckCircle2, ChevronRight, ClipboardList,
  GraduationCap, Hash, Layers, PlayCircle, RefreshCw, RotateCcw, School,
  TrendingUp, Users, Group, Clock, Sparkles,
} from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { formatDayMonthTime } from '../../../lib/dateFormat';
import {
  getMappingsByStudent,
  type AcademicMapping,
  type NodeLevel,
} from '../../../lib/firebaseService';
import { getAssessmentsForStudent, type Assessment } from '../../../lib/assessmentService';
import { getAttemptsByStudent, type Attempt } from '../../../lib/submissionService';
import { buildResultRows, summariseResults } from '../../../lib/studentResults';
import {
  buildSchedule,
  countdownTo,
  pickUpNext,
  timeLeft,
  type UpNext,
} from '../../../lib/studentSchedule';
import {
  Button, Card, Chip, EmptyState, ErrorBanner, LiveDot, LoadingBlock,
  PageHeader, PageShell, SectionHeading, StatRow, StatTile,
} from '../../components/console/ui';

// ── Helpers ────────────────────────────────────────────────────────

function getGreeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function longDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

/**
 * A clock that ticks no faster than the thing it is driving needs.
 *
 * The countdown card wants seconds; the rest of the page wants a date that
 * changes at midnight. Re-rendering the whole page every second to keep a
 * "3d left" chip accurate is work nobody sees.
 */
function useTicker(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// ── Node level metadata ────────────────────────────────────────────

const LEVEL_CONFIG: Record<NodeLevel, { label: string; icon: React.ReactNode }> = {
  school:          { label: 'School',   icon: <School size={11} strokeWidth={1.6} /> },
  academicLevel:   { label: 'Level',    icon: <GraduationCap size={11} strokeWidth={1.6} /> },
  program:         { label: 'Program',  icon: <BookOpen size={11} strokeWidth={1.6} /> },
  academicSession: { label: 'Session',  icon: <Calendar size={11} strokeWidth={1.6} /> },
  academicYear:    { label: 'Year',     icon: <Hash size={11} strokeWidth={1.6} /> },
  semester:        { label: 'Semester', icon: <Layers size={11} strokeWidth={1.6} /> },
  course:          { label: 'Course',   icon: <BookOpen size={11} strokeWidth={1.6} /> },
  section:         { label: 'Section',  icon: <Users size={11} strokeWidth={1.6} /> },
  group:           { label: 'Group',    icon: <Group size={11} strokeWidth={1.6} /> },
};

const LEVEL_ORDER: NodeLevel[] = [
  'school', 'academicLevel', 'program', 'academicSession',
  'academicYear', 'semester', 'course', 'section', 'group',
];

// ══════════════════════════════════════════════════════════════════
// UP NEXT
// ══════════════════════════════════════════════════════════════════

/**
 * The countdown.
 *
 * Days and hours are dropped once they are zero rather than shown as "00d",
 * because a padded zero is a digit the eye has to read before discovering it
 * means nothing. Under an hour the seconds appear — that is the point at
 * which they stop being decoration and start being the information.
 */
function Countdown({ iso, now, urgent }: { iso: string; now: Date; urgent: boolean }) {
  const c = countdownTo(iso, now);
  if (c.expired) {
    return (
      <span className="ef-display" style={{ fontSize: 22, color: 'var(--ef-danger)' }}>
        Closed
      </span>
    );
  }

  const showSeconds = c.days === 0 && c.hours === 0;
  const parts: Array<[number, string]> = [];
  if (c.days > 0) parts.push([c.days, 'd']);
  if (c.days > 0 || c.hours > 0) parts.push([c.hours, 'h']);
  parts.push([c.minutes, 'm']);
  if (showSeconds) parts.push([c.seconds, 's']);

  return (
    <span
      className="ef-display flex items-baseline gap-1.5"
      style={{ fontSize: 26, lineHeight: 1, color: urgent ? 'var(--ef-danger)' : 'var(--ef-ink)' }}
      // The value changes every second; announcing each one would make a
      // screen reader unusable. The label beside it already says what the
      // number is counting down to.
      aria-hidden="true"
    >
      {parts.map(([value, unit]) => (
        <span key={unit}>
          {value}
          <span style={{ fontSize: 13, color: 'var(--ef-text-muted)', fontFamily: 'var(--font-sans)' }}>{unit}</span>
        </span>
      ))}
    </span>
  );
}

function UpNextCard({ up, now }: { up: UpNext; now: Date }) {
  const navigate = useNavigate();
  const a = up.entry.assessment;

  const urgency = up.deadline ? timeLeft(up.deadline, now) : null;
  const urgent = up.kind === 'resume' || (urgency?.urgent ?? false);

  const headline =
    up.kind === 'resume'   ? 'You have a sitting in progress'
    : up.kind === 'open'   ? 'Open now'
    : 'Scheduled next';

  const deadlineLabel =
    up.kind === 'upcoming' ? 'Opens in' : 'Closes in';

  const cta =
    up.kind === 'resume'   ? { label: 'Resume sitting', icon: <RotateCcw size={13} strokeWidth={1.6} /> }
    : up.kind === 'open'   ? { label: 'Begin', icon: <PlayCircle size={13} strokeWidth={1.6} /> }
    : null;

  return (
    <Card
      padded={false}
      style={{
        overflow: 'hidden',
        borderColor: urgent ? 'var(--ef-danger-border)' : 'var(--ef-accent-border)',
        boxShadow: 'var(--ef-shadow-md)',
      }}
    >
      {/* The accent band. It is the one place on the console where the
          student's theme is used at full strength — this card is the thing
          they are meant to look at first, and colour is how a page says so. */}
      <div
        style={{
          height: 3,
          background: urgent ? 'var(--ef-danger)' : 'var(--ef-accent)',
        }}
      />

      <div style={{ padding: 'calc(var(--ef-pad-card) + 4px)' }}>
        <div className="flex items-start justify-between gap-5 flex-wrap">
          <div style={{ minWidth: 240, flex: 1 }}>
            <div className="ef-eyebrow mb-2.5">
              <span
                className="ef-eyebrow-dot"
                style={urgent ? { background: 'var(--ef-danger)' } : undefined}
              />
              {headline}
            </div>

            <h2 className="ef-display" style={{ fontSize: 21, lineHeight: 1.25, color: 'var(--ef-ink)' }}>
              {a.title || 'Untitled Assessment'}
            </h2>

            <div
              className="flex items-center gap-3.5 flex-wrap mt-3"
              style={{ fontSize: 11.5, color: 'var(--ef-text-muted)' }}
            >
              {a.subject && (
                <span className="flex items-center gap-1.5">
                  <BookOpen size={11} strokeWidth={1.5} />
                  {a.subject}
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <ClipboardList size={11} strokeWidth={1.5} />
                {a.questions.length} question{a.questions.length !== 1 ? 's' : ''}
              </span>
              <span className="flex items-center gap-1.5">
                <Layers size={11} strokeWidth={1.5} />
                {a.totalMarks} marks
              </span>
              {up.deadline && (
                <span className="flex items-center gap-1.5">
                  <Calendar size={11} strokeWidth={1.5} />
                  {formatDayMonthTime(up.deadline)}
                </span>
              )}
            </div>
          </div>

          {up.deadline && (
            <div style={{ minWidth: 132 }}>
              <p
                style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ef-text-muted)' }}
              >
                {deadlineLabel}
              </p>
              <div className="mt-1.5">
                <Countdown iso={up.deadline} now={now} urgent={urgent} />
              </div>
              {/* The accessible version of the same fact, phrased once rather
                  than re-announced every second. */}
              <span className="sr-only">
                {deadlineLabel} {urgency?.label ?? ''}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap mt-5">
          {cta && (
            <Button variant="primary" onClick={() => navigate(`/student/exam/${a.id}/briefing`)}>
              {cta.icon}
              {cta.label}
            </Button>
          )}
          <Button onClick={() => navigate('/student/assessments')}>
            All assessments
            <ChevronRight size={12} strokeWidth={1.6} />
          </Button>
          {up.kind === 'resume' && (
            <span style={{ fontSize: 11.5, color: 'var(--ef-warning)' }}>
              An unfinished sitting is submitted automatically when its window closes.
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// PLACEMENT
// ══════════════════════════════════════════════════════════════════

function PlacementCard({ mappings }: { mappings: AcademicMapping[] }) {
  const grouped = useMemo(() => {
    const byLevel = new Map<NodeLevel, AcademicMapping[]>();
    for (const m of mappings) {
      if (!byLevel.has(m.nodeType)) byLevel.set(m.nodeType, []);
      byLevel.get(m.nodeType)!.push(m);
    }
    return LEVEL_ORDER
      .filter((l) => byLevel.has(l))
      .map((l) => ({ level: l, items: byLevel.get(l)! }));
  }, [mappings]);

  if (grouped.length === 0) return null;

  return (
    <Card>
      <div className="flex flex-col" style={{ gap: 14 }}>
        {grouped.map(({ level, items }) => (
          <div key={level} className="flex items-start gap-3 flex-wrap">
            <span
              className="flex items-center gap-1.5 flex-shrink-0"
              style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ef-text-muted)', width: 104, paddingTop: 3 }}
            >
              {LEVEL_CONFIG[level].icon}
              {LEVEL_CONFIG[level].label}
            </span>
            <div className="flex items-center gap-1.5 flex-wrap flex-1" style={{ minWidth: 200 }}>
              {items.map((m) => (
                <Chip key={m.id} title={m.breadcrumb}>
                  {m.nodeName}
                </Chip>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 pt-3" style={{ fontSize: 11, color: 'var(--ef-text-muted)', borderTop: '1px solid var(--ef-border-subtle)' }}>
        Your placement is managed by your institute administrator. Hover a tag to see its full path.
      </p>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════

export function StudentLandingPage() {
  const { session } = useStudentAuth();
  const navigate = useNavigate();

  const [mappings, setMappings]       = useState<AcademicMapping[]>([]);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [attempts, setAttempts]       = useState<Attempt[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [lastSynced, setLastSynced]   = useState<Date | null>(null);
  const [syncAge, setSyncAge]         = useState('');

  const now = useTicker(1000);

  const load = useCallback(async () => {
    if (!session?.studentId) return;
    setLoading(true);
    setError('');
    try {
      // Three reads, one round trip. The placement list is the slowest and the
      // least urgent of them, and running it after the assessments would have
      // the page's least important section gate its most important one.
      const [mapList, aList, attemptList] = await Promise.all([
        getMappingsByStudent(session.studentId),
        getAssessmentsForStudent(),
        getAttemptsByStudent(session.studentId),
      ]);
      setMappings(mapList);
      setAssessments(aList);
      setAttempts(attemptList);
      setLastSynced(new Date());
    } catch (e: any) {
      console.error('[StudentLandingPage] load error:', e);
      setError(e?.message || 'Failed to load your dashboard.');
    } finally {
      setLoading(false);
    }
  }, [session?.studentId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!lastSynced) return;
    const fmt = (d: Date) => {
      const s = Math.floor((Date.now() - d.getTime()) / 1000);
      if (s < 10) return 'just now';
      if (s < 60) return `${s}s ago`;
      return `${Math.floor(s / 60)}m ago`;
    };
    setSyncAge(fmt(lastSynced));
    const t = setInterval(() => setSyncAge(fmt(lastSynced)), 1000);
    return () => clearInterval(t);
  }, [lastSynced]);

  // ── Derived ───────────────────────────────────────────────────
  //
  // Bucketed against a MINUTE-resolution clock, not the one-second ticker that
  // drives the countdown. The buckets only change when a window opens or
  // closes, so recomputing them 60 times a minute would rebuild every card in
  // the page for an answer that changed once.
  const minuteKey = Math.floor(now.getTime() / 60_000);
  const buckets = useMemo(
    () => buildSchedule(assessments, attempts, session?.studentId ?? '', new Date(minuteKey * 60_000)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assessments, attempts, session?.studentId, minuteKey],
  );

  const upNext = useMemo(() => pickUpNext(buckets), [buckets]);

  const resultRows = useMemo(() => {
    const byAssessment: Record<string, Attempt[]> = {};
    for (const at of attempts) (byAssessment[at.assessmentId] ??= []).push(at);
    return buildResultRows(assessments, byAssessment);
  }, [assessments, attempts]);

  const summary = useMemo(() => summariseResults(resultRows), [resultRows]);

  const openNow = buckets.available.filter((e) => e.availability === 'available').length;

  if (!session) return null;

  const firstName = session.name.split(' ')[0] || session.name;

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            {longDate(now)}
          </>
        }
        title={
          <>
            {getGreeting(now.getHours())}, {firstName}.
          </>
        }
        subtitle={
          openNow > 0
            ? `You have ${openNow} assessment${openNow !== 1 ? 's' : ''} open right now.`
            : 'Nothing is open right now — here is where everything stands.'
        }
        actions={
          <>
            {lastSynced && !loading && <LiveDot label={syncAge} />}
            <Button size="sm" onClick={load} disabled={loading} aria-label="Refresh dashboard">
              <RefreshCw size={11} strokeWidth={1.6} className={loading ? 'animate-spin' : ''} />
              Refresh
            </Button>
          </>
        }
      >
        <div className="flex items-center gap-2 flex-wrap">
          <Chip tone={session.status === 'active' ? 'success' : 'muted'}>
            {session.status === 'active' ? 'Active' : 'Disabled'}
          </Chip>
          <Chip>{session.instituteName}</Chip>
          <span style={{ fontSize: 11.5, color: 'var(--ef-text-muted)', fontFamily: 'ui-monospace, monospace' }}>
            {session.email}
          </span>
        </div>
      </PageHeader>

      {error && (
        <div className="mb-6">
          <ErrorBanner message={error} onRetry={load} />
        </div>
      )}

      {loading ? (
        <LoadingBlock label="Loading your dashboard…" rows={3} />
      ) : (
        <div className="flex flex-col" style={{ gap: 28 }}>
          {/* ── Up next ── */}
          {upNext ? (
            <UpNextCard up={upNext} now={now} />
          ) : (
            <EmptyState
              icon={<CheckCircle2 size={28} strokeWidth={1} />}
              title="Nothing due"
              body="No assessment is open or scheduled for you at the moment. Anything your institute publishes will show up here first."
              action={
                <Button onClick={() => navigate('/student/assessments')}>
                  Browse assessments
                  <ChevronRight size={12} strokeWidth={1.6} />
                </Button>
              }
            />
          )}

          {/* ── At a glance ── */}
          <section>
            <SectionHeading label="At a glance" />
            <StatRow>
              <StatTile
                label="Open now"
                value={openNow}
                icon={<PlayCircle size={12} strokeWidth={1.6} />}
                tone={openNow > 0 ? 'accent' : undefined}
                sub={buckets.available.length - openNow > 0
                  ? `${buckets.available.length - openNow} scheduled`
                  : 'nothing waiting to open'}
                hint="Assessments you can start right now."
              />
              <StatTile
                label="Submitted"
                value={buckets.submitted.length}
                icon={<CheckCircle2 size={12} strokeWidth={1.6} />}
                sub={summary.awaitingMarking > 0 ? `${summary.awaitingMarking} still being marked` : 'all marked'}
                hint="Papers you have handed in."
              />
              <StatTile
                label="Missed"
                value={buckets.missed.length}
                icon={<Clock size={12} strokeWidth={1.6} />}
                tone={buckets.missed.length > 0 ? 'warning' : undefined}
                sub={buckets.missed.length > 0 ? 'closed without a submission' : 'none'}
                hint="Assessments that closed before you submitted."
              />
              <StatTile
                label="Average best"
                value={summary.averageBestPercentage !== null ? `${summary.averageBestPercentage}%` : '—'}
                icon={<TrendingUp size={12} strokeWidth={1.6} />}
                sub={summary.averageBestPercentage !== null
                  ? `across ${summary.settledCount} fully marked`
                  : 'no marked papers yet'}
                hint="Mean of your best sitting in each fully marked assessment. Papers still being marked are left out."
              />
            </StatRow>
          </section>

          {/* ── Recently released ── */}
          {resultRows.length > 0 && (
            <section>
              <SectionHeading
                label="Recent results"
                count={resultRows.length}
                action={
                  <Button size="sm" variant="ghost" onClick={() => navigate('/student/progress')}>
                    See progress
                    <ArrowRight size={11} strokeWidth={1.6} />
                  </Button>
                }
              />
              <div className="flex flex-col" style={{ gap: 'var(--ef-gap)' }}>
                {resultRows.slice(0, 3).map((row, i) => {
                  const entry = row.best ?? row.latest;
                  const pct = entry.attempt.scores?.percentage ?? null;
                  const withheld = row.visibility === 'withheld';
                  return (
                    <motion.button
                      key={row.assessment.id}
                      type="button"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.24, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
                      onClick={() =>
                        navigate(
                          `/student/exam/${row.assessment.id}/results?attempt=${encodeURIComponent(entry.attempt.id)}`,
                        )
                      }
                      className="ef-card ef-card--interactive flex items-center gap-4 text-left"
                      style={{ padding: 'var(--ef-pad-card)' }}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="truncate" style={{ fontSize: 13.5, color: 'var(--ef-ink)' }}>
                          {row.assessment.title || 'Untitled Assessment'}
                        </p>
                        <p className="truncate mt-1" style={{ fontSize: 11.5, color: 'var(--ef-text-muted)' }}>
                          {row.assessment.subject ? `${row.assessment.subject} · ` : ''}
                          {entry.attempt.submittedAt ? formatDayMonthTime(entry.attempt.submittedAt) : 'not submitted'}
                        </p>
                      </div>
                      {withheld ? (
                        <Chip small>Withheld</Chip>
                      ) : pct !== null ? (
                        <span className="ef-display" style={{ fontSize: 20, color: 'var(--ef-ink)' }}>
                          {pct}%
                        </span>
                      ) : (
                        <Chip small tone="warning">Awaiting marking</Chip>
                      )}
                      <ChevronRight size={14} strokeWidth={1.6} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
                    </motion.button>
                  );
                })}
              </div>
            </section>
          )}

          {/* ── Placement ── */}
          <section>
            <SectionHeading
              label="Your placement"
              count={mappings.length || undefined}
              hint="Where your institute has placed you in its academic structure."
            />
            {mappings.length > 0 ? (
              <PlacementCard mappings={mappings} />
            ) : (
              <EmptyState
                icon={<GraduationCap size={26} strokeWidth={1} />}
                title="No placement yet"
                body="You have not been assigned to any courses, sections or groups. Your institute administrator sets this up."
              />
            )}
          </section>

          <p className="text-center flex items-center justify-center gap-1.5" style={{ fontSize: 11.5, color: 'var(--ef-text-muted)' }}>
            <Sparkles size={11} strokeWidth={1.6} />
            Prefer a different look? Pick a theme from the palette icon in the header.
          </p>
        </div>
      )}
    </PageShell>
  );
}
