/**
 * ExamShell
 *
 * Full-screen exam taking interface. Orchestrates:
 *   - Section-by-section navigation (locked — cannot go backwards)
 *   - Per-question answer state with 1.5 s debounced Firestore saves
 *   - Per-section countdown timer with auto-submit on expiry
 *   - Global window-expiry check (assessment endDate)
 *   - IntegrityEngine (all keyboard/focus/clipboard restrictions)
 *   - FaceMonitor (webcam PiP + face detection)
 *   - ViolationOverlay system (warning → final warning → terminated)
 *   - Fullscreen enforcement
 *   - Submit flow with client-side score calculation
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import {
  Loader2, ChevronLeft, ChevronRight, AlertTriangle,
  CheckCircle2, Shield, Send, Layers, Flag, MonitorSmartphone,
} from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { getAssessment, type Assessment, type AssessmentSection } from '../../../lib/assessmentService';
import { getQuestion, type Question } from '../../../lib/questionBankService';
import {
  startAttempt,
  saveAnswer,
  submitSection,
  submitAttempt,
  autoTerminate,
  logViolation,
  calculateScores,
  getAttemptByStudentAndAssessment,
  subscribeToAttempt,
  registerSession,
  type Attempt,
  type AttemptAnswer,
  type AnswerValue,
  type ViolationType,
} from '../../../lib/submissionService';
import {
  createReportsForAttempt,
  type ReportReason,
} from '../../../lib/questionReportService';
import { IntegrityEngine } from '../../components/exam/IntegrityEngine';
import { FaceMonitor } from '../../components/exam/FaceMonitor';
import { SectionTimer } from '../../components/exam/SectionTimer';
import { QuestionNavigator } from '../../components/exam/QuestionNavigator';
import { QuestionRenderer } from '../../components/exam/QuestionRenderer';
import {
  WarningOverlay,
  FinalWarningOverlay,
  FullscreenRequiredOverlay,
  TerminatedOverlay,
} from '../../components/exam/ViolationOverlay';

// ── freeze-ping keyframe ──────────────────────────────────────────
if (typeof document !== 'undefined') {
  const id = 'freeze-banner-ping';
  if (!document.getElementById(id)) {
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      @keyframes freeze-ping {
        0%, 100% { transform: scale(1); opacity: 0.35; }
        50%       { transform: scale(1.7); opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }
}

// ════════════════════════════════════════════��═════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════

type ShellStatus = 'loading' | 'ready' | 'submitting_section' | 'submitting_exam' | 'submitted' | 'terminated' | 'error';

type OverlayKind =
  | { kind: 'warning'; violationType: ViolationType; warningNumber: 1 | 2 }
  | { kind: 'final_warning'; violationType: ViolationType }
  | { kind: 'fullscreen_required' }
  | { kind: 'terminated'; reason: string }
  | { kind: 'session_conflict' }
  | null;

// ── Generate a unique session ID for dual-device detection ────────
function generateSessionId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// ══════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════

const WARNING_VIOLATION_TYPES: ViolationType[] = ['tab_switch', 'focus_loss', 'fullscreen_exit'];
const MAX_WARNINGS = 3;

/**
 * Normalises sections so the exam shell always has at least one section
 * with at least one question. Priority order:
 *   1. sections[] where at least some have populated questions — use those
 *   2. sections[] all empty but assessment.questions exists — wrap flat list
 *   3. No sections at all — wrap flat list into a single "Questions" section
 */
function buildEffectiveSections(a: Assessment): AssessmentSection[] {
  const secs = a.sections ?? [];

  // Case 1: at least one section already has resolved questions
  const hasResolved = secs.some((s) => s.questions && s.questions.length > 0);
  if (hasResolved) {
    // Drop any sections that are completely empty (safety filter)
    return secs.filter((s) => s.questions && s.questions.length > 0);
  }

  // Case 2 & 3: fall back to the flat assessment.questions list
  if (a.questions && a.questions.length > 0) {
    const syntheticSection: AssessmentSection = {
      id: 'main_section',
      name: 'Questions',
      rules: [],
      questions: a.questions,
    };
    // If named sections exist, distribute questions across them equally;
    // otherwise use a single synthetic section.
    if (secs.length > 0) {
      const perSection = Math.ceil(a.questions.length / secs.length);
      return secs.map((sec, i) => ({
        ...sec,
        questions: a.questions.slice(i * perSection, (i + 1) * perSection),
      })).filter((s) => s.questions.length > 0);
    }
    return [syntheticSection];
  }

  // Nothing to work with — return original (shell will show "no questions")
  return secs;
}

// ══════════════════════════════════════════════════════════════════
// FREEZE BANNER  (non-blocking — student's exam continues normally)
// ══════════════════════════════════════════════════════════════════

function FreezeBanner({ reason }: { reason?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.25 }}
      className="flex items-center gap-3 px-5 py-2.5 flex-shrink-0"
      style={{
        background:   '#FFFBF0',
        borderBottom: '1px solid #F5DFA0',
      }}
    >
      {/* Pulsing dot */}
      <div style={{ position: 'relative', width: 8, height: 8, flexShrink: 0 }}>
        <div style={{
          position: 'absolute', inset: 0, borderRadius: '50%',
          background: '#D4A017', opacity: 0.35,
          animation: 'freeze-ping 1.6s ease-in-out infinite',
        }} />
        <div style={{
          position: 'absolute', inset: 1, borderRadius: '50%',
          background: '#D4A017',
        }} />
      </div>

      <Flag size={12} strokeWidth={1.5} style={{ color: '#92680A', flexShrink: 0 }} />

      <p className="text-xs flex-1" style={{ color: '#92680A', lineHeight: 1.5 }}>
        <span style={{ fontWeight: 500 }}>Your session has been flagged by an invigilator.</span>
        {' '}Your exam continues normally — please keep working.
        {reason && (
          <span style={{ color: '#A07830' }}>{' '}Reason: {reason}</span>
        )}
      </p>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SESSION CONFLICT OVERLAY
// ══════════════════════════════════════════════════════════════════

function SessionConflictOverlay() {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center"
      style={{ background: 'rgba(12,12,11,0.92)' }}
    >
      <motion.div
        initial={{ scale: 0.95, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 12 }}
        className="flex flex-col items-center gap-5"
        style={{ maxWidth: 400, textAlign: 'center' }}
      >
        <div className="flex items-center justify-center"
          style={{ width: 56, height: 56, borderRadius: '50%',
            background: 'rgba(155,40,40,0.15)', border: '1px solid rgba(155,40,40,0.3)' }}>
          <MonitorSmartphone size={24} strokeWidth={1} style={{ color: '#F2CECE' }} />
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs" style={{ color: '#F2CECE', letterSpacing: '0.12em' }}>
            SESSION CONFLICT
          </p>
          <p className="text-sm" style={{ color: '#FFFFFF', lineHeight: 1.6 }}>
            Another device has joined this exam session.
          </p>
          <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.4)', lineHeight: 1.6 }}>
            This incident has been logged and your invigilator has been alerted.
            Only one device may be active at a time.
          </p>
        </div>
        <p className="text-xs" style={{ color: 'rgba(255,255,255,0.25)' }}>
          Contact your invigilator to continue.
        </p>
      </motion.div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SUBMIT CONFIRMATION MODAL
// ══════════════════════════════════════════════════════════════════

function SubmitConfirmModal({
  sectionName,
  unanswered,
  isFinal,
  onConfirm,
  onCancel,
  submitting,
}: {
  sectionName: string;
  unanswered: number;
  isFinal: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(12,12,11,0.5)' }}
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0 }}
        style={{ width: 400, background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4" style={{ borderBottom: '1px solid #E3E1DB' }}>
          <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>
            {isFinal ? 'SUBMIT EXAM' : `SUBMIT ${sectionName.toUpperCase()}`}
          </p>
        </div>
        <div className="px-5 py-5">
          {unanswered > 0 && (
            <div className="flex items-start gap-2.5 px-3 py-3 mb-4"
              style={{ background: '#FEF9EC', border: '1px solid #F5DFA0', borderRadius: 2 }}>
              <AlertTriangle size={12} strokeWidth={1.5} style={{ color: '#92680A', flexShrink: 0, marginTop: 1 }} />
              <p className="text-xs" style={{ color: '#92680A', lineHeight: 1.6 }}>
                You have <strong>{unanswered} unanswered question{unanswered !== 1 ? 's' : ''}</strong>{' '}
                in this section. Unanswered questions receive 0 marks.
              </p>
            </div>
          )}
          <p className="text-xs" style={{ color: '#4A4A45', lineHeight: 1.6 }}>
            {isFinal
              ? 'Are you sure you want to submit the entire exam? This action cannot be undone.'
              : `Are you sure you want to submit ${sectionName}? You cannot return to this section once submitted.`}
          </p>
        </div>
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderTop: '1px solid #E3E1DB' }}>
          <button
            onClick={onConfirm}
            disabled={submitting}
            className="flex items-center gap-1.5 text-xs px-4 py-2.5"
            style={{
              background: submitting ? '#C8C7C2' : '#0C0C0B',
              color: '#FFFFFF', borderRadius: 2,
              cursor: submitting ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting && <Loader2 size={11} className="animate-spin" />}
            {isFinal ? 'Submit exam' : `Submit ${sectionName}`}
          </button>
          <button
            onClick={onCancel}
            disabled={submitting}
            className="text-xs px-4 py-2.5"
            style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}
          >
            Continue reviewing
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════════

export function ExamShell() {
  const { assessmentId } = useParams<{ assessmentId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { session } = useStudentAuth();

  // Navigation state from ExamBriefingPage
  const navState = location.state as { cameraDeclined?: boolean; cameraGranted?: boolean } | null;
  const cameraGranted  = navState?.cameraGranted ?? false;
  const cameraDeclined = navState?.cameraDeclined ?? true;

  // ── Stable per-tab session ID (dual-device detection) ─────────
  const localSessionId = useRef(generateSessionId());

  // ── Core data ──────────────────────────────────────────────────
  const [shellStatus, setShellStatus]       = useState<ShellStatus>('loading');
  const [errorMsg, setErrorMsg]             = useState('');
  const [assessment, setAssessment]         = useState<Assessment | null>(null);
  // effectiveSections: normalised sections that always have questions populated
  const [effectiveSections, setEffectiveSections] = useState<AssessmentSection[]>([]);
  const [attempt, setAttempt]               = useState<Attempt | null>(null);
  const [questionMap, setQuestionMap]       = useState<Map<string, Question>>(new Map());
  const [marksMap, setMarksMap]             = useState<Map<string, number>>(new Map());

  // ── Freeze / session state (synced from Firestore) ─────────────
  const [isFrozen, setIsFrozen]                     = useState(false);
  const [frozenReason, setFrozenReason]             = useState<string | undefined>();
  const [hasConflict, setHasConflict]               = useState(false);

  // ── Navigation state ───────────────────────────────────────────
  const [currentSectionIdx, setCurrentSectionIdx] = useState(0);
  const [currentQIdx, setCurrentQIdx]             = useState(0);

  // ── Answer state ───────────────────────────────────────────────
  const [localAnswers, setLocalAnswers] = useState<Record<string, AttemptAnswer>>({});
  const answerTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── Flag/report state — buffered locally; written on final submit ──
  const [flagged, setFlagged] = useState<Record<string, ReportReason>>({});
  const flaggedRef = useRef<Record<string, ReportReason>>({});
  useEffect(() => { flaggedRef.current = flagged; }, [flagged]);

  const handleFlagChange = useCallback((questionId: string, reason: ReportReason | null) => {
    setFlagged((prev) => {
      const next = { ...prev };
      if (reason === null) delete next[questionId];
      else next[questionId] = reason;
      return next;
    });
  }, []);

  // ── Overlay / violation state ──────────────────────────────────
  const [overlay, setOverlay]           = useState<OverlayKind>(null);
  const [warningCount, setWarningCount] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showSubmitModal, setShowSubmitModal] = useState(false);

  // ── Refs (stable access inside callbacks/effects) ──────────────
  const assessmentRef   = useRef<Assessment | null>(null);
  const attemptRef      = useRef<Attempt | null>(null);
  const localAnswersRef = useRef<Record<string, AttemptAnswer>>({});
  const warningCountRef = useRef(0);
  const overlayRef      = useRef<OverlayKind>(null);

  useEffect(() => { assessmentRef.current   = assessment; },    [assessment]);
  useEffect(() => { attemptRef.current      = attempt; },       [attempt]);
  useEffect(() => { localAnswersRef.current = localAnswers; },  [localAnswers]);
  useEffect(() => { warningCountRef.current = warningCount; },  [warningCount]);
  useEffect(() => { overlayRef.current      = overlay; },       [overlay]);

  // ── Prevent scroll on body while exam is active ────────────────
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // ── LOAD: assessment + attempt + questions ─────────────────────

  useEffect(() => {
    if (!assessmentId || !session) {
      navigate('/student/login', { replace: true });
      return;
    }

    const load = async () => {
      setShellStatus('loading');
      try {
        // 1. Fetch assessment
        const a = await getAssessment(assessmentId);
        if (!a) { setErrorMsg('Assessment not found.'); setShellStatus('error'); return; }

        // 2. Normalise sections — guarantees questions are populated
        const effSections = buildEffectiveSections(a);

        // 3. Get or create attempt (idempotent)
        let att = await getAttemptByStudentAndAssessment(session.studentId, assessmentId);

        if (!att || (att.status !== 'in_progress' && att.status !== 'frozen')) {
          // Compute the effective max for this student (override → global → unlimited)
          const effectiveMaxAttempts =
            a.attemptOverrides?.[session.studentId] ??
            a.maxAttempts;

          att = await startAttempt({
            assessmentId: a.id,
            assessmentTitle: a.title,
            studentId: session.studentId,
            studentName: session.name,
            instituteId: session.instituteId,
            sections: effSections.map((s) => ({
              id: s.id,
              name: s.name,
              questions: s.questions,
            })),
            shuffleQuestions: a.shuffleQuestions,
            cameraDeclined,
            effectiveMaxAttempts,
          });
        }

        // 4. Load all question documents in parallel
        const allQIds = [...new Set(
          effSections.flatMap((s) => s.questions.map((q) => q.questionId))
        )];
        const qResults = await Promise.all(allQIds.map((id) => getQuestion(id)));
        const qMap = new Map<string, Question>();
        qResults.forEach((q) => { if (q) qMap.set(q.id, q); });

        // 5. Build marks map
        const mMap = new Map<string, number>();
        effSections.forEach((s) => {
          s.questions.forEach((aq) => mMap.set(aq.questionId, aq.marks));
        });

        // Register this browser session (detect dual-device)
        const { conflict } = await registerSession(att.id, localSessionId.current);
        if (conflict) setHasConflict(true);

        // Sync initial freeze state
        if (att.frozenAt) {
          setIsFrozen(true);
          setFrozenReason(att.frozenReason);
        }

        setAssessment(a);
        setEffectiveSections(effSections);
        setAttempt(att);
        setQuestionMap(qMap);
        setMarksMap(mMap);
        setLocalAnswers({ ...att.answers });
        setCurrentSectionIdx(att.currentSectionIdx);

        // Init violation warning count from existing integrity log
        const log = att.integrityLog;
        const existingWarnings = log.tabSwitches + log.focusLosses + log.fullscreenExits;
        setWarningCount(existingWarnings);

        setShellStatus('ready');
      } catch (e: any) {
        console.error('[ExamShell] load error', e);
        const msg: string = e.message ?? '';
        if (msg.startsWith('ATTEMPT_LIMIT_EXCEEDED')) {
          const [, used, max] = msg.split(':');
          setErrorMsg(`Attempt limit reached — you have used ${used} of ${max} allowed attempts for this assessment.`);
        } else {
          setErrorMsg(msg || 'Failed to start exam.');
        }
        setShellStatus('error');
      }
    };

    load();
  }, [assessmentId, session]); // eslint-disable-line

  // ── onSnapshot: watch attempt for freeze + session conflict ──────

  useEffect(() => {
    if (!attempt?.id) return;
    const unsub = subscribeToAttempt(attempt.id, (live) => {
      if (!live) return;
      // Freeze — administrative flag only; exam continues, banner is shown
      if (live.frozenAt) {
        setIsFrozen(true);
        setFrozenReason(live.frozenReason);
      } else {
        setIsFrozen(false);
        setFrozenReason(undefined);
      }
      // Session conflict: another device took over
      if (live.activeSessionId && live.activeSessionId !== localSessionId.current) {
        setHasConflict(true);
        setOverlay({ kind: 'session_conflict' });
      }
    });
    return () => unsub();
  }, [attempt?.id]); // eslint-disable-line

  // ── Global window expiry check ─────────────────────────────────

  useEffect(() => {
    if (shellStatus !== 'ready' || !assessment?.endDate) return;
    const checkExpiry = () => {
      if (new Date() > new Date(assessment.endDate!)) {
        handleFinalSubmit('window_closed');
      }
    };
    checkExpiry();
    const interval = setInterval(checkExpiry, 30_000);
    return () => clearInterval(interval);
  }, [shellStatus, assessment?.endDate]); // eslint-disable-line

  // ── Derived: current section ───────────────────────────────────

  const currentSection = useMemo(
    () => effectiveSections[currentSectionIdx] ?? null,
    [effectiveSections, currentSectionIdx]
  );

  const currentSectionQIds = useMemo(
    () => (attempt && currentSection ? (attempt.questionOrder[currentSection.id] ?? []) : []),
    [attempt, currentSection]
  );

  const currentQId = currentSectionQIds[currentQIdx] ?? null;
  const currentQuestion = currentQId ? questionMap.get(currentQId) ?? null : null;

  const totalSections = effectiveSections.length || 1;
  const isLastSection = currentSectionIdx >= totalSections - 1;
  const isLastQuestion = currentQIdx >= currentSectionQIds.length - 1;

  // ── Count unanswered in current section ────────────────────────

  const unansweredInSection = useMemo(() => {
    return currentSectionQIds.filter((qId) => {
      const ans = localAnswers[qId];
      if (!ans) return true;
      if (ans.type === 'text') return !(ans.value as string).trim();
      if (Array.isArray(ans.value)) return (ans.value as string[]).length === 0;
      if (typeof ans.value === 'object') return Object.keys(ans.value as Record<string, string>).length === 0;
      return !(ans.value as string);
    }).length;
  }, [currentSectionQIds, localAnswers]);

  // ══════════════════════════════════════════════════════════════════
  // ANSWER HANDLING
  // ══════════════════════════════════════════════════════════════════

  const handleAnswer = useCallback((questionId: string, value: AnswerValue) => {
    if (!attemptRef.current || !assessmentRef.current) return;

    const q = questionMap.get(questionId);
    if (!q) return;

    const sectionId = currentSection?.id ?? '';
    const type = q.engine === 'mcq' ? 'mcq' : q.engine === 'text' ? 'text' : 'match';
    const answer: AttemptAnswer = {
      type,
      value,
      answeredAt: new Date().toISOString(),
      sectionId,
    };

    // Immediate local update
    setLocalAnswers((prev) => ({ ...prev, [questionId]: answer }));

    // Debounced Firestore write (1500 ms per question)
    const existing = answerTimersRef.current.get(questionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      try {
        await saveAnswer(attemptRef.current!.id, questionId, answer);
      } catch (e) {
        console.error('[ExamShell] saveAnswer failed', e);
      }
      answerTimersRef.current.delete(questionId);
    }, 1500);
    answerTimersRef.current.set(questionId, timer);
  }, [questionMap, currentSection]);

  // Flush all pending answer saves immediately
  const flushAnswers = useCallback(async () => {
    for (const [, timer] of answerTimersRef.current) clearTimeout(timer);
    answerTimersRef.current.clear();

    const att = attemptRef.current;
    if (!att) return;
    const answers = localAnswersRef.current;
    await Promise.allSettled(
      Object.entries(answers).map(([qId, ans]) => saveAnswer(att.id, qId, ans))
    );
  }, []);

  // ══════════════════════════════════════════════════════════════════
  // SECTION SUBMIT
  // ══════════════════════════════════════════════════════════════════

  const doSectionSubmit = useCallback(async (reason: 'manual' | 'time_expired') => {
    const att = attemptRef.current;
    const a   = assessmentRef.current;
    if (!att || !a || !currentSection) return;

    setShellStatus('submitting_section');
    await flushAnswers();

    const sectionId = currentSection.id;
    const startedAt = att.sectionTimings[sectionId]?.startedAt ?? new Date().toISOString();
    const timeUsedSeconds = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);

    const nextIdx = currentSectionIdx + 1;
    const nextSection = effectiveSections[nextIdx] ?? null;

    await submitSection({
      attemptId: att.id,
      sectionId,
      nextSectionId: nextSection?.id ?? null,
      nextSectionIdx: nextIdx,
      timeUsedSeconds,
    });

    if (nextSection) {
      // Advance to next section
      setCurrentSectionIdx(nextIdx);
      setCurrentQIdx(0);
      setShellStatus('ready');
      // Update local attempt copy
      setAttempt((prev) =>
        prev
          ? {
              ...prev,
              currentSectionIdx: nextIdx,
              sectionTimings: {
                ...prev.sectionTimings,
                [sectionId]: { ...prev.sectionTimings[sectionId], submittedAt: new Date().toISOString(), timeUsedSeconds },
                [nextSection.id]: { ...prev.sectionTimings[nextSection.id], startedAt: new Date().toISOString(), timeUsedSeconds: 0 },
              },
            }
          : prev
      );
    } else {
      // Last section — go to final submit
      await doFinalSubmit('manual');
    }
  }, [currentSection, currentSectionIdx, flushAnswers, effectiveSections]);

  // ══════════════════════════════════════════════════════════════════
  // FINAL SUBMIT
  // ══════════════════════════════════════════════════════════════════

  const handleFinalSubmit = useCallback(async (
    reason: 'manual' | 'time_expired' | 'violation_limit' | 'window_closed'
  ) => {
    await doFinalSubmit(reason);
  }, []); // eslint-disable-line

  const doFinalSubmit = useCallback(async (
    reason: 'manual' | 'time_expired' | 'violation_limit' | 'window_closed'
  ) => {
    const att = attemptRef.current;
    const a   = assessmentRef.current;
    if (!att || !a) return;

    setShellStatus('submitting_exam');
    await flushAnswers();

    // Calculate scores
    const allQuestions = [...questionMap.values()];
    const updatedAttempt = { ...att, answers: { ...att.answers, ...localAnswersRef.current } };
    const scores = calculateScores(updatedAttempt, a, allQuestions);

    try {
      await submitAttempt({ attemptId: att.id, reason, scores });
    } catch (e) {
      console.error('[ExamShell] submitAttempt failed', e);
    }

    // Persist any flags raised during the exam (best-effort; never blocks navigation)
    const flags = flaggedRef.current;
    const flagEntries = Object.entries(flags);
    if (flagEntries.length > 0 && session) {
      try {
        await createReportsForAttempt({
          attemptId: att.id,
          studentId: session.studentId,
          studentName: session.name,
          assessmentId: a.id,
          assessmentTitle: a.title,
          ownerId: a.ownerId,
          ownerType: a.ownerType,
          instituteId: session.instituteId,
          flags: flagEntries.map(([questionId, reason]) => ({ questionId, reason })),
        });
      } catch (e) {
        console.error('[ExamShell] createReportsForAttempt failed', e);
      }
    }

    setShellStatus('submitted');
    navigate(`/student/exam/${assessmentId}/results`, { replace: true });
  }, [questionMap, assessmentId, navigate, flushAnswers]);

  // ══════════════════════════════════════════════════════════════════
  // VIOLATION HANDLING
  // ══════════════════════════════════════════════════════════════════

  const handleViolation = useCallback(async (type: ViolationType, detail?: string) => {
    const att = attemptRef.current;
    if (!att) return;

    const isWarningType = WARNING_VIOLATION_TYPES.includes(type);
    let newWarningCount = warningCountRef.current;

    if (isWarningType) {
      newWarningCount = warningCountRef.current + 1;
      setWarningCount(newWarningCount);
    }

    // Log to Firestore
    await logViolation(att.id, type, detail, isWarningType ? newWarningCount : undefined)
      .catch((e) => console.error('[ExamShell] logViolation failed', e));

    // Show overlay based on violation type and warning count
    if (type === 'fullscreen_exit') {
      // Fullscreen exit handled by onFullscreenChange — don't double-show warning overlay
      return;
    }

    if (!isWarningType) return; // Non-warning types are logged but don't show overlay

    if (newWarningCount >= MAX_WARNINGS) {
      setOverlay({ kind: 'final_warning', violationType: type });
    } else {
      setOverlay({
        kind: 'warning',
        violationType: type,
        warningNumber: newWarningCount as 1 | 2,
      });
    }
  }, []);

  const handleFullscreenChange = useCallback((isNow: boolean) => {
    setIsFullscreen(isNow);
    if (!isNow && overlayRef.current?.kind !== 'terminated') {
      // Log violation (already done in IntegrityEngine, just show the overlay)
      const newCount = warningCountRef.current + 1;
      setWarningCount(newCount);
      if (newCount >= MAX_WARNINGS) {
        setOverlay({ kind: 'final_warning', violationType: 'fullscreen_exit' });
      } else {
        setOverlay({ kind: 'fullscreen_required' });
      }
    }
  }, []);

  const handleReturnFullscreen = useCallback(async () => {
    try {
      await document.documentElement.requestFullscreen();
      setOverlay(null);
    } catch {
      // If fullscreen request fails, keep showing the overlay
    }
  }, []);

  const handleDismissWarning = useCallback(() => {
    setOverlay(null);
  }, []);

  const handleTerminate = useCallback(async () => {
    const att = attemptRef.current;
    if (!att) return;
    setShellStatus('terminated');
    const reason = 'Exam terminated due to repeated integrity violations.';
    await autoTerminate(att.id, reason).catch(() => {});
    setOverlay({ kind: 'terminated', reason });
  }, []);

  const handleExitTerminatedView = useCallback(() => {
    navigate(`/student/exam/${assessmentId}/results`, { replace: true });
  }, [assessmentId, navigate]);

  // ══════════════════════════════════════════════════════════════════
  // SECTION TIMER EXPIRY
  // ══════════════════════════════════════════════════════════════════

  const handleSectionTimerExpire = useCallback(() => {
    if (shellStatus !== 'ready') return;
    doSectionSubmit('time_expired');
  }, [shellStatus, doSectionSubmit]);

  // ══════════════════════════════════════════════════════════════════
  // RENDER: LOADING / ERROR
  // ══════════════════════════════════════════════════════════════════

  if (shellStatus === 'loading') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: '#F7F6F3' }}>
        <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
        <p className="text-xs mt-4" style={{ color: '#C4C3BD' }}>Preparing your exam…</p>
      </div>
    );
  }

  if (shellStatus === 'error') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: '#F7F6F3' }}>
        <AlertTriangle size={20} strokeWidth={1} style={{ color: '#9B2828' }} />
        <p className="text-xs mt-4" style={{ color: '#9B2828' }}>{errorMsg}</p>
        <button
          onClick={() => navigate('/student/assessments')}
          className="text-xs mt-6 px-4 py-2"
          style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2 }}
        >
          Return to assessments
        </button>
      </div>
    );
  }

  if (shellStatus === 'submitting_exam' || shellStatus === 'submitted') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: '#F7F6F3' }}>
        <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
        <p className="text-xs mt-4" style={{ color: '#C4C3BD' }}>Submitting your exam…</p>
      </div>
    );
  }

  if (!assessment || !attempt || !currentSection) return null;

  const sectionStartedAt = attempt.sectionTimings[currentSection.id]?.startedAt ?? new Date().toISOString();
  const isIntegrityActive = overlay === null && shellStatus === 'ready' && !hasConflict;

  // ══════════════════════════════════════════════════════════════════
  // RENDER: EXAM SHELL
  // ══════════════════════════════════════════════════════════════════

  return (
    <div
      className="fixed inset-0 flex flex-col"
      style={{ background: '#F7F6F3', userSelect: 'none' }}
    >
      {/* ── Invisible engines ── */}
      <IntegrityEngine
        active={isIntegrityActive}
        onViolation={handleViolation}
        onFullscreenChange={handleFullscreenChange}
      />

      {/* ── TOP BAR ── */}
      <div
        className="flex items-center gap-4 px-5 py-2.5 flex-shrink-0"
        style={{
          background: '#FFFFFF',
          borderBottom: '1px solid #E3E1DB',
          height: 52,
        }}
      >
        {/* Section name + progress */}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <Layers size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />
            <span className="text-xs" style={{ color: '#0C0C0B' }}>
              {currentSection.name}
            </span>
            {totalSections > 1 && (
              <span className="text-xs" style={{ color: '#C4C3BD' }}>
                ({currentSectionIdx + 1}/{totalSections})
              </span>
            )}
          </div>
          {/* Section progress dots */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {effectiveSections.map((_, idx) => (
              <div
                key={idx}
                style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: idx < currentSectionIdx
                    ? '#1E7B3C'
                    : idx === currentSectionIdx
                      ? '#0C0C0B'
                      : '#E3E1DB',
                }}
              />
            ))}
          </div>
        </div>

        {/* Section timer */}
        {currentSection.timeLimit && sectionStartedAt && (
          <SectionTimer
            timeLimitMinutes={currentSection.timeLimit}
            startedAtISO={sectionStartedAt}
            onExpire={handleSectionTimerExpire}
          />
        )}
        {/* Session conflict badge */}
        {hasConflict && (
          <div className="flex items-center gap-1.5 px-3 py-1.5"
            style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
            <MonitorSmartphone size={11} strokeWidth={1.5} style={{ color: '#9B2828' }} />
            <span className="text-xs" style={{ color: '#9B2828' }}>Multi-device</span>
          </div>
        )}

        {/* Violation indicator */}
        <div
          className="flex items-center gap-1.5 px-3 py-1.5"
          style={{
            background: warningCount >= 2 ? '#FDF5F5' : warningCount >= 1 ? '#FEF9EC' : '#F7F6F3',
            border: `1px solid ${warningCount >= 2 ? '#F2CECE' : warningCount >= 1 ? '#F5DFA0' : '#E3E1DB'}`,
            borderRadius: 2,
          }}
        >
          <Shield
            size={11}
            strokeWidth={1.5}
            style={{ color: warningCount >= 2 ? '#9B2828' : warningCount >= 1 ? '#92680A' : '#C4C3BD' }}
          />
          <span
            className="text-xs"
            style={{ color: warningCount >= 2 ? '#9B2828' : warningCount >= 1 ? '#92680A' : '#C4C3BD' }}
          >
            {warningCount}/{MAX_WARNINGS}
          </span>
        </div>

        {/* Submit button */}
        <button
          onClick={() => setShowSubmitModal(true)}
          disabled={shellStatus !== 'ready'}
          className="flex items-center gap-1.5 text-xs px-4 py-2"
          style={{
            background: '#0C0C0B', color: '#FFFFFF',
            borderRadius: 2, cursor: 'pointer',
          }}
        >
          <Send size={11} strokeWidth={1.5} />
          {isLastSection ? 'Submit exam' : `Submit ${currentSection.name}`}
        </button>
      </div>

      {/* ── FREEZE BANNER (non-blocking notification) ── */}
      <AnimatePresence>
        {isFrozen && <FreezeBanner key="freeze-banner" reason={frozenReason} />}
      </AnimatePresence>

      {/* ── BODY ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── LEFT SIDEBAR ── */}
        <div className="flex flex-col" style={{ width: 200, flexShrink: 0 }}>
          {/* Question navigator */}
          <div className="flex-1 overflow-hidden">
            <QuestionNavigator
              questionIds={currentSectionQIds}
              answers={localAnswers}
              currentQIdx={currentQIdx}
              onSelectQ={setCurrentQIdx}
              sectionName={currentSection.name}
              totalSections={totalSections}
              currentSectionNumber={currentSectionIdx + 1}
            />
          </div>

          {/* Webcam PiP */}
          <div className="flex-shrink-0 p-3" style={{ borderTop: '1px solid #E3E1DB' }}>
            <FaceMonitor
              enabled={cameraGranted}
              active={isIntegrityActive}
              onViolation={handleViolation}
            />
          </div>
        </div>

        {/* ── MAIN QUESTION AREA ── */}
        <div className="flex-1 flex flex-col overflow-hidden" style={{ background: '#FFFFFF' }}>

          {currentQuestion ? (
            <>
              {/* Question content — scrollable */}
              <div className="flex-1 overflow-y-auto">
                <QuestionRenderer
                  key={currentQId!} /* re-mount on question change */
                  question={currentQuestion}
                  marks={marksMap.get(currentQId!) ?? 1}
                  questionNumber={currentQIdx + 1}
                  totalQuestions={currentSectionQIds.length}
                  answer={localAnswers[currentQId!]?.value}
                  onAnswer={(value) => handleAnswer(currentQId!, value)}
                  flagReason={flagged[currentQId!] ?? null}
                  onFlagChange={(reason) => handleFlagChange(currentQId!, reason)}
                />
              </div>

              {/* Bottom navigation bar */}
              <div
                className="flex items-center justify-between px-8 py-4 flex-shrink-0"
                style={{ borderTop: '1px solid #F0EFEB' }}
              >
                <button
                  onClick={() => setCurrentQIdx((i) => Math.max(0, i - 1))}
                  disabled={currentQIdx === 0}
                  className="flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity"
                  style={{
                    border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2,
                    opacity: currentQIdx === 0 ? 0.3 : 1,
                    cursor: currentQIdx === 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  <ChevronLeft size={13} strokeWidth={1.5} />
                  Previous
                </button>

                {/* Centre: answered count */}
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: '#C4C3BD' }}>
                    {Object.keys(localAnswers).filter((id) => currentSectionQIds.includes(id)).length}
                    /{currentSectionQIds.length} answered in this section
                  </span>
                  {localAnswers[currentQId!] && (
                    <CheckCircle2 size={12} strokeWidth={1.5} style={{ color: '#1E7B3C' }} />
                  )}
                </div>

                {isLastQuestion ? (
                  <button
                    onClick={() => setShowSubmitModal(true)}
                    className="flex items-center gap-1.5 text-xs px-4 py-2"
                    style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, cursor: 'pointer' }}
                  >
                    <Send size={11} strokeWidth={1.5} />
                    {isLastSection ? 'Submit exam' : `Submit ${currentSection.name}`}
                  </button>
                ) : (
                  <button
                    onClick={() => setCurrentQIdx((i) => Math.min(currentSectionQIds.length - 1, i + 1))}
                    className="flex items-center gap-1.5 text-xs px-4 py-2"
                    style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, cursor: 'pointer' }}
                  >
                    Next
                    <ChevronRight size={13} strokeWidth={1.5} />
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <AlertTriangle size={16} strokeWidth={1} style={{ color: '#C4C3BD' }} />
              <p className="text-xs" style={{ color: '#C4C3BD' }}>
                No questions found in this section.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── VIOLATION OVERLAYS ── */}
      <AnimatePresence>
        {overlay?.kind === 'warning' && (
          <WarningOverlay
            key="warning"
            violationType={overlay.violationType}
            warningNumber={overlay.warningNumber}
            onDismiss={handleDismissWarning}
          />
        )}
        {overlay?.kind === 'final_warning' && (
          <FinalWarningOverlay
            key="final"
            violationType={overlay.violationType}
            onCountdownEnd={handleTerminate}
          />
        )}
        {overlay?.kind === 'fullscreen_required' && (
          <FullscreenRequiredOverlay
            key="fullscreen"
            onReturnFullscreen={handleReturnFullscreen}
          />
        )}
        {overlay?.kind === 'terminated' && (
          <TerminatedOverlay
            key="terminated"
            reason={overlay.reason}
            onExitView={handleExitTerminatedView}
          />
        )}
        {overlay?.kind === 'session_conflict' && (
          <SessionConflictOverlay key="conflict" />
        )}
      </AnimatePresence>

      {/* ── SUBMIT MODAL ── */}
      <AnimatePresence>
        {showSubmitModal && shellStatus === 'ready' && (
          <SubmitConfirmModal
            key="submit-modal"
            sectionName={currentSection.name}
            unanswered={unansweredInSection}
            isFinal={isLastSection}
            submitting={shellStatus === 'submitting_section' || shellStatus === 'submitting_exam'}
            onConfirm={async () => {
              setShowSubmitModal(false);
              await doSectionSubmit('manual');
            }}
            onCancel={() => setShowSubmitModal(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}