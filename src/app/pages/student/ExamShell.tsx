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
import { getExamQuestionsForStudent, type Question } from '../../../lib/questionBankService';
import {
  startAttempt,
  saveAnswer,
  saveAnswers,
  submitSection,
  endBreak,
  pickSection,
  gradeAttempt,
  logViolation,
  enforceIntegrityThreshold,
  MAX_INTEGRITY_WARNINGS,
  MAX_LOGGED_VIOLATION_EVENTS,
  getAttemptByStudentAndAssessment,
  getServerSkew,
  subscribeToAttempt,
  registerSession,
  sendHeartbeat,
  reportExtensionCheck,
  verifyAndResume,
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
import { ExtensionWatchdog } from '../../components/exam/ExtensionWatchdog';
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

type ShellStatus = 'loading' | 'ready' | 'choosing_section' | 'on_break' | 'submitting_section' | 'submitting_exam' | 'submit_failed' | 'submitted' | 'terminated' | 'error';

type BreakState = {
  justSubmittedSectionId: string;
  justSubmittedSectionName: string;
  nextSectionId: string;
  nextSectionIdx: number;
  nextSectionName: string;
  endsAt: number;        // ms timestamp
  mandatory: boolean;
};

type OverlayKind =
  | { kind: 'warning'; violationType: ViolationType; warningNumber: 1 | 2 }
  | { kind: 'final_warning'; violationType: ViolationType }
  | { kind: 'fullscreen_required' }
  | { kind: 'terminated'; reason: string }
  | { kind: 'session_conflict' }
  | null;

// ── Generate a unique session ID for dual-device detection ────────
// Persisted in sessionStorage per-tab so a same-tab refresh keeps the
// same identity (won't kick itself); a new tab/window/device gets a
// fresh id and is correctly detected as another session.
function generateSessionId(): string {
  const KEY = 'stratum.examSessionId';
  try {
    const existing = sessionStorage.getItem(KEY);
    if (existing) return existing;
  } catch {
    // sessionStorage may be blocked; fall through to a fresh id
  }
  const fresh =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `sess_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  try { sessionStorage.setItem(KEY, fresh); } catch { /* ignore */ }
  return fresh;
}

// ══════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════

const WARNING_VIOLATION_TYPES: ViolationType[] = ['tab_switch', 'focus_loss', 'fullscreen_exit'];
const MAX_WARNINGS = MAX_INTEGRITY_WARNINGS;

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

/**
 * Single source of truth for "did the student meaningfully answer this?".
 * Used by both the submit-modal unanswered count and the bottom-bar answered
 * count so the two never disagree (e.g. a whitespace-only text answer must
 * read the same way in both places).
 */
function isAnswerEmpty(ans: AttemptAnswer | undefined): boolean {
  if (!ans) return true;
  if (ans.type === 'text') return !(ans.value as string).trim();
  if (Array.isArray(ans.value)) return (ans.value as string[]).length === 0;
  if (typeof ans.value === 'object') return Object.keys(ans.value as Record<string, string>).length === 0;
  return !(ans.value as string);
}

// ══════════════════════════════════════════════════════════════════
// FREEZE PAUSED OVERLAY  (blocking — exam is halted, clock is paused)
// ══════════════════════════════════════════════════════════════════

function FreezePausedOverlay({ reason }: { reason?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center px-6"
      style={{ background: 'rgba(12,12,11,0.92)' }}
    >
      <motion.div
        initial={{ scale: 0.95, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 12 }}
        className="flex flex-col items-center gap-5"
        style={{ maxWidth: 420, textAlign: 'center' }}
      >
        {/* Pulsing pause indicator */}
        <div className="flex items-center justify-center"
          style={{
            position: 'relative', width: 56, height: 56, borderRadius: '50%',
            background: 'rgba(212,160,23,0.15)', border: '1px solid rgba(212,160,23,0.35)',
          }}>
          <div style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            background: '#D4A017', opacity: 0.25,
            animation: 'freeze-ping 1.6s ease-in-out infinite',
          }} />
          <Flag size={22} strokeWidth={1.5} style={{ color: '#F5DFA0' }} />
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs" style={{ color: '#F5DFA0', letterSpacing: '0.12em' }}>
            EXAM PAUSED
          </p>
          <p className="text-sm" style={{ color: '#FFFFFF', lineHeight: 1.6 }}>
            An invigilator has paused your exam.
          </p>
          <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.5)', lineHeight: 1.6 }}>
            Your timer is stopped and no time is being lost. Please wait — the exam
            will resume automatically when the invigilator lifts the pause.
          </p>
          {reason && (
            <p className="text-xs mt-2" style={{ color: 'rgba(255,255,255,0.4)', lineHeight: 1.6 }}>
              Reason: {reason}
            </p>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// EXTENSION FREEZE OVERLAY (Phase 1c)
// Shown when the server froze the attempt because a browser extension was
// detected. The student must remove the extension, then re-scan. If the
// re-scan passes AND the tier allows auto-resume, the exam continues;
// otherwise it waits for an invigilator to clear it.
// ══════════════════════════════════════════════════════════════════

function ExtensionFreezeOverlay({
  detail,
  autoResume,
  onResume,
  resuming,
  resumeError,
}: {
  detail?: string;
  autoResume: boolean;
  onResume: () => void;
  resuming: boolean;
  resumeError?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center px-6"
      style={{ background: 'rgba(12,12,11,0.92)' }}
    >
      <motion.div
        initial={{ scale: 0.95, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 12 }}
        className="flex flex-col items-center gap-5"
        style={{ maxWidth: 440, textAlign: 'center' }}
      >
        <div className="flex items-center justify-center"
          style={{
            width: 56, height: 56, borderRadius: '50%',
            background: 'rgba(212,160,23,0.15)', border: '1px solid rgba(212,160,23,0.35)',
          }}>
          <Flag size={22} strokeWidth={1.5} style={{ color: '#F5DFA0' }} />
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs" style={{ color: '#F5DFA0', letterSpacing: '0.12em' }}>
            EXAM PAUSED — EXTENSION DETECTED
          </p>
          <p className="text-sm" style={{ color: '#FFFFFF', lineHeight: 1.6 }}>
            A browser extension was detected and your exam has been paused.
          </p>
          <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.5)', lineHeight: 1.6 }}>
            {autoResume
              ? 'Please disable or remove the extension, then click Re-scan & resume. Your timer is unaffected while paused.'
              : 'Please disable or remove the extension. An invigilator must clear this pause before you can continue.'}
          </p>
          {detail && (
            <p className="text-xs mt-2" style={{ color: 'rgba(255,255,255,0.4)', lineHeight: 1.6 }}>
              Detected: {detail}
            </p>
          )}
        </div>
        {autoResume && (
          <button
            type="button"
            onClick={onResume}
            disabled={resuming}
            className="text-xs px-4 py-2 transition-colors"
            style={{
              background: resuming ? 'rgba(255,255,255,0.15)' : '#F5DFA0',
              color: resuming ? 'rgba(255,255,255,0.6)' : '#0C0C0B',
              borderRadius: 2, cursor: resuming ? 'default' : 'pointer',
            }}
          >
            {resuming ? 'Re-scanning…' : 'Re-scan & resume'}
          </button>
        )}
        {resumeError && (
          <p className="text-xs" style={{ color: '#E5A5A5', lineHeight: 1.6 }}>
            {resumeError}
          </p>
        )}
      </motion.div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// FACE GATE OVERLAY (Phase 2 — load-then-render)
// Brief warm-up shown on camera-required tiers until face detection is ready,
// so the questions never render during an unmonitored window at the start.
// ══════════════════════════════════════════════════════════════════

function FaceGateOverlay() {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-40 flex flex-col items-center justify-center px-6"
      style={{ background: 'rgba(247,246,243,0.97)' }}
    >
      <motion.div
        initial={{ scale: 0.96, y: 10 }} animate={{ scale: 1, y: 0 }}
        className="flex flex-col items-center gap-4"
        style={{ maxWidth: 380, textAlign: 'center' }}
      >
        <div className="flex items-center justify-center"
          style={{ width: 52, height: 52, borderRadius: '50%', background: '#EFEEE9', border: '1px solid #E3E1DB' }}>
          <Loader2 size={20} strokeWidth={1.5} className="animate-spin" style={{ color: '#6B6B66' }} />
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.12em' }}>
            PREPARING MONITORING
          </p>
          <p className="text-sm" style={{ color: '#4A4A45', lineHeight: 1.6 }}>
            Setting up webcam monitoring before your exam begins…
          </p>
          <p className="text-xs mt-1" style={{ color: '#B0AEA8', lineHeight: 1.6 }}>
            This takes just a moment. Your questions will appear once monitoring is active.
          </p>
        </div>
      </motion.div>
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
}: {
  sectionName: string;
  unanswered: number;
  isFinal: boolean;
  onConfirm: () => void;
  onCancel: () => void;
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
            className="flex items-center gap-1.5 text-xs px-4 py-2.5"
            style={{
              background: '#0C0C0B',
              color: '#FFFFFF', borderRadius: 2,
              cursor: 'pointer',
            }}
          >
            {isFinal ? 'Submit exam' : `Submit ${sectionName}`}
          </button>
          <button
            onClick={onCancel}
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
// BREAK SCREEN
// ══════════════════════════════════════════════════════════════════

function BreakScreen({
  state,
  onContinue,
}: {
  state: BreakState;
  onContinue: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const remainingMs = Math.max(0, state.endsAt - now);
  const remainingSec = Math.ceil(remainingMs / 1000);
  const mm = Math.floor(remainingSec / 60);
  const ss = remainingSec % 60;
  const expired = remainingMs <= 0;
  const canContinue = expired || !state.mandatory;

  // Auto-continue once a mandatory break expires
  useEffect(() => {
    if (expired && state.mandatory) onContinue();
  }, [expired, state.mandatory, onContinue]);

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: '#F7F6F3' }}>
      <div className="flex flex-col items-center gap-4" style={{ maxWidth: 440, textAlign: 'center', padding: '0 24px' }}>
        <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.12em' }}>BREAK</p>
        <p className="text-sm" style={{ color: '#0C0C0B', lineHeight: 1.6 }}>
          {state.justSubmittedSectionName} submitted. Take a moment before {state.nextSectionName} begins.
        </p>
        <div
          className="flex items-center justify-center"
          style={{
            width: 120, height: 120, borderRadius: '50%',
            border: '1px solid #E3E1DB', background: '#FFFFFF',
          }}
        >
          <span style={{ color: '#0C0C0B', fontVariantNumeric: 'tabular-nums', fontSize: 24 }}>
            {mm}:{ss.toString().padStart(2, '0')}
          </span>
        </div>
        <p className="text-xs" style={{ color: '#9A9891' }}>
          {state.mandatory
            ? 'You must wait until the timer ends.'
            : 'You may skip this break and continue immediately.'}
        </p>
        <button
          onClick={onContinue}
          disabled={!canContinue}
          className="text-xs px-5 py-2.5 mt-2"
          style={{
            background: canContinue ? '#0C0C0B' : '#C8C7C2',
            color: '#FFFFFF', borderRadius: 2,
            cursor: canContinue ? 'pointer' : 'not-allowed',
          }}
        >
          {expired ? `Continue to ${state.nextSectionName}` : (state.mandatory ? 'Please wait…' : `Skip break`)}
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SECTION PICKER (student_choice mode)
// ══════════════════════════════════════════════════════════════════

function SectionPicker({
  remaining,
  completedCount,
  totalCount,
  onPick,
  picking,
}: {
  remaining: AssessmentSection[];
  completedCount: number;
  totalCount: number;
  onPick: (sectionId: string) => void;
  picking: boolean;
}) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: '#F7F6F3', padding: 24 }}>
      <div className="flex flex-col items-center gap-4" style={{ maxWidth: 560, width: '100%' }}>
        <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.12em' }}>CHOOSE YOUR NEXT SECTION</p>
        <p className="text-sm" style={{ color: '#0C0C0B', textAlign: 'center', lineHeight: 1.6 }}>
          {completedCount === 0
            ? 'Pick which section you want to start with.'
            : `You've completed ${completedCount} of ${totalCount} sections. Pick what to take next.`}
        </p>
        <div className="w-full grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          {remaining.map((sec) => (
            <button
              key={sec.id}
              type="button"
              disabled={picking}
              onClick={() => onPick(sec.id)}
              className="flex flex-col items-start gap-1.5 px-4 py-3 transition-colors text-left"
              style={{
                background: '#FFFFFF',
                border: '1px solid #E3E1DB',
                borderRadius: 3,
                cursor: picking ? 'not-allowed' : 'pointer',
                opacity: picking ? 0.6 : 1,
              }}
              onMouseEnter={(e) => { if (!picking) e.currentTarget.style.borderColor = '#0C0C0B'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#E3E1DB'; }}
            >
              <span className="text-xs" style={{ color: '#0C0C0B' }}>{sec.name}</span>
              <span className="text-xs" style={{ color: '#9A9891' }}>
                {sec.questions.length} question{sec.questions.length === 1 ? '' : 's'}
                {sec.timeLimit ? ` · ${sec.timeLimit} min` : ''}
              </span>
            </button>
          ))}
        </div>
        {picking && (
          <div className="flex items-center gap-2" style={{ color: '#9A9891' }}>
            <Loader2 size={11} className="animate-spin" />
            <span className="text-xs">Starting section…</span>
          </div>
        )}
      </div>
    </div>
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

  // ── Server clock skew (serverNow - clientNow, ms) ──────────────
  // Captured once on load; SectionTimer uses it so the countdown display
  // resists local-clock tampering. Server owns actual enforcement.
  const serverSkewRef = useRef(0);
  const nowFn = useCallback(() => Date.now() + serverSkewRef.current, []);

  // ── Freeze / session state (synced from Firestore) ─────────────
  const [isFrozen, setIsFrozen]                     = useState(false);
  const [frozenReason, setFrozenReason]             = useState<string | undefined>();
  // ── Extension freeze (Phase 1c) ────────────────────────────────
  const [extFrozen, setExtFrozen]                   = useState(false);
  const [extFreezeDetail, setExtFreezeDetail]       = useState<string | undefined>();
  const [extResuming, setExtResuming]               = useState(false);
  const [extResumeError, setExtResumeError]         = useState<string | undefined>();
  const extReportedRef                              = useRef(false);
  // ── Face detection readiness (Phase 2 — load-then-render) ──────
  const [faceDetectionState, setFaceDetectionState] =
    useState<'loading' | 'ready' | 'unavailable' | 'denied' | 'error'>('loading');
  const [frozenAtISO, setFrozenAtISO]               = useState<string | null>(null);
  const [totalFrozenSeconds, setTotalFrozenSeconds] = useState(0);
  const [hasConflict, setHasConflict]               = useState(false);
  const isFrozenRef = useRef(false);
  useEffect(() => { isFrozenRef.current = isFrozen; }, [isFrozen]);

  // Synchronous submit lock. shellStatus updates asynchronously, so two triggers
  // firing in the same tick (e.g. timer expiry + click, or window_closed + manual
  // submit on the last section) can both pass the status check. This ref latches
  // true on first entry and is never reset — once we're submitting we're going
  // to the results page.
  const submittingRef = useRef(false);
  // Remembers the trigger of the last final-submit so the retry button on the
  // submit_failed screen re-runs grading with the same reason.
  const lastFinalReasonRef = useRef<'manual' | 'time_expired' | 'violation_limit' | 'window_closed'>('manual');
  // Running count of ALL logged violation events this attempt (init from the
  // stored integrityLog on load) — drives the detail-logging cap.
  const totalViolationsRef = useRef(0);

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
  const [breakState, setBreakState] = useState<BreakState | null>(null);
  const [pickingSection, setPickingSection] = useState(false);

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

  // ── Enforce fullscreen on mount (covers refresh / direct URL) ──
  useEffect(() => {
    const inFs = !!document.fullscreenElement;
    setIsFullscreen(inFs);
    if (!inFs) setOverlay({ kind: 'fullscreen_required' });
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

        // Schedule gate (defense-in-depth) — the briefing already refuses to
        // let a student enter before startDate, but a student who navigates
        // directly to /student/exam/<id>/shell would otherwise bypass that.
        // Only enforced if there is no existing attempt already in progress —
        // once started, letting a running attempt continue is the right thing.
        if (a.startDate && new Date() < new Date(a.startDate)) {
          const existing = await getAttemptByStudentAndAssessment(session.studentId, assessmentId);
          if (!existing || (existing.status !== 'in_progress' && existing.status !== 'frozen')) {
            setErrorMsg('This exam is not yet open. Please return once it starts.');
            setShellStatus('error');
            return;
          }
        }

        // 2. Normalise sections — guarantees questions are populated
        let effSections = buildEffectiveSections(a);

        // 3. Get or create attempt (idempotent)
        let att = await getAttemptByStudentAndAssessment(session.studentId, assessmentId);

        // Resume guard — if the previous session breached the integrity
        // threshold but never finalized (e.g. tab killed mid-countdown),
        // finalize it as terminated via the gradeAttempt Cloud Function, then
        // block this session with an error. The student does NOT auto-continue
        // to a fresh attempt: a terminated student can only get another attempt
        // when the invigilator raises their attemptOverride.
        if (att && await enforceIntegrityThreshold(att)) {
          setErrorMsg('Your previous attempt was terminated due to repeated integrity violations. Contact your invigilator if you believe you should be granted another attempt.');
          setShellStatus('error');
          return;
        }

        if (!att || (att.status !== 'in_progress' && att.status !== 'frozen')) {
          // Compute the effective max for this student (override → global → default 1)
          const effectiveMaxAttempts =
            a.attemptOverrides?.[session.studentId] ??
            a.maxAttempts ??
            1;

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
            sectionStartOrder: a.sectionStartOrder,
            cameraDeclined,
            effectiveMaxAttempts,
          });
        }

        // Reorder effSections to match the attempt's frozen section order.
        // The attempt may have been created with a shuffled order
        // (sectionStartOrder = 'random' / 'student_choice') so the shell
        // navigation must walk the attempt's order, not the builder's.
        if (att.sectionIds && att.sectionIds.length === effSections.length) {
          const byId = new Map(effSections.map((s) => [s.id, s]));
          const reordered = att.sectionIds.map((id) => byId.get(id)).filter(Boolean) as typeof effSections;
          if (reordered.length === effSections.length) effSections = reordered;
        }

        // 4. Load all question documents — single server call. Students can
        // no longer read the questions collection directly (rules deny it);
        // getExamQuestions returns whitelisted, key-less content for exactly
        // this assessment's paper.
        const allQIds = [...new Set(
          effSections.flatMap((s) => s.questions.map((q) => q.questionId))
        )];
        const paper = await getExamQuestionsForStudent(a.id, 'exam');
        const qMap = new Map<string, Question>();
        const wanted = new Set(allQIds);
        paper.forEach((q) => { if (wanted.has(q.id)) qMap.set(q.id, q); });

        // 5. Build marks map
        const mMap = new Map<string, number>();
        effSections.forEach((s) => {
          s.questions.forEach((aq) => mMap.set(aq.questionId, aq.marks));
        });

        // Register this browser session. We always claim ownership here —
        // if a prior session existed it's now displaced, and the snapshot
        // listener on the older device will detect the mismatch and lock.
        // Doing it this way means the takeover device proceeds normally.
        await registerSession(att.id, localSessionId.current);

        // Sync initial freeze state (including accumulated paused time so the
        // timer resumes fairly, and the current freeze instant so it stays paused)
        setTotalFrozenSeconds(att.totalFrozenSeconds ?? 0);
        if (att.frozenAt) {
          setIsFrozen(true);
          setFrozenReason(att.frozenReason);
          setFrozenAtISO(att.frozenAt);
        }

        // Capture server-clock skew once so the section countdown display is
        // anchored to server time (spoof-resistant). Non-blocking: on failure
        // skew stays 0 and enforcement remains server-side anyway.
        getServerSkew().then((skew) => { serverSkewRef.current = skew; }).catch(() => {});

        setAssessment(a);
        setEffectiveSections(effSections);
        setAttempt(att);
        setQuestionMap(qMap);
        setMarksMap(mMap);
        setLocalAnswers({ ...att.answers });
        setCurrentSectionIdx(att.currentSectionIdx);

        // Detect resume-mid-pick (student_choice): if the active section
        // has no startedAt yet, the student needs to choose before we
        // can render the question shell.
        if (a.sectionStartOrder === 'student_choice') {
          const cur = effSections[att.currentSectionIdx];
          if (cur && !att.sectionTimings[cur.id]?.startedAt) {
            setShellStatus('choosing_section');
            return;
          }
        }

        // Detect resume-mid-break: a section is submitted, the next one
        // hasn't started, and the configured break window hasn't elapsed.
        const curSec = effSections[att.currentSectionIdx];
        const nextSec = effSections[att.currentSectionIdx + 1];
        if (curSec && nextSec && curSec.breakAfter && curSec.breakAfter.durationMinutes > 0) {
          const timing = att.sectionTimings[curSec.id];
          const nextTiming = att.sectionTimings[nextSec.id];
          if (timing?.submittedAt && !nextTiming?.startedAt) {
            const endsAt = new Date(timing.submittedAt).getTime() + curSec.breakAfter.durationMinutes * 60 * 1000;
            if (endsAt > Date.now()) {
              setBreakState({
                justSubmittedSectionId: curSec.id,
                justSubmittedSectionName: curSec.name,
                nextSectionId: nextSec.id,
                nextSectionIdx: att.currentSectionIdx + 1,
                nextSectionName: nextSec.name,
                endsAt,
                mandatory: curSec.breakAfter.mandatory,
              });
              setShellStatus('on_break');
              return;
            }
          }
        }

        // Init violation warning count from existing integrity log
        const log = att.integrityLog;
        const existingWarnings = log.tabSwitches + log.focusLosses + log.fullscreenExits;
        setWarningCount(existingWarnings);
        totalViolationsRef.current = log.totalViolations ?? 0;

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
      // Freeze — invigilator pause: the exam halts and the clock stops.
      // totalFrozenSeconds (credited paused time) always tracks the live doc so
      // the timer resumes fairly the moment the invigilator unfreezes.
      setTotalFrozenSeconds(live.totalFrozenSeconds ?? 0);
      if (live.frozenAt) {
        setIsFrozen(true);
        setFrozenReason(live.frozenReason);
        setFrozenAtISO(live.frozenAt);
        // Drop focus so nothing can be typed into a field behind the overlay.
        (document.activeElement as HTMLElement | null)?.blur?.();
      } else {
        setIsFrozen(false);
        setFrozenReason(undefined);
        setFrozenAtISO(null);
      }
      // Session conflict: another device took over
      if (live.activeSessionId && live.activeSessionId !== localSessionId.current) {
        setHasConflict(true);
        setOverlay({ kind: 'session_conflict' });
      }

      // ── Extension freeze (Phase 1c) ──────────────────────────────
      // The server sets status='frozen' with freezeState.reason when an
      // extension is detected on a tier that requires the check. Surface
      // the extension-specific overlay (distinct from invigilator pause).
      const extFreeze =
        live.status === 'frozen' && live.freezeState?.reason === 'extension_detected';
      if (extFreeze) {
        setExtFrozen(true);
        setExtFreezeDetail(live.lastExtensionCheck?.found?.[0]);
        (document.activeElement as HTMLElement | null)?.blur?.();
      } else {
        setExtFrozen(false);
      }
    });
    return () => unsub();
  }, [attempt?.id]); // eslint-disable-line

  // ── Global window expiry check ─────────────────────────────────

  useEffect(() => {
    if (shellStatus !== 'ready' || !assessment?.endDate) return;
    const checkExpiry = () => {
      // Anchor to server time via the captured skew — the local clock is
      // student-controlled. (Enforcement is server-side regardless; this only
      // decides when the client auto-submits.)
      const serverNow = Date.now() + (serverSkewRef.current ?? 0);
      if (serverNow > new Date(assessment.endDate!).getTime()) {
        handleFinalSubmit('window_closed');
      }
    };
    checkExpiry();
    const interval = setInterval(checkExpiry, 30_000);
    return () => clearInterval(interval);
  }, [shellStatus, assessment?.endDate]); // eslint-disable-line

  // ── Heartbeat (Phase 1a) ───────────────────────────────────────
  // For proctored tiers (normal / high_stake), ping the server every ~15s
  // while the attempt is active. A gap the server sees at grade time is a
  // tamper/connectivity signal (a student who blocks Firestore to hide
  // violations also stops heartbeating). Mock tier does not heartbeat.
  useEffect(() => {
    if (shellStatus !== 'ready' || !attempt?.id) return;
    const tier = attempt.securityConfig?.tier;
    if (tier !== 'normal' && tier !== 'high_stake') return;
    const beat = () => {
      const att = attemptRef.current;
      if (att?.id) void sendHeartbeat(att.id);
    };
    beat();
    const interval = setInterval(beat, 15_000);
    return () => clearInterval(interval);
  }, [shellStatus, attempt?.id, attempt?.securityConfig?.tier]); // eslint-disable-line

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
    return currentSectionQIds.filter((qId) => isAnswerEmpty(localAnswers[qId])).length;
  }, [currentSectionQIds, localAnswers]);

  // ══════════════════════════════════════════════════════════════════
  // ANSWER HANDLING
  // ══════════════════════════════════════════════════════════════════

  const handleAnswer = useCallback((questionId: string, value: AnswerValue) => {
    if (!attemptRef.current || !assessmentRef.current) return;
    // Exam is halted by an invigilator — reject any answer input.
    if (isFrozenRef.current) return;

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

  // Flush all pending answer saves immediately — as ONE write. The previous
  // version fired one updateDoc per answered question in parallel against the
  // same attempt doc, which caused heavy write contention (aborted/retried
  // commits) exactly at submit time on long papers.
  const flushAnswers = useCallback(async () => {
    for (const [, timer] of answerTimersRef.current) clearTimeout(timer);
    answerTimersRef.current.clear();

    const att = attemptRef.current;
    if (!att) return;
    await saveAnswers(att.id, localAnswersRef.current);
  }, []);

  // Flush pending answers the instant a freeze lands, so nothing sitting in the
  // 1.5 s debounce window is lost if the paused tab is later closed.
  const prevFrozenRef = useRef(false);
  useEffect(() => {
    if (isFrozen && !prevFrozenRef.current) {
      flushAnswers().catch((e) => console.error('[ExamShell] flush on freeze failed', e));
    }
    prevFrozenRef.current = isFrozen;
  }, [isFrozen, flushAnswers]);

  // ══════════════════════════════════════════════════════════════════
  // SECTION SUBMIT
  // ══════════════════════════════════════════════════════════════════

  const doSectionSubmit = useCallback(async (reason: 'manual' | 'time_expired') => {
    const att = attemptRef.current;
    const a   = assessmentRef.current;
    if (!att || !a || !currentSection) return;
    if (submittingRef.current) return; // another submit path is already running
    submittingRef.current = true;

    setShellStatus('submitting_section');
    await flushAnswers();

    const sectionId = currentSection.id;
    const startedAt = att.sectionTimings[sectionId]?.startedAt ?? new Date().toISOString();
    const timeUsedSeconds = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);

    const nextIdx = currentSectionIdx + 1;
    const nextSection = effectiveSections[nextIdx] ?? null;
    const breakCfg = currentSection.breakAfter;
    const isStudentChoice = a.sectionStartOrder === 'student_choice';
    // Pause if a break is configured OR we're in student_choice and there's
    // a next slot — in both cases the next section's timer must not start
    // automatically.
    // student_choice takes precedence over breakAfter (the picker
    // already pauses between sections, so a break is redundant).
    const useBreak = !isStudentChoice && !!(breakCfg && breakCfg.durationMinutes > 0);
    const pauseBeforeNext = !!nextSection && (useBreak || isStudentChoice);

    try {
      await submitSection({
        attemptId: att.id,
        sectionId,
        nextSectionId: nextSection?.id ?? null,
        nextSectionIdx: nextIdx,
        timeUsedSeconds,
        pauseBeforeNext,
      });
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? '';
      // A late submit is finalised server-side (section closed at its true
      // deadline, and advanced identically to the normal path). Fall through
      // to the local-state advance below. Any OTHER error is a real failure.
      if (!msg.includes('SECTION_DEADLINE_EXCEEDED') && !msg.includes('deadline-exceeded')) {
        submittingRef.current = false;
        setErrorMsg('Could not submit this section. Check your connection and try again.');
        setShellStatus('error');
        return;
      }
    }

    if (nextSection && useBreak && breakCfg) {
      // Enter break — next section's timer will start when student continues.
      // RELEASE THE SUBMIT LOCK: control returns to the student, and the next
      // section's submit must be able to run. (This lock being left engaged
      // was the bug that made every multi-section exam unsubmittable past its
      // first section — doSectionSubmit and handleFinalSubmit both early-
      // returned forever.)
      submittingRef.current = false;
      const submittedAtMs = Date.now();
      setBreakState({
        justSubmittedSectionId: sectionId,
        justSubmittedSectionName: currentSection.name,
        nextSectionId: nextSection.id,
        nextSectionIdx: nextIdx,
        nextSectionName: nextSection.name,
        endsAt: submittedAtMs + breakCfg.durationMinutes * 60 * 1000,
        mandatory: breakCfg.mandatory,
      });
      setAttempt((prev) =>
        prev
          ? {
              ...prev,
              sectionTimings: {
                ...prev.sectionTimings,
                [sectionId]: { ...prev.sectionTimings[sectionId], submittedAt: new Date(submittedAtMs).toISOString(), timeUsedSeconds },
              },
            }
          : prev
      );
      setShellStatus('on_break');
    } else if (nextSection && isStudentChoice) {
      // No break, but student picks the next section themselves.
      submittingRef.current = false; // release — see note above
      setAttempt((prev) =>
        prev
          ? {
              ...prev,
              sectionTimings: {
                ...prev.sectionTimings,
                [sectionId]: { ...prev.sectionTimings[sectionId], submittedAt: new Date().toISOString(), timeUsedSeconds },
              },
            }
          : prev
      );
      setShellStatus('choosing_section');
    } else if (nextSection) {
      // Advance to next section
      submittingRef.current = false; // release — see note above
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
      // Last section — go to final submit. Preserve the trigger reason so a
      // timer-driven finish is recorded as auto_submitted, not manual.
      await doFinalSubmit(reason);
    }
  }, [currentSection, currentSectionIdx, flushAnswers, effectiveSections]);

  // ══════════════════════════════════════════════════════════════════
  // END BREAK
  // ══════════════════════════════════════════════════════════════════

  // Re-enter fullscreen before unlocking the next section. If the browser
  // rejects (e.g. mandatory-break auto-advance has no user gesture), show
  // the existing FullscreenRequiredOverlay so the student is forced to click
  // back into fullscreen before they can interact with the next section.
  const enforceFullscreenOrPrompt = useCallback(async () => {
    if (document.fullscreenElement) return;
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      setOverlay({ kind: 'fullscreen_required' });
    }
  }, []);

  const handleEndBreak = useCallback(async () => {
    const att = attemptRef.current;
    const bs = breakState;
    if (!att || !bs) return;
    // Request fullscreen FIRST so the click gesture is still live; if rejected,
    // the overlay will gate interaction until the student returns to fullscreen.
    await enforceFullscreenOrPrompt();
    try {
      await endBreak({
        attemptId: att.id,
        nextSectionId: bs.nextSectionId,
        nextSectionIdx: bs.nextSectionIdx,
      });
    } catch (e) {
      // If the server refused (mandatory break not elapsed on the SERVER
      // clock, or a transient failure), do NOT advance locally — the next
      // section has no server-side startedAt, and submitSection would later
      // reject it with 'Section was never started', wedging the exam.
      console.error('[ExamShell] endBreak failed', e);
      const msg = (e as { message?: string })?.message ?? '';
      if (msg.includes('Mandatory break') || msg.includes('failed-precondition')) {
        return; // stay on the break screen; the countdown will retry
      }
      setErrorMsg('Could not start the next section. Check your connection and try again.');
      setShellStatus('error');
      return;
    }
    const startISO = new Date().toISOString();
    setAttempt((prev) =>
      prev
        ? {
            ...prev,
            currentSectionIdx: bs.nextSectionIdx,
            sectionTimings: {
              ...prev.sectionTimings,
              [bs.nextSectionId]: {
                ...prev.sectionTimings[bs.nextSectionId],
                startedAt: startISO,
                timeUsedSeconds: 0,
              },
            },
          }
        : prev
    );
    setCurrentSectionIdx(bs.nextSectionIdx);
    setCurrentQIdx(0);
    setBreakState(null);
    setShellStatus('ready');
  }, [breakState]);

  // ══════════════════════════════════════════════════════════════════
  // PICK SECTION (student_choice)
  // ══════════════════════════════════════════════════════════════════

  const handlePickSection = useCallback(async (pickedSectionId: string) => {
    const att = attemptRef.current;
    if (!att || pickingSection) return;
    setPickingSection(true);
    // Same fullscreen gate as handleEndBreak — re-enter or prompt before
    // starting the picked section.
    await enforceFullscreenOrPrompt();
    try {
      // newIdx = number of sections already started (have a startedAt)
      const startedCount = att.sectionIds.filter(
        (id) => !!att.sectionTimings[id]?.startedAt
      ).length;
      const newIdx = startedCount;

      const reorderedIds = await pickSection({
        attemptId: att.id,
        pickedSectionId,
        currentSectionIds: att.sectionIds,
        newIdx,
      });

      const startISO = new Date().toISOString();

      // Reorder effectiveSections to match new sectionIds
      const byId = new Map(effectiveSections.map((s) => [s.id, s]));
      const reorderedSections = reorderedIds
        .map((id) => byId.get(id))
        .filter(Boolean) as AssessmentSection[];
      if (reorderedSections.length === effectiveSections.length) {
        setEffectiveSections(reorderedSections);
      }

      setAttempt((prev) =>
        prev
          ? {
              ...prev,
              sectionIds: reorderedIds,
              currentSectionIdx: newIdx,
              sectionTimings: {
                ...prev.sectionTimings,
                [pickedSectionId]: {
                  ...prev.sectionTimings[pickedSectionId],
                  startedAt: startISO,
                  timeUsedSeconds: 0,
                },
              },
            }
          : prev
      );
      setCurrentSectionIdx(newIdx);
      setCurrentQIdx(0);
      setShellStatus('ready');
    } catch (e) {
      console.error('[ExamShell] pickSection failed', e);
    } finally {
      setPickingSection(false);
    }
  }, [pickingSection, effectiveSections]);

  // ══════════════════════════════════════════════════════════════════
  // FINAL SUBMIT
  // ══════════════════════════════════════════════════════════════════

  const handleFinalSubmit = useCallback(async (
    reason: 'manual' | 'time_expired' | 'violation_limit' | 'window_closed'
  ) => {
    if (submittingRef.current) return; // another submit path is already running
    submittingRef.current = true;
    await doFinalSubmit(reason);
  }, []); // eslint-disable-line

  const doFinalSubmit = useCallback(async (
    reason: 'manual' | 'time_expired' | 'violation_limit' | 'window_closed'
  ) => {
    const att = attemptRef.current;
    const a   = assessmentRef.current;
    if (!att || !a) return;

    lastFinalReasonRef.current = reason;
    setShellStatus('submitting_exam');
    await flushAnswers();

    try {
      await gradeAttempt({ attemptId: att.id, reason });
    } catch (e) {
      // DO NOT navigate to results on failure — the attempt is still
      // in_progress server-side; showing "submitted" would be a lie and the
      // student would lose their only chance to retry. Surface a retry
      // screen instead (answers are already flushed, nothing is lost).
      console.error('[ExamShell] gradeAttempt failed', e);
      submittingRef.current = false;
      setErrorMsg('Your exam could not be submitted. Your answers are saved — check your connection and try again.');
      setShellStatus('submit_failed');
      return;
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

    // Detail cap — past MAX_LOGGED_VIOLATION_EVENTS, log counters only so a
    // violation storm can't balloon the attempt doc toward the 1 MiB limit.
    totalViolationsRef.current += 1;
    const skipEventDetail = totalViolationsRef.current > MAX_LOGGED_VIOLATION_EVENTS;

    // Log to Firestore
    await logViolation(att.id, type, detail, isWarningType ? newWarningCount : undefined, { skipEventDetail })
      .catch((e) => console.error('[ExamShell] logViolation failed', e));

    // ── Extension detected (Phase 1c) ──────────────────────────────
    // Report to the server, which decides whether to freeze the attempt
    // (only on tiers where requireExtensionCheck is true). Guarded so a
    // repeated detection doesn't spam the callable while already frozen.
    if (type === 'extension_detected' && !extReportedRef.current) {
      extReportedRef.current = true;
      reportExtensionCheck({ attemptId: att.id, passed: false, found: detail ? [detail] : [] })
        .catch((e) => {
          console.error('[ExamShell] reportExtensionCheck failed', e);
          extReportedRef.current = false; // allow retry on next detection
        });
    }

    // Show overlay based on violation type and warning count
    if (type === 'fullscreen_exit') {
      // Fullscreen exit handled by onFullscreenChange — don't double-show warning overlay
      return;
    }

    if (!isWarningType) return; // Non-warning types are logged but don't show overlay

    if (newWarningCount >= MAX_WARNINGS) {
      // Server-authoritative: finalize the attempt BEFORE the 30-second overlay
      // countdown so killing the tab can't dodge termination. This goes through
      // gradeAttempt (Cloud Function, admin SDK) because student-side writes to
      // `status` are — correctly — denied by the tightened Firestore rules.
      gradeAttempt({
        attemptId: att.id,
        reason: 'terminated',
        terminateReason: 'Exam terminated due to repeated integrity violations.',
      }).catch((e) => console.error('[ExamShell] pre-countdown terminate failed', e));
      setOverlay({ kind: 'final_warning', violationType: type });
    } else {
      setOverlay({
        kind: 'warning',
        violationType: type,
        warningNumber: newWarningCount as 1 | 2,
      });
    }
  }, []);

  // ── Extension-freeze resume (Phase 1c) ─────────────────────────
  // Re-scan for the extension; if it's gone, report a passing check and
  // ask the server to resume. Auto-resume succeeds only on eligible tiers
  // with a passing latest check; otherwise the server tells the student an
  // invigilator must clear it. The live subscription clears extFrozen when
  // status returns to in_progress.
  const handleExtensionResume = useCallback(async () => {
    const att = attemptRef.current;
    if (!att) return;
    setExtResuming(true);
    setExtResumeError(undefined);
    try {
      // Re-scan happens live in ExtensionWatchdog; here we optimistically
      // report a passing check, then ask to resume. If the extension is still
      // present, the watchdog will re-fire and re-freeze immediately.
      await reportExtensionCheck({ attemptId: att.id, passed: true });
      extReportedRef.current = false; // allow a future re-detection to re-freeze
      const res = await verifyAndResume(att.id);
      if (!res.resumed) {
        setExtResumeError('Waiting for an invigilator to clear this pause.');
      }
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? '';
      setExtResumeError(
        msg.includes('RESUME_BLOCKED')
          ? 'An invigilator must clear this pause before you can continue.'
          : 'Could not resume. Please ensure the extension is removed and try again.',
      );
    } finally {
      setExtResuming(false);
    }
  }, []);

  const handleFullscreenChange = useCallback((isNow: boolean) => {
    setIsFullscreen(isNow);
    // Counting + termination are owned by handleViolation. This handler only
    // surfaces the appropriate overlay so we don't double-count the strike.
    if (!isNow && overlayRef.current?.kind !== 'terminated') {
      if (warningCountRef.current < MAX_WARNINGS) {
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
    const a   = assessmentRef.current;
    if (!att) return;
    setShellStatus('terminated');
    const reason = 'Exam terminated due to repeated integrity violations.';

    // Flush pending answers and ask the server to grade + terminate.
    await flushAnswers().catch(() => {});
    if (a) {
      await gradeAttempt({
        attemptId: att.id,
        reason: 'terminated',
        terminateReason: reason,
      }).catch((e) => console.error('[ExamShell] gradeAttempt(terminate) failed', e));
    }
    setOverlay({ kind: 'terminated', reason });
  }, [flushAnswers]);

  const handleExitTerminatedView = useCallback(() => {
    navigate(`/student/exam/${assessmentId}/results`, { replace: true });
  }, [assessmentId, navigate]);

  // ══════════════════════════════════════════════════════════════════
  // SECTION TIMER EXPIRY
  // ══════════════════════════════════════════════════════════════════

  const handleSectionTimerExpire = useCallback(() => {
    if (shellStatus !== 'ready') return;
    if (isFrozenRef.current) return; // paused by invigilator — don't auto-submit
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

  if (shellStatus === 'submit_failed') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: '#F7F6F3' }}>
        <AlertTriangle size={20} strokeWidth={1} style={{ color: '#9B2828' }} />
        <p className="text-xs mt-4 px-8 text-center" style={{ color: '#9B2828' }}>{errorMsg}</p>
        <button
          onClick={() => {
            if (submittingRef.current) return;
            submittingRef.current = true;
            doFinalSubmit(lastFinalReasonRef.current);
          }}
          className="text-xs mt-6 px-4 py-2"
          style={{ background: '#2F2F2B', color: '#FFFFFF', borderRadius: 2 }}
        >
          Retry submission
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

  if (shellStatus === 'on_break' && breakState) {
    return <BreakScreen state={breakState} onContinue={handleEndBreak} />;
  }

  if (shellStatus === 'choosing_section') {
    const remaining = effectiveSections.filter(
      (s) => !attempt?.sectionTimings[s.id]?.startedAt
    );
    const completedCount = effectiveSections.length - remaining.length;
    return (
      <SectionPicker
        remaining={remaining}
        completedCount={completedCount}
        totalCount={effectiveSections.length}
        onPick={handlePickSection}
        picking={pickingSection}
      />
    );
  }

  if (!assessment || !attempt || !currentSection) return null;

  // Read startedAt WITHOUT a wall-clock fallback: SectionTimer re-syncs on
  // startedAtISO change, and re-renders happen on every keystroke, so any
  // fallback like `?? new Date().toISOString()` would restart the countdown
  // forever. If startedAt is genuinely missing, the timer simply doesn't render
  // — the shell should have routed to `choosing_section` before reaching here.
  const sectionStartedAt = attempt.sectionTimings[currentSection.id]?.startedAt || null;
  if (!sectionStartedAt && currentSection.timeLimit) {
    console.warn('[ExamShell] section missing startedAt — timer suppressed', currentSection.id);
  }
  const isIntegrityActive = overlay === null && shellStatus === 'ready' && !hasConflict && !isFrozen;

  // ── Load-then-render gate (Phase 2) ────────────────────────────
  // For camera-required tiers, hold the question area behind a brief
  // "initializing monitoring" overlay until face detection reaches a settled
  // state. We only block while state is 'loading' — a terminal failure
  // ('unavailable'/'denied'/'error'/'ready') releases the gate so a model-load
  // problem can never trap the student. Only applies when the camera was
  // actually granted and the tier requires it.
  const faceGateActive =
    shellStatus === 'ready'
    && attempt?.securityConfig?.requireCamera === true
    && cameraGranted
    && faceDetectionState === 'loading';

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
      <ExtensionWatchdog
        active={isIntegrityActive}
        onViolation={(type, detail) => handleViolation(type, detail)}
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
            frozenOffsetSeconds={totalFrozenSeconds}
            frozenAtISO={isFrozen ? frozenAtISO : null}
            nowFn={nowFn}
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
              onStateChange={setFaceDetectionState}
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
                    {currentSectionQIds.length - unansweredInSection}
                    /{currentSectionQIds.length} answered in this section
                  </span>
                  {!isAnswerEmpty(localAnswers[currentQId!]) && (
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
        {/* Freeze halts the exam; a session conflict is terminal and outranks it. */}
        {isFrozen && !hasConflict && (
          <FreezePausedOverlay key="freeze-paused" reason={frozenReason} />
        )}
        {/* Extension freeze (Phase 1c) — server paused for a detected extension. */}
        {extFrozen && !hasConflict && !isFrozen && (
          <ExtensionFreezeOverlay
            key="ext-freeze"
            detail={extFreezeDetail}
            autoResume={attempt?.securityConfig?.autoResume === true}
            onResume={handleExtensionResume}
            resuming={extResuming}
            resumeError={extResumeError}
          />
        )}
        {/* Load-then-render gate (Phase 2) — brief monitoring warm-up. Lowest
            priority: never shown over a conflict / freeze. */}
        {faceGateActive && !hasConflict && !isFrozen && !extFrozen && (
          <FaceGateOverlay key="face-gate" />
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