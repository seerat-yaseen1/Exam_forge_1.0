import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useNavigate } from 'react-router';
import {
  ClipboardList, Loader2, AlertTriangle, RefreshCw,
  Clock, Calendar, CheckCircle2, XCircle, PlayCircle,
  Timer, Layers, BookOpen, Award,
  ChevronRight, RotateCcw, Eye, ArrowRight, BarChart2,
  Shield,
} from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import {
  getAssessmentsForStudent,
  type Assessment,
} from '../../../lib/assessmentService';
import {
  getAttemptsByStudent,
  type Attempt,
  type AttemptStatus,
} from '../../../lib/submissionService';

// ══════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════

type AvailabilityState = 'available' | 'upcoming' | 'window_closed' | 'admin_closed';

type AssessmentWithMeta = {
  assessment: Assessment;
  attempt: Attempt | undefined;
  allAttempts: Attempt[];
  availability: AvailabilityState;
};

const FINISHED_STATUSES: AttemptStatus[] = ['submitted', 'auto_submitted', 'terminated'];

/**
 * The student can still open/access the test when the window is active AND
 * they're not blocked AND either an in-progress attempt exists to resume OR
 * they have remaining attempts (respecting per-student override). Mirrors the
 * gate in ExamBriefingPage so the card and the briefing never disagree.
 */
function canStillOpen(
  a: Assessment,
  availability: AvailabilityState,
  allAttempts: Attempt[],
  studentId: string,
): boolean {
  if (availability !== 'available') return false;
  if (a.blockedStudents?.includes(studentId)) return false;

  const effMax = a.attemptOverrides?.[studentId] ?? a.maxAttempts ?? 1;
  const finished = allAttempts.filter((at) => FINISHED_STATUSES.includes(at.status)).length;
  if (finished >= effMax) return false; // matches ExamBriefingPage attempt-limit gate

  // Slots remaining: either resume an in-progress attempt or start a fresh one.
  return true;
}

type TabKey = 'available' | 'missed' | 'submitted';

/**
 * Tab bucketing rule:
 *  - available: student can still open the test now (or window not yet open)
 *  - submitted: has at least one finished attempt and can NOT still open
 *  - missed:    everything else (window closed/blocked, never submitted)
 *
 * A card with prior submissions AND a remaining attempt stays in `available`
 * — the card itself surfaces a "Submitted N×" badge so the student knows.
 */
function classifyForTab(
  a: Assessment,
  availability: AvailabilityState,
  allAttempts: Attempt[],
  studentId: string,
): TabKey {
  if (canStillOpen(a, availability, allAttempts, studentId)) return 'available';
  if (availability === 'upcoming') return 'available';

  const finished = allAttempts.filter((at) => FINISHED_STATUSES.includes(at.status)).length;
  if (finished > 0) return 'submitted';
  return 'missed';
}

// ══════════════════════════════════════════════════════════════════
// PURE HELPERS
// ══════════════════════════════════════════════════════════════════

function getAvailability(a: Assessment, now: Date): AvailabilityState {
  if (a.status === 'closed') return 'admin_closed';

  const start = a.startDate ? new Date(a.startDate) : null;
  const end   = a.endDate   ? new Date(a.endDate)   : null;

  if (start && now < start) return 'upcoming';
  if (end   && now > end)   return 'window_closed';
  return 'available';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function timeLeft(endIso: string, now: Date): { label: string; urgent: boolean } {
  const diff = new Date(endIso).getTime() - now.getTime();
  if (diff <= 0) return { label: 'ended', urgent: true };
  const totalMin = Math.floor(diff / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const days = Math.floor(h / 24);
  if (days >= 2)  return { label: `${days}d left`,          urgent: false };
  if (days === 1) return { label: `1d ${h % 24}h left`,     urgent: false };
  if (h > 0)      return { label: `${h}h ${m}m left`,       urgent: h < 2  };
  return              { label: `${m}m left`,                 urgent: m < 30 };
}

function timeUntil(startIso: string, now: Date): string {
  const diff = new Date(startIso).getTime() - now.getTime();
  if (diff <= 0) return 'starting soon';
  const totalMin = Math.floor(diff / 60000);
  const h = Math.floor(totalMin / 60);
  const days = Math.floor(h / 24);
  if (days >= 1) return `in ${days}d ${h % 24}h`;
  if (h > 0)     return `in ${h}h ${totalMin % 60}m`;
  return `in ${totalMin}m`;
}

// ══════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ══════════════════════════════════════════════════════════════════


// ── Attempt status indicator ──────────────────────────────────────

function AttemptStatusBadge({ status, autoTerminated }: { status: AttemptStatus; autoTerminated?: boolean }) {
  if (status === 'in_progress') {
    return (
      <div className="flex items-center gap-1.5">
        <div className="relative w-2 h-2">
          <span
            className="absolute inline-flex w-2 h-2 rounded-full opacity-70"
            style={{ background: '#92680A', animation: 'ping 1.8s cubic-bezier(0,0,0.2,1) infinite' }}
          />
          <span className="relative inline-flex w-1.5 h-1.5 rounded-full" style={{ background: '#92680A', margin: '1px' }} />
        </div>
        <span className="text-xs" style={{ color: '#92680A' }}>In progress</span>
      </div>
    );
  }
  if (status === 'submitted' || status === 'auto_submitted') {
    return (
      <div className="flex items-center gap-1.5">
        <CheckCircle2 size={12} strokeWidth={1.5} style={{ color: '#1E7B3C' }} />
        <span className="text-xs" style={{ color: '#1E7B3C' }}>
          {status === 'auto_submitted' ? 'Auto-submitted' : 'Submitted'}
        </span>
      </div>
    );
  }
  if (status === 'terminated') {
    return (
      <div className="flex items-center gap-1.5">
        <XCircle size={12} strokeWidth={1.5} style={{ color: '#9B2828' }} />
        <span className="text-xs" style={{ color: '#9B2828' }}>Terminated</span>
      </div>
    );
  }
  return null;
}

// ── Score display ─────────────────────────────────────────────────

function ScoreDisplay({ attempt, assessment }: { attempt: Attempt; assessment: Assessment }) {
  if (!assessment.showResults) {
    return (
      <span className="text-xs" style={{ color: '#C4C3BD' }}>
        Results not shown
      </span>
    );
  }
  if (!attempt.scores) {
    return (
      <span className="text-xs" style={{ color: '#C4C3BD' }}>
        Score pending
      </span>
    );
  }
  const { total, available, percentage, passed } = attempt.scores;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs" style={{ color: '#0C0C0B' }}>
        {total}/{available}
      </span>
      {/* G-02: amber while `passed` is null — the paper is scored but not
          finished being marked, so the red "fail" styling would be a verdict
          nobody has reached. */}
      <span
        className="text-xs px-1.5 py-0.5"
        style={{
          background: passed === true ? '#F0F9F4' : passed === false ? '#FDF5F5' : '#FDF8EC',
          color: passed === true ? '#1E7B3C' : passed === false ? '#9B2828' : '#92680A',
          border: `1px solid ${passed === true ? '#B8E6C8' : passed === false ? '#F2CECE' : '#EBD9A8'}`,
          borderRadius: 2,
        }}
      >
        {percentage}%
      </span>
      {attempt.scores.requiresManualReview && (
        <span className="text-xs" style={{ color: '#92680A' }}>· awaiting marking</span>
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
}: {
  data: AssessmentWithMeta;
  nowDate: Date;
  index: number;
  studentId: string;
}) {
  const { assessment: a, attempt, allAttempts, availability } = data;
  const [hovered, setHovered] = useState(false);
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
    const finished = allAttempts.filter((at) => FINISHED_STATUSES.includes(at.status)).length;
    if (finished === 0) return null;
    if (!canStillOpen(a, availability, allAttempts, studentId)) return null;
    const effMax = a.attemptOverrides?.[studentId] ?? a.maxAttempts ?? 1;
    return { used: finished, total: effMax };
  }, [a, availability, allAttempts, studentId]);

  // ── Action button ──────────────────────────────────────────────
  const action = useMemo((): { label: string; icon: React.ReactNode; variant: 'primary' | 'secondary' } | null => {
    if (availability === 'upcoming') return null;

    // Primary: if the student can still open the test, that takes priority over
    // any "view results" action — even after a successful submission with slots left.
    if (canStillOpen(a, availability, allAttempts, studentId)) {
      const hasInProgress = allAttempts.some((at) => at.status === 'in_progress');
      if (hasInProgress) {
        return { label: 'Resume', icon: <RotateCcw size={12} strokeWidth={1.5} />, variant: 'primary' };
      }
      const finishedCount = allAttempts.filter((at) => FINISHED_STATUSES.includes(at.status)).length;
      if (finishedCount > 0) {
        return { label: 'Retake', icon: <RotateCcw size={12} strokeWidth={1.5} />, variant: 'primary' };
      }
      return { label: 'Begin', icon: <PlayCircle size={12} strokeWidth={1.5} />, variant: 'primary' };
    }

    // Secondary: window closed / attempts exhausted — surface results when allowed.
    const done = attempt?.status === 'submitted' || attempt?.status === 'auto_submitted';
    if (done) {
      if (a.showResults && a.allowReview) {
        return { label: 'Review', icon: <Eye size={12} strokeWidth={1.5} />, variant: 'secondary' };
      }
      if (a.showResults) {
        return { label: 'Results', icon: <BarChart2 size={12} strokeWidth={1.5} />, variant: 'secondary' };
      }
    }

    return null;
  }, [a, attempt, allAttempts, availability, studentId]);

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
    const finished = allAttempts.filter((at) => FINISHED_STATUSES.includes(at.status)).length;
    if (finished > 0) {
      const lastTerminated = attempt?.status === 'terminated';
      return lastTerminated ? 'No attempts left' : 'Attempts exhausted';
    }
    return null;
  }, [a, attempt, allAttempts, availability, studentId]);

  // ── Status bar left side ───────────────────────────────────────
  const statusLeft = useMemo(() => {
    if (!attempt) {
      return <span className="text-xs" style={{ color: '#C4C3BD' }}>Not started</span>;
    }
    return (
      <AttemptStatusBadge
        status={attempt.status}
        autoTerminated={attempt.integrityLog?.autoTerminated}
      />
    );
  }, [attempt]);

  // ── Availability colours ───────────────────────────────────────
  const leftBarColor =
    availability === 'available'     ? '#1E7B3C' :
    availability === 'upcoming'      ? '#4A6FA5' :
    availability === 'window_closed' ? '#9A9891' :
    '#6B6B66';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: index * 0.05, ease: [0.16, 1, 0.3, 1] }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? '#FAFAF8' : '#FFFFFF',
        border: '1px solid #E3E1DB',
        borderRadius: 3,
        overflow: 'hidden',
        transition: 'background 0.15s',
        display: 'flex',
      }}
    >
      {/* Left colour bar */}
      <div style={{ width: 3, background: leftBarColor, flexShrink: 0 }} />

      {/* Card body */}
      <div className="flex-1 px-4 py-4">

        {/* Top row: title + time indicator */}
        <div className="flex items-start justify-between gap-3 mb-2">
          <p className="text-sm" style={{ color: '#0C0C0B', lineHeight: 1.5, flex: 1 }}>
            {a.title || <em style={{ color: '#B0AEA8' }}>Untitled Assessment</em>}
          </p>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Reattempt badge — only when prior submission exists + chances left */}
            {attemptInfo && (
              <span
                className="text-xs px-2 py-0.5 flex items-center gap-1"
                style={{
                  background: '#FFF7E6',
                  color: '#8B5E1A',
                  border: '1px solid #F0DFA0',
                  borderRadius: 2,
                }}
                title="You've already submitted this assessment but have a reattempt available."
              >
                <RotateCcw size={9} strokeWidth={1.5} />
                Submitted {attemptInfo.used}× · {attemptInfo.total - attemptInfo.used} left
              </span>
            )}
            {/* Time left badge for available */}
            {timeInfo && (
              <span
                className="text-xs px-2 py-0.5 flex items-center gap-1"
                style={{
                  background: timeInfo.urgent ? '#FDF5F5' : '#F0F9F4',
                  color: timeInfo.urgent ? '#9B2828' : '#1E7B3C',
                  border: `1px solid ${timeInfo.urgent ? '#F2CECE' : '#B8E6C8'}`,
                  borderRadius: 2,
                }}
              >
                <Clock size={9} strokeWidth={1.5} />
                {timeInfo.label}
              </span>
            )}
            {/* Upcoming badge */}
            {availability === 'upcoming' && a.startDate && (
              <span
                className="text-xs px-2 py-0.5 flex items-center gap-1"
                style={{
                  background: '#EEF3FB',
                  color: '#4A6FA5',
                  border: '1px solid #C8D8F0',
                  borderRadius: 2,
                }}
              >
                <Calendar size={9} strokeWidth={1.5} />
                {timeUntil(a.startDate, nowDate)}
              </span>
            )}
            {/* Closed badge */}
            {(availability === 'window_closed' || availability === 'admin_closed') && (
              <span
                className="text-xs px-2 py-0.5"
                style={{
                  background: '#F5F5F5',
                  color: '#6B6B66',
                  border: '1px solid #DDDBD5',
                  borderRadius: 2,
                }}
              >
                {availability === 'admin_closed' ? 'Closed' : 'Window closed'}
              </span>
            )}
          </div>
        </div>

        {/* Meta pills row */}
        <div className="flex items-center gap-3 flex-wrap mb-3">
          {a.subject && (
            <span className="flex items-center gap-1 text-xs" style={{ color: '#6B6B66' }}>
              <BookOpen size={10} strokeWidth={1.5} style={{ color: '#9A9891' }} />
              {a.subject}
            </span>
          )}
          {sectionCount > 0 && (
            <span className="flex items-center gap-1 text-xs" style={{ color: '#9A9891' }}>
              <Layers size={10} strokeWidth={1.5} />
              {sectionCount} section{sectionCount !== 1 ? 's' : ''}
            </span>
          )}
          <span className="flex items-center gap-1 text-xs" style={{ color: '#9A9891' }}>
            <ClipboardList size={10} strokeWidth={1.5} />
            {questionCount} question{questionCount !== 1 ? 's' : ''}
          </span>
          <span className="flex items-center gap-1 text-xs" style={{ color: '#9A9891' }}>
            <Award size={10} strokeWidth={1.5} />
            {a.totalMarks} marks
          </span>
          {totalSectionTime > 0 && (
            <span className="flex items-center gap-1 text-xs" style={{ color: '#9A9891' }}>
              <Timer size={10} strokeWidth={1.5} />
              {totalSectionTime}m
            </span>
          )}
          {a.passingScore !== undefined && (
            <span className="text-xs" style={{ color: '#9A9891' }}>
              · Pass: {a.passingScore}%
            </span>
          )}
        </div>

        {/* Date range */}
        {(a.startDate || a.endDate) && (
          <div className="flex items-center gap-1.5 mb-3">
            <Calendar size={10} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
            <span className="text-xs" style={{ color: '#C4C3BD' }}>
              {a.startDate ? formatDateTime(a.startDate) : 'Open'}
            </span>
            {a.endDate && (
              <>
                <ArrowRight size={9} strokeWidth={1.5} style={{ color: '#DDDBD5' }} />
                <span className="text-xs" style={{ color: '#C4C3BD' }}>
                  {formatDateTime(a.endDate)}
                </span>
              </>
            )}
          </div>
        )}

        {/* Section breakdown (subtle) */}
        {a.sections && a.sections.length > 1 && (
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {a.sections.map((sec, si) => (
              <span
                key={sec.id}
                className="text-xs px-2 py-0.5"
                style={{
                  background: '#F7F6F3',
                  color: '#9A9891',
                  border: '1px solid #E3E1DB',
                  borderRadius: 2,
                }}
              >
                {sec.name}
                {sec.timeLimit ? ` · ${sec.timeLimit}m` : ''}
              </span>
            ))}
          </div>
        )}

        {/* Bottom row: attempt status + score + action */}
        <div
          className="flex items-center justify-between gap-3 pt-3"
          style={{ borderTop: '1px solid #F0EFEB' }}
        >
          <div className="flex items-center gap-4">
            {statusLeft}
            {noAccessReason && (
              <span
                className="text-xs px-2 py-0.5"
                style={{
                  background: '#F5F5F5',
                  color: '#6B6B66',
                  border: '1px solid #DDDBD5',
                  borderRadius: 2,
                }}
              >
                {noAccessReason}
              </span>
            )}
            {attempt && (attempt.status === 'submitted' || attempt.status === 'auto_submitted') && (
              <ScoreDisplay attempt={attempt} assessment={a} />
            )}
            {attempt && attempt.integrityLog && attempt.integrityLog.totalViolations > 0 && (
              <div className="flex items-center gap-1" title={`${attempt.integrityLog.totalViolations} integrity violation(s) logged`}>
                <Shield size={10} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
                <span className="text-xs" style={{ color: '#C4C3BD' }}>
                  {attempt.integrityLog.totalViolations}v
                </span>
              </div>
            )}
          </div>

          {action && (
            <button
              onClick={() => {
                if (action.variant === 'primary') {
                  navigate(`/student/exam/${a.id}/briefing`);
                } else {
                  navigate(`/student/exam/${a.id}/results`);
                }
              }}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-opacity hover:opacity-75"
              style={{
                background: action.variant === 'primary' ? '#0C0C0B' : '#FFFFFF',
                color: action.variant === 'primary' ? '#FFFFFF' : '#4A4A45',
                border: action.variant === 'primary' ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
                borderRadius: 2,
                cursor: 'pointer',
              }}
            >
              {action.icon}
              {action.label}
              <ChevronRight size={10} strokeWidth={1.5} />
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ── Empty state ───────────────────────────────────────────────────

function EmptyState({ category }: { category: 'available' | 'missed' | 'submitted' | 'all' }) {
  const messages: Record<typeof category, { icon: React.ReactNode; title: string; body: string }> = {
    all: {
      icon: <ClipboardList size={28} strokeWidth={1} style={{ color: '#DDDBD5' }} />,
      title: 'No assessments yet',
      body: 'Assessments assigned to you will appear here once your administrator publishes them.',
    },
    available: {
      icon: <PlayCircle size={20} strokeWidth={1} style={{ color: '#DDDBD5' }} />,
      title: 'Nothing available right now',
      body: 'Check back later — new assessments will appear here when they open.',
    },
    missed: {
      icon: <XCircle size={20} strokeWidth={1} style={{ color: '#DDDBD5' }} />,
      title: 'Nothing missed',
      body: 'Assessments you did not submit before they closed will appear here.',
    },
    submitted: {
      icon: <CheckCircle2 size={20} strokeWidth={1} style={{ color: '#DDDBD5' }} />,
      title: 'No submissions yet',
      body: 'Your completed assessments will appear here.',
    },
  };
  const m = messages[category];

  return (
    <div
      className="flex flex-col items-center py-10"
      style={{ background: '#FAFAF8', border: '1px solid #F0EFEB', borderRadius: 3 }}
    >
      {m.icon}
      <p className="text-xs mt-3" style={{ color: '#C4C3BD', letterSpacing: '0.06em' }}>{m.title}</p>
      {m.body && (
        <p className="text-xs mt-1 text-center" style={{ color: '#DDDBD5', maxWidth: 300, lineHeight: 1.7 }}>
          {m.body}
        </p>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════

export function StudentAssessmentsPage() {
  const { session } = useStudentAuth();

  const [assessments, setAssessments]     = useState<Assessment[]>([]);
  const [attemptMap, setAttemptMap]       = useState<Record<string, Attempt>>({});
  const [attemptsByAssessment, setAttemptsByAssessment] = useState<Record<string, Attempt[]>>({});
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState('');
  const [lastSynced, setLastSynced]       = useState<Date | null>(null);
  const [syncAge, setSyncAge]             = useState('');

  const [activeTab, setActiveTab] = useState<TabKey>('available');

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

      // Build attempt map: assessmentId → most recent attempt, plus a parallel
      // map of assessmentId → all attempts (needed for attempt-limit math).
      const map: Record<string, Attempt> = {};
      const allMap: Record<string, Attempt[]> = {};
      const sorted = [...attemptList].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      sorted.forEach((at) => {
        map[at.assessmentId] = at;
        (allMap[at.assessmentId] ??= []).push(at);
      });

      setAssessments(aList);
      setAttemptMap(map);
      setAttemptsByAssessment(allMap);
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

  const { available, missed, submitted } = useMemo(() => {
    const available: AssessmentWithMeta[] = [];
    const missed:    AssessmentWithMeta[] = [];
    const submitted: AssessmentWithMeta[] = [];

    assessments.forEach((a) => {
      const avail = getAvailability(a, nowDate);
      const all   = attemptsByAssessment[a.id] ?? [];
      const entry: AssessmentWithMeta = {
        assessment: a,
        attempt: attemptMap[a.id],
        allAttempts: all,
        availability: avail,
      };

      const tab = session
        ? classifyForTab(a, avail, all, session.studentId)
        : 'available';
      if (tab === 'available')      available.push(entry);
      else if (tab === 'submitted') submitted.push(entry);
      else                          missed.push(entry);
    });

    // Available: open-now (by closest end date) before upcoming (by soonest start)
    available.sort((x, y) => {
      const xOpen = x.availability === 'available';
      const yOpen = y.availability === 'available';
      if (xOpen !== yOpen) return xOpen ? -1 : 1;
      if (xOpen) {
        if (x.assessment.endDate && y.assessment.endDate)
          return new Date(x.assessment.endDate).getTime() - new Date(y.assessment.endDate).getTime();
        if (x.assessment.endDate) return -1;
        if (y.assessment.endDate) return  1;
        return 0;
      }
      if (x.assessment.startDate && y.assessment.startDate)
        return new Date(x.assessment.startDate).getTime() - new Date(y.assessment.startDate).getTime();
      return 0;
    });

    // Submitted: most recently submitted first
    submitted.sort((x, y) => {
      const xd = x.attempt?.submittedAt ?? x.assessment.endDate ?? x.assessment.updatedAt;
      const yd = y.attempt?.submittedAt ?? y.assessment.endDate ?? y.assessment.updatedAt;
      return new Date(yd).getTime() - new Date(xd).getTime();
    });

    // Missed: most recently closed first
    missed.sort((x, y) => {
      const xd = x.assessment.endDate || x.assessment.updatedAt;
      const yd = y.assessment.endDate || y.assessment.updatedAt;
      return new Date(yd).getTime() - new Date(xd).getTime();
    });

    return { available, missed, submitted };
  }, [assessments, attemptMap, attemptsByAssessment, nowDate, session]);

  const total = assessments.length;

  if (!session) return null;

  // ── Render ────────────────────────────────────────────────────

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="px-8 py-10"
      style={{ maxWidth: 860, margin: '0 auto' }}
    >
      {/* Page header */}
      <div className="mb-8" style={{ borderBottom: '1px solid #E3E1DB', paddingBottom: 20 }}>
        <div className="flex items-center gap-2 mb-2">
          <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#4A6FA5' }} />
          <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>
            ASSESSMENTS · {session.instituteName.toUpperCase()}
          </p>
        </div>
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-light" style={{ color: '#0C0C0B', letterSpacing: '0.02em' }}>
              Your Assessments
            </h1>
            <p className="text-xs mt-1" style={{ color: '#9A9891' }}>
              Tests and exams assigned to you will appear here.
            </p>
          </div>
          {/* Controls */}
          <div className="flex items-center gap-3 flex-shrink-0">
            {lastSynced && !loading && (
              <div className="flex items-center gap-1.5 select-none">
                <div className="relative w-2 h-2">
                  <span
                    className="absolute inline-flex w-2 h-2 rounded-full opacity-60"
                    style={{ background: '#2A6B3A', animation: 'ping 1.8s cubic-bezier(0,0,0.2,1) infinite' }}
                  />
                  <span className="relative inline-flex w-1.5 h-1.5 rounded-full" style={{ background: '#2A6B3A', margin: '1px' }} />
                </div>
                <span className="text-xs" style={{ color: '#C4C3BD' }}>{syncAge}</span>
              </div>
            )}
            <button
              onClick={load}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-colors"
              style={{
                border: '1px solid #E3E1DB', color: '#4A4A45',
                borderRadius: 2, background: '#FFFFFF',
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = '#0C0C0B')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB')}
            >
              <RefreshCw size={10} strokeWidth={1.5} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <AnimatePresence mode="wait">

        {/* Loading */}
        {loading && (
          <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="flex flex-col items-center py-24">
              <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
              <p className="text-xs mt-4" style={{ color: '#C4C3BD' }}>Loading assessments…</p>
            </div>
          </motion.div>
        )}

        {/* Error */}
        {!loading && error && (
          <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div
              className="flex items-center gap-2.5 px-4 py-3"
              style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}
            >
              <AlertTriangle size={12} strokeWidth={1.5} style={{ color: '#9B2828', flexShrink: 0 }} />
              <p className="text-xs flex-1" style={{ color: '#9B2828' }}>{error}</p>
              <button onClick={load} className="text-xs" style={{ color: '#9B2828', textDecoration: 'underline' }}>
                Retry
              </button>
            </div>
          </motion.div>
        )}

        {/* Empty — no assessments at all */}
        {!loading && !error && total === 0 && (
          <motion.div key="empty-all" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <EmptyState category="all" />
          </motion.div>
        )}

        {/* Main content */}
        {!loading && !error && total > 0 && (
          <motion.div key="content" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>

            {/* Tab strip */}
            <div className="flex items-center gap-1 mb-5" style={{ borderBottom: '1px solid #E3E1DB' }}>
              {(['available', 'missed', 'submitted'] as TabKey[]).map((key) => {
                const count = key === 'available' ? available.length : key === 'missed' ? missed.length : submitted.length;
                const label = key === 'available' ? 'Available' : key === 'missed' ? 'Missed' : 'Submitted';
                const isActive = activeTab === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setActiveTab(key)}
                    className="flex items-center gap-1.5 text-xs px-3 py-2 transition-colors"
                    style={{
                      color: isActive ? '#0C0C0B' : '#9A9891',
                      borderBottom: isActive ? '2px solid #0C0C0B' : '2px solid transparent',
                      marginBottom: -1,
                      background: 'transparent',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {label}
                    <span
                      className="text-xs px-1.5"
                      style={{
                        background: isActive ? '#0C0C0B' : '#F0EFEB',
                        color: isActive ? '#FFFFFF' : '#9A9891',
                        borderRadius: 2,
                        fontSize: 10,
                      }}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Active list */}
            {(() => {
              const list = activeTab === 'available' ? available : activeTab === 'missed' ? missed : submitted;
              if (list.length === 0) return <EmptyState category={activeTab} />;
              return (
                <div className="space-y-3">
                  {list.map((d, i) => (
                    <AssessmentCard key={d.assessment.id} data={d} nowDate={nowDate} index={i} studentId={session.studentId} />
                  ))}
                </div>
              );
            })()}

            {/* Footer note */}
            <p className="text-xs mt-6 text-center" style={{ color: '#C4C3BD' }}>
              {total} assessment{total !== 1 ? 's' : ''} assigned to your account
            </p>
          </motion.div>
        )}

      </AnimatePresence>
    </motion.div>
  );
}