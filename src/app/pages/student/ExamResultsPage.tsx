/**
 * ExamResultsPage
 *
 * Post-submission results page, gated by assessment flags:
 *   showResults   false → "Submitted, results withheld"
 *   showResults   true  → Score, pass/fail, section breakdown
 *   allowReview   true  → Full answer review with correct/incorrect per question
 *
 * Also handles terminated attempts (integrity violation).
 */

import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import {
  CheckCircle2, XCircle, Loader2, AlertTriangle, Shield,
  BarChart2, ArrowLeft, Award, Layers, ClipboardList, Eye,
  ChevronDown, ChevronUp, BookOpen, AlertCircle,
} from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { getAssessment, type Assessment } from '../../../lib/assessmentService';
import {
  getAttemptByStudentAndAssessment,
  type Attempt,
  type AttemptAnswer,
  type GradedAnswer,
} from '../../../lib/submissionService';
import { getExamQuestionsForStudent, type Question } from '../../../lib/questionBankService';
import {
  listReportsByAttempt,
  type QuestionReport,
} from '../../../lib/questionReportService';
import { RichText } from '../../components/questions/RichText';

// ── Helpers ───────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// ── Score ring (SVG donut) ─────────────────────────────────────────

// G-02: `passed` is three-state. Null means the paper still has answers a
// human must mark, so the ring shows an amber "PENDING" rather than stamping
// FAILED in red over a score that is only a floor.
function ScoreRing({ pct, passed }: { pct: number; passed: boolean | null }) {
  const r   = 42;
  const circ = 2 * Math.PI * r;
  const dash = circ * Math.min(1, pct / 100);

  // LITERAL, deliberately (H3). These feed SVG PRESENTATION ATTRIBUTES
  // (stroke={color} below), and a presentation attribute does not parse
  // var() — the browser drops the whole declaration and the ring renders
  // black. Only CSS property positions can take a token. Kept in step with
  // --ef-success-strong / --ef-danger / --ef-warning in palette.css.
  const color = passed === true ? '#1E7B3C'
    : passed === false ? '#9B2828'
    : '#92680A';

  return (
    <svg width={110} height={110} viewBox="0 0 110 110">
      {/* Track */}
      <circle cx={55} cy={55} r={r} fill="none" stroke="#F0EFEB" strokeWidth={8} />{/* literal: SVG attribute, see above */}
      {/* Fill */}
      <circle
        cx={55} cy={55} r={r}
        fill="none"
        stroke={color}
        strokeWidth={8}
        strokeDasharray={`${dash} ${circ - dash}`}
        strokeDashoffset={circ / 4}  /* start at top */
        strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 1s ease' }}
      />
      {/* Percentage */}
      <text x={55} y={50} textAnchor="middle" style={{ fontSize: 18, fill: color, fontWeight: 300 }}>
        {pct}%
      </text>
      <text x={55} y={66} textAnchor="middle" style={{ fontSize: 10, fill: 'var(--ef-text-muted)' }}>
        {passed === true ? 'PASSED' : passed === false ? 'FAILED' : 'PENDING'}
      </text>
    </svg>
  );
}

// ── Answer review row ─────────────────────────────────────────────

function ReviewQuestion({
  question,
  answer,
  graded,
  marks,
  qNumber,
}: {
  question: Question;
  answer: AttemptAnswer | undefined;
  graded: GradedAnswer | undefined;
  marks: number;
  qNumber: number;
}) {
  // Correct-answer data comes from the server-populated gradedAnswers map
  // (questionAnswers itself is denied to students by Firestore rules). Falls
  // back to inline question fields for legacy/pre-migration attempts.
  const correctIds   = graded?.correctIds   ?? question.correctIds   ?? [];
  const correctPairs = graded?.correctPairs ?? question.correctPairs ?? [];
  const [open, setOpen] = useState(false);

  const studentAnswerText = useMemo(() => {
    if (!answer) return '(not answered)';
    const { type, value } = answer;
    if (type === 'text') return (value as string) || '(not answered)';
    if (type === 'mcq') {
      const ids = Array.isArray(value) ? value : [value as string];
      const opts = question.options.filter((o) => ids.includes(o.id));
      return opts.map((o) => o.text).join(', ') || '(not answered)';
    }
    if (type === 'match') {
      const m = value as Record<string, string>;
      return question.pairs
        .map((p) => {
          const rightId = m[p.leftId];
          const rightItem = question.pairs.find((pp) => pp.rightId === rightId);
          return `${p.leftText} → ${rightItem?.rightText ?? '?'}`;
        })
        .join('\n');
    }
    return '(not answered)';
  }, [answer, question]);

  const isCorrect = useMemo(() => {
    if (!answer || question.engine === 'text') return null;
    // Prefer the authoritative server result when present.
    if (graded && typeof graded.isCorrect === 'boolean') return graded.isCorrect;
    if (question.engine === 'mcq') {
      const ids = Array.isArray(answer.value) ? answer.value : [answer.value as string];
      const sortedCorrect = [...correctIds].sort();
      const sortedSelected = [...ids].sort();
      return JSON.stringify(sortedCorrect) === JSON.stringify(sortedSelected);
    }
    if (question.engine === 'match') {
      const m = answer.value as Record<string, string>;
      return correctPairs.every((cp) => m[cp.leftId] === cp.rightId);
    }
    return false;
  }, [answer, question, graded, correctIds, correctPairs]);

  const statusIcon =
    question.engine === 'text'
      ? <Eye size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
      : isCorrect
        ? <CheckCircle2 size={13} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)' }} />
        : <XCircle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />;

  return (
    <div
      style={{
        border: '1px solid var(--ef-border)',
        borderRadius: 3,
        overflow: 'hidden',
        borderLeft: `3px solid ${
          question.engine === 'text' ? 'var(--ef-text-muted)'
          : isCorrect ? 'var(--ef-success-strong)'
          : 'var(--ef-danger)'
        }`,
      }}
    >
      {/* Header row */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
        style={{ background: 'var(--ef-canvas-raised)', cursor: 'pointer' }}
      >
        <span className="text-xs flex-shrink-0" style={{ color: 'var(--ef-text-muted)', minWidth: 24 }}>
          Q{qNumber}
        </span>
        <div className="flex-1 min-w-0">
          <RichText
            text={question.stem}
            style={{ fontSize: 12, color: 'var(--ef-ink)', lineHeight: '1.5',
              display: '-webkit-box', WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical', overflow: 'hidden' } as any}
          />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{marks} mk</span>
          {statusIcon}
          {open
            ? <ChevronUp size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
            : <ChevronDown size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          }
        </div>
      </button>

      {/* Expanded content */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div className="px-4 py-4 space-y-4" style={{ borderTop: '1px solid var(--ef-border-subtle)' }}>

              {/* Full stem */}
              <div>
                <p className="text-xs mb-1.5" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>QUESTION</p>
                <RichText
                  text={question.stem}
                  image={question.stemImage}
                  style={{ fontSize: 13, color: 'var(--ef-ink)', lineHeight: '1.7', display: 'block' }}
                />
              </div>

              {/* Student's answer */}
              <div>
                <p className="text-xs mb-1.5" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>YOUR ANSWER</p>
                <div
                  className="px-3 py-2.5"
                  style={{
                    background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2,
                    fontSize: 13, color: 'var(--ef-ink)', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                  }}
                >
                  {studentAnswerText}
                </div>
              </div>

              {/* Correct answer (MCQ / Match only) */}
              {question.engine === 'mcq' && (
                <div>
                  <p className="text-xs mb-1.5" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>CORRECT ANSWER</p>
                  <div
                    className="px-3 py-2.5"
                    style={{
                      background: 'var(--ef-success-bg)', border: '1px solid var(--ef-success-border)', borderRadius: 2,
                      fontSize: 13, color: 'var(--ef-success-strong)', lineHeight: 1.6,
                    }}
                  >
                    {question.options
                      .filter((o) => correctIds.includes(o.id))
                      .map((o) => o.text)
                      .join(', ')}
                  </div>
                </div>
              )}

              {question.engine === 'match' && (
                <div>
                  <p className="text-xs mb-1.5" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>CORRECT PAIRS</p>
                  <div
                    className="px-3 py-2.5 space-y-1"
                    style={{ background: 'var(--ef-success-bg)', border: '1px solid var(--ef-success-border)', borderRadius: 2 }}
                  >
                    {correctPairs.map((cp) => {
                      const left  = question.pairs.find((p) => p.leftId  === cp.leftId);
                      const right = question.pairs.find((p) => p.rightId === cp.rightId);
                      return (
                        <p key={cp.leftId} className="text-xs" style={{ color: 'var(--ef-success-strong)' }}>
                          {left?.leftText} → {right?.rightText}
                        </p>
                      );
                    })}
                  </div>
                </div>
              )}

              {question.engine === 'text' && (
                <div className="flex items-center gap-2 px-3 py-2.5"
                  style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                  <Eye size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
                  <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                    This question requires manual grading by your examiner.
                  </p>
                </div>
              )}

              {/* Explanation */}
              {question.explanation && (
                <div>
                  <p className="text-xs mb-1.5" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>EXPLANATION</p>
                  <RichText
                    text={question.explanation}
                    style={{ fontSize: 13, color: 'var(--ef-text-muted)', lineHeight: '1.7', display: 'block' }}
                  />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────

export function ExamResultsPage() {
  const { assessmentId } = useParams<{ assessmentId: string }>();
  const navigate = useNavigate();
  // B3: set by ExamShell when a submit proceeded with unconfirmed answers.
  // Router state, so it dies on refresh — it describes this submission, not
  // the attempt, and re-showing it later would be misleading.
  const saveWarning = (useLocation().state as { saveWarning?: string } | null)?.saveWarning ?? null;
  const { session } = useStudentAuth();

  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [attempt, setAttempt]       = useState<Attempt | null>(null);
  const [questionMap, setQuestionMap] = useState<Map<string, Question>>(new Map());
  const [reports, setReports] = useState<QuestionReport[]>([]);

  useEffect(() => {
    if (!assessmentId || !session) return;
    setLoading(true);

    Promise.all([
      getAssessment(assessmentId),
      getAttemptByStudentAndAssessment(session.studentId, assessmentId),
    ])
      .then(async ([a, att]) => {
        if (!a) { setError('Assessment not found.'); return; }
        setAssessment(a);
        setAttempt(att);

        // Load questions for review (only if allowReview) — one server call;
        // review mode also returns explanations (server re-verifies the
        // allowReview + finished-attempt gate). Direct question reads are
        // denied to students by the rules.
        if (att && a.showResults && a.allowReview) {
          const allQIds = new Set([
            ...(a.sections ?? []).flatMap((s) => (s.questions ?? []).map((q) => q.questionId)),
            ...(a.questions ?? []).map((q) => q.questionId), // legacy flat shape
          ]);
          const paper = await getExamQuestionsForStudent(a.id, 'review');
          const map = new Map<string, Question>();
          paper.forEach((q) => { if (allQIds.has(q.id)) map.set(q.id, q); });
          setQuestionMap(map);
        }

        // Load any reports the student raised on this attempt
        if (att) {
          try {
            const list = await listReportsByAttempt(att.id, session.studentId);
            setReports(list);
          } catch { /* non-blocking */ }
        }
      })
      .catch((e) => setError(e.message || 'Failed to load results.'))
      .finally(() => setLoading(false));
  }, [assessmentId, session]);

  // ── Derived ────────────────────────────────────────────────────

  const marksMap = useMemo(() => {
    const m = new Map<string, number>();
    if (!assessment) return m;
    (assessment.sections ?? []).forEach((s) =>
      s.questions.forEach((aq) => m.set(aq.questionId, aq.marks))
    );
    return m;
  }, [assessment]);

  const totalTimeUsed = useMemo(() => {
    if (!attempt) return 0;
    return Object.values(attempt.sectionTimings).reduce(
      (sum, t) => sum + (t.timeUsedSeconds ?? 0), 0
    );
  }, [attempt]);

  if (!session) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="px-8 py-10"
      style={{ maxWidth: 800, margin: '0 auto' }}
    >
      {/* Page header */}
      <div className="flex items-center gap-3 mb-8" style={{ borderBottom: '1px solid var(--ef-border)', paddingBottom: 20 }}>
        <button
          onClick={() => navigate('/student/assessments')}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5"
          style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-muted)', borderRadius: 2, background: 'var(--ef-surface)' }}
        >
          <ArrowLeft size={11} strokeWidth={1.5} />
          Assessments
        </button>
        <span style={{ color: 'var(--ef-border)' }}>›</span>
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Results</p>
      </div>

      {/*
        Phase 4.1 / B3 — carried here from ExamShell through router state.

        The submit went ahead with answers still unconfirmed, which is the
        correct behaviour (never block submission), but the student must not
        find that out from a mark. Shown once, on the screen they land on,
        because the shell that raised it has already been destroyed.

        Deliberately not styled as an error: nothing failed to submit. It is a
        specific, actionable notice — tell an invigilator, now, while the
        sitting can still be reconstructed.
      */}
      {saveWarning && (
        <div className="flex items-start gap-2.5 px-4 py-3 mb-6"
          style={{ background: '#FBF3F3', border: '1px solid #E3C9C9', borderRadius: 2 }}>
          <AlertTriangle size={14} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', marginTop: 1 }} />
          <p className="text-xs" style={{ color: 'var(--ef-danger)', lineHeight: 1.6 }}>{saveWarning}</p>
        </div>
      )}

      {/* ── Phase 3 (Stage 3): SEB quit link ──────────────────────────
          For SEB exams the student is still locked inside Safe Exam Browser
          when they land here. Navigating to /seb-quit closes SEB when the
          .seb config's quit URL points at that route; otherwise the page it
          lands on explains how to quit manually. */}
      {!loading && assessment?.requireSEB === true &&
        attempt && attempt.status !== 'in_progress' && attempt.status !== 'frozen' && (
        <div className="flex items-center justify-between gap-4 px-4 py-3 mb-6"
          style={{ background: 'var(--ef-success-bg)', border: '1px solid var(--ef-success-border)', borderRadius: 2 }}>
          <div className="flex items-center gap-3">
            <Shield size={13} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)', flexShrink: 0 }} />
            <p className="text-xs" style={{ color: 'var(--ef-success-strong)' }}>
              Your exam is submitted. You can now close Safe Exam Browser.
            </p>
          </div>
          {/* A REAL anchor, not a JS navigation: SEB's quit-link detection
              hooks link navigations to the configured quit URL — the docs'
              usage is a link on the post-exam summary page, and JS-initiated
              location changes are not reliably detected on all SEB versions.
              Absolute href so it matches the configured URL exactly. */}
          <a
            href={`${window.location.origin}/seb-quit`}
            className="text-xs px-4 py-2 flex-shrink-0"
            style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, textDecoration: 'none' }}
          >
            Close Safe Exam Browser
          </a>
        </div>
      )}

      <AnimatePresence mode="wait">

        {loading && (
          <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="flex flex-col items-center py-24">
              <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
              <p className="text-xs mt-4" style={{ color: 'var(--ef-text-muted)' }}>Loading results…</p>
            </div>
          </motion.div>
        )}

        {!loading && error && (
          <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="flex items-center gap-3 px-4 py-3"
              style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
              <AlertTriangle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />
              <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{error}</p>
            </div>
          </motion.div>
        )}

        {!loading && !error && assessment && attempt && (
          <motion.div key="content" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>

            {/* Assessment title */}
            <div className="mb-6">
              <h1 className="text-2xl font-light mb-1" style={{ color: 'var(--ef-ink)', letterSpacing: '0.01em' }}>
                {assessment.title}
              </h1>
              <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                Submitted {attempt.submittedAt ? formatDate(attempt.submittedAt) : ''}
              </p>
            </div>

            {/* TERMINATED state */}
            {attempt.status === 'terminated' && (
              <div className="flex items-start gap-3 px-5 py-4 mb-6"
                style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 3 }}>
                <XCircle size={16} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', flexShrink: 0, marginTop: 1 }} />
                <div>
                  <p className="text-xs mb-1" style={{ color: 'var(--ef-danger)' }}>Exam terminated</p>
                  <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                    {attempt.integrityLog?.terminatedReason || 'Your exam was terminated due to integrity violations.'}
                  </p>
                </div>
              </div>
            )}

            {/* Results hidden */}
            {!assessment.showResults && (
              <div className="flex flex-col items-center py-16 mb-6"
                style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}>
                <CheckCircle2 size={32} strokeWidth={1} style={{ color: 'var(--ef-success-strong)' }} />
                <p className="text-sm mt-4" style={{ color: 'var(--ef-ink)' }}>
                  Your answers have been submitted successfully.
                </p>
                <p className="text-xs mt-2 text-center" style={{ color: 'var(--ef-text-muted)', maxWidth: 320, lineHeight: 1.7 }}>
                  Results for this assessment are not shown to students. Your examiner will
                  review your responses and share feedback separately.
                </p>
              </div>
            )}

            {/* Results shown */}
            {assessment.showResults && attempt.scores && (
              <>
                {/* Score card */}
                <div
                  className="flex items-center gap-8 px-6 py-6 mb-6"
                  style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
                >
                  <ScoreRing
                    pct={attempt.scores.percentage}
                    passed={attempt.scores.passed}
                  />
                  <div className="flex-1">
                    <div className="grid grid-cols-3 gap-4 mb-4">
                      {[
                        { label: 'Marks', value: `${attempt.scores.total}/${attempt.scores.available}` },
                        { label: 'Score', value: `${attempt.scores.percentage}%` },
                        { label: 'Time used', value: formatTime(totalTimeUsed) },
                      ].map((item) => (
                        <div key={item.label}>
                          <p className="text-xs mb-0.5" style={{ color: 'var(--ef-text-muted)' }}>{item.label}</p>
                          <p className="text-sm" style={{ color: 'var(--ef-ink)' }}>{item.value}</p>
                        </div>
                      ))}
                    </div>
                    {assessment.passingScore !== undefined && (
                      // G-02: three states, not two. `passed === null` means the
                      // paper still has answers a human must mark, and telling a
                      // student "Did not pass" on a score that cannot yet be
                      // final is the one outcome this screen must never produce.
                      <div
                        className="flex items-center gap-2 px-3 py-2"
                        style={{
                          background: attempt.scores.passed === true ? 'var(--ef-success-bg)'
                            : attempt.scores.passed === false ? 'var(--ef-danger-bg)'
                            : '#FDF8EC',
                          border: `1px solid ${attempt.scores.passed === true ? 'var(--ef-success-border)'
                            : attempt.scores.passed === false ? 'var(--ef-danger-border)'
                            : '#EBD9A8'}`,
                          borderRadius: 2, display: 'inline-flex',
                        }}
                      >
                        {attempt.scores.passed === true
                          ? <CheckCircle2 size={12} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)' }} />
                          : attempt.scores.passed === false
                            ? <XCircle size={12} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />
                            : <AlertCircle size={12} strokeWidth={1.5} style={{ color: 'var(--ef-warning)' }} />
                        }
                        <p className="text-xs" style={{
                          color: attempt.scores.passed === true ? 'var(--ef-success-strong)'
                            : attempt.scores.passed === false ? 'var(--ef-danger)'
                            : 'var(--ef-warning)' }}>
                          {attempt.scores.passed === true ? 'Passed'
                            : attempt.scores.passed === false ? 'Did not pass'
                            : 'Result pending — awaiting marking'}
                          {' '}(pass mark: {assessment.passingScore}%)
                        </p>
                      </div>
                    )}
                    {attempt.scores.requiresManualReview && (
                      <div className="flex items-center gap-2 mt-2">
                        <AlertCircle size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
                        <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                          Some answers require manual grading — score may change.
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Section breakdown */}
                {attempt.scores.bySection.length > 1 && (
                  <div className="mb-6"
                    style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3, overflow: 'hidden' }}>
                    <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
                      <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>SECTION BREAKDOWN</p>
                    </div>
                    {attempt.scores.bySection.map((sec, idx) => {
                      const secPct = sec.marksAvailable > 0
                        ? Math.round((sec.marksAwarded / sec.marksAvailable) * 100)
                        : 0;
                      return (
                        <div key={sec.sectionId}
                          className="flex items-center gap-4 px-4 py-3"
                          style={{ borderBottom: idx < attempt.scores!.bySection.length - 1 ? '1px solid var(--ef-border-subtle)' : 'none' }}>
                          <div style={{ width: 20, height: 20, borderRadius: 2, background: 'var(--ef-border-subtle)', border: '1px solid var(--ef-border)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: 'var(--ef-text-muted)', flexShrink: 0 }}>
                            {idx + 1}
                          </div>
                          <p className="text-xs flex-1" style={{ color: 'var(--ef-ink)' }}>{sec.sectionName}</p>
                          <div className="flex items-center gap-3">
                            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                              {sec.answeredQuestions}/{sec.totalQuestions} answered
                            </span>
                            <span className="text-xs" style={{ color: 'var(--ef-ink)' }}>
                              {sec.marksAwarded}/{sec.marksAvailable} mk
                            </span>
                            <span
                              className="text-xs px-1.5 py-0.5"
                              style={{
                                background: secPct >= 50 ? 'var(--ef-success-bg)' : 'var(--ef-danger-bg)',
                                color: secPct >= 50 ? 'var(--ef-success-strong)' : 'var(--ef-danger)',
                                border: `1px solid ${secPct >= 50 ? 'var(--ef-success-border)' : 'var(--ef-danger-border)'}`,
                                borderRadius: 2,
                              }}
                            >
                              {secPct}%
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {/* Integrity log summary */}
            {attempt.integrityLog && attempt.integrityLog.totalViolations > 0 && (
              <div className="mb-6"
                style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 3 }}>
                <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
                  <Shield size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
                  <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>INTEGRITY LOG</p>
                </div>
                <div className="px-4 py-3 grid grid-cols-3 gap-3">
                  {[
                    { label: 'Tab switches', value: attempt.integrityLog.tabSwitches },
                    { label: 'Focus losses', value: attempt.integrityLog.focusLosses },
                    { label: 'Fullscreen exits', value: attempt.integrityLog.fullscreenExits },
                    { label: 'Copy attempts', value: attempt.integrityLog.copyAttempts },
                    { label: 'Multi-person', value: attempt.integrityLog.multiPersonEvents },
                    { label: 'Total events', value: attempt.integrityLog.totalViolations },
                  ].filter((item) => item.value > 0).map((item) => (
                    <div key={item.label}>
                      <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{item.label}</p>
                      <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{item.value}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Your reports — resolution outcomes from the reviewer */}
            {reports.length > 0 && (
              <div className="mb-8">
                <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
                  YOUR REPORTS ({reports.length})
                </p>
                <div className="flex flex-col gap-2">
                  {reports.map((r) => {
                    const sc = r.status === 'fixed'
                      ? { bg: '#EAF6EE', border: '#B5D9C0', text: 'var(--ef-success-strong)' }
                      : r.status === 'dismissed'
                        ? { bg: 'var(--ef-canvas)', border: 'var(--ef-border)', text: 'var(--ef-text-muted)' }
                        : r.status === 'reviewed'
                          ? { bg: 'var(--ef-canvas)', border: 'var(--ef-border)', text: 'var(--ef-text-subtle)' }
                          : { bg: '#FEF9EC', border: 'var(--ef-warning-border)', text: 'var(--ef-warning)' };
                    const reasonLabel = {
                      wrong_answer: 'Wrong answer',
                      typo: 'Typo',
                      ambiguous: 'Ambiguous',
                      other: 'Other',
                    }[r.reason];
                    return (
                      <div key={r.id}
                        className="px-4 py-3"
                        style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs px-1.5 py-0.5"
                            style={{ background: sc.bg, border: `1px solid ${sc.border}`, color: sc.text, borderRadius: 2 }}>
                            {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                          </span>
                          <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{reasonLabel}</span>
                          <span className="text-xs ml-auto" style={{ color: 'var(--ef-text-muted)' }}>
                            {new Date(r.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        {r.resolution && (
                          <p className="text-xs mt-2" style={{ color: 'var(--ef-text-subtle)', lineHeight: 1.6 }}>
                            Outcome: {r.resolution.action.replace(/_/g, ' ')}
                            {r.resolution.regradeApplied && (
                              <span style={{ color: 'var(--ef-success-strong)' }}> · your score was regraded</span>
                            )}
                            {r.resolution.note && (
                              <span style={{ color: 'var(--ef-text-muted)' }}> — "{r.resolution.note}"</span>
                            )}
                          </p>
                        )}
                        {!r.resolution && r.status === 'open' && (
                          <p className="text-xs mt-2" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                            Awaiting review by your evaluator.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Answer review */}
            {assessment.showResults && assessment.allowReview && questionMap.size > 0 && (
              <div className="mb-8">
                <p className="text-xs mb-4" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
                  ANSWER REVIEW
                </p>
                <div className="space-y-3">
                  {(assessment.sections ?? []).flatMap((sec, sIdx) =>
                    (attempt.questionOrder[sec.id] ?? []).map((qId, qIdx) => {
                      const q = questionMap.get(qId);
                      if (!q) return null;
                      const globalIdx = (assessment.sections ?? [])
                        .slice(0, sIdx)
                        .reduce((s, s2) => s + (attempt.questionOrder[s2.id]?.length ?? 0), 0) + qIdx;
                      return (
                        <ReviewQuestion
                          key={qId}
                          question={q}
                          answer={attempt.answers[qId]}
                          graded={attempt.gradedAnswers?.[qId]}
                          marks={marksMap.get(qId) ?? 1}
                          qNumber={globalIdx + 1}
                        />
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between pt-4"
              style={{ borderTop: '1px solid var(--ef-border)' }}>
              <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                Attempt ID: <span style={{ fontFamily: 'monospace' }}>{attempt.id}</span>
              </p>
              <button
                onClick={() => navigate('/student/assessments')}
                className="flex items-center gap-1.5 text-xs px-4 py-2"
                style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2, background: 'var(--ef-surface)' }}
              >
                <ArrowLeft size={11} strokeWidth={1.5} />
                Back to assessments
              </button>
            </div>

          </motion.div>
        )}

      </AnimatePresence>
    </motion.div>
  );
}