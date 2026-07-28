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

import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import {
  Loader2, ChevronLeft, ChevronRight, AlertTriangle,
  CheckCircle2, Shield, Send, Layers, Flag, MonitorSmartphone, Clock,
} from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { getAssessment, getSEBPublicInfo, type Assessment, type AssessmentSection, type SectionBreak, getSebToken, setSebRequired } from '../../../lib/assessmentService';
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
  submitAnswerAndAdvance,
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
  endsAt: number;        // ms timestamp
  mandatory: boolean;
  // How the break resolves when the student continues:
  //   'start_next' — sequential/random: endBreak → startSection on the known
  //                  next section in play order.
  //   'choose'     — student_choice: hand off to the section picker locally;
  //                  the mandatory wait is re-checked server-side when the
  //                  pick reaches startSection.
  then: 'start_next' | 'choose';
  // Present only when then === 'start_next'.
  nextSectionId?: string;
  nextSectionIdx?: number;
  nextSectionName?: string;
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

// ── SEB error translation (Phase 3, Stage 3) ──────────────────────
// The server and the token manager both fail-closed with machine-readable
// messages ('SEB_REQUIRED: …', 'SEB_EXPIRED: …', 'SEB_REQUIRED:SEB_CONFIG_MISMATCH').
// Fail-closed must never mean fail-cryptic: this maps every SEB rejection to
// guidance a student can act on. Returns null for non-SEB errors so callers
// fall through to their existing handling.
function sebFriendlyMessage(raw: string): string | null {
  if (!raw.includes('SEB_')) return null;
  if (raw.includes('SEB_CONFIG_MISMATCH')) {
    return 'Safe Exam Browser was detected, but it is not running the correct exam configuration. Close SEB and reopen the exam from the .seb configuration file provided by your institute.';
  }
  if (raw.includes('SEB_EXPIRED')) {
    return 'Your Safe Exam Browser session could not be re-verified. Please stay in Safe Exam Browser and try again — your answers are saved.';
  }
  if (raw.includes('SEB_VERIFY_UNREACHABLE')) {
    return 'Could not reach the Safe Exam Browser verification service. Check your connection and try again — your answers are saved.';
  }
  if (raw.includes('SEB_REQUIRED')) {
    return 'This exam must be taken in Safe Exam Browser. Open the exam from the .seb configuration file provided by your institute, then resume — your progress is saved.';
  }
  return null;
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

// ── Positional break resolution ───────────────────────────────────
// (Client mirror of breakAfterCompletion in functions/src/index.ts — the
// server enforces, this schedules the UI. Keep the two in sync.)
//
// A break is AUTHORED on a section in builder order, but is APPLIED by
// completion count: the break after the Nth completed section is the one
// authored on the Nth section in builder order, regardless of the per-student
// play order. That makes the break schedule identical for every student under
// 'random' and 'student_choice'; under 'sequential' builder order == play
// order, so this is exactly the legacy behaviour.
//
// builderSections is assessment.sections (builder order), filtered down to
// the ids the attempt actually plays (buildEffectiveSections can drop empty
// sections, and legacy flat-question attempts use a synthetic id that never
// matches — both cases resolve to "no breaks" or the correct reduced list).
function breakAfterCompletion(
  builderSections: AssessmentSection[] | undefined,
  attemptSectionIds: string[] | undefined,
  completedCount: number,
): SectionBreak | null {
  if (!builderSections || builderSections.length === 0 || completedCount < 1) return null;
  const played = new Set(attemptSectionIds ?? []);
  const ordered = played.size > 0
    ? builderSections.filter((s) => played.has(s.id))
    : builderSections;
  if (completedCount >= ordered.length) return null; // no break after the last section
  const brk = ordered[completedCount - 1]?.breakAfter;
  return brk && brk.durationMinutes > 0 ? brk : null;
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
  unseen,
  totalInSection,
  isFinal,
  onConfirm,
  onCancel,
}: {
  sectionName: string;
  /** Served questions left blank. In linear delivery this EXCLUDES anything
   *  the server has not handed out yet — see `unseen`. */
  unanswered: number;
  /** Linear/adaptive only: questions in this section not yet shown. Zero in
   *  standard delivery, where the student already has the whole section. */
  unseen: number;
  totalInSection: number;
  isFinal: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Guards the window between the click and the shell switching to a
  // submitting state. Without it the confirm button stayed live and identical,
  // so an impatient second click fired onConfirm twice — harmless today only
  // because submittingRef swallows the duplicate, which is a fragile thing to
  // rely on for correctness.
  const [confirming, setConfirming] = useState(false);
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
          {/* Gated on unseen too, not just unanswered — that omission was the
              sharper half of the bug. In linear delivery a student who had
              ANSWERED both served questions while sitting on Q2 of 5 hit
              unanswered === 0 and got NO warning at all, then submitted and
              silently forfeited three questions they were never shown.

              The copy leads with the unseen count because that is the only
              part the student can still act on. Linear delivery has no back
              navigation, so naming the questions they already passed is
              information they cannot use; the questions still to come are
              recoverable simply by not submitting. The unrecoverable ones are
              still counted honestly in the second clause rather than hidden. */}
          {(unanswered > 0 || unseen > 0) && (
            <div className="flex items-start gap-2.5 px-3 py-3 mb-4"
              style={{ background: '#FEF9EC', border: '1px solid #F5DFA0', borderRadius: 2 }}>
              <AlertTriangle size={12} strokeWidth={1.5} style={{ color: '#92680A', flexShrink: 0, marginTop: 1 }} />
              <p className="text-xs" style={{ color: '#92680A', lineHeight: 1.6 }}>
                {unseen > 0 ? (
                  <>
                    <strong>
                      {unseen} question{unseen !== 1 ? 's' : ''} in this section
                      {unseen !== 1 ? ' have' : ' has'} not been shown yet.
                    </strong>{' '}
                    Submitting now ends the section — {unanswered + unseen} of {totalInSection}{' '}
                    will receive 0 marks.
                  </>
                ) : (
                  <>
                    You have <strong>{unanswered} unanswered question{unanswered !== 1 ? 's' : ''}</strong>{' '}
                    in this section. Unanswered questions receive 0 marks.
                  </>
                )}
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
            onClick={() => { if (confirming) return; setConfirming(true); onConfirm(); }}
            disabled={confirming}
            className="flex items-center gap-1.5 text-xs px-4 py-2.5"
            style={{
              background: confirming ? '#5A5A54' : '#0C0C0B',
              color: '#FFFFFF', borderRadius: 2,
              cursor: confirming ? 'wait' : 'pointer',
            }}
          >
            {confirming
              ? 'Submitting…'
              : isFinal ? 'Submit exam' : `Submit ${sectionName}`}
          </button>
          <button
            onClick={onCancel}
            disabled={confirming}
            className="text-xs px-4 py-2.5"
            style={{
              color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2,
              cursor: confirming ? 'not-allowed' : 'pointer',
              opacity: confirming ? 0.5 : 1,
            }}
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

  // A mandatory break that has run out is ALREADY continuing on its own via
  // the effect above. Previously the button simply flipped to "Continue to X"
  // at that moment, offering an action the student did not need to take and
  // which did nothing when taken — the exam moved on regardless. Say what is
  // actually happening instead of presenting a decision that isn't one.
  const autoContinuing = expired && state.mandatory;

  // Set on click so a manual continue (skippable break) visibly registers
  // rather than looking ignored while handleEndBreak does its work.
  const [continuing, setContinuing] = useState(false);
  const busy = autoContinuing || continuing;

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: '#F7F6F3' }}>
      <div className="flex flex-col items-center gap-4" style={{ maxWidth: 440, textAlign: 'center', padding: '0 24px' }}>
        <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.12em' }}>BREAK</p>
        <p className="text-sm" style={{ color: '#0C0C0B', lineHeight: 1.6 }}>
          {state.then === 'choose'
            ? `${state.justSubmittedSectionName} submitted. Take a moment — you'll choose your next section when you continue.`
            : `${state.justSubmittedSectionName} submitted. Take a moment before ${state.nextSectionName} begins.`}
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
          onClick={() => { if (busy) return; setContinuing(true); onContinue(); }}
          disabled={!canContinue || busy}
          className="text-xs px-5 py-2.5 mt-2"
          style={{
            background: canContinue && !busy ? '#0C0C0B' : '#C8C7C2',
            color: '#FFFFFF', borderRadius: 2,
            cursor: canContinue && !busy ? 'pointer' : 'not-allowed',
          }}
        >
          {busy
            ? 'Continuing…'
            : expired
              ? (state.then === 'choose' ? 'Choose next section' : `Continue to ${state.nextSectionName}`)
              : (state.mandatory ? 'Please wait…' : `Skip break`)}
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// TIMER CHIP — labelled wrapper for the top-bar countdowns
// ══════════════════════════════════════════════════════════════════
// The exam can show up to three clocks at once (per-question in linear/
// adaptive, per-section, and the whole-exam Total). Bare pills side by side
// are indistinguishable — "01:24  04:24" gives the student no way to tell
// which is which. This wraps each SectionTimer with a small uppercase caption
// so they read as a labelled family: PER Q · SECTION · TOTAL. The caption
// sits inline to the left of the pill to keep the 52px bar height.
function TimerChip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      <span
        className="text-[10px] uppercase"
        style={{ color: '#9A9891', letterSpacing: '0.06em', fontWeight: 500 }}
      >
        {label}
      </span>
      {children}
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
  const { session, loading } = useStudentAuth();

  // Navigation state from ExamBriefingPage
  const navState = location.state as { cameraDeclined?: boolean; cameraGranted?: boolean } | null;
  const cameraGranted  = navState?.cameraGranted ?? false;
  const cameraDeclined = navState?.cameraDeclined ?? true;

  // ── Stable per-tab session ID (dual-device detection) ─────────
  const localSessionId = useRef(generateSessionId());

  // ── Core data ──────────────────────────────────────────────────
  const [shellStatus, setShellStatus]       = useState<ShellStatus>('loading');
  // Sub-state of 'loading' explaining WHY we are still waiting, so a
  // staggered student sees purpose rather than a stalled spinner.
  const [startPhase, setStartPhase]         = useState<'queued' | 'retrying' | null>(null);
  const [errorMsg, setErrorMsg]             = useState('');
  // Phase 3 (Stage 3): true when errorMsg is an SEB rejection, so the error
  // screen renders the guided SEB panel instead of the generic message.
  const [errorIsSeb, setErrorIsSeb]         = useState(false);
  // Stage 4b: platform .seb link fallback for the SEB error panel.
  const [platformSebUrl, setPlatformSebUrl] = useState('');
  useEffect(() => {
    if (!errorIsSeb) return;
    getSEBPublicInfo().then((i) => setPlatformSebUrl(i.configFileUrl ?? '')).catch(() => {});
  }, [errorIsSeb]);
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
  // ── Sequential delivery state (Phase 2.5) ──────────────────────
  const [linearSectionComplete, setLinearSectionComplete] = useState(false);
  const [linearAdvancing, setLinearAdvancing]             = useState(false);
  const [linearError, setLinearError]                     = useState<string | undefined>();

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
    // Auth rehydration guard. Firebase restores the session from IndexedDB
    // asynchronously, so on a refresh this effect's FIRST run always sees
    // session === null while loading is still true. Acting on that null threw
    // the student out of a live exam and onto the login page — the worst place
    // this race could land, since re-entry means signing back in and, on a SEB
    // exam, reopening the .seb file.
    //
    // `session` is already in the deps, but that does not save it: by the time
    // the effect re-runs with a real session the navigate has fired and this
    // component is gone. The decision has to be deferred, not corrected after
    // the fact. `loading` is in the deps so a genuinely signed-out student
    // still gets redirected the moment the answer is known.
    if (loading) return;
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

        // Phase 3 (Stage 3): expose the assessment to the error screens
        // immediately — the SEB_REQUIRED panel needs `sebConfigFileUrl` even
        // when the load aborts before the main setup completes. Safe: every
        // render below 'error' is still gated on shellStatus.
        setAssessment(a);

        // ── Phase 3 (Stage 2b): arm the SEB token manager ──────────────
        // Must happen BEFORE any exam callable runs — including on RESUME,
        // where no new attempt is created. Every subsequent call (heartbeat,
        // answers, section submit, question fetch) then carries a fresh proof.
        setSebRequired(a.requireSEB === true, a.id);

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

          // ── Phase 3: obtain the SEB proof before starting ──────────
          // Only when the assessment requires it. The proof is minted by
          // /api/seb-verify on our own origin (the only place SEB injects its
          // header). The server re-derives the requirement, so a forged
          // "not required" from the client changes nothing.
          let sebToken: string | undefined;
          if (a.requireSEB === true) {
            const seb = await getSebToken(a.id);
            if (!seb.ok || !seb.sebToken) {
              setErrorIsSeb(true);
              setErrorMsg(
                seb.error === 'SEB_REQUIRED' || seb.error === 'SEB_CONFIG_MISMATCH'
                  ? 'This exam must be taken in Safe Exam Browser, using the exam configuration provided by your institute.'
                  : 'Could not verify Safe Exam Browser. Please reopen the exam from the provided .seb file and try again.',
              );
              setShellStatus('error');
              return;
            }
            sebToken = seb.sebToken;
          }

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
            sebToken,
            // Stagger the arrival (see staggerDelayMs). allocatedCount is the
            // head-count already denormalized onto the assessment doc, so
            // sizing the window costs no extra read. Small cohorts wait zero.
            cohortSize: a.allocatedCount,
            onStaggerWait: () => setStartPhase('queued'),
            onRetry: () => setStartPhase('retrying'),
          });
          setStartPhase(null);
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

        const isChoice = a.sectionStartOrder === 'student_choice';

        // Detect resume-mid-pick (student_choice): if the active section
        // has no startedAt yet, the student needs to choose before we
        // can render the question shell.
        if (isChoice) {
          const cur = effSections[att.currentSectionIdx];
          if (cur && !att.sectionTimings[cur.id]?.startedAt) {
            setShellStatus('choosing_section');
            return;
          }
        }

        // Detect resume-between-sections: the active section is submitted but
        // a next section exists and hasn't started. The applicable break is
        // POSITIONAL — resolved by how many sections are completed (builder
        // order via breakAfterCompletion), not by which section was played.
        //   • break still running        → break screen (resolves into the
        //     picker in choice mode, or into the next section otherwise)
        //   • break over / none due, choice mode → the picker
        //   • break over / none due, sequential+random → an expired break
        //     screen; its Continue button runs the normal endBreak →
        //     startSection path. (This also un-wedges attempts that
        //     previously resumed here onto an already-submitted section.)
        const curSec = effSections[att.currentSectionIdx];
        const curTiming = curSec ? att.sectionTimings[curSec.id] : undefined;
        const nextSec = effSections[att.currentSectionIdx + 1];
        const nextTiming = nextSec ? att.sectionTimings[nextSec.id] : undefined;
        if (curSec && nextSec && curTiming?.submittedAt && !nextTiming?.startedAt) {
          const completedCount = att.currentSectionIdx + 1;
          const brk = breakAfterCompletion(a.sections, att.sectionIds, completedCount);
          const endsAt = brk
            ? new Date(curTiming.submittedAt).getTime() + brk.durationMinutes * 60 * 1000
            : 0;
          if (brk && endsAt > Date.now()) {
            setBreakState({
              justSubmittedSectionId: curSec.id,
              justSubmittedSectionName: curSec.name,
              endsAt,
              mandatory: brk.mandatory,
              then: isChoice ? 'choose' : 'start_next',
              ...(isChoice
                ? {}
                : { nextSectionId: nextSec.id, nextSectionIdx: att.currentSectionIdx + 1, nextSectionName: nextSec.name }),
            });
            setShellStatus('on_break');
            return;
          }
          if (isChoice) {
            setShellStatus('choosing_section');
            return;
          }
          // Break already elapsed while away (or none configured — possible
          // when the server force-paused a mandatory break an older bundle
          // didn't schedule). Show the break screen in its expired state:
          // mandatory=false so the Continue click (a real gesture, needed for
          // the fullscreen re-entry) drives endBreak → startSection.
          setBreakState({
            justSubmittedSectionId: curSec.id,
            justSubmittedSectionName: curSec.name,
            endsAt: Date.now(),
            mandatory: false,
            then: 'start_next',
            nextSectionId: nextSec.id,
            nextSectionIdx: att.currentSectionIdx + 1,
            nextSectionName: nextSec.name,
          });
          setShellStatus('on_break');
          return;
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
        const seb = sebFriendlyMessage(msg);
        if (seb) {
          // Phase 3 (Stage 3): fail-closed, never cryptic — a raw
          // 'SEB_REQUIRED:SEB_REQUIRED' tells the student nothing.
          setErrorIsSeb(true);
          setErrorMsg(seb);
        } else if (msg.startsWith('ATTEMPT_LIMIT_EXCEEDED')) {
          const [, used, max] = msg.split(':');
          setErrorMsg(`Attempt limit reached — you have used ${used} of ${max} allowed attempts for this assessment.`);
        } else {
          setErrorMsg(msg || 'Failed to start exam.');
        }
        setShellStatus('error');
      }
    };

    load();
  }, [assessmentId, session, loading]); // eslint-disable-line

  // ── onSnapshot: watch attempt for freeze + session conflict ──────

  useEffect(() => {
    if (!attempt?.id) return;
    const unsub = subscribeToAttempt(attempt.id, (live) => {
      if (!live) return;
      // Keep server-owned, append-only fields in sync. servedQuestions is the
      // source of truth for sequential delivery (Phase 2.5) — without this the
      // client never learns that the server served the next question.
      setAttempt((prev) => (prev ? {
        ...prev,
        servedQuestions: live.servedQuestions ?? prev.servedQuestions,
        status: live.status ?? prev.status,
      } : prev));
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

  // ── Sequential delivery (Phase 2.5) ────────────────────────────
  // In linear/adaptive the server serves one question at a time. The client
  // holds ONLY what has been served (getExamQuestions is scoped), so the
  // question list for the section is the servedQuestions slice, not the
  // (server-side) questionOrder.
  const isLinear =
    attempt?.securityConfig?.deliveryMode === 'linear'
    || attempt?.securityConfig?.deliveryMode === 'adaptive';

  const currentSectionQIds = useMemo(() => {
    if (!attempt || !currentSection) return [];
    if (isLinear) {
      return (attempt.servedQuestions ?? [])
        .filter((s) => s.sectionId === currentSection.id)
        .map((s) => s.questionId);
    }
    return attempt.questionOrder[currentSection.id] ?? [];
  }, [attempt, currentSection, isLinear]);

  const currentQId = currentSectionQIds[currentQIdx] ?? null;
  const currentQuestion = currentQId ? questionMap.get(currentQId) ?? null : null;

  // ── Counter denominator ─────────────────────────────────────────
  // In linear/adaptive delivery currentSectionQIds only contains what has
  // been SERVED (it grows 1 → N), so its length made the header count read
  // "Q1 of 1, Q2 of 2, …". The section's true size is already client-visible
  // in every mode via the assessment's resolved sections (questionOrder is a
  // permutation of the same list), so showing N leaks nothing new — linear
  // secrecy gates question CONTENT, not counts. Adaptive currently delivers
  // the same fixed paper as linear; revisit this denominator when the
  // adaptive ladder lands and the served count may diverge from the pool.
  const currentSectionTotal = isLinear
    ? (currentSection?.questions.length || currentSectionQIds.length)
    : currentSectionQIds.length;

  // In linear mode the student is ALWAYS on the newest served question —
  // there is no navigation. When the server appends a question (via the
  // attempt subscription), advance to it.
  useEffect(() => {
    if (!isLinear) return;
    const last = currentSectionQIds.length - 1;
    if (last >= 0 && currentQIdx !== last) setCurrentQIdx(last);
  }, [isLinear, currentSectionQIds.length]); // eslint-disable-line

  const totalSections = effectiveSections.length || 1;
  const isLastSection = currentSectionIdx >= totalSections - 1;
  // Standard: last index of the paper's section. Linear: the SERVER tells us
  // (sectionComplete) — the client never knows how many questions remain.
  const isLastQuestion = isLinear
    ? linearSectionComplete
    : currentQIdx >= currentSectionQIds.length - 1;

  // ── Count unanswered in current section ────────────────────────

  const unansweredInSection = useMemo(() => {
    return currentSectionQIds.filter((qId) => isAnswerEmpty(localAnswers[qId])).length;
  }, [currentSectionQIds, localAnswers]);

  // Questions in this section the server has not handed out yet.
  //
  // currentSectionQIds is the SERVED slice in linear/adaptive (it grows 1 → N),
  // so unansweredInSection above can only ever see what the student has
  // reached. On Q2 of 5 it reports 2 and says nothing about the other 3 — the
  // student is told they are forfeiting two questions when in fact they are
  // forfeiting five. currentSectionTotal already carries the section's true
  // size (added for the "Q1 of 1" counter fix), so the gap is just arithmetic.
  //
  // Always 0 in standard delivery: the whole section is served up front, so
  // served length === total and there is nothing unseen. That keeps the
  // existing message untouched for the mode where the student CAN navigate
  // back and the unanswered count is genuinely actionable.
  const unseenInSection = useMemo(() => {
    if (!isLinear) return 0;
    return Math.max(0, currentSectionTotal - currentSectionQIds.length);
  }, [isLinear, currentSectionTotal, currentSectionQIds.length]);

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

    // Sequential delivery (Phase 2.5): the SERVER owns answer writes via
    // submitAnswerAndAdvance, and firestore.rules reject a direct client
    // write. Keep the answer local; it is committed when the student advances.
    const dMode = attemptRef.current?.securityConfig?.deliveryMode;
    if (dMode === 'linear' || dMode === 'adaptive') return;

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
    // Sequential delivery: answers are already committed server-side by
    // submitAnswerAndAdvance, and a direct write would be rejected by rules.
    const dMode = att.securityConfig?.deliveryMode;
    if (dMode === 'linear' || dMode === 'adaptive') return;
    await saveAnswers(att.id, localAnswersRef.current);
  }, []);

  // ── Sequential delivery: merge a server-served question (Phase 2.5) ──
  // Puts the content in questionMap AND optimistically records it in
  // servedQuestions, so the shell renders it immediately instead of waiting
  // for the Firestore subscription to echo the append back.
  const mergeServedQuestion = useCallback((q: Question, sectionId: string) => {
    setQuestionMap((prev) => new Map(prev).set(q.id, q));
    setAttempt((prev) => {
      if (!prev) return prev;
      const served = prev.servedQuestions ?? [];
      if (served.some((s) => s.questionId === q.id)) return prev;
      return {
        ...prev,
        servedQuestions: [...served, {
          questionId: q.id,
          sectionId,
          difficulty: (q.difficulty as string) ?? 'medium',
          servedAt: new Date().toISOString(),
          locked: false,
        }],
      };
    });
  }, []);

  // ── Sequential delivery: submit current answer, receive next question ──
  // One atomic server call. The client cannot advance on its own, cannot go
  // back, and does not know the next question until the server returns it.
  const handleLinearNext = useCallback(async () => {
    const att = attemptRef.current;
    if (!att || !currentQId || linearAdvancing) return;
    setLinearAdvancing(true);
    setLinearError(undefined);
    try {
      const ans = localAnswersRef.current[currentQId];
      const payload = ans && !isAnswerEmpty(ans)
        ? { type: ans.type, value: ans.value as unknown }
        : null; // no answer (or timer expired) → server records nothing, scores 0
      const res = await submitAnswerAndAdvance({
        attemptId: att.id,
        questionId: currentQId,
        answer: payload,
      });

      // Advance OPTIMISTICALLY from the server's response. Do not wait for the
      // Firestore subscription to echo servedQuestions back — that round-trip
      // is slow enough that the student would sit on the (now locked) question
      // and a second click would hit QUESTION_LOCKED.
      if (res.question) {
        const q = res.question;
        setQuestionMap((prev) => new Map(prev).set(q.id, q));
        setAttempt((prev) => {
          if (!prev) return prev;
          const served = prev.servedQuestions ?? [];
          // Lock the question just answered, append the newly served one.
          const locked = served.map((s, i) =>
            i === served.length - 1 ? { ...s, locked: true } : s);
          const alreadyAppended = locked.some((s) => s.questionId === q.id);
          return {
            ...prev,
            servedQuestions: alreadyAppended ? locked : [...locked, {
              questionId: q.id,
              sectionId: currentSection?.id ?? '',
              difficulty: (q.difficulty as string) ?? 'medium',
              servedAt: new Date().toISOString(),
              locked: false,
            }],
          };
        });
      }
      if (res.sectionComplete) setLinearSectionComplete(true);
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? '';
      setLinearError(
        msg.includes('QUESTION_LOCKED')
          ? 'This question is already locked and cannot be changed.'
          : 'Could not save your answer. Check your connection and try again.',
      );
    } finally {
      setLinearAdvancing(false);
    }
  }, [currentQId, linearAdvancing, currentSection]);

  // A new section starts fresh (not complete).
  useEffect(() => { setLinearSectionComplete(false); }, [currentSectionIdx]);

  // Clear any advance error once the student is on a new question.
  useEffect(() => { setLinearError(undefined); }, [currentQId]);

  // ── Per-question timer (Phase 2.5 Stage 3) ─────────────────────
  // Authority toggle: currentSection.questionTimeLimit (seconds). Undefined =
  // off. The clock starts from the server's servedAt for the current served
  // question. On expiry the client auto-advances with whatever is selected
  // (or nothing) — the server also validates elapsed time and flags a late
  // answer, so suppressing the client timer gains nothing.
  const questionTimeLimit = isLinear ? currentSection?.questionTimeLimit : undefined;
  const currentServedAt = useMemo(() => {
    if (!attempt || !currentQId) return null;
    const entry = (attempt.servedQuestions ?? []).find((s) => s.questionId === currentQId);
    return entry?.servedAt ?? null;
  }, [attempt, currentQId]);

  const [qSecondsLeft, setQSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!questionTimeLimit || !currentServedAt || isLastQuestion) {
      setQSecondsLeft(null);
      return;
    }
    const deadline = Date.parse(currentServedAt) + questionTimeLimit * 1000;
    let fired = false;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setQSecondsLeft(left);
      if (left <= 0 && !fired) {
        fired = true;
        // Auto-advance. handleLinearNext sends the current selection (or null).
        handleLinearNext();
      }
    };
    tick();
    const iv = setInterval(tick, 500);
    return () => clearInterval(iv);
  }, [questionTimeLimit, currentServedAt, isLastQuestion, handleLinearNext]);

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

    // On the FINAL section there is no section-submit step worth showing: the
    // very next thing doSectionSubmit does is hand off to doFinalSubmit. Going
    // through 'submitting_section' first made the student watch two different
    // progress states for one action they confirmed as "Submit exam" — the
    // internal two-phase implementation leaking into the UI. Same test the
    // advance branch uses at the bottom of this function (nextSection is
    // effectiveSections[currentSectionIdx + 1]), so the two cannot disagree.
    const isFinalSection = currentSectionIdx + 1 >= effectiveSections.length;
    setShellStatus(isFinalSection ? 'submitting_exam' : 'submitting_section');
    // B-02 (audit 2026-07-26): this flush MUST NOT be allowed to throw past
    // here. submittingRef is already engaged above, and every release below
    // sits after this line — so an exception escaping flushAnswers strands the
    // lock at `true` forever, and because doSectionSubmit, handleFinalSubmit
    // and the Retry button all share that one ref, the student can no longer
    // submit this section OR the exam by any route. The failure is silent:
    // each retry hits its own `if (submittingRef.current) return`.
    //
    // Failing loudly is also better than continuing: if the answers did not
    // reach Firestore, submitting the section would grade against a stale
    // snapshot and quietly drop whatever the student typed last. Release,
    // report, let them retry — the answers are still in localAnswersRef.
    try {
      await flushAnswers();
    } catch (e) {
      console.error('[ExamShell] flush before section submit failed', e);
      submittingRef.current = false;
      setErrorMsg('Could not save your answers. Check your connection and try again.');
      setShellStatus('error');
      return;
    }

    const sectionId = currentSection.id;
    const startedAt = att.sectionTimings[sectionId]?.startedAt ?? new Date().toISOString();
    const timeUsedSeconds = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);

    const nextIdx = currentSectionIdx + 1;
    const nextSection = effectiveSections[nextIdx] ?? null;
    const isStudentChoice = a.sectionStartOrder === 'student_choice';
    // POSITIONAL break lookup: the break after the Nth completed section comes
    // from the Nth section in BUILDER order (breakAfterCompletion), not from
    // the section that happened to be played. nextIdx == completions after
    // this submit, because sections complete strictly in play order. This
    // makes the break schedule identical for every student under 'random',
    // and breaks now apply in 'student_choice' too — break first, then the
    // picker. Under 'sequential' builder order == play order: unchanged.
    const breakCfg = nextSection ? breakAfterCompletion(a.sections, att.sectionIds, nextIdx) : null;
    const useBreak = !!nextSection && !!breakCfg;
    // Pause if a break is due OR we're in student_choice and there's a next
    // slot — in both cases the next section's timer must not start
    // automatically. (The server independently refuses to auto-start when a
    // MANDATORY positional break is due, so a tampered client gains nothing.)
    const pauseBeforeNext = !!nextSection && (useBreak || isStudentChoice);

    try {
      const submitted = await submitSection({
        attemptId: att.id,
        sectionId,
        nextSectionId: nextSection?.id ?? null,
        nextSectionIdx: nextIdx,
        timeUsedSeconds,
        pauseBeforeNext,
      });
      // Sequential delivery (Phase 2.5): advancing straight into the next
      // section (no break) — the server serves and returns its first question.
      if (submitted.question && nextSection) {
        mergeServedQuestion(submitted.question, nextSection.id);
      }
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? '';
      // Overall exam deadline breached — HARD CUT. The server has already
      // closed the current section at the overall deadline and refused to
      // advance; the whole attempt is over. Finalise it now (grade with
      // 'time_expired') instead of falling through to the advance/break
      // branches below. doFinalSubmit takes over the submit lock, so leave
      // submittingRef engaged here.
      if (msg.includes('OVERALL_DEADLINE_EXCEEDED')) {
        await doFinalSubmit('time_expired');
        return;
      }
      // A late SECTION submit is finalised server-side (section closed at its
      // true deadline, and advanced identically to the normal path). Fall
      // through to the local-state advance below. Any OTHER error is a real
      // failure.
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
        endsAt: submittedAtMs + breakCfg.durationMinutes * 60 * 1000,
        mandatory: breakCfg.mandatory,
        then: isStudentChoice ? 'choose' : 'start_next',
        ...(isStudentChoice
          ? {}
          : { nextSectionId: nextSection.id, nextSectionIdx: nextIdx, nextSectionName: nextSection.name }),
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

    // student_choice: the break resolves into the section picker — no server
    // call here. The mandatory wait is still enforced server-side when the
    // student's pick reaches startSection (positional gate), so a clock-
    // skewed early continue is refused there and the pick simply retries.
    if (bs.then === 'choose') {
      setBreakState(null);
      setShellStatus('choosing_section');
      return;
    }
    if (!bs.nextSectionId || bs.nextSectionIdx === undefined) return; // defensive — start_next always carries these
    const nextSectionId = bs.nextSectionId;
    const nextSectionIdx = bs.nextSectionIdx;
    try {
      const broke = await endBreak({
        attemptId: att.id,
        nextSectionId,
        nextSectionIdx,
      });
      // Sequential delivery: the next section's first question arrives here.
      if (broke.question) {
        mergeServedQuestion(broke.question, nextSectionId);
      }
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
            currentSectionIdx: nextSectionIdx,
            sectionTimings: {
              ...prev.sectionTimings,
              [nextSectionId]: {
                ...prev.sectionTimings[nextSectionId],
                startedAt: startISO,
                timeUsedSeconds: 0,
              },
            },
          }
        : prev
    );
    setCurrentSectionIdx(nextSectionIdx);
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

      const picked = await pickSection({
        attemptId: att.id,
        pickedSectionId,
        currentSectionIds: att.sectionIds,
        newIdx,
      });
      const reorderedIds = picked.sectionIds;
      // Sequential delivery: the server serves this section's first question
      // and returns its content — merge it so the shell can render it.
      if (picked.question) {
        mergeServedQuestion(picked.question, pickedSectionId);
      }

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
    // B-02 backstop. doFinalSubmit handles its own known failures, but this
    // outer catch is what guarantees the invariant "the lock is never held by
    // a call that is no longer running". Anything unforeseen — a render-time
    // throw inside a setState, a future edit that adds an unguarded await —
    // lands here instead of stranding every submit path for the rest of the
    // sitting. Cheap insurance on the one code path where failure costs the
    // student their entire exam.
    try {
      await doFinalSubmit(reason);
    } catch (e) {
      console.error('[ExamShell] final submit threw', e);
      submittingRef.current = false;
      setErrorMsg('Your exam could not be submitted. Your answers are saved — check your connection and press Retry submission.');
      setShellStatus('submit_failed');
    }
  }, []); // eslint-disable-line

  const doFinalSubmit = useCallback(async (
    reason: 'manual' | 'time_expired' | 'violation_limit' | 'window_closed'
  ) => {
    const att = attemptRef.current;
    const a   = assessmentRef.current;
    // B-02: release before bailing. handleFinalSubmit and the Retry button
    // both engage the lock and then delegate here, so returning without
    // releasing leaves every submit path permanently disabled. (Callers that
    // deliberately hand the lock over — doSectionSubmit at the overall-deadline
    // and last-section branches — are unaffected: they only reach this line
    // when the attempt is already gone, at which point nothing can submit
    // anyway and a released lock is strictly safer than a stuck one.)
    if (!att || !a) {
      submittingRef.current = false;
      return;
    }

    lastFinalReasonRef.current = reason;
    setShellStatus('submitting_exam');
    // B-02: same reasoning as the section-submit flush above. Do not grade an
    // attempt whose latest answers failed to persist — that would submit a
    // stale snapshot and silently lose the student's last answers. This file
    // already refuses to fake success at submit time (see the gradeAttempt
    // catch below); this extends the same rule to the save that precedes it.
    try {
      await flushAnswers();
    } catch (e) {
      console.error('[ExamShell] flush before final submit failed', e);
      submittingRef.current = false;
      setErrorMsg('Your answers could not be saved, so the exam was not submitted. Check your connection and press Retry submission.');
      setShellStatus('submit_failed');
      return;
    }

    try {
      await gradeAttempt({ attemptId: att.id, reason });
    } catch (e) {
      // DO NOT navigate to results on failure — the attempt is still
      // in_progress server-side; showing "submitted" would be a lie and the
      // student would lose their only chance to retry. Surface a retry
      // screen instead (answers are already flushed, nothing is lost).
      console.error('[ExamShell] gradeAttempt failed', e);
      submittingRef.current = false;
      const sebMsg = sebFriendlyMessage((e as { message?: string })?.message ?? '');
      setErrorMsg(
        sebMsg
          // Phase 3 (Stage 3): SEB rejection at submit time (e.g. the student
          // left SEB before submitting). Answers are flushed; retrying from
          // inside SEB succeeds.
          ? `${sebMsg} Then press Retry submission.`
          : 'Your exam could not be submitted. Your answers are saved — check your connection and try again.',
      );
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
        sebFriendlyMessage(msg)
          ?? (msg.includes('RESUME_BLOCKED')
            ? 'An invigilator must clear this pause before you can continue.'
            : 'Could not resume. Please ensure the extension is removed and try again.'),
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

  // Fires on a normal tick to zero AND on mount when the timer is ALREADY
  // past zero — SectionTimer calls tick() immediately, so returning to an
  // abandoned exam triggers this straight away rather than waiting for a
  // transition that already happened while nobody was watching.
  //
  // The `shellStatus !== 'ready'` guard stays: it prevents a stray expiry
  // during a break, a section pick or an in-flight submit. It is not the
  // enforcement, though. Server-side, answersLockedAfter now blocks the write
  // outright and scheduledCloseExpiredAttempts closes the attempt — this
  // handler only makes the client do the polite thing promptly.
  const handleSectionTimerExpire = useCallback(() => {
    if (shellStatus !== 'ready') return;
    if (isFrozenRef.current) return; // paused by invigilator — don't auto-submit
    doSectionSubmit('time_expired');
  }, [shellStatus, doSectionSubmit]);

  // ══════════════════════════════════════════════════════════════════
  // OVERALL TIMER EXPIRY (hard cut)
  // ══════════════════════════════════════════════════════════════════
  // The whole-exam clock hit zero. Unlike the section timer, this ends the
  // ENTIRE attempt — go straight to final submit, whatever section the
  // student is on. The server enforces the same deadline on the next
  // submitSection regardless (this display-driven path just gets there
  // faster and cleaner). Suppressed while frozen — an invigilator pause
  // must not auto-finalise the exam.
  const handleOverallTimerExpire = useCallback(() => {
    if (shellStatus !== 'ready') return;
    if (isFrozenRef.current) return;
    handleFinalSubmit('time_expired');
  }, [shellStatus, handleFinalSubmit]);

  // ══════════════════════════════════════════════════════════════════
  // RENDER: LOADING / ERROR
  // ══════════════════════════════════════════════════════════════════

  if (shellStatus === 'loading') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: '#F7F6F3' }}>
        <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
        {/* Copy varies with startPhase so a staggered wait reads as progress
            rather than a stalled spinner. Deliberately NOT a countdown or a
            queue position: both invite students to compare with a neighbour
            and conclude something is wrong, when in fact the delay costs them
            nothing — their timer starts when their attempt does. */}
        <p className="text-xs mt-4" style={{ color: '#C4C3BD' }}>
          {startPhase === 'retrying'
            ? 'Still preparing your exam…'
            : startPhase === 'queued'
              ? 'Preparing your exam… your time starts when it opens.'
              : 'Preparing your exam…'}
        </p>
      </div>
    );
  }

  if (shellStatus === 'error') {
    // Phase 3 (Stage 3): SEB rejections get a guided panel — what happened,
    // what to do, where to get SEB and the config — never a raw error code.
    if (errorIsSeb) {
      return (
        <div className="fixed inset-0 flex flex-col items-center justify-center px-6" style={{ background: '#F7F6F3' }}>
          <div className="flex items-center justify-center mb-5"
            style={{ width: 52, height: 52, borderRadius: '50%', background: '#FBF3F3', border: '1px solid #E3C9C9' }}>
            <AlertTriangle size={22} strokeWidth={1} style={{ color: '#9B2828' }} />
          </div>
          <p className="text-xs mb-2" style={{ color: '#9B2828', letterSpacing: '0.1em' }}>
            SAFE EXAM BROWSER REQUIRED
          </p>
          <p className="text-xs text-center mb-1" style={{ color: '#4A4A45', lineHeight: 1.7, maxWidth: 420 }}>
            {errorMsg}
          </p>
          <p className="text-xs text-center mb-6" style={{ color: '#9A9891', lineHeight: 1.6, maxWidth: 420 }}>
            Your progress is saved — resuming inside Safe Exam Browser continues where you left off.
          </p>
          <div className="flex items-center gap-2 flex-wrap justify-center">
            <a
              href="https://safeexambrowser.org/download_en.html"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-4 py-2"
              style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, textDecoration: 'none' }}
            >
              Download Safe Exam Browser
            </a>
            {(assessment?.sebConfigFileUrl || platformSebUrl) && (
              <a
                href={assessment?.sebConfigFileUrl || platformSebUrl}
                className="text-xs px-4 py-2"
                style={{ color: '#4A4A45', border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', textDecoration: 'none' }}
              >
                Exam configuration (.seb)
              </a>
            )}
            <button
              onClick={() => navigate('/student/assessments')}
              className="text-xs px-4 py-2"
              style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, background: '#FFFFFF', cursor: 'pointer' }}
            >
              Return to assessments
            </button>
          </div>
        </div>
      );
    }
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
            // B-02: goes through handleFinalSubmit rather than re-implementing
            // the guard/engage pair and calling doFinalSubmit directly. The
            // old form was a floating promise with no catch, so a throw became
            // an unhandled rejection AND left the lock engaged — which killed
            // this very button, the one control whose whole job is to recover
            // from a failed submit. Reusing the wrapper means retry gets the
            // same backstop as every other submit path, for free.
            void handleFinalSubmit(lastFinalReasonRef.current);
          }}
          className="text-xs mt-6 px-4 py-2"
          style={{ background: '#2F2F2B', color: '#FFFFFF', borderRadius: 2 }}
        >
          Retry submission
        </button>
      </div>
    );
  }

  // 'submitting_section' previously had NO render case, so it fell through to
  // the live exam UI — the student confirmed a submit and then watched the
  // paper sit there unchanged until the next state arrived. Nothing signalled
  // that the click had registered, which is what made it feel inert and
  // invited a second click on an already-submitting section.
  if (shellStatus === 'submitting_section') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: '#F7F6F3' }}>
        <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
        <p className="text-xs mt-4" style={{ color: '#C4C3BD' }}>Submitting this section…</p>
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

  // ── Overall exam clock ─────────────────────────────────────────
  // Whole-sitting countdown, anchored on attempt.startedAt (set once, server-
  // side, at attempt creation — the true start of the exam). Rendered only
  // when the assessment defines an overall cap. Display-only; the server
  // enforces the same deadline on every submitSection (hard cut). Freeze is
  // credited exactly like the section clock, via totalFrozenSeconds /
  // frozenAtISO, so an invigilator pause does not eat the overall budget.
  const overallLimitMinutes = assessment.overallTimeLimit ?? 0;
  const overallAnchorISO = attempt.startedAt || null;
  const showOverallTimer = overallLimitMinutes > 0 && !!overallAnchorISO;

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
          <TimerChip label="Section">
            <SectionTimer
              timeLimitMinutes={currentSection.timeLimit}
              startedAtISO={sectionStartedAt}
              onExpire={handleSectionTimerExpire}
              frozenOffsetSeconds={totalFrozenSeconds}
              frozenAtISO={isFrozen ? frozenAtISO : null}
              nowFn={nowFn}
            />
          </TimerChip>
        )}

        {/* Overall exam timer (whole sitting) — labelled to distinguish it
            from the per-section clock. Only shown when the exam defines an
            overall cap. Enforcement is server-side; this is the visible
            countdown so the total limit is never a surprise. */}
        {showOverallTimer && (
          <TimerChip label="Total">
            <SectionTimer
              timeLimitMinutes={overallLimitMinutes}
              startedAtISO={overallAnchorISO!}
              onExpire={handleOverallTimerExpire}
              frozenOffsetSeconds={totalFrozenSeconds}
              frozenAtISO={isFrozen ? frozenAtISO : null}
              nowFn={nowFn}
            />
          </TimerChip>
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
            {!isLinear && (
            <QuestionNavigator
              questionIds={currentSectionQIds}
              answers={localAnswers}
              currentQIdx={currentQIdx}
              onSelectQ={setCurrentQIdx}
              sectionName={currentSection.name}
              totalSections={totalSections}
              currentSectionNumber={currentSectionIdx + 1}
            />
            )}
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
                  totalQuestions={currentSectionTotal}
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
                {isLinear ? (
                  <span className="flex items-center gap-1.5 text-xs px-1 py-2"
                    style={{ color: '#9A9891' }}>
                    <Shield size={12} strokeWidth={1.5} />
                    Answers are final — you cannot return to a question
                  </span>
                ) : (
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
                )}

                {/* Centre: answered count (standard) or progress + error (linear) */}
                <div className="flex items-center gap-2">
                  {isLinear ? (
                    <>
                      <span className="text-xs" style={{ color: '#C4C3BD' }}>
                        Question {currentSectionQIds.length}
                      </span>
                      {qSecondsLeft !== null && (
                        <span className="flex items-center gap-1 text-xs px-2 py-0.5"
                          style={{
                            background: qSecondsLeft <= 10 ? '#FBF3F3' : '#F0F9F4',
                            border: `1px solid ${qSecondsLeft <= 10 ? '#E3C9C9' : '#B8E6C8'}`,
                            borderRadius: 2,
                            color: qSecondsLeft <= 10 ? '#9B2828' : '#1E7B3C',
                          }}>
                          <span className="text-[10px] uppercase" style={{ letterSpacing: '0.06em', opacity: 0.7 }}>
                            Per Q
                          </span>
                          <Clock size={10} strokeWidth={1.5} />
                          {Math.floor(qSecondsLeft / 60)}:{String(qSecondsLeft % 60).padStart(2, '0')}
                        </span>
                      )}
                      {linearError && (
                        <span className="text-xs" style={{ color: '#9B2828' }}>{linearError}</span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="text-xs" style={{ color: '#C4C3BD' }}>
                        {currentSectionQIds.length - unansweredInSection}
                        /{currentSectionQIds.length} answered in this section
                      </span>
                      {!isAnswerEmpty(localAnswers[currentQId!]) && (
                        <CheckCircle2 size={12} strokeWidth={1.5} style={{ color: '#1E7B3C' }} />
                      )}
                    </>
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
                    onClick={isLinear
                      ? handleLinearNext
                      : () => setCurrentQIdx((i) => Math.min(currentSectionQIds.length - 1, i + 1))}
                    disabled={isLinear && linearAdvancing}
                    className="flex items-center gap-1.5 text-xs px-4 py-2"
                    style={{
                      border: '1px solid #E3E1DB',
                      color: isLinear ? '#FFFFFF' : '#4A4A45',
                      background: isLinear ? '#0C0C0B' : 'transparent',
                      borderRadius: 2,
                      opacity: isLinear && linearAdvancing ? 0.5 : 1,
                      cursor: isLinear && linearAdvancing ? 'default' : 'pointer',
                    }}
                  >
                    {isLinear
                      ? (linearAdvancing ? 'Saving…' : 'Save & next')
                      : 'Next'}
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
            unseen={unseenInSection}
            totalInSection={currentSectionTotal}
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