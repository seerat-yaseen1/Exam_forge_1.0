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
  CheckCircle2, Shield, Info, ChevronRight, Clock, Ban, Download,
} from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { getAssessment, getSebToken, getSEBPublicInfo, type Assessment } from '../../../lib/assessmentService';
import { scanForExtensionsWithSettle, extensionGateBlocks } from '../../components/exam/extensionScan';
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

/**
 * Can this browser be asked for fullscreen at all?
 *
 * `fullscreenEnabled` is false when the API is unavailable or forbidden by a
 * permissions policy — an iframe without `allow="fullscreen"`, and iOS Safari
 * on iPhone, which grants fullscreen to `<video>` and to nothing else.
 *
 * This is checked at call time rather than captured at module load because the
 * answer is a property of the document as it stands, and a module-level
 * constant would freeze whatever the very first render happened to see.
 */
export function fullscreenSupported(): boolean {
  if (typeof document === 'undefined') return false;
  return document.fullscreenEnabled === true
    && typeof document.documentElement.requestFullscreen === 'function';
}

/**
 * The entry gate's fullscreen condition.
 *
 * On a browser that CAN go fullscreen, being in it is required — no override,
 * because an exam that merely suggests fullscreen has not gated anything.
 *
 * On a browser that cannot, the requirement is unsatisfiable, and enforcing it
 * would not make that student's sitting more secure — it would make it
 * impossible. They are let through and the shell's other detectors (tab
 * switch, focus loss, viewport geometry) carry the load, which is the same
 * bargain `allowMobile` already strikes. The alternative is a student locked
 * out of their own exam by a device the institution chose to permit.
 */
export function fullscreenOk(isFullscreen: boolean): boolean {
  return !fullscreenSupported() || isFullscreen;
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
        style={{ background: 'var(--ef-success-bg)', border: '1px solid var(--ef-success-border)', borderRadius: 2 }}>
        <CheckCircle2 size={14} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)', flexShrink: 0 }} />
        <p className="text-xs" style={{ color: 'var(--ef-success-strong)' }}>Camera access granted. You can be seen during the exam.</p>
      </div>
    );
  }

  if (state === 'denied') {
    return (
      <div className="flex items-start gap-3 px-4 py-3"
        style={{ background: '#FEF9EC', border: '1px solid var(--ef-warning-border)', borderRadius: 2 }}>
        <AlertTriangle size={14} strokeWidth={1.5} style={{ color: 'var(--ef-warning)', flexShrink: 0, marginTop: 1 }} />
        <div>
          <p className="text-xs" style={{ color: 'var(--ef-warning)' }}>
            Camera access was declined or unavailable. You may continue without camera,
            but this will be noted in your attempt record.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-4 px-4 py-4"
      style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
      <div className="flex items-center justify-center flex-shrink-0"
        style={{ width: 36, height: 36, borderRadius: 2, background: 'var(--ef-border-subtle)', border: '1px solid var(--ef-border)' }}>
        <Camera size={16} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
      </div>
      <div className="flex-1">
        <p className="text-xs mb-1" style={{ color: 'var(--ef-ink)' }}>Webcam verification required</p>
        <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
          This exam uses webcam monitoring to verify your identity and detect irregularities.
          Your camera feed is not recorded — only face count is analysed.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={onRequest}
            disabled={state === 'requesting'}
            className="flex items-center gap-1.5 text-xs px-4 py-2"
            style={{
              background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2,
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
              color: 'var(--ef-text-muted)',
              border: '1px solid var(--ef-border)',
              borderRadius: 2, background: 'var(--ef-surface)', cursor: 'pointer',
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
    <div className="flex items-start gap-3 py-2.5" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
      <div style={{ color: 'var(--ef-text-muted)', flexShrink: 0, marginTop: 1 }}>{icon}</div>
      <p className="text-xs" style={{ color: 'var(--ef-text-subtle)', lineHeight: 1.6 }}>{text}</p>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────

export function ExamBriefingPage() {
  const { assessmentId } = useParams<{ assessmentId: string }>();
  const navigate = useNavigate();
  const { session, loading: authLoading } = useStudentAuth();

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
  // ── Extension entry gate (Phase 1c completion) ─────────────────
  // 'idle' before scan, 'scanning' while checking, 'clean' or 'dirty' after.
  const [extScanState, setExtScanState] = useState<'idle' | 'scanning' | 'clean' | 'dirty'>('idle');
  const [extFound, setExtFound] = useState<string[]>([]);
  // Generic foreign-DOM findings. Advisory only — never gates entry (see the
  // scan effect), so it is held apart from extFound rather than merged into it.
  const [extForeign, setExtForeign] = useState<string[]>([]);
  const [extScanNonce, setExtScanNonce] = useState(0); // bump to re-scan

  // ── SEB entry gate (Phase 3, Stage 3) ────────────────────────────
  // 'na' when the assessment doesn't require SEB. Otherwise we ask
  // /api/seb-verify (via getSebToken) whether THIS browser is a genuine
  // Safe Exam Browser running the correct config. This is a real server
  // verdict, not user-agent sniffing — a spoofed UA fails here exactly as
  // it would fail at startExam. UX-only: the server re-checks every call.
  const [sebGate, setSebGate] = useState<'na' | 'checking' | 'verified' | 'blocked'>('na');
  const [sebGateError, setSebGateError] = useState('');
  const [sebNonce, setSebNonce] = useState(0); // bump to re-verify
  // Stage 4b: platform .seb link fallback (publicSettings/seb — link only,
  // never keys). Used when the exam has no exam-specific file of its own.
  const [platformSebUrl, setPlatformSebUrl] = useState('');
  useEffect(() => {
    if (assessment?.requireSEB !== true) return;
    getSEBPublicInfo().then((i) => setPlatformSebUrl(i.configFileUrl ?? '')).catch(() => {});
  }, [assessment?.requireSEB]);

  // Redirect if not logged in — but only once auth has finished rehydrating.
  // Firebase restores the session from IndexedDB asynchronously, so the first
  // run after a refresh always sees session === null with loading still true;
  // redirecting on that raced the restore and bounced the student to login.
  // Deferring is required rather than cosmetic: the effect does re-run when
  // session arrives, but the navigate has already happened by then.
  useEffect(() => {
    if (authLoading) return;
    if (!session) navigate('/student/login', { replace: true });
  }, [authLoading, session, navigate]);

  // Track fullscreen state
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // ── Extension entry scan (Phase 1c) ────────────────────────────
  // For tiers that require the extension check, scan (with a settle delay to
  // catch slow-injecting extensions) before allowing entry. Re-runs when
  // extScanNonce is bumped by the "re-check" button. Tiers that don't require
  // the check skip straight to 'clean'.
  useEffect(() => {
    if (!assessment) return;
    const required = assessment.requireExtensionCheck === true;
    if (!required) { setExtScanState('clean'); setExtFound([]); return; }
    let cancelled = false;
    setExtScanState('scanning');
    scanForExtensionsWithSettle().then((result) => {
      if (cancelled) return;
      // ── BOTH halves gate entry now ──────────────────────────────
      //
      // This used to admit a student over any finding the fingerprint list
      // could not name, on the reasoning that a heuristic false positive here
      // refuses somebody their sitting. That reasoning was imported from the
      // FREEZE path, and it does not survive the move to this surface.
      //
      // A freeze is unrecoverable without a human: since D-30 there is no
      // automatic exit, so a false positive mid-exam strands a student until
      // an invigilator notices. Refusing ENTRY is the opposite — it is the one
      // moment in the whole sitting when being wrong costs nothing that cannot
      // be undone. Nothing has started, no clock is running, no answer exists.
      // The student disables the extension, presses re-check, and continues.
      // The remedy is in their hands and takes seconds.
      //
      // Against that, admitting them was never free either: an unnamed
      // injector is precisely the case the named list cannot see, and letting
      // it through meant the student sat the whole paper accumulating
      // foreign_dom violations for something they were told was "often
      // harmless" and could have removed before starting.
      //
      // What made this safe to switch on was fixing the detector, not changing
      // the policy around it. Until this same branch, the app's own Firebase
      // App Check container was reported as a foreign element on every load —
      // so this gate would have refused every student on every machine. A
      // blocking check is only as defensible as its quietest false positive.
      //
      // Mid-exam behaviour is deliberately NOT changed: foreign_dom stays a
      // recorded, non-freezing signal there, because that surface still has
      // the cost profile the original note described.
      setExtForeign(result.foreign);
      const blocking = extensionGateBlocks(result);
      setExtFound(result.named);
      setExtScanState(blocking ? 'dirty' : 'clean');
    });
    return () => { cancelled = true; };
  }, [assessment, extScanNonce]);

  // ── SEB verification (Phase 3, Stage 3) ─────────────────────────
  // Runs when the assessment requires SEB; re-runs when sebNonce is bumped
  // by the "Re-check" button (e.g. after the student reopens via the .seb
  // file). Assessments without the requirement skip straight to 'na'.
  useEffect(() => {
    if (!assessment) return;
    if (assessment.requireSEB !== true) {
      setSebGate('na');
      setSebGateError('');
      return;
    }
    let cancelled = false;
    setSebGate('checking');
    getSebToken(assessment.id).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setSebGate('verified');
        setSebGateError('');
      } else {
        setSebGate('blocked');
        setSebGateError(r.error ?? '');
      }
    });
    return () => { cancelled = true; };
  }, [assessment, sebNonce]);

  // Update ready state
  useEffect(() => {
    const cameraOk = cameraState === 'granted' || cameraDeclined;
    const extensionOk = extScanState === 'clean';
    const sebOk = sebGate === 'na' || sebGate === 'verified';
    // Fullscreen was already in this effect's dependency list and was never
    // read — the gate said "recommended" and let the student through without
    // it. The shell then caught them with its own overlay, so the exam was
    // never actually interactive outside fullscreen, but the requirement was
    // being enforced one page too late: the student clicked Enter, the attempt
    // was created, and only then were they told they had to be in fullscreen.
    //
    // Requiring it HERE means the transition into the exam happens from a
    // known-good state, and the browser's fullscreen request is driven by the
    // student's own click on the button below — a real user gesture, which is
    // the only kind Chrome and Safari honour.
    setReadyToEnter(cameraOk && extensionOk && sebOk && fullscreenOk(isFullscreen));
  }, [cameraState, cameraDeclined, isFullscreen, extScanState, sebGate]);

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

        // Schedule gate — refuse entry before the advertised startDate. A
        // student who navigates directly to the briefing URL early sees a
        // locked state instead of the exam. The countdown effect below
        // re-checks each minute so the state auto-clears when the time hits.
        if (a.startDate && new Date() < new Date(a.startDate)) {
          setAssessment(a);
          setError('__not_yet_open__'); return;
        }

        // Attempt-limit gate
        const effMax =
          a.attemptOverrides?.[session.studentId] ??
          a.maxAttempts ??
          1;
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

  // ── Auto-clear the "not yet open" gate when startDate passes ─────
  useEffect(() => {
    if (error !== '__not_yet_open__' || !assessment?.startDate) return;
    const startMs = new Date(assessment.startDate).getTime();
    const tick = () => {
      if (Date.now() >= startMs) {
        // Reload — the load effect above will re-check the gate and, if all
        // other gates pass, transition into the briefing.
        setError('');
        // Trigger a fresh load by nudging session dep; simplest is to
        // re-run getAssessment + attempts and let the load effect settle.
        // Force a rerun by toggling loading — the outer effect keys on
        // assessmentId/session only, so we manually restart the checks.
        setLoading(true);
        Promise.all([
          getAssessment(assessmentId!),
          getAllAttemptsByStudentAndAssessment(session!.studentId, assessmentId!),
        ])
          .then(([a, allAttempts]) => {
            if (!a) { setError('Assessment not found.'); return; }
            if (a.blockedStudents?.includes(session!.studentId)) { setError('__blocked__'); return; }
            const effMax = a.attemptOverrides?.[session!.studentId] ?? a.maxAttempts ?? 1;
            const finished = allAttempts.filter((at) =>
              at.status === 'submitted' || at.status === 'auto_submitted' || at.status === 'terminated').length;
            setAttemptsUsed(finished);
            setEffectiveMax(effMax);
            if (effMax !== undefined && finished >= effMax) { setError('__attempts_exhausted__'); return; }
            setAssessment(a);
            const sorted = [...allAttempts].sort(
              (x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime());
            setExistingAttempt(sorted.find((at) => at.status === 'in_progress' || at.status === 'frozen') ?? null);
          })
          .finally(() => setLoading(false));
      }
    };
    tick(); // immediate check in case component mounted late
    const id = setInterval(tick, 15_000); // 15s cadence — good enough for a per-minute schedule
    return () => clearInterval(id);
  }, [error, assessment?.startDate, assessmentId, session]);

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
    // Belt-and-suspenders schedule check at click-time in case the render
    // is stale (e.g. student left the tab open on the briefing for a while).
    if (assessment?.startDate && new Date() < new Date(assessment.startDate)) {
      setError('__not_yet_open__');
      return;
    }
    // Click-time extension re-scan (Phase 1c). Catches an extension enabled
    // AFTER the initial scan passed. If dirty, block entry and surface it.
    if (assessment?.requireExtensionCheck === true) {
      const result = await scanForExtensionsWithSettle(300);
      setExtForeign(result.foreign);
      // Same both-halves rule as the mount scan above. This is the branch that
      // actually matters for the case it was written for: an extension enabled
      // AFTER the first scan passed. Somebody turning on a sidebar between
      // reading the rules and pressing Enter is not doing it by accident, and
      // the first scan is exactly what they would be stepping around.
      if (extensionGateBlocks(result)) {
        setExtFound(result.named);
        setExtScanState('dirty');
        return;
      }
    }
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
  }, [assessmentId, navigate, cameraDeclined, cameraState, assessment?.startDate, assessment?.requireExtensionCheck]);

  // ── Render ────────────────────────────────────────────────────

  if (!session) return null;

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: 'var(--ef-canvas)' }}
    >
      {/* Minimal header */}
      <div
        className="sticky top-0 z-10 flex items-center justify-between px-8 py-3"
        style={{ background: 'var(--ef-surface)', borderBottom: '1px solid var(--ef-border)' }}
      >
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.12em' }}>
          STRATUM · EXAM BRIEFING
        </p>
        <button
          onClick={() => navigate('/student/assessments')}
          className="text-xs px-3 py-1.5"
          style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}
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
                  <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
                  <p className="text-xs mt-4" style={{ color: 'var(--ef-text-muted)' }}>Loading assessment…</p>
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
                      <p className="text-sm mb-2" style={{ color: 'var(--ef-ink)', lineHeight: 1.7 }}>
                        You have been blocked from entering this exam.
                      </p>
                      <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                        Please contact your invigilator or faculty member if you believe
                        this is an error.
                      </p>
                    </div>
                    <button
                      onClick={() => navigate('/student/assessments')}
                      className="text-xs px-4 py-2"
                      style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2, background: 'var(--ef-surface)', cursor: 'pointer' }}
                    >
                      ← Back to assessments
                    </button>
                  </div>
                ) : error === '__not_yet_open__' ? (
                  <div className="flex flex-col items-center gap-5 py-24 px-4">
                    <div className="flex items-center justify-center"
                      style={{ width: 52, height: 52, borderRadius: '50%',
                        background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)' }}>
                      <Clock size={22} strokeWidth={1} style={{ color: 'var(--ef-text-muted)' }} />
                    </div>
                    <div className="text-center" style={{ maxWidth: 380 }}>
                      <p className="text-xs mb-2" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
                        NOT YET OPEN
                      </p>
                      <p className="text-sm mb-2 break-words" style={{ color: 'var(--ef-ink)', lineHeight: 1.7 }}>
                        This exam hasn't started yet.
                      </p>
                      {assessment?.startDate && (
                        <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                          Opens {formatDateTime(assessment.startDate)}. This page will unlock
                          automatically once the exam is open.
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => navigate('/student/assessments')}
                      className="text-xs px-4 py-2"
                      style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2, background: 'var(--ef-surface)', cursor: 'pointer' }}
                    >
                      ← Back to assessments
                    </button>
                  </div>
                ) : error === '__attempts_exhausted__' ? (
                  <div className="flex flex-col items-center gap-5 py-24">
                    <div className="flex items-center justify-center"
                      style={{ width: 52, height: 52, borderRadius: '50%',
                        background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)' }}>
                      <ClipboardList size={22} strokeWidth={1} style={{ color: 'var(--ef-text-muted)' }} />
                    </div>
                    <div className="text-center" style={{ maxWidth: 380 }}>
                      <p className="text-xs mb-2" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
                        ATTEMPT LIMIT REACHED
                      </p>
                      <p className="text-sm mb-2" style={{ color: 'var(--ef-ink)', lineHeight: 1.7 }}>
                        You have used all {effectiveMax} allowed attempt{effectiveMax !== 1 ? 's' : ''} for this exam.
                      </p>
                      <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                        {attemptsUsed} of {effectiveMax} attempt{effectiveMax !== 1 ? 's' : ''} completed.
                        Contact your faculty if you believe additional attempts should be granted.
                      </p>
                    </div>
                    <button
                      onClick={() => navigate('/student/assessments')}
                      className="text-xs px-4 py-2"
                      style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2, background: 'var(--ef-surface)', cursor: 'pointer' }}
                    >
                      ← Back to assessments
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 px-4 py-3"
                    style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
                    <AlertTriangle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />
                    <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{error}</p>
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
                    style={{ background: '#FEF9EC', border: '1px solid var(--ef-warning-border)', borderRadius: 2 }}>
                    <Info size={13} strokeWidth={1.5} style={{ color: 'var(--ef-warning)' }} />
                    <p className="text-xs" style={{ color: 'var(--ef-warning)' }}>
                      You have an in-progress attempt for this exam. Entering will resume where you left off.
                    </p>
                  </div>
                )}

                {/* Attempt counter badge (shown if limit is set) */}
                {effectiveMax !== undefined && (
                  <div className="flex items-center gap-3 px-4 py-3 mb-5"
                    style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                    <ClipboardList size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
                    <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                      Attempt <strong style={{ color: 'var(--ef-ink)' }}>{attemptsUsed + 1}</strong> of{' '}
                      <strong style={{ color: 'var(--ef-ink)' }}>{effectiveMax}</strong>
                      {attemptsUsed === 0 ? ' — first attempt' : ` — ${effectiveMax - attemptsUsed - 1} remaining after this`}
                    </p>
                  </div>
                )}

                {/* Assessment header */}
                <div className="mb-8" style={{ borderBottom: '1px solid var(--ef-border)', paddingBottom: 24 }}>
                  <div className="flex items-center gap-2 mb-2">
                    <ClipboardList size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
                    <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
                      {assessment.subject || 'ASSESSMENT'}
                    </p>
                  </div>
                  <h1 className="text-2xl font-light mb-2" style={{ color: 'var(--ef-ink)', letterSpacing: '0.01em' }}>
                    {assessment.title}
                  </h1>
                  {assessment.description && (
                    <p className="text-sm" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.7 }}>
                      {assessment.description}
                    </p>
                  )}
                </div>

                {/* Quick stats */}
                <div className="grid grid-cols-3 gap-3 mb-8">
                  {[
                    {
                      icon: <Layers size={14} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />,
                      label: 'Sections',
                      value: assessment.sections?.length ?? 1,
                    },
                    {
                      icon: <ClipboardList size={14} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />,
                      label: 'Questions',
                      value: assessment.questions.length,
                    },
                    {
                      icon: <Award size={14} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />,
                      label: 'Total marks',
                      value: assessment.totalMarks,
                    },
                  ].map((stat) => (
                    <div key={stat.label}
                      className="flex flex-col gap-1.5 px-4 py-4"
                      style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}>
                      {stat.icon}
                      <p className="text-sm" style={{ color: 'var(--ef-ink)' }}>{stat.value}</p>
                      <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{stat.label}</p>
                    </div>
                  ))}
                </div>

                {/* Section breakdown */}
                {assessment.sections && assessment.sections.length > 0 && (
                  <div className="mb-8"
                    style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3, overflow: 'hidden' }}>
                    <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
                      <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>SECTIONS</p>
                    </div>
                    {assessment.sections.map((sec, idx) => {
                      const secMarks = sec.questions.reduce((s, q) => s + q.marks, 0);
                      return (
                        <div key={sec.id}
                          className="flex items-center gap-4 px-4 py-3"
                          style={{ borderBottom: idx < assessment.sections!.length - 1 ? '1px solid var(--ef-border-subtle)' : 'none' }}>
                          <div className="flex items-center justify-center flex-shrink-0"
                            style={{ width: 22, height: 22, borderRadius: 2, background: 'var(--ef-border-subtle)', border: '1px solid var(--ef-border)', fontSize: 10, color: 'var(--ef-text-muted)' }}>
                            {idx + 1}
                          </div>
                          <p className="text-xs flex-1" style={{ color: 'var(--ef-ink)' }}>{sec.name}</p>
                          <div className="flex items-center gap-4">
                            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                              {sec.questions.length} Q · {secMarks} mk
                            </span>
                            {sec.timeLimit && (
                              <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
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
                    style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                    <Calendar size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
                    {assessment.startDate && (
                      <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                        {formatDateTime(assessment.startDate)}
                      </span>
                    )}
                    {assessment.endDate && (
                      <>
                        <ArrowRight size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
                        <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                          {formatDateTime(assessment.endDate)}
                        </span>
                      </>
                    )}
                  </div>
                )}

                {/* Exam rules */}
                <div className="mb-8"
                  style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3, overflow: 'hidden' }}>
                  <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
                    <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>EXAM RULES</p>
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
                    {/* Stated up front because it is now a HARD gate. A student
                        who reads this before starting can clear their browser
                        in their own time; one who meets it for the first time
                        at the Enter button is troubleshooting under exam
                        pressure, which is the same requirement delivered at the
                        worst possible moment. */}
                    {assessment.requireExtensionCheck === true && (
                      <RuleItem icon={<Shield size={12} strokeWidth={1.5} />}
                        text="This exam requires a clean browser. Any browser extension that adds content to the page will block entry until it is disabled — check before you begin." />
                    )}
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
                  <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>CAMERA SETUP</p>
                  <CameraStep
                    state={cameraState}
                    onRequest={requestCamera}
                    onDecline={declineCamera}
                  />
                </div>

                {/* Fullscreen setup */}
                <div className="mb-8">
                  <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>FULLSCREEN</p>
                  <div className="flex items-center justify-between px-4 py-3"
                    style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                    <div className="flex items-center gap-3">
                      {isFullscreen
                        ? <CheckCircle2 size={13} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)' }} />
                        : <Maximize size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
                      }
                      <p className="text-xs" style={{ color: 'var(--ef-text-subtle)' }}>
                        {isFullscreen
                          ? 'Fullscreen active'
                          : fullscreenSupported()
                            ? 'Not in fullscreen — required before entering'
                            : 'This browser cannot enter fullscreen — you may continue'}
                      </p>
                    </div>
                    {!isFullscreen && fullscreenSupported() && (
                      <button
                        onClick={requestFullscreen}
                        className="text-xs px-3 py-1.5"
                        style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: 'pointer' }}
                      >
                        Enter fullscreen
                      </button>
                    )}
                  </div>
                </div>

                {/* Safe Exam Browser gate (Phase 3, Stage 3) */}
                {assessment?.requireSEB === true && (
                  <div className="mb-8">
                    <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
                      SAFE EXAM BROWSER
                    </p>
                    <div className="px-4 py-3"
                      style={{
                        background: sebGate === 'blocked' ? '#FBF3F3' : sebGate === 'verified' ? 'var(--ef-success-bg)' : 'var(--ef-canvas-raised)',
                        border: `1px solid ${sebGate === 'blocked' ? '#E3C9C9' : sebGate === 'verified' ? 'var(--ef-success-border)' : 'var(--ef-border)'}`,
                        borderRadius: 2,
                      }}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          {sebGate === 'checking' && <Loader2 size={13} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />}
                          {sebGate === 'verified' && <CheckCircle2 size={13} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)' }} />}
                          {sebGate === 'blocked' && <AlertTriangle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />}
                          {sebGate === 'na' && <Shield size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />}
                          <p className="text-xs" style={{ color: sebGate === 'blocked' ? 'var(--ef-danger)' : sebGate === 'verified' ? 'var(--ef-success-strong)' : 'var(--ef-text-subtle)' }}>
                            {sebGate === 'checking' && 'Verifying Safe Exam Browser…'}
                            {sebGate === 'verified' && 'Safe Exam Browser verified'}
                            {sebGate === 'blocked' && 'This exam must be taken in Safe Exam Browser'}
                          </p>
                        </div>
                        {sebGate === 'blocked' && (
                          <button
                            onClick={() => setSebNonce((n) => n + 1)}
                            className="text-xs px-3 py-1.5 flex-shrink-0"
                            style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: 'pointer' }}
                          >
                            Re-check
                          </button>
                        )}
                      </div>
                      {sebGate === 'blocked' && (
                        <div className="mt-3" style={{ borderTop: '1px solid #E3C9C9', paddingTop: 12 }}>
                          <p className="text-xs mb-3" style={{ color: 'var(--ef-danger)', lineHeight: 1.6 }}>
                            {sebGateError === 'SEB_CONFIG_MISMATCH'
                              ? 'Safe Exam Browser was detected, but it is not running the exam configuration for this platform. Close SEB and reopen the exam using the .seb configuration file provided by your institute.'
                              : 'You are not currently in Safe Exam Browser. Install SEB, then open the exam by double-clicking the .seb configuration file provided by your institute — it will launch SEB and bring you back to this page.'}
                          </p>
                          <div className="flex items-center gap-2 flex-wrap">
                            <a
                              href="https://safeexambrowser.org/download_en.html"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1.5 text-xs px-4 py-2"
                              style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, textDecoration: 'none' }}
                            >
                              <Download size={11} strokeWidth={1.5} />
                              Download Safe Exam Browser
                            </a>
                            {(assessment.sebConfigFileUrl || platformSebUrl) && (
                              <a
                                href={assessment.sebConfigFileUrl || platformSebUrl}
                                className="flex items-center gap-1.5 text-xs px-4 py-2"
                                style={{ color: 'var(--ef-text-subtle)', border: '1px solid #E3C9C9', borderRadius: 2, background: 'var(--ef-surface)', textDecoration: 'none' }}
                              >
                                <Download size={11} strokeWidth={1.5} />
                                Exam configuration (.seb)
                              </a>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Extension check (Phase 1c) — only for tiers that require it */}
                {assessment?.requireExtensionCheck === true && (
                  <div className="mb-8">
                    <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
                      EXTENSION CHECK
                    </p>
                    <div className="px-4 py-3"
                      style={{
                        background: extScanState === 'dirty' ? '#FBF3F3' : 'var(--ef-canvas-raised)',
                        border: `1px solid ${extScanState === 'dirty' ? '#E3C9C9' : 'var(--ef-border)'}`,
                        borderRadius: 2,
                      }}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {extScanState === 'scanning' && <Loader2 size={13} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />}
                          {extScanState === 'clean' && <CheckCircle2 size={13} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)' }} />}
                          {extScanState === 'dirty' && <AlertTriangle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />}
                          {(extScanState === 'idle') && <Shield size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />}
                          <p className="text-xs" style={{ color: extScanState === 'dirty' ? 'var(--ef-danger)' : 'var(--ef-text-subtle)' }}>
                            {extScanState === 'scanning' && 'Checking for browser extensions…'}
                            {extScanState === 'clean' && 'No conflicting extensions detected'}
                            {/* "Browser extension detected" is a claim only the
                                named half can support. When the block comes
                                from the generic check the headline says what
                                was actually observed. */}
                            {extScanState === 'dirty' && (extFound.length > 0
                              ? 'Browser extension detected — remove it to continue'
                              : 'Unrecognised page content — must be cleared to continue')}
                            {extScanState === 'idle' && 'Extension check pending'}
                          </p>
                        </div>
                        {extScanState === 'dirty' && (
                          <button
                            onClick={() => setExtScanNonce((n) => n + 1)}
                            className="text-xs px-3 py-1.5"
                            style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: 'pointer' }}
                          >
                            Re-check
                          </button>
                        )}
                      </div>
                      {extScanState === 'dirty' && extFound.length > 0 && (
                        <p className="text-xs mt-2" style={{ color: 'var(--ef-danger)', lineHeight: 1.6 }}>
                          Detected: {extFound.join(', ')}. Please disable or remove
                          {extFound.length > 1 ? ' these extensions' : ' this extension'} in your browser,
                          then click Re-check.
                        </p>
                      )}
                      {/* Blocking now, and worded for a student who CANNOT act
                          on the finding as written. A named match says
                          "Grammarly" and the remedy is obvious; this half can
                          only say <div#xyz>, which names nothing the student
                          recognises. So the copy leads with the remedy that
                          always works regardless of what the element turns out
                          to be — disable everything, or use a clean profile —
                          and still shows the descriptor, because a student who
                          DOES recognise it is one re-check away from being
                          done. It stays an observation rather than an
                          accusation: the check genuinely cannot name what it
                          found, and telling somebody they have cheated on the
                          strength of an unidentified <div> would be a claim
                          this code cannot support. */}
                      {extScanState !== 'scanning' && extForeign.length > 0 && (
                        <p className="text-xs mt-2" style={{ color: 'var(--ef-danger)', lineHeight: 1.6 }}>
                          Unrecognised on this page: {extForeign.join(', ')}. This exam requires a
                          clean browser, so {extForeign.length > 1 ? 'these must' : 'this must'} be
                          gone before you can enter. It usually belongs to a browser extension.
                          Disable your extensions — or open this exam in a private/guest window with
                          extensions off — then click Re-check. If it will not clear, contact your
                          invigilator rather than waiting; your exam has not started.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Acknowledgement + enter */}
                <div
                  className="flex items-center justify-between gap-4 px-5 py-4"
                  style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
                >
                  <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                    By entering, you confirm that you have read and understood the exam rules and
                    that you will not engage in any academic dishonesty.
                  </p>
                  <button
                    onClick={enterExam}
                    disabled={!readyToEnter}
                    className="flex items-center gap-2 text-xs px-5 py-3 flex-shrink-0 transition-opacity"
                    style={{
                      background: readyToEnter ? 'var(--ef-ink)' : 'var(--ef-track)',
                      color: 'var(--ef-surface)',
                      borderRadius: 2,
                      cursor: readyToEnter ? 'pointer' : 'not-allowed',
                    }}
                  >
                    {existingAttempt?.status === 'in_progress' ? 'Resume exam' : 'Enter exam'}
                    <ChevronRight size={13} strokeWidth={1.5} />
                  </button>
                </div>

                {!readyToEnter && (
                  <p className="text-xs mt-3 text-center" style={{ color: 'var(--ef-text-muted)' }}>
                    {sebGate === 'blocked'
                      ? 'Open this exam in Safe Exam Browser to proceed.'
                      : sebGate === 'checking'
                        ? 'Verifying Safe Exam Browser…'
                        : extScanState === 'dirty'
                          ? 'Remove the detected extension and re-check to proceed.'
                          : extScanState === 'scanning'
                            ? 'Checking your browser before you can enter…'
                            : 'Please complete the setup above to proceed.'}
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