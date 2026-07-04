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
import { useParams, useNavigate } from 'react-router';
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
import { getQuestion, type Question } from '../../../lib/questionBankService';
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

function ScoreRing({ pct, passed }: { pct: number; passed: boolean }) {
  const r   = 42;
  const circ = 2 * Math.PI * r;
  const dash = circ * Math.min(1, pct / 100);

  const color = passed ? '#1E7B3C' : '#9B2828';

  return (
    <svg width={110} height={110} viewBox="0 0 110 110">
      {/* Track */}
      <circle cx={55} cy={55} r={r} fill="none" stroke="#F0EFEB" strokeWidth={8} />
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
      <text x={55} y={66} textAnchor="middle" style={{ fontSize: 10, fill: '#9A9891' }}>
        {passed ? 'PASSED' : 'FAILED'}
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
      ? <Eye size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />
      : isCorrect
        ? <CheckCircle2 size={13} strokeWidth={1.5} style={{ color: '#1E7B3C' }} />
        : <XCircle size={13} strokeWidth={1.5} style={{ color: '#9B2828' }} />;

  return (
    <div
      style={{
        border: '1px solid #E3E1DB',
        borderRadius: 3,
        overflow: 'hidden',
        borderLeft: `3px solid ${
          question.engine === 'text' ? '#C4C3BD'
          : isCorrect ? '#1E7B3C'
          : '#9B2828'
        }`,
      }}
    >
      {/* Header row */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
        style={{ background: '#FAFAF8', cursor: 'pointer' }}
      >
        <span className="text-xs flex-shrink-0" style={{ color: '#9A9891', minWidth: 24 }}>
          Q{qNumber}
        </span>
        <div className="flex-1 min-w-0">
          <RichText
            text={question.stem}
            style={{ fontSize: 12, color: '#0C0C0B', lineHeight: '1.5',
              display: '-webkit-box', WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical', overflow: 'hidden' } as any}
          />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs" style={{ color: '#9A9891' }}>{marks} mk</span>
          {statusIcon}
          {open
            ? <ChevronUp size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />
            : <ChevronDown size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />
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
            <div className="px-4 py-4 space-y-4" style={{ borderTop: '1px solid #F0EFEB' }}>

              {/* Full stem */}
              <div>
                <p className="text-xs mb-1.5" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>QUESTION</p>
                <RichText
                  text={question.stem}
                  image={question.stemImage}
                  style={{ fontSize: 13, color: '#0C0C0B', lineHeight: '1.7', display: 'block' }}
                />
              </div>

              {/* Student's answer */}
              <div>
                <p className="text-xs mb-1.5" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>YOUR ANSWER</p>
                <div
                  className="px-3 py-2.5"
                  style={{
                    background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2,
                    fontSize: 13, color: '#0C0C0B', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                  }}
                >
                  {studentAnswerText}
                </div>
              </div>

              {/* Correct answer (MCQ / Match only) */}
              {question.engine === 'mcq' && (
                <div>
                  <p className="text-xs mb-1.5" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>CORRECT ANSWER</p>
                  <div
                    className="px-3 py-2.5"
                    style={{
                      background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2,
                      fontSize: 13, color: '#1E7B3C', lineHeight: 1.6,
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
                  <p className="text-xs mb-1.5" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>CORRECT PAIRS</p>
                  <div
                    className="px-3 py-2.5 space-y-1"
                    style={{ background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2 }}
                  >
                    {correctPairs.map((cp) => {
                      const left  = question.pairs.find((p) => p.leftId  === cp.leftId);
                      const right = question.pairs.find((p) => p.rightId === cp.rightId);
                      return (
                        <p key={cp.leftId} className="text-xs" style={{ color: '#1E7B3C' }}>
                          {left?.leftText} → {right?.rightText}
                        </p>
                      );
                    })}
                  </div>
                </div>
              )}

              {question.engine === 'text' && (
                <div className="flex items-center gap-2 px-3 py-2.5"
                  style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                  <Eye size={12} strokeWidth={1.5} style={{ color: '#9A9891' }} />
                  <p className="text-xs" style={{ color: '#9A9891' }}>
                    This question requires manual grading by your examiner.
                  </p>
                </div>
              )}

              {/* Explanation */}
              {question.explanation && (
                <div>
                  <p className="text-xs mb-1.5" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>EXPLANATION</p>
                  <RichText
                    text={question.explanation}
                    style={{ fontSize: 13, color: '#6B6B66', lineHeight: '1.7', display: 'block' }}
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

        // Load questions for review (only if allowReview)
        if (att && a.showResults && a.allowReview) {
          const allQIds = [...new Set([
            ...(a.sections ?? []).flatMap((s) => (s.questions ?? []).map((q) => q.questionId)),
            ...(a.questions ?? []).map((q) => q.questionId), // legacy flat shape
          ])];
          const results = await Promise.all(
            allQIds.map((id) => getQuestion(id, { includeAnswer: false }))
          );
          const map = new Map<string, Question>();
          results.forEach((q) => { if (q) map.set(q.id, q); });
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
      <div className="flex items-center gap-3 mb-8" style={{ borderBottom: '1px solid #E3E1DB', paddingBottom: 20 }}>
        <button
          onClick={() => navigate('/student/assessments')}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5"
          style={{ border: '1px solid #E3E1DB', color: '#9A9891', borderRadius: 2, background: '#FFFFFF' }}
        >
          <ArrowLeft size={11} strokeWidth={1.5} />
          Assessments
        </button>
        <span style={{ color: '#E3E1DB' }}>›</span>
        <p className="text-xs" style={{ color: '#9A9891' }}>Results</p>
      </div>

      <AnimatePresence mode="wait">

        {loading && (
          <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="flex flex-col items-center py-24">
              <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
              <p className="text-xs mt-4" style={{ color: '#C4C3BD' }}>Loading results…</p>
            </div>
          </motion.div>
        )}

        {!loading && error && (
          <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="flex items-center gap-3 px-4 py-3"
              style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
              <AlertTriangle size={13} strokeWidth={1.5} style={{ color: '#9B2828' }} />
              <p className="text-xs" style={{ color: '#9B2828' }}>{error}</p>
            </div>
          </motion.div>
        )}

        {!loading && !error && assessment && attempt && (
          <motion.div key="content" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>

            {/* Assessment title */}
            <div className="mb-6">
              <h1 className="text-2xl font-light mb-1" style={{ color: '#0C0C0B', letterSpacing: '0.01em' }}>
                {assessment.title}
              </h1>
              <p className="text-xs" style={{ color: '#9A9891' }}>
                Submitted {attempt.submittedAt ? formatDate(attempt.submittedAt) : ''}
              </p>
            </div>

            {/* TERMINATED state */}
            {attempt.status === 'terminated' && (
              <div className="flex items-start gap-3 px-5 py-4 mb-6"
                style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 3 }}>
                <XCircle size={16} strokeWidth={1.5} style={{ color: '#9B2828', flexShrink: 0, marginTop: 1 }} />
                <div>
                  <p className="text-xs mb-1" style={{ color: '#9B2828' }}>Exam terminated</p>
                  <p className="text-xs" style={{ color: '#9A9891', lineHeight: 1.6 }}>
                    {attempt.integrityLog?.terminatedReason || 'Your exam was terminated due to integrity violations.'}
                  </p>
                </div>
              </div>
            )}

            {/* Results hidden */}
            {!assessment.showResults && (
              <div className="flex flex-col items-center py-16 mb-6"
                style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}>
                <CheckCircle2 size={32} strokeWidth={1} style={{ color: '#1E7B3C' }} />
                <p className="text-sm mt-4" style={{ color: '#0C0C0B' }}>
                  Your answers have been submitted successfully.
                </p>
                <p className="text-xs mt-2 text-center" style={{ color: '#9A9891', maxWidth: 320, lineHeight: 1.7 }}>
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
                  style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
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
                          <p className="text-xs mb-0.5" style={{ color: '#9A9891' }}>{item.label}</p>
                          <p className="text-sm" style={{ color: '#0C0C0B' }}>{item.value}</p>
                        </div>
                      ))}
                    </div>
                    {assessment.passingScore !== undefined && (
                      <div
                        className="flex items-center gap-2 px-3 py-2"
                        style={{
                          background: attempt.scores.passed ? '#F0F9F4' : '#FDF5F5',
                          border: `1px solid ${attempt.scores.passed ? '#B8E6C8' : '#F2CECE'}`,
                          borderRadius: 2, display: 'inline-flex',
                        }}
                      >
                        {attempt.scores.passed
                          ? <CheckCircle2 size={12} strokeWidth={1.5} style={{ color: '#1E7B3C' }} />
                          : <XCircle size={12} strokeWidth={1.5} style={{ color: '#9B2828' }} />
                        }
                        <p className="text-xs" style={{ color: attempt.scores.passed ? '#1E7B3C' : '#9B2828' }}>
                          {attempt.scores.passed ? 'Passed' : 'Did not pass'}
                          {' '}(pass mark: {assessment.passingScore}%)
                        </p>
                      </div>
                    )}
                    {attempt.scores.requiresManualReview && (
                      <div className="flex items-center gap-2 mt-2">
                        <AlertCircle size={12} strokeWidth={1.5} style={{ color: '#9A9891' }} />
                        <p className="text-xs" style={{ color: '#9A9891' }}>
                          Some answers require manual grading — score may change.
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Section breakdown */}
                {attempt.scores.bySection.length > 1 && (
                  <div className="mb-6"
                    style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3, overflow: 'hidden' }}>
                    <div className="px-4 py-3" style={{ borderBottom: '1px solid #F0EFEB' }}>
                      <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>SECTION BREAKDOWN</p>
                    </div>
                    {attempt.scores.bySection.map((sec, idx) => {
                      const secPct = sec.marksAvailable > 0
                        ? Math.round((sec.marksAwarded / sec.marksAvailable) * 100)
                        : 0;
                      return (
                        <div key={sec.sectionId}
                          className="flex items-center gap-4 px-4 py-3"
                          style={{ borderBottom: idx < attempt.scores!.bySection.length - 1 ? '1px solid #F0EFEB' : 'none' }}>
                          <div style={{ width: 20, height: 20, borderRadius: 2, background: '#F0EFEB', border: '1px solid #E3E1DB',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#9A9891', flexShrink: 0 }}>
                            {idx + 1}
                          </div>
                          <p className="text-xs flex-1" style={{ color: '#0C0C0B' }}>{sec.sectionName}</p>
                          <div className="flex items-center gap-3">
                            <span className="text-xs" style={{ color: '#9A9891' }}>
                              {sec.answeredQuestions}/{sec.totalQuestions} answered
                            </span>
                            <span className="text-xs" style={{ color: '#0C0C0B' }}>
                              {sec.marksAwarded}/{sec.marksAvailable} mk
                            </span>
                            <span
                              className="text-xs px-1.5 py-0.5"
                              style={{
                                background: secPct >= 50 ? '#F0F9F4' : '#FDF5F5',
                                color: secPct >= 50 ? '#1E7B3C' : '#9B2828',
                                border: `1px solid ${secPct >= 50 ? '#B8E6C8' : '#F2CECE'}`,
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
                style={{ background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 3 }}>
                <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid #F0EFEB' }}>
                  <Shield size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />
                  <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>INTEGRITY LOG</p>
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
                      <p className="text-xs" style={{ color: '#C4C3BD' }}>{item.label}</p>
                      <p className="text-xs" style={{ color: '#9A9891' }}>{item.value}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Your reports — resolution outcomes from the reviewer */}
            {reports.length > 0 && (
              <div className="mb-8">
                <p className="text-xs mb-3" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>
                  YOUR REPORTS ({reports.length})
                </p>
                <div className="flex flex-col gap-2">
                  {reports.map((r) => {
                    const sc = r.status === 'fixed'
                      ? { bg: '#EAF6EE', border: '#B5D9C0', text: '#1E7B3C' }
                      : r.status === 'dismissed'
                        ? { bg: '#F7F6F3', border: '#E3E1DB', text: '#9A9891' }
                        : r.status === 'reviewed'
                          ? { bg: '#F7F6F3', border: '#E3E1DB', text: '#4A4A45' }
                          : { bg: '#FEF9EC', border: '#F5DFA0', text: '#92680A' };
                    const reasonLabel = {
                      wrong_answer: 'Wrong answer',
                      typo: 'Typo',
                      ambiguous: 'Ambiguous',
                      other: 'Other',
                    }[r.reason];
                    return (
                      <div key={r.id}
                        className="px-4 py-3"
                        style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs px-1.5 py-0.5"
                            style={{ background: sc.bg, border: `1px solid ${sc.border}`, color: sc.text, borderRadius: 2 }}>
                            {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                          </span>
                          <span className="text-xs" style={{ color: '#6B6B66' }}>{reasonLabel}</span>
                          <span className="text-xs ml-auto" style={{ color: '#C4C3BD' }}>
                            {new Date(r.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        {r.resolution && (
                          <p className="text-xs mt-2" style={{ color: '#4A4A45', lineHeight: 1.6 }}>
                            Outcome: {r.resolution.action.replace(/_/g, ' ')}
                            {r.resolution.regradeApplied && (
                              <span style={{ color: '#1E7B3C' }}> · your score was regraded</span>
                            )}
                            {r.resolution.note && (
                              <span style={{ color: '#6B6B66' }}> — "{r.resolution.note}"</span>
                            )}
                          </p>
                        )}
                        {!r.resolution && r.status === 'open' && (
                          <p className="text-xs mt-2" style={{ color: '#9A9891', lineHeight: 1.6 }}>
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
                <p className="text-xs mb-4" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>
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
              style={{ borderTop: '1px solid #E3E1DB' }}>
              <p className="text-xs" style={{ color: '#C4C3BD' }}>
                Attempt ID: <span style={{ fontFamily: 'monospace' }}>{attempt.id}</span>
              </p>
              <button
                onClick={() => navigate('/student/assessments')}
                className="flex items-center gap-1.5 text-xs px-4 py-2"
                style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, background: '#FFFFFF' }}
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
