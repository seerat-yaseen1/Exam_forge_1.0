import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useNavigate } from 'react-router';
import {
  ClipboardList, Loader2, AlertTriangle, RefreshCw,
  Clock, Calendar, CheckCircle2, XCircle, PlayCircle,
  Timer, Layers, BookOpen, Award,
  ChevronRight, RotateCcw, Eye, ArrowRight, BarChart2,
  Shield, Laptop, GraduationCap,
} from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import {
  detectDeviceClass,
  deviceAllowed,
  effectiveDevicePolicy,
  type DeviceClass,
} from '../../../lib/deviceClass';
import { formatDate, formatDayMonthTime as formatDateTime } from '../../../lib/dateFormat';
import {
  getAssessmentsForStudent,
  type Assessment,
} from '../../../lib/assessmentService';
import {
  getAttemptsByStudent,
  type Attempt,
  type AttemptStatus,
} from '../../../lib/submissionService';
import { buildResultRows, studentResultVisibility } from '../../../lib/studentResults';
import {
  buildSchedule,
  canStillOpen,
  effectiveMaxAttempts,
  finishedCount,
  timeLeft,
  timeUntil,
  type ScheduleBucket,
  type ScheduleEntry,
} from '../../../lib/studentSchedule';
import { ResultsTab } from './ResultsTab';
import {
  Button, Card, Chip, EmptyState as EmptyPanel, ErrorBanner, LiveDot,
  LoadingBlock, PageHeader, PageShell,
} from '../../components/console/ui';

// ══════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════

/**
 * `results` is deliberately NOT part of the bucketing.
 *
 * Available / Missed / Submitted partition the list — every assessment lands
 * in exactly one of them. Results is a cross-cutting VIEW over the same data:
 * an exam with a submitted attempt and a retake still open belongs in
 * Available *and* in Results, and forcing it to choose would make a student
 * with a reattempt left pick between seeing the mark they already have and
 * seeing the button that lets them improve it. See ResultsTab.tsx.
 */
type TabKey = ScheduleBucket | 'results';

/**
 * The bucketing rule, the availability rule, the attempt-limit rule and the
 * two clock formatters all used to live here as module-private functions.
 * They moved to lib/studentSchedule.ts when the Overview page needed the same
 * answers — two screens deciding independently whether a student may open an
 * exam is precisely the disagreement the "mirrors the gate in
 * ExamBriefingPage" note in that module exists to prevent.
 */
type AssessmentWithMeta = ScheduleEntry;

// ══════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ══════════════════════════════════════════════════════════════════


// ── Attempt status indicator ──────────────────────────────────────

function AttemptStatusBadge({ status }: { status: AttemptStatus }) {
  if (status === 'in_progress') {
    return (
      <span className="flex items-center gap-2" style={{ fontSize: 13, color: 'var(--ef-warning)' }}>
        <span className="ef-pulse" style={{ ['--ef-success' as string]: 'var(--ef-warning)' }} />
        In progress
      </span>
    );
  }
  if (status === 'submitted' || status === 'auto_submitted') {
    return (
      <span className="flex items-center gap-1.5" style={{ fontSize: 13, color: 'var(--ef-success-strong)' }}>
        <CheckCircle2 size={12} strokeWidth={1.6} />
        {status === 'auto_submitted' ? 'Auto-submitted' : 'Submitted'}
      </span>
    );
  }
  if (status === 'terminated') {
    return (
      <span className="flex items-center gap-1.5" style={{ fontSize: 13, color: 'var(--ef-danger)' }}>
        <XCircle size={12} strokeWidth={1.6} />
        Terminated
      </span>
    );
  }
  return null;
}

// ── Score display ─────────────────────────────────────────────────

function ScoreDisplay({ attempt, assessment }: { attempt: Attempt; assessment: Assessment }) {
  // Through the audience helper rather than the legacy boolean. The two agree
  // on every document the builder writes (it keeps `showResults` in sync with
  // the students entry of `showResultsTo`), but the ARRAY is the authoritative
  // field — and the Results tab reads it that way. A card and a tab disagreeing
  // about whether a mark is released is the kind of split this codebase has
  // paid for before.
  if (studentResultVisibility(assessment) === 'withheld') {
    return (
      <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
        Results not shown
      </span>
    );
  }
  if (!attempt.scores) {
    return (
      <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
        Score pending
      </span>
    );
  }
  const { total, available, percentage, passed } = attempt.scores;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs" style={{ color: 'var(--ef-ink)' }}>
        {total}/{available}
      </span>
      {/* G-02: amber while `passed` is null — the paper is scored but not
          finished being marked, so the red "fail" styling would be a verdict
          nobody has reached. */}
      <span
        className="text-xs px-1.5 py-0.5"
        style={{
          background: passed === true ? 'var(--ef-success-bg)' : passed === false ? 'var(--ef-danger-bg)' : 'var(--ef-warning-bg)',
          color: passed === true ? 'var(--ef-success-strong)' : passed === false ? 'var(--ef-danger)' : 'var(--ef-warning)',
          border: `1px solid ${passed === true ? 'var(--ef-success-border)' : passed === false ? 'var(--ef-danger-border)' : 'var(--ef-warning-border)'}`,
          borderRadius: 'var(--ef-radius-pill)',
        }}
      >
        {percentage}%
      </span>
      {attempt.scores.requiresManualReview && (
        <span className="text-xs" style={{ color: 'var(--ef-warning)' }}>· awaiting marking</span>
      )}
    </div>
  );
}

// ── Assessment card ───────────────────────────────────────────────

function AssessmentCard({
  data,
  nowDate,
  index,
  studentId,
  deviceClass,
}: {
  data: AssessmentWithMeta;
  nowDate: Date;
  index: number;
  studentId: string;
  /**
   * Resolved once by the page and passed down, not detected per card. Reading
   * the browser in every row would do the same work N times for one answer
   * that cannot differ between them.
   */
  deviceClass: DeviceClass;
}) {
  const { assessment: a, attempt, allAttempts, availability } = data;
  const navigate = useNavigate();

  const sectionCount   = a.sections?.length ?? 0;
  const questionCount  = a.questions.length;
  const totalSectionTime = a.sections?.reduce((s, sec) => s + (sec.timeLimit ?? 0), 0) ?? 0;

  // ── Time display logic ────────────────────────────────────────
  // Show the countdown only when the student can actually still open the test
  // (window active + not blocked + attempts remaining OR resumable in-progress).
  const timeInfo = useMemo(() => {
    if (!a.endDate) return null;
    if (!canStillOpen(a, availability, allAttempts, studentId)) return null;
    return timeLeft(a.endDate, nowDate);
  }, [a, availability, allAttempts, studentId, nowDate]);

  // ── Reattempt indicator ───────────────────────────────────────
  // When the student has already submitted but still has chances left,
  // surface that explicitly so they don't think the card is a fresh test.
  const attemptInfo = useMemo(() => {
    const finished = finishedCount(allAttempts);
    if (finished === 0) return null;
    if (!canStillOpen(a, availability, allAttempts, studentId)) return null;
    return { used: finished, total: effectiveMaxAttempts(a, studentId) };
  }, [a, availability, allAttempts, studentId]);

  // ── Can this device sit this exam? ─────────────────────────────
  //
  // Asked HERE, on the card, and not only at the briefing. A student scanning
  // their list on a phone should be able to see at a glance which of these
  // they can start now and which need them to go and find a computer —
  // planning information, before they have committed to anything. Learning it
  // one exam at a time, after opening each briefing, is the same fact
  // delivered too late to be useful.
  const deviceOk = useMemo(
    () => deviceAllowed(deviceClass, effectiveDevicePolicy(a)),
    [deviceClass, a],
  );

  // ── Action button ──────────────────────────────────────────────
  const action = useMemo((): { label: string; icon: React.ReactNode; variant: 'primary' | 'secondary' } | null => {
    if (availability === 'upcoming') return null;

    // Primary: if the student can still open the test, that takes priority over
    // any "view results" action — even after a successful submission with slots left.
    if (canStillOpen(a, availability, allAttempts, studentId)) {
      // The wrong device does not remove the action, it changes it. A dead
      // greyed-out button would be the honest thing to show and the least
      // useful: the student still needs the exam's address to open it on a
      // computer, and the briefing is where they can copy it. So the card
      // sends them somewhere that helps rather than stopping them at a
      // control that does nothing.
      if (!deviceOk) {
        return {
          label: 'Needs a computer',
          icon: <Laptop size={12} strokeWidth={1.5} />,
          variant: 'secondary',
        };
      }
      const hasInProgress = allAttempts.some((at) => at.status === 'in_progress');
      if (hasInProgress) {
        return { label: 'Resume', icon: <RotateCcw size={12} strokeWidth={1.5} />, variant: 'primary' };
      }
      if (finishedCount(allAttempts) > 0) {
        return { label: 'Retake', icon: <RotateCcw size={12} strokeWidth={1.5} />, variant: 'primary' };
      }
      return { label: 'Begin', icon: <PlayCircle size={12} strokeWidth={1.5} />, variant: 'primary' };
    }

    // Secondary: window closed / attempts exhausted — surface results when allowed.
    const done = attempt?.status === 'submitted' || attempt?.status === 'auto_submitted';
    if (done) {
      const visibility = studentResultVisibility(a);
      if (visibility === 'review') {
        return { label: 'Review', icon: <Eye size={12} strokeWidth={1.5} />, variant: 'secondary' };
      }
      if (visibility === 'score') {
        return { label: 'Results', icon: <BarChart2 size={12} strokeWidth={1.5} />, variant: 'secondary' };
      }
    }

    return null;
  }, [a, attempt, allAttempts, availability, studentId, deviceOk]);

  // ── Why the student can't act (only when there's no primary action) ──
  // Surfaces an explicit reason next to the status badge so the absence of a
  // Begin/Retake button is never ambiguous.
  const noAccessReason = useMemo((): string | null => {
    if (canStillOpen(a, availability, allAttempts, studentId)) return null;
    if (availability === 'upcoming') return null; // upcoming is its own story
    if (a.blockedStudents?.includes(studentId)) return 'Blocked';
    if (availability === 'admin_closed' || availability === 'window_closed') {
      return 'Access closed';
    }
    if (finishedCount(allAttempts) > 0) {
      const lastTerminated = attempt?.status === 'terminated';
      return lastTerminated ? 'No attempts left' : 'Attempts exhausted';
    }
    return null;
  }, [a, attempt, allAttempts, availability, studentId]);

  // ── Status bar left side ───────────────────────────────────────
  const statusLeft = useMemo(() => {
    if (!attempt) {
      return <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Not started</span>;
    }
    return (
      <AttemptStatusBadge status={attempt.status} />
    );
  }, [attempt]);

  // ── Availability colours ───────────────────────────────────────
  const railColour =
    availability === 'available'     ? 'var(--ef-success)' :
    availability === 'upcoming'      ? 'var(--ef-info)' :
    'var(--ef-border-muted)';

  const go = () => {
    // The wrong-device action is styled secondary but belongs at the briefing,
    // not at results — that page carries the refusal explanation and the
    // copyable link. Keyed off deviceOk rather than the variant so the two
    // cannot drift.
    if (!action) return;
    if (action.variant === 'primary' || !deviceOk) navigate(`/student/exam/${a.id}/briefing`);
    else navigate(`/student/exam/${a.id}/results`);
  };

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index, 6) * 0.045, ease: [0.16, 1, 0.3, 1] }}
      className="ef-card flex"
      style={{ overflow: 'hidden' }}
    >
      <div className="ef-card-rail" style={{ background: railColour }} />

      <div className="flex-1" style={{ padding: 'var(--ef-pad-card)' }}>
        {/* Title + the badges that change what the student can do */}
        <div className="flex items-start justify-between gap-3 mb-2.5">
          <h3 style={{ fontSize: 15, lineHeight: 1.45, color: 'var(--ef-ink)', flex: 1, fontWeight: 500 }}>
            {a.title || <em style={{ color: 'var(--ef-text-muted)' }}>Untitled Assessment</em>}
          </h3>
          <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap justify-end">
            {/* ── What kind of exam this is ────────────────────────────
                The security tier reached the student nowhere at all before
                this: not on the card, not as a word on the briefing. A
                practice paper and a high-stake one looked identical in the
                list, which matters most for the practice one — a student who
                does not know it is practice treats a rehearsal as the real
                thing, which is the opposite of what it is for.

                'normal' gets no chip on purpose. It is the ordinary case, and
                a badge on every row is a badge that says nothing. */}
            {a.securityTier === 'mock' && (
              <Chip small icon={<GraduationCap size={9} strokeWidth={1.6} />}
                title="A practice exam. Not proctored, and the result does not count.">
                Practice
              </Chip>
            )}
            {a.securityTier === 'high_stake' && (
              <Chip small tone="accent" icon={<Shield size={9} strokeWidth={1.6} />}
                title="A high-stake exam. Camera, a clean browser, Safe Exam Browser and a computer are all required.">
                High-stake
              </Chip>
            )}
            {/* Only where it changes what the student can do — a laptop needs
                no badge telling it that it is a laptop. */}
            {!deviceOk && (
              <Chip small tone="warning" icon={<Laptop size={9} strokeWidth={1.6} />}
                title="This exam cannot be taken on this device. Open it on a laptop or desktop computer.">
                Computer only
              </Chip>
            )}
            {/* Reattempt badge — only when prior submission exists + chances left */}
            {attemptInfo && (
              <Chip small tone="warning" icon={<RotateCcw size={9} strokeWidth={1.6} />}
                title="You've already submitted this assessment but have a reattempt available.">
                Submitted {attemptInfo.used}× · {attemptInfo.total - attemptInfo.used} left
              </Chip>
            )}
            {timeInfo && (
              <Chip small tone={timeInfo.urgent ? 'danger' : 'success'} icon={<Clock size={9} strokeWidth={1.6} />}>
                {timeInfo.label}
              </Chip>
            )}
            {availability === 'upcoming' && a.startDate && (
              <Chip small tone="info" icon={<Calendar size={9} strokeWidth={1.6} />}>
                {timeUntil(a.startDate, nowDate)}
              </Chip>
            )}
            {(availability === 'window_closed' || availability === 'admin_closed') && (
              <Chip small>{availability === 'admin_closed' ? 'Closed' : 'Window closed'}</Chip>
            )}
          </div>
        </div>

        {/* What the paper is made of */}
        <div className="flex items-center gap-3.5 flex-wrap mb-3" style={{ fontSize: 13, color: 'var(--ef-text-muted)' }}>
          {a.subject && (
            <span className="flex items-center gap-1.5">
              <BookOpen size={11} strokeWidth={1.5} />
              {a.subject}
            </span>
          )}
          {sectionCount > 0 && (
            <span className="flex items-center gap-1.5">
              <Layers size={11} strokeWidth={1.5} />
              {sectionCount} section{sectionCount !== 1 ? 's' : ''}
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <ClipboardList size={11} strokeWidth={1.5} />
            {questionCount} question{questionCount !== 1 ? 's' : ''}
          </span>
          <span className="flex items-center gap-1.5">
            <Award size={11} strokeWidth={1.5} />
            {a.totalMarks} marks
          </span>
          {totalSectionTime > 0 && (
            <span className="flex items-center gap-1.5">
              <Timer size={11} strokeWidth={1.5} />
              {totalSectionTime}m
            </span>
          )}
          {a.passingScore !== undefined && <span>· Pass: {a.passingScore}%</span>}
        </div>

        {/* When it runs */}
        {(a.startDate || a.endDate) && (
          <div className="flex items-center gap-1.5 mb-3" style={{ fontSize: 13, color: 'var(--ef-text-muted)' }}>
            <Calendar size={11} strokeWidth={1.5} />
            <span>{a.startDate ? formatDateTime(a.startDate) : 'Open'}</span>
            {a.endDate && (
              <>
                <ArrowRight size={10} strokeWidth={1.5} style={{ color: 'var(--ef-border-muted)' }} />
                <span>{formatDateTime(a.endDate)}</span>
              </>
            )}
          </div>
        )}

        {a.sections && a.sections.length > 1 && (
          <div className="flex items-center gap-1.5 mb-3 flex-wrap">
            {a.sections.map((sec) => (
              <Chip key={sec.id} small>
                {sec.name}
                {sec.timeLimit ? ` · ${sec.timeLimit}m` : ''}
              </Chip>
            ))}
          </div>
        )}

        {/* Where the student stands, and the one thing they can do about it */}
        <div
          className="flex items-center justify-between gap-3 pt-3 flex-wrap"
          style={{ borderTop: '1px solid var(--ef-border-subtle)' }}
        >
          <div className="flex items-center gap-3.5 flex-wrap">
            {statusLeft}
            {noAccessReason && <Chip small>{noAccessReason}</Chip>}
            {attempt && (attempt.status === 'submitted' || attempt.status === 'auto_submitted') && (
              <ScoreDisplay attempt={attempt} assessment={a} />
            )}
            {attempt && attempt.integrityLog && attempt.integrityLog.totalViolations > 0 && (
              <span
                className="flex items-center gap-1"
                style={{ fontSize: 13, color: 'var(--ef-text-muted)' }}
                title={`${attempt.integrityLog.totalViolations} integrity violation(s) logged`}
              >
                <Shield size={11} strokeWidth={1.5} />
                {attempt.integrityLog.totalViolations}v
              </span>
            )}
          </div>

          {action && (
            <Button size="sm" variant={action.variant} onClick={go}>
              {action.icon}
              {action.label}
              <ChevronRight size={11} strokeWidth={1.6} />
            </Button>
          )}
        </div>
      </div>
    </motion.article>
  );
}

// ── Empty state ───────────────────────────────────────────────────

function EmptyState({ category }: { category: ScheduleBucket | 'all' }) {
  const messages: Record<ScheduleBucket | 'all', { icon: React.ReactNode; title: string; body: string }> = {
    all: {
      icon: <ClipboardList size={30} strokeWidth={1} />,
      title: 'No assessments yet',
      body: 'Assessments assigned to you will appear here once your administrator publishes them.',
    },
    available: {
      icon: <PlayCircle size={26} strokeWidth={1} />,
      title: 'Nothing available right now',
      body: 'Check back later — new assessments appear here as soon as they open.',
    },
    missed: {
      icon: <XCircle size={26} strokeWidth={1} />,
      title: 'Nothing missed',
      body: 'Assessments you did not submit before they closed would appear here.',
    },
    submitted: {
      icon: <CheckCircle2 size={26} strokeWidth={1} />,
      title: 'No submissions yet',
      body: 'Papers you have handed in appear here, with whatever your examiner has released.',
    },
  };
  const m = messages[category];
  return <EmptyPanel icon={m.icon} title={m.title} body={m.body} />;
}

// ══════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════

export function StudentAssessmentsPage() {
  const { session } = useStudentAuth();

  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [attempts, setAttempts]       = useState<Attempt[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [lastSynced, setLastSynced]   = useState<Date | null>(null);
  const [syncAge, setSyncAge]         = useState('');

  const [activeTab, setActiveTab] = useState<TabKey>('available');

  // Resolved once for the whole list. A browser does not change device class
  // while the page is open, so this is a constant for the session.
  const [deviceClass] = useState<DeviceClass>(() => detectDeviceClass());

  // Live clock — updates every 30s (good enough for the listing page)
  const [nowDate, setNowDate] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNowDate(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // ── Data fetch ────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError('');
    try {
      const [aList, attemptList] = await Promise.all([
        getAssessmentsForStudent(),
        getAttemptsByStudent(session.studentId),
      ]);
      setAssessments(aList);
      setAttempts(attemptList);
      setLastSynced(new Date());
    } catch (e: any) {
      console.error('[StudentAssessmentsPage] load error:', e);
      setError(e.message || 'Failed to load assessments.');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { load(); }, [load]);

  // Sync age ticker
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

  // ── Categorise ────────────────────────────────────────────────
  // The bucketing and its three sort orders live in lib/studentSchedule so the
  // Overview page leads with the same "most urgent" assessment this list puts
  // at the top.
  const buckets = useMemo(
    () => buildSchedule(assessments, attempts, session?.studentId ?? '', nowDate),
    [assessments, attempts, session?.studentId, nowDate],
  );

  // Results is built from the same two fetches, not a third one: every mark a
  // student is allowed to see is already on the attempt documents this page
  // loaded. Deliberately NOT dependent on `nowDate` — a result does not change
  // on the 30-second clock tick, and rebuilding these rows twice a minute
  // would remount every card in the tab.
  const resultRows = useMemo(() => {
    const byAssessment: Record<string, Attempt[]> = {};
    for (const at of attempts) (byAssessment[at.assessmentId] ??= []).push(at);
    return buildResultRows(assessments, byAssessment);
  }, [assessments, attempts]);

  const total = assessments.length;

  if (!session) return null;

  const counts: Record<TabKey, number> = {
    available: buckets.available.length,
    missed: buckets.missed.length,
    submitted: buckets.submitted.length,
    results: resultRows.length,
  };
  const TAB_LABELS: Record<TabKey, string> = {
    available: 'Available',
    missed: 'Missed',
    submitted: 'Submitted',
    results: 'Results',
  };

  // ── Render ────────────────────────────────────────────────────

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Assessments · {session.instituteName}
          </>
        }
        title="Your assessments"
        subtitle="Everything assigned to you, ordered by what runs out first."
        actions={
          <>
            {lastSynced && !loading && <LiveDot label={syncAge} />}
            <Button size="sm" onClick={load} disabled={loading} aria-label="Refresh assessments">
              <RefreshCw size={11} strokeWidth={1.6} className={loading ? 'animate-spin' : ''} />
              Refresh
            </Button>
          </>
        }
      />

      <AnimatePresence mode="wait">
        {loading && (
          <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <LoadingBlock label="Loading assessments…" rows={3} />
          </motion.div>
        )}

        {!loading && error && (
          <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <ErrorBanner message={error} onRetry={load} />
          </motion.div>
        )}

        {!loading && !error && total === 0 && (
          <motion.div key="empty-all" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <EmptyState category="all" />
          </motion.div>
        )}

        {!loading && !error && total > 0 && (
          <motion.div key="content" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {/* Tab strip */}
            <div
              className="flex items-center gap-1 mb-5 overflow-x-auto"
              role="tablist"
              aria-label="Assessment views"
              style={{ borderBottom: '1px solid var(--ef-border)' }}
            >
              {(['available', 'missed', 'submitted', 'results'] as TabKey[]).map((key) => {
                const isActive = activeTab === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setActiveTab(key)}
                    className="ef-nav-link"
                    aria-current={isActive ? 'page' : undefined}
                    style={{ marginBottom: -1, paddingLeft: 10, paddingRight: 10 }}
                  >
                    {TAB_LABELS[key]}
                    <span className="ef-chip ef-chip--sm" data-tone={isActive ? 'solid' : undefined}>
                      {counts[key]}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Active list */}
            {(() => {
              // Results is a different shape of answer, not a fourth list of
              // the same card — it renders per SITTING, and carries its own
              // empty state because "nothing here" means something different
              // in it (nothing finished yet, rather than nothing assigned).
              if (activeTab === 'results') return <ResultsTab rows={resultRows} />;

              const list = buckets[activeTab];
              if (list.length === 0) return <EmptyState category={activeTab} />;
              return (
                <div className="flex flex-col" style={{ gap: 'var(--ef-gap)' }}>
                  {list.map((d, i) => (
                    <AssessmentCard
                      key={d.assessment.id}
                      data={d}
                      nowDate={nowDate}
                      index={i}
                      studentId={session.studentId}
                      deviceClass={deviceClass}
                    />
                  ))}
                </div>
              );
            })()}

            <p className="mt-6 text-center" style={{ fontSize: 13, color: 'var(--ef-text-muted)' }}>
              {total} assessment{total !== 1 ? 's' : ''} assigned to your account
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </PageShell>
  );
}
