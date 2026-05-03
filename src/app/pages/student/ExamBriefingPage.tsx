/**
 * ExamBriefingPage
 *
 * Pre-exam gate shown before the student enters the exam shell.
 *
 * Steps:
 *  1. Verify the assessment is accessible and active
 *  2. Show rules, section breakdown, marks, time limits
 *  3. Request webcam permission (student can decline)
 *  4. Request fullscreen
 *  5. "Enter Exam" button → navigate to ExamShell
 *
 * Resumes an in_progress attempt transparently.
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import {
  Loader2, AlertTriangle, ClipboardList, Timer, Layers,
  Award, Calendar, ArrowRight, Camera, Maximize,
  CheckCircle2, Shield, Info, ChevronRight, Clock, Ban,
} from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { getAssessment, type Assessment } from '../../../lib/assessmentService';
import {
  getAllAttemptsByStudentAndAssessment,
  type Attempt,
} from '../../../lib/submissionService';

// ── Helpers ───────────────────────────────────────────────────────

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

// ── Camera permission step ────────────────────────────────────────

type CameraState = 'idle' | 'requesting' | 'granted' | 'denied';

function CameraStep({
  state,
  onRequest,
  onDecline,
}: {
  state: CameraState;
  onRequest: () => void;
  onDecline: () => void;
}) {
  if (state === 'granted') {
    return (
      <div className="flex items-center gap-3 px-4 py-3"
        style={{ background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2 }}>
        <CheckCircle2 size={14} strokeWidth={1.5} style={{ color: '#1E7B3C', flexShrink: 0 }} />
        <p className="text-xs" style={{ color: '#1E7B3C' }}>Camera access granted. You can be seen during the exam.</p>
      </div>
    );
  }

  if (state === 'denied') {
    return (
      <div className="flex items-start gap-3 px-4 py-3"
        style={{ background: '#FEF9EC', border: '1px solid #F5DFA0', borderRadius: 2 }}>
        <AlertTriangle size={14} strokeWidth={1.5} style={{ color: '#92680A', flexShrink: 0, marginTop: 1 }} />
        <div>
          <p className="text-xs" style={{ color: '#92680A' }}>
            Camera access was declined or unavailable. You may continue without camera,
            but this will be noted in your attempt record.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-4 px-4 py-4"
      style={{ background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2 }}>
      <div className="flex items-center justify-center flex-shrink-0"
        style={{ width: 36, height: 36, borderRadius: 2, background: '#F0EFEB', border: '1px solid #E3E1DB' }}>
        <Camera size={16} strokeWidth={1.5} style={{ color: '#6B6B66' }} />
      </div>
      <div className="flex-1">
        <p className="text-xs mb-1" style={{ color: '#0C0C0B' }}>Webcam verification required</p>
        <p className="text-xs mb-3" style={{ color: '#9A9891', lineHeight: 1.6 }}>
          This exam uses webcam monitoring to verify your identity and detect irregularities.
          Your camera feed is not recorded — only face count is analysed.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={onRequest}
            disabled={state === 'requesting'}
            className="flex items-center gap-1.5 text-xs px-4 py-2"
            style={{
              background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2,
              cursor: state === 'requesting' ? 'wait' : 'pointer',
              opacity: state === 'requesting' ? 0.6 : 1,
            }}
          >
            {state === 'requesting' && <Loader2 size={10} className="animate-spin" />}
            Allow camera
          </button>
          <button
            onClick={onDecline}
            disabled={state === 'requesting'}
            className="text-xs px-4 py-2"
            style={{
              color: '#9A9891',
              border: '1px solid #E3E1DB',
              borderRadius: 2, background: '#FFFFFF', cursor: 'pointer',
            }}
          >
            Continue without camera
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Rule item ─────────────────────────────────────────────────────

function RuleItem({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-start gap-3 py-2.5" style={{ borderBottom: '1px solid #F0EFEB' }}>
      <div style={{ color: '#9A9891', flexShrink: 0, marginTop: 1 }}>{icon}</div>
      <p className="text-xs" style={{ color: '#4A4A45', lineHeight: 1.6 }}>{text}</p>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────

export function ExamBriefingPage() {
  const { assessmentId } = useParams<{ assessmentId: string }>();
  const navigate = useNavigate();
  const { session } = useStudentAuth();

  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [existingAttempt, setExistingAttempt] = useState<Attempt | null>(null);
  const [attemptsUsed, setAttemptsUsed] = useState(0);
  const [effectiveMax, setEffectiveMax] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [cameraState, setCameraState] = useState<CameraState>('idle');
  const [cameraDeclined, setCameraDeclined] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [readyToEnter, setReadyToEnter] = useState(false);

  // Redirect if not logged in
  useEffect(() => {
    if (!session) navigate('/student/login', { replace: true });
  }, [session, navigate]);

  // Track fullscreen state
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // Update ready state
  useEffect(() => {
    const cameraOk = cameraState === 'granted' || cameraDeclined;
    setReadyToEnter(cameraOk);
  }, [cameraState, cameraDeclined, isFullscreen]);

  // Load assessment + existing attempt
  useEffect(() => {
    if (!assessmentId || !session) return;
    setLoading(true);
    Promise.all([
      getAssessment(assessmentId),
      getAllAttemptsByStudentAndAssessment(session.studentId, assessmentId),
    ])
      .then(([a, allAttempts]) => {
        if (!a) { setError('Assessment not found.'); return; }
        if (a.status === 'draft') { setError('This assessment is not yet published.'); return; }
        // Block gate — checked before showing briefing
        if (a.blockedStudents?.includes(session.studentId)) {
          setError('__blocked__'); return;
        }

        // Attempt-limit gate
        const effMax =
          a.attemptOverrides?.[session.studentId] ??
          a.maxAttempts;
        const finished = allAttempts.filter(
          (at) =>
            at.status === 'submitted' ||
            at.status === 'auto_submitted' ||
            at.status === 'terminated'
        ).length;
        setAttemptsUsed(finished);
        setEffectiveMax(effMax);
        if (effMax !== undefined && finished >= effMax) {
          setError('__attempts_exhausted__'); return;
        }

        setAssessment(a);
        // Most-recent attempt for resume detection
        const sorted = [...allAttempts].sort(
          (x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime()
        );
        const inProgress = sorted.find((at) => at.status === 'in_progress' || at.status === 'frozen') ?? null;
        setExistingAttempt(inProgress);
      })
      .catch((e) => setError(e.message || 'Failed to load assessment.'))
      .finally(() => setLoading(false));
  }, [assessmentId, session]);

  // ── Camera request ────────────────────────────────────────────

  const requestCamera = useCallback(async () => {
    setCameraState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      stream.getTracks().forEach((t) => t.stop()); // just checking permission
      setCameraState('granted');
      setCameraDeclined(false);
    } catch {
      setCameraState('denied');
      setCameraDeclined(true);
    }
  }, []);

  const declineCamera = useCallback(() => {
    setCameraState('denied');
    setCameraDeclined(true);
  }, []);

  // ── Fullscreen request ────────────────────────────────────────

  const requestFullscreen = useCallback(async () => {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // Some browsers block programmatic fullscreen — proceed anyway
    }
  }, []);

  // ── Enter exam ────────────────────────────────────────────────

  const enterExam = useCallback(async () => {
    if (!assessmentId) return;
    // Try fullscreen one more time
    if (!document.fullscreenElement) {
      try { await document.documentElement.requestFullscreen(); } catch {}
    }
    navigate(`/student/exam/${assessmentId}/shell`, {
      state: {
        cameraDeclined,
        cameraGranted: cameraState === 'granted',
      },
    });
  }, [assessmentId, navigate, cameraDeclined, cameraState]);

  // ── Render ────────────────────────────────────────────────────

  if (!session) return null;

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: '#F7F6F3' }}
    >
      {/* Minimal header */}
      <div
        className="sticky top-0 z-10 flex items-center justify-between px-8 py-3"
        style={{ background: '#FFFFFF', borderBottom: '1px solid #E3E1DB' }}
      >
        <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.12em' }}>
          STRATUM · EXAM BRIEFING
        </p>
        <button
          onClick={() => navigate('/student/assessments')}
          className="text-xs px-3 py-1.5"
          style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}
        >
          ← Back to assessments
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 flex items-start justify-center px-6 py-10">
        <div style={{ maxWidth: 680, width: '100%' }}>

          <AnimatePresence mode="wait">

            {loading && (
              <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div className="flex flex-col items-center py-24">
                  <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
                  <p className="text-xs mt-4" style={{ color: '#C4C3BD' }}>Loading assessment…</p>
                </div>
              </motion.div>
            )}

            {!loading && error && (
              <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                {error === '__blocked__' ? (
                  <div className="flex flex-col items-center gap-5 py-24">
                    <div className="flex items-center justify-center"
                      style={{ width: 52, height: 52, borderRadius: '50%',
                        background: '#FFF7ED', border: '1px solid #FED7AA' }}>
                      <Ban size={22} strokeWidth={1} style={{ color: '#9A3412' }} />
                    </div>
                    <div className="text-center" style={{ maxWidth: 360 }}>
                      <p className="text-xs mb-2" style={{ color: '#9A3412', letterSpacing: '0.1em' }}>
                        ACCESS RESTRICTED
                      </p>
                      <p className="text-sm mb-2" style={{ color: '#0C0C0B', lineHeight: 1.7 }}>
                        You have been blocked from entering this exam.
                      </p>
                      <p className="text-xs" style={{ color: '#9A9891', lineHeight: 1.6 }}>
                        Please contact your invigilator or faculty member if you believe
                        this is an error.
                      </p>
                    </div>
                    <button
                      onClick={() => navigate('/student/assessments')}
                      className="text-xs px-4 py-2"
                      style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, background: '#FFFFFF', cursor: 'pointer' }}
                    >
                      ← Back to assessments
                    </button>
                  </div>
                ) : error === '__attempts_exhausted__' ? (
                  <div className="flex flex-col items-center gap-5 py-24">
                    <div className="flex items-center justify-center"
                      style={{ width: 52, height: 52, borderRadius: '50%',
                        background: '#F7F6F3', border: '1px solid #E3E1DB' }}>
                      <ClipboardList size={22} strokeWidth={1} style={{ color: '#9A9891' }} />
                    </div>
                    <div className="text-center" style={{ maxWidth: 380 }}>
                      <p className="text-xs mb-2" style={{ color: '#6B6B66', letterSpacing: '0.1em' }}>
                        ATTEMPT LIMIT REACHED
                      </p>
                      <p className="text-sm mb-2" style={{ color: '#0C0C0B', lineHeight: 1.7 }}>
                        You have used all {effectiveMax} allowed attempt{effectiveMax !== 1 ? 's' : ''} for this exam.
                      </p>
                      <p className="text-xs" style={{ color: '#9A9891', lineHeight: 1.6 }}>
                        {attemptsUsed} of {effectiveMax} attempt{effectiveMax !== 1 ? 's' : ''} completed.
                        Contact your faculty if you believe additional attempts should be granted.
                      </p>
                    </div>
                    <button
                      onClick={() => navigate('/student/assessments')}
                      className="text-xs px-4 py-2"
                      style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, background: '#FFFFFF', cursor: 'pointer' }}
                    >
                      ← Back to assessments
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 px-4 py-3"
                    style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
                    <AlertTriangle size={13} strokeWidth={1.5} style={{ color: '#9B2828' }} />
                    <p className="text-xs" style={{ color: '#9B2828' }}>{error}</p>
                  </div>
                )}
              </motion.div>
            )}

            {!loading && !error && assessment && (
              <motion.div
                key="content"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                {/* Resume banner */}
                {existingAttempt?.status === 'in_progress' && (
                  <div className="flex items-center gap-3 px-4 py-3 mb-5"
                    style={{ background: '#FEF9EC', border: '1px solid #F5DFA0', borderRadius: 2 }}>
                    <Info size={13} strokeWidth={1.5} style={{ color: '#92680A' }} />
                    <p className="text-xs" style={{ color: '#92680A' }}>
                      You have an in-progress attempt for this exam. Entering will resume where you left off.
                    </p>
                  </div>
                )}

                {/* Attempt counter badge (shown if limit is set) */}
                {effectiveMax !== undefined && (
                  <div className="flex items-center gap-3 px-4 py-3 mb-5"
                    style={{ background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                    <ClipboardList size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
                    <p className="text-xs" style={{ color: '#6B6B66' }}>
                      Attempt <strong style={{ color: '#0C0C0B' }}>{attemptsUsed + 1}</strong> of{' '}
                      <strong style={{ color: '#0C0C0B' }}>{effectiveMax}</strong>
                      {attemptsUsed === 0 ? ' — first attempt' : ` — ${effectiveMax - attemptsUsed - 1} remaining after this`}
                    </p>
                  </div>
                )}

                {/* Assessment header */}
                <div className="mb-8" style={{ borderBottom: '1px solid #E3E1DB', paddingBottom: 24 }}>
                  <div className="flex items-center gap-2 mb-2">
                    <ClipboardList size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />
                    <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>
                      {assessment.subject || 'ASSESSMENT'}
                    </p>
                  </div>
                  <h1 className="text-2xl font-light mb-2" style={{ color: '#0C0C0B', letterSpacing: '0.01em' }}>
                    {assessment.title}
                  </h1>
                  {assessment.description && (
                    <p className="text-sm" style={{ color: '#6B6B66', lineHeight: 1.7 }}>
                      {assessment.description}
                    </p>
                  )}
                </div>

                {/* Quick stats */}
                <div className="grid grid-cols-3 gap-3 mb-8">
                  {[
                    {
                      icon: <Layers size={14} strokeWidth={1.5} style={{ color: '#9A9891' }} />,
                      label: 'Sections',
                      value: assessment.sections?.length ?? 1,
                    },
                    {
                      icon: <ClipboardList size={14} strokeWidth={1.5} style={{ color: '#9A9891' }} />,
                      label: 'Questions',
                      value: assessment.questions.length,
                    },
                    {
                      icon: <Award size={14} strokeWidth={1.5} style={{ color: '#9A9891' }} />,
                      label: 'Total marks',
                      value: assessment.totalMarks,
                    },
                  ].map((stat) => (
                    <div key={stat.label}
                      className="flex flex-col gap-1.5 px-4 py-4"
                      style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}>
                      {stat.icon}
                      <p className="text-sm" style={{ color: '#0C0C0B' }}>{stat.value}</p>
                      <p className="text-xs" style={{ color: '#9A9891' }}>{stat.label}</p>
                    </div>
                  ))}
                </div>

                {/* Section breakdown */}
                {assessment.sections && assessment.sections.length > 0 && (
                  <div className="mb-8"
                    style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3, overflow: 'hidden' }}>
                    <div className="px-4 py-3" style={{ borderBottom: '1px solid #F0EFEB' }}>
                      <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>SECTIONS</p>
                    </div>
                    {assessment.sections.map((sec, idx) => {
                      const secMarks = sec.questions.reduce((s, q) => s + q.marks, 0);
                      return (
                        <div key={sec.id}
                          className="flex items-center gap-4 px-4 py-3"
                          style={{ borderBottom: idx < assessment.sections!.length - 1 ? '1px solid #F0EFEB' : 'none' }}>
                          <div className="flex items-center justify-center flex-shrink-0"
                            style={{ width: 22, height: 22, borderRadius: 2, background: '#F0EFEB', border: '1px solid #E3E1DB', fontSize: 10, color: '#9A9891' }}>
                            {idx + 1}
                          </div>
                          <p className="text-xs flex-1" style={{ color: '#0C0C0B' }}>{sec.name}</p>
                          <div className="flex items-center gap-4">
                            <span className="text-xs" style={{ color: '#9A9891' }}>
                              {sec.questions.length} Q · {secMarks} mk
                            </span>
                            {sec.timeLimit && (
                              <div className="flex items-center gap-1 text-xs" style={{ color: '#9A9891' }}>
                                <Timer size={10} strokeWidth={1.5} />
                                {formatDuration(sec.timeLimit)}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Timing info */}
                {(assessment.startDate || assessment.endDate) && (
                  <div className="flex items-center gap-4 px-4 py-3 mb-6"
                    style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                    <Calendar size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />
                    {assessment.startDate && (
                      <span className="text-xs" style={{ color: '#6B6B66' }}>
                        {formatDateTime(assessment.startDate)}
                      </span>
                    )}
                    {assessment.endDate && (
                      <>
                        <ArrowRight size={11} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
                        <span className="text-xs" style={{ color: '#6B6B66' }}>
                          {formatDateTime(assessment.endDate)}
                        </span>
                      </>
                    )}
                  </div>
                )}

                {/* Exam rules */}
                <div className="mb-8"
                  style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3, overflow: 'hidden' }}>
                  <div className="px-4 py-3" style={{ borderBottom: '1px solid #F0EFEB' }}>
                    <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>EXAM RULES</p>
                  </div>
                  <div className="px-4">
                    <RuleItem icon={<Shield size={12} strokeWidth={1.5} />}
                      text="This exam is monitored for academic integrity. Any suspicious activity is logged and reviewed by your examiner." />
                    <RuleItem icon={<Maximize size={12} strokeWidth={1.5} />}
                      text="The exam must be taken in fullscreen mode. Exiting fullscreen will be recorded as a violation." />
                    <RuleItem icon={<Clock size={12} strokeWidth={1.5} />}
                      text="Each section has an independent time limit. When time expires, your answers for that section are automatically saved and you advance to the next section." />
                    <RuleItem icon={<Camera size={12} strokeWidth={1.5} />}
                      text="Your webcam is used for face verification only. Your video is not recorded. Multiple faces or absence of face for more than 10 seconds will be flagged." />
                    <RuleItem icon={<AlertTriangle size={12} strokeWidth={1.5} />}
                      text="Switching tabs, losing window focus, or opening DevTools will count as violations. After 3 violations, your exam will be automatically terminated." />
                    <RuleItem icon={<ClipboardList size={12} strokeWidth={1.5} />}
                      text="Copying, pasting, and right-clicking are disabled during the exam. All keyboard shortcuts are restricted." />
                    {assessment.shuffleQuestions && (
                      <RuleItem icon={<Info size={12} strokeWidth={1.5} />}
                        text="Questions are presented in a randomised order unique to your attempt." />
                    )}
                    {assessment.passingScore !== undefined && (
                      <RuleItem icon={<Award size={12} strokeWidth={1.5} />}
                        text={`The passing score for this exam is ${assessment.passingScore}%.`} />
                    )}
                  </div>
                </div>

                {/* Camera setup */}
                <div className="mb-6">
                  <p className="text-xs mb-3" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>CAMERA SETUP</p>
                  <CameraStep
                    state={cameraState}
                    onRequest={requestCamera}
                    onDecline={declineCamera}
                  />
                </div>

                {/* Fullscreen setup */}
                <div className="mb-8">
                  <p className="text-xs mb-3" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>FULLSCREEN</p>
                  <div className="flex items-center justify-between px-4 py-3"
                    style={{ background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                    <div className="flex items-center gap-3">
                      {isFullscreen
                        ? <CheckCircle2 size={13} strokeWidth={1.5} style={{ color: '#1E7B3C' }} />
                        : <Maximize size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />
                      }
                      <p className="text-xs" style={{ color: '#4A4A45' }}>
                        {isFullscreen ? 'Fullscreen active' : 'Not in fullscreen — recommended before entering'}
                      </p>
                    </div>
                    {!isFullscreen && (
                      <button
                        onClick={requestFullscreen}
                        className="text-xs px-3 py-1.5"
                        style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, cursor: 'pointer' }}
                      >
                        Enter fullscreen
                      </button>
                    )}
                  </div>
                </div>

                {/* Acknowledgement + enter */}
                <div
                  className="flex items-center justify-between gap-4 px-5 py-4"
                  style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
                >
                  <p className="text-xs" style={{ color: '#6B6B66', lineHeight: 1.6 }}>
                    By entering, you confirm that you have read and understood the exam rules and
                    that you will not engage in any academic dishonesty.
                  </p>
                  <button
                    onClick={enterExam}
                    disabled={!readyToEnter}
                    className="flex items-center gap-2 text-xs px-5 py-3 flex-shrink-0 transition-opacity"
                    style={{
                      background: readyToEnter ? '#0C0C0B' : '#C8C7C2',
                      color: '#FFFFFF',
                      borderRadius: 2,
                      cursor: readyToEnter ? 'pointer' : 'not-allowed',
                    }}
                  >
                    {existingAttempt?.status === 'in_progress' ? 'Resume exam' : 'Enter exam'}
                    <ChevronRight size={13} strokeWidth={1.5} />
                  </button>
                </div>

                {!readyToEnter && (
                  <p className="text-xs mt-3 text-center" style={{ color: '#C4C3BD' }}>
                    Please complete the camera setup above to proceed.
                  </p>
                )}

              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}