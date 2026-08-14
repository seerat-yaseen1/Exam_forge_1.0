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
import { getExamQuestionsForStudent, type Question, type ExamQuestionGroup, type GroupKind } from '../../../lib/questionBankService';
import {
  startAttempt,
  saveAnswer,
  saveAnswers,
  submitSection,
  endBreak,
  pickSection,
  gradeAttempt,
  runCodeSample,
  recordCodeTelemetry,
  logViolation,
  enforceIntegrityThreshold,
  MAX_INTEGRITY_WARNINGS,
  MAX_LOGGED_VIOLATION_EVENTS,
  getAttemptByStudentAndAssessment,
  getAttempt,
  getServerSkew,
  subscribeToAttempt,
  registerSession,
  getExamVerdict,
  DEFAULT_QUESTION_GRACE_SECONDS,
  sendHeartbeat,
  reportExtensionCheck,
  verifyAndResume,
  submitAnswerAndAdvance,
  saveAnswerNoAdvance,
  lockToMillis,
  type AttemptLock,
  type Attempt,
  type AttemptAnswer,
  type AnswerValue,
  type ViolationType,
} from '../../../lib/submissionService';
import {
  createReportsForAttempt,
  type ReportReason,
} from '../../../lib/questionReportService';
import { IntegrityEngine, codeEditorPasteAllowed } from '../../components/exam/IntegrityEngine';
import { telemetryEnabled } from '../../../lib/codeTelemetry';
import { answerTypeForEngine } from '../../../lib/itemTypes';
import { FaceMonitor } from '../../components/exam/FaceMonitor';
import { ExtensionWatchdog } from '../../components/exam/ExtensionWatchdog';
import {
  scanForExtensionsWithSettle,
  extensionGateBlocks,
  type ExtensionScanResult,
} from '../../components/exam/extensionScan';
import { SectionTimer } from '../../components/exam/SectionTimer';
import { QuestionNavigator, answerHasContent } from '../../components/exam/QuestionNavigator';
import { QuestionRenderer } from '../../components/exam/QuestionRenderer';
import {
  WarningOverlay,
  FinalWarningOverlay,
  FullscreenRequiredOverlay,
  ExtensionRequiredOverlay,
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
  | { kind: 'extension_required'; found: string[] }
  | { kind: 'terminated'; reason: string; answersMayBeUnsaved?: boolean }
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
/**
 * Did this write fail because the exam's answer window has closed?
 *
 * firestore.rules denies answer writes once answersLockedAfter has passed
 * (audit 2026-07-28). That denial is not a fault to recover from — it is the
 * deadline doing its job, and it means the attempt must now be SUBMITTED
 * rather than retried. Treating it like a network failure would strand the
 * student on an error screen with an exam they can neither continue nor close,
 * which is exactly what the two flush handlers below used to do.
 *
 * Only the final flush is affected. Everything the student answered before the
 * deadline was already persisted by the 1.5s autosave; what is refused here is
 * at most the last unflushed moment, which is precisely what expiring means.
 */
/**
 * Has this attempt's answer window already closed?
 *
 * Reads the same answersLockedAfter that firestore.rules enforces, so the
 * client reaches the identical verdict without waiting for a timer callback.
 *
 * That independence is the point (audit 2026-07-28). Auto-submit used to hang
 * entirely off SectionTimer's onExpire, which only fires if the component is
 * mounted, unfrozen, and the shell happens to be in 'ready' at that instant.
 * A student who walked away and came back met all the wrong conditions: the
 * clock had run out while nothing was watching, so there was no tick to
 * transition on, and they landed on a live question with 00:00 showing. The
 * server refuses their answers now, but leaving them staring at a Save & next
 * button that silently fails is not an answer — the attempt should finalise
 * itself the moment we know the window is shut.
 *
 * Tolerates every shape a lock can arrive in — Firestore Timestamp, callable
 * JSON, ISO string, or absent — via lockToMillis (D-34). The conversion lives
 * in submissionService so this file and the Attempt type cannot drift apart
 * about what a lock looks like.
 */

/** Has this specific bound passed? Null/absent/unparseable = no bound. */
function lockPassed(raw: AttemptLock | undefined, nowMs: number): boolean {
  const ms = lockToMillis(raw);
  return ms !== null && nowMs >= ms;
}

/**
 * Build the break state from the section's AUTHORITATIVE submit time.
 * (Phase 0.1, timer plan — 2026-07-31.)
 *
 * There were two code paths that entered a break and they disagreed. The
 * RESUME path read the server's persisted `submittedAt`, which submitSection
 * CLAMPS to the section's true deadline when a submit arrives late — so a
 * break whose window had already passed correctly showed as elapsed. The
 * in-session TRANSITION path invented its own `Date.now()` instead, so the
 * same break started fresh from the moment the student walked back.
 *
 * That stayed hidden until Phase 0, because before it a section expiring while
 * the student was away finalised the whole attempt and the break code never
 * ran at all. Reported live: a mandatory break made the student wait its full
 * minute after returning, hours after that break was due.
 *
 * One builder, two callers, so they cannot drift again. `submittedAtIso` must
 * come from the server — never from the client's clock.
 *
 * Returns null when the break has no duration left AND the caller should skip
 * straight past it; returns an `elapsed` state when the break is over but a
 * gesture is still needed (fullscreen re-entry requires a real click).
 */
function buildBreakState(args: {
  submittedAtIso: string;
  durationMinutes: number;
  mandatory: boolean;
  sectionId: string;
  sectionName: string;
  isChoice: boolean;
  nextSectionId?: string;
  nextSectionIdx?: number;
  nextSectionName?: string;
  nowMs?: number;
  /** Server-materialised freeze credit for this break (D-29 / D-35). */
  breakCreditMs?: number;
}): BreakState {
  const now = args.nowMs ?? Date.now();
  // D-29: the break gets its freeze credit like every other clock. Server twin
  // is pendingBreak in examTimingCore, which adds creditForAnchor(a, last.at)
  // to the same expression — these two must move together.
  const endsAt = new Date(args.submittedAtIso).getTime()
    + args.durationMinutes * 60 * 1000
    + (args.breakCreditMs ?? 0);
  const live = Number.isFinite(endsAt) && endsAt > now;

  // `mandatory` is reported honestly, including for an elapsed break. It only
  // governs whether the student may leave EARLY; once the clock reaches zero
  // BreakScreen continues on its own regardless of which kind it was. An
  // earlier version forced mandatory=false on elapsed breaks to let the click
  // through, which was a lie in the state and — because auto-continue was
  // gated on mandatory — turned every elapsed break into a dead screen.
  return {
    justSubmittedSectionId: args.sectionId,
    justSubmittedSectionName: args.sectionName,
    endsAt: live ? endsAt : now,
    mandatory: args.mandatory,
    then: args.isChoice ? 'choose' : 'start_next',
    ...(args.isChoice
      ? {}
      : {
          nextSectionId: args.nextSectionId,
          nextSectionIdx: args.nextSectionIdx,
          nextSectionName: args.nextSectionName,
        }),
  } as BreakState;
}

function answerWindowClosed(attempt: Attempt | null, nowMs = Date.now()): boolean {
  return lockPassed(attempt?.answersLockedAfter, nowMs);
}

/**
 * Which clock ran out? (Phase 0 of the timer plan, 2026-07-31.)
 *
 * 'overall'  — the whole sitting is over; finalise.
 * 'section'  — this section is over but the sitting is not; close the section
 *              and let the normal advance/break path run.
 * 'unknown'  — the combined bound has passed but the split bounds are absent,
 *              i.e. an attempt that started before this shipped. Treated as
 *              'overall' because that is the previous behaviour, and because
 *              the alternative — doing nothing — strands the student on a live
 *              question whose answers the rules will refuse. Self-clearing:
 *              no new attempt lacks these fields.
 * null       — nothing has expired.
 *
 * Order matters and mirrors the spec's precedence: overall outranks section.
 *
 * ── STALE-LOCK GUARD (Phase 0.2, 2026-07-31) ────────────────────
 * `sectionLockedAfter` is written by the SERVER when a section starts. All
 * three client advance paths (section submit, end break, pick section) update
 * currentSectionIdx and the new section's startedAt optimistically, but none
 * of them can know the new lock — it only arrives when the Firestore
 * subscription catches up. For that window the attempt carries the PREVIOUS
 * section's lock, which is already in the past.
 *
 * That window is why entering section B instantly submitted it, then C, then
 * D: each advance set shellStatus to 'ready' while the stale lock still read
 * as expired, so this effect fired again immediately. A cascade, not a
 * one-off.
 *
 * The guard is a consistency check, NOT a re-derivation of the deadline: a
 * lock bounds a section, so it must fall AFTER that section started. If the
 * current section started later than the lock, the lock provably belongs to an
 * earlier section and is ignored until the real one arrives. Being briefly
 * permissive here is safe — firestore.rules still refuses late answers, and
 * the scheduled sweep still closes abandoned attempts.
 *
 * The overall bound needs no such guard: it is anchored on attempt.startedAt,
 * which never moves, so a stale copy holds the identical value.
 */
function expiredClock(
  attempt: Attempt | null,
  nowMs = Date.now(),
  currentSectionStartedAtIso?: string,
): 'overall' | 'section' | 'unknown' | null {
  if (!attempt) return null;
  if (lockPassed(attempt.overallLockedAfter, nowMs)) return 'overall';

  if (lockPassed(attempt.sectionLockedAfter, nowMs)) {
    // Same helper as lockPassed above — this used to repeat the conversion
    // inline, which meant two places had to learn about the callable wire
    // shape and only one ever did (D-34).
    const lockMs = lockToMillis(attempt.sectionLockedAfter);
    const startedMs = currentSectionStartedAtIso
      ? new Date(currentSectionStartedAtIso).getTime()
      : NaN;
    // Stale: this lock predates the section it would be closing.
    const stale = lockMs !== null && Number.isFinite(startedMs) && startedMs >= lockMs;
    if (!stale) return 'section';
  }

  if (!answerWindowClosed(attempt, nowMs)) return null;
  const hasSplit =
    attempt.overallLockedAfter !== undefined || attempt.sectionLockedAfter !== undefined;
  return hasSplit ? null : 'unknown';
}

/**
 * Is this failure "the deadline doing its job" rather than something wrong?
 *
 * Two shapes, one meaning. STANDARD delivery writes answers directly and the
 * rules deny them past answersLockedAfter, which surfaces as permission-denied.
 * SEQUENTIAL delivery writes through submitAnswerAndAdvance /
 * saveAnswerNoAdvance, which since A-03 refuse a late answer explicitly — those
 * arrive as deadline-exceeded carrying ANSWER_WINDOW_CLOSED.
 *
 * Both have to read the same here. The callers use this to decide between "your
 * time was up, submit cleanly" and "something failed, warn the student and tell
 * the invigilator". Before A-03 the sequential path could not produce this
 * condition at all, so a late flush would have been reported to the student as
 * an unexplained save failure — alarming, and wrong.
 */
function isAnswerWindowClosed(e: unknown): boolean {
  const code = String((e as { code?: string })?.code ?? '');
  if (code === 'permission-denied' || code.endsWith('/permission-denied')) return true;
  const msg = String((e as { message?: string })?.message ?? '');
  return msg.includes('ANSWER_WINDOW_CLOSED');
}

/**
 * The inverse of `answerHasContent`, and deliberately nothing more.
 *
 * This used to be its own rule, dispatching on the VALUE's shape rather than
 * on the answer type. For mcq, text and match the two agreed; for code they
 * could not, because a coding value is an object whose keys are present even
 * when the editor is empty — `{ language, source: '' }` has two keys and read
 * as content. Eight call sites depended on it, three of them counting what the
 * student still has unanswered.
 *
 * One rule, one implementation. If what counts as an answer ever changes, it
 * changes for the navigator and for durability in the same edit.
 */
function isAnswerEmpty(ans: AttemptAnswer | undefined): boolean {
  return !answerHasContent(ans);
}

/**
 * A stable identity for an answer's CONTENT (Phase 4.1, D-31).
 *
 * Durability turns on one question: does the server hold what the student is
 * looking at? Comparing the answer objects cannot tell us — `answeredAt` is
 * stamped fresh on every keystroke, so two identical selections never look
 * equal. Comparing only type and value does.
 *
 * Object values (match questions) have their keys sorted first. Two
 * semantically identical maps built in different orders would otherwise
 * fingerprint differently and show as permanently unsaved, and the sweep would
 * re-send them forever. Arrays are left alone: for a multi-select the order is
 * the student's, not ours to normalise.
 *
 * Empty answers fingerprint as '' and are never counted as unsaved. A student
 * who has not answered has nothing at risk.
 */
function answerFingerprint(ans: AttemptAnswer | undefined): string {
  if (!ans || isAnswerEmpty(ans)) return '';
  const v = ans.value;
  const norm =
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v as Record<string, string>).sort()
          .map((k) => [k, (v as Record<string, string>)[k]])
      : v;
  return JSON.stringify([ans.type, norm]);
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
          <Flag size={22} strokeWidth={1.5} style={{ color: 'var(--ef-warning-border)' }} />
        </div>
        <div className="flex flex-col gap-2">
          {/*
            COPY IS LOAD-BEARING — read before editing.

            This previously read "Your timer is stopped and no time is being
            lost", which was false in both directions.

            False today: the DISPLAY pauses (SectionTimer freezes its reference
            instant on frozenAtISO) but the server-side deadline does not —
            CONSUME_LEGACY_FROZEN_SECONDS is false and the resolver gives an
            open freeze no credit. That is D-03 in its original shape, display
            crediting what the write gate does not, stated to the student in
            words.

            Still false after 4.3: once freeze really does stop the clocks,
            how much of the pause comes back is the invigilator's DECISION
            (FREEZE_AND_ROADMAP A4), and zero is a valid answer. A promise the
            system cannot keep is exactly the quiet wrongness this project is
            about, so the copy promises only what is actually guaranteed: the
            exam is paused, and a person decides what happens next.

            Wording follows A1: "paused by invigilator", never "finished" or
            "submitted" — a student reads either as final, and it is not.
          */}
          <p className="text-xs" style={{ color: 'var(--ef-warning-border)', letterSpacing: '0.12em' }}>
            ASSESSMENT PAUSED
          </p>
          <p className="text-sm" style={{ color: 'var(--ef-surface)', lineHeight: 1.6 }}>
            Your assessment has been paused by an invigilator.
          </p>
          <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.5)', lineHeight: 1.6 }}>
            Your answers so far have been saved. Please stay on this screen and
            wait — an invigilator will decide when your assessment resumes and
            how the paused time is handled. You will be told what was decided.
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
          <Flag size={22} strokeWidth={1.5} style={{ color: 'var(--ef-warning-border)' }} />
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs" style={{ color: 'var(--ef-warning-border)', letterSpacing: '0.12em' }}>
            EXAM PAUSED — EXTENSION DETECTED
          </p>
          <p className="text-sm" style={{ color: 'var(--ef-surface)', lineHeight: 1.6 }}>
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
              background: resuming ? 'rgba(255,255,255,0.15)' : 'var(--ef-warning-border)',
              color: resuming ? 'rgba(255,255,255,0.6)' : 'var(--ef-ink)',
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
          style={{ width: 52, height: 52, borderRadius: '50%', background: '#EFEEE9', border: '1px solid var(--ef-border)' }}>
          <Loader2 size={20} strokeWidth={1.5} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.12em' }}>
            PREPARING MONITORING
          </p>
          <p className="text-sm" style={{ color: 'var(--ef-text-subtle)', lineHeight: 1.6 }}>
            Setting up webcam monitoring before your exam begins…
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
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
          <MonitorSmartphone size={24} strokeWidth={1} style={{ color: 'var(--ef-danger-border)' }} />
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs" style={{ color: 'var(--ef-danger-border)', letterSpacing: '0.12em' }}>
            SESSION CONFLICT
          </p>
          <p className="text-sm" style={{ color: 'var(--ef-surface)', lineHeight: 1.6 }}>
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
        style={{ width: 400, background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--ef-border)' }}>
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
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
              style={{ background: '#FEF9EC', border: '1px solid var(--ef-warning-border)', borderRadius: 2 }}>
              <AlertTriangle size={12} strokeWidth={1.5} style={{ color: 'var(--ef-warning)', flexShrink: 0, marginTop: 1 }} />
              <p className="text-xs" style={{ color: 'var(--ef-warning)', lineHeight: 1.6 }}>
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
          <p className="text-xs" style={{ color: 'var(--ef-text-subtle)', lineHeight: 1.6 }}>
            {isFinal
              ? 'Are you sure you want to submit the entire exam? This action cannot be undone.'
              : `Are you sure you want to submit ${sectionName}? You cannot return to this section once submitted.`}
          </p>
        </div>
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderTop: '1px solid var(--ef-border)' }}>
          <button
            onClick={() => { if (confirming) return; setConfirming(true); onConfirm(); }}
            disabled={confirming}
            className="flex items-center gap-1.5 text-xs px-4 py-2.5"
            style={{
              background: confirming ? '#5A5A54' : 'var(--ef-ink)',
              color: 'var(--ef-surface)', borderRadius: 2,
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
              color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2,
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
  frozenAtISO,
}: {
  state: BreakState;
  onContinue: () => void;
  /** Instant an invigilator paused, or null when running (D-36). */
  frozenAtISO?: string | null;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  // ── D-36: a break is a clock too, and freeze must stop it ───────
  //
  // This ran on raw Date.now() with no freeze awareness of any kind. Freeze a
  // student on a break and the countdown carried on underneath the overlay —
  // then hit zero and AUTO-FIRED onContinue, which calls endBreak and
  // startSection. A paused student was advanced into the next section without
  // touching anything.
  //
  // That is D-32 in a second place. Phase 4.2b audited the four expiry paths
  // inside ExamShell and guarded the one that was missing; this component owns
  // its own independent timer and was never looked at. Same lesson, wider than
  // it was taken: find every clock, not every clock in one file.
  //
  // Pinning `now` at the freeze instant freezes the display AND, because the
  // auto-continue fires off `expired`, stops the advance as well — one change
  // closing both halves.
  const frozenMs = frozenAtISO ? Date.parse(frozenAtISO) : NaN;
  const refNow = Number.isFinite(frozenMs) ? Math.min(now, frozenMs) : now;

  const remainingMs = Math.max(0, state.endsAt - refNow);
  const remainingSec = Math.ceil(remainingMs / 1000);
  const mm = Math.floor(remainingSec / 60);
  const ss = remainingSec % 60;
  const expired = remainingMs <= 0;
  const canContinue = expired || !state.mandatory;

  // ── Auto-continue once the break's time is up (fixed 2026-08-01) ──
  // This used to require `state.mandatory`, so an OPTIONAL break that ran down
  // to 0:00 just sat there waiting for a click, and after Phase 0.1 marked
  // elapsed breaks non-mandatory every resumed break landed in the same dead
  // state. "Optional" means the student may leave EARLY — not that they must
  // dismiss a break that is already over. When the clock reaches zero the exam
  // resumes, whichever kind it was.
  //
  // Fires once: onContinue is stable while this screen is up (its only dep is
  // breakState), and the ref guards a re-fire if React re-runs the effect.
  const autoFiredRef = useRef(false);
  const [autoFailed, setAutoFailed] = useState(false);
  useEffect(() => {
    if (!expired || autoFiredRef.current) return;
    autoFiredRef.current = true;
    onContinue();
    // If we are still on this screen several seconds later the advance did not
    // take (a refused start, a dropped connection). Hand the student a working
    // button back rather than leaving them on a disabled "Continuing…" with no
    // way out — being stuck with no recourse is the failure mode this module
    // has already produced twice.
    const t = setTimeout(() => setAutoFailed(true), 5000);
    return () => clearTimeout(t);
  }, [expired, onContinue]);

  const autoContinuing = expired && !autoFailed;

  // Set on click so a manual continue (skippable break) visibly registers
  // rather than looking ignored while handleEndBreak does its work.
  const [continuing, setContinuing] = useState(false);
  const busy = autoContinuing || continuing;

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: 'var(--ef-canvas)' }}>
      <div className="flex flex-col items-center gap-4" style={{ maxWidth: 440, textAlign: 'center', padding: '0 24px' }}>
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.12em' }}>BREAK</p>
        <p className="text-sm" style={{ color: 'var(--ef-ink)', lineHeight: 1.6 }}>
          {state.then === 'choose'
            ? `${state.justSubmittedSectionName} submitted. Take a moment — you'll choose your next section when you continue.`
            : `${state.justSubmittedSectionName} submitted. Take a moment before ${state.nextSectionName} begins.`}
        </p>
        <div
          className="flex items-center justify-center"
          style={{
            width: 120, height: 120, borderRadius: '50%',
            border: '1px solid var(--ef-border)', background: 'var(--ef-surface)',
          }}
        >
          <span style={{ color: 'var(--ef-ink)', fontVariantNumeric: 'tabular-nums', fontSize: 24 }}>
            {mm}:{ss.toString().padStart(2, '0')}
          </span>
        </div>
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
          {state.mandatory
            ? 'You must wait until the timer ends.'
            : 'You may skip this break and continue immediately.'}
        </p>
        <button
          onClick={() => { if (busy) return; setContinuing(true); onContinue(); }}
          disabled={!canContinue || busy}
          className="text-xs px-5 py-2.5 mt-2"
          style={{
            background: canContinue && !busy ? 'var(--ef-ink)' : 'var(--ef-track)',
            color: 'var(--ef-surface)', borderRadius: 2,
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
        style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em', fontWeight: 500 }}
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
    <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: 'var(--ef-canvas)', padding: 24 }}>
      <div className="flex flex-col items-center gap-4" style={{ maxWidth: 560, width: '100%' }}>
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.12em' }}>CHOOSE YOUR NEXT SECTION</p>
        <p className="text-sm" style={{ color: 'var(--ef-ink)', textAlign: 'center', lineHeight: 1.6 }}>
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
                background: 'var(--ef-surface)',
                border: '1px solid var(--ef-border)',
                borderRadius: 3,
                cursor: picking ? 'not-allowed' : 'pointer',
                opacity: picking ? 0.6 : 1,
              }}
              onMouseEnter={(e) => { if (!picking) e.currentTarget.style.borderColor = 'var(--ef-ink)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--ef-border)'; }}
            >
              <span className="text-xs" style={{ color: 'var(--ef-ink)' }}>{sec.name}</span>
              <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                {sec.questions.length} question{sec.questions.length === 1 ? '' : 's'}
                {sec.timeLimit ? ` · ${sec.timeLimit} min` : ''}
              </span>
            </button>
          ))}
        </div>
        {picking && (
          <div className="flex items-center gap-2" style={{ color: 'var(--ef-text-muted)' }}>
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
  // Shared stimulus for grouped sets (Phase 1). Arrives on the SAME
  // getExamQuestions call as the questions — one round trip, not two — and is
  // keyed by group id. Empty for every paper with no grouped questions.
  const [groupMap, setGroupMap]             = useState<Map<string, ExamQuestionGroup>>(new Map());
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
  /**
   * Per-clock freeze credit, straight from the server (D-35).
   *
   * totalFrozenSeconds above is a FLAT total for the whole attempt, and it was
   * subtracted from the section clock, the overall clock and the question
   * clock alike. The server has credited per-clock since D-28 — only pauses
   * that began after a clock's own anchor count — so the two agreed only when
   * the pause happened inside the clock currently running. Freeze in section 1
   * and section 2 showed ten minutes nobody had granted.
   *
   * Nothing is computed here. These are the numbers the write gate uses.
   * totalFrozenSeconds is kept only as the fallback for attempts that started
   * before this shipped.
   */
  const [freezeCredits, setFreezeCredits] = useState<{
    overallMs: number; sectionMs: number; questionMs: number; breakMs: number;
  }>({ overallMs: 0, sectionMs: 0, questionMs: 0, breakMs: 0 });
  const creditSeconds = (ms: number) => Math.round(ms / 1000);
  const [hasConflict, setHasConflict]               = useState(false);
  const isFrozenRef = useRef(false);
  useEffect(() => { isFrozenRef.current = isFrozen; }, [isFrozen]);
  // D-32: the per-question tick needs freeze state too. Held in refs, like
  // every other guard in this file, so an invigilator pausing or releasing
  // does not tear down and rebuild the countdown interval underneath the
  // student.
  const frozenAtRef = useRef<string | null>(null);
  useEffect(() => { frozenAtRef.current = frozenAtISO; }, [frozenAtISO]);
  // D-35: the QUESTION clock's own credit, not the attempt-wide total. In 4.2b
  // this mirrored the section timer's flat offset — faithfully reproducing a
  // bug rather than questioning it.
  const frozenOffsetRef = useRef(0);
  useEffect(() => {
    frozenOffsetRef.current = creditSeconds(freezeCredits.questionMs);
  }, [freezeCredits.questionMs]);

  // ── Phase 4.1: what the SERVER holds ────────────────────────────
  //
  // questionId -> answerFingerprint of the value the server has confirmed.
  // The whole of answer durability is the gap between this and localAnswers:
  // anything present locally and absent here is at risk, and that gap is what
  // the sweep closes and the indicator reports.
  //
  // D-31 was that nothing tracked this at all. Standard mode fired a debounced
  // write and moved on; a failure logged to console and the student's screen
  // went on showing an answer the server had never received.
  const [confirmedAnswers, setConfirmedAnswers] = useState<Record<string, string>>({});
  /**
   * Set when a submit went ahead with answers still unconfirmed (B3).
   *
   * Held separately from errorMsg on purpose: errorMsg means "this did not
   * happen", and here it did. The submit succeeded and the student needs to
   * know something was lost with it, not be told the opposite.
   */
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  // Read inside the submit callback, which closes over [] — state would be
  // stale there, and this is set moments earlier in the same call.
  const saveWarningRef = useRef<string | null>(null);
  useEffect(() => { saveWarningRef.current = saveWarning; }, [saveWarning]);
  const confirmedRef = useRef<Record<string, string>>({});
  useEffect(() => { confirmedRef.current = confirmedAnswers; }, [confirmedAnswers]);

  /**
   * Fold a set of server-held answers into the confirmed map.
   *
   * Called from three places, and the redundancy is the point:
   *   • the attempt snapshot — AUTHORITATIVE, this is literally the stored doc
   *   • initial load — same, for the first paint
   *   • a successful write — optimistic, so the indicator settles immediately
   *     instead of flickering "unsaved" until the snapshot returns
   *
   * Merge, never replace. A snapshot that has not yet caught up with a write
   * we just made must not un-confirm it.
   */
  const confirmFromServer = useCallback((serverAnswers: Record<string, AttemptAnswer> | undefined) => {
    if (!serverAnswers) return;
    setConfirmedAnswers((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [qid, ans] of Object.entries(serverAnswers)) {
        const fp = answerFingerprint(ans);
        if (fp && next[qid] !== fp) { next[qid] = fp; changed = true; }
      }
      return changed ? next : prev;
    });
  }, []);

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
  /** Mirror of linearAdvancing for the answer handler, which is a stable
   *  callback and would otherwise close over a stale value (D-27). */
  const linearAdvancingRef = useRef(false);
  /** Current question id, readable from stable callbacks (D-25 flush). */
  const currentQIdRef = useRef<string | null>(null);
  /** The section on SCREEN, for violation context — see handleViolation. */
  const currentSectionIdxRef = useRef(0);
  /** Whether the student is on the final question, readable from the timer
   *  effect without re-arming it on every change (D-26). */
  const isLastQuestionRef = useRef(false);
  /**
   * Served-question id whose clock expiry has already been acted on.
   *
   * The question-timer effect re-arms whenever the attempt document changes —
   * and submitting an answer changes it. Its local `fired` flag resets, the
   * deadline is still in the past, so it fired again: save, submit, save,
   * submit. Visible as the shell flickering between "Submitting this
   * section..." and the break screen, with the break appearing frozen because
   * every re-submit re-stamped submittedAt, which is the break's anchor.
   *
   * A ref, not state: it must survive re-renders without causing one.
   */
  const questionExpiryHandledRef = useRef<string | null>(null);
  /** shellStatus readable from the timer effect without re-arming it. */
  const shellStatusRef = useRef<string>('loading');
  const [linearAdvancing, setLinearAdvancing]             = useState(false);
  const [linearError, setLinearError]                     = useState<string | undefined>();

  // ── Answer state ───────────────────────────────────────────────
  const [localAnswers, setLocalAnswers] = useState<Record<string, AttemptAnswer>>({});
  const answerTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Set when the bounded flush in handleViolation did not confirm before the
  // pre-countdown grade went out. A ref, not state, because writing it must
  // not re-render the shell mid-termination — it is read once, 30 seconds
  // later, by handleTerminate.
  const preTerminateFlushFailedRef = useRef(false);

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

  // ── In-exam code runs ──────────────────────────────────────────
  //
  // The only path where a student's action reaches the judge. Everything that
  // decides whether it may — ownership, attempt state, the answer window, the
  // per-question quota and cooldown — is enforced server-side; this is a relay.
  //
  // It does not throw for a refusal. Out of runs, cooling down, or runs turned
  // off all arrive as ok:false and are rendered as a note beside the editor,
  // because none of them is the candidate's mistake and an error mid-exam reads
  // as "the exam is broken". A genuine transport failure is caught here for the
  // same reason: a judge that cannot be reached must never look like a judge
  // that failed the code.
  const handleRunCode = useCallback(async (
    questionId: string,
    language: string,
    source: string,
  ) => {
    const att = attemptRef.current;
    if (!att) {
      return { ok: false as const, reason: 'disabled' as const, remaining: 0, retryAfterMs: 0 };
    }
    return runCodeSample({ attemptId: att.id, questionId, language, source });
  }, []);

  // ── Code telemetry ─────────────────────────────────────────────
  //
  // The sink is withheld entirely when the tier forbids recording, rather than
  // supplied and then ignored. An editor with no sink never buffers, so the
  // decision not to record a candidate is made once, here, and cannot be
  // undone further down.
  const telemetryOn = telemetryEnabled(assessment?.securityTier, assessment?.codeTelemetry);

  const handleCodeTelemetry = useCallback((
    questionId: string,
    events: unknown[],
    seq: number,
  ) => {
    const att = attemptRef.current;
    if (!att) return;
    // Not awaited. A flush must never delay a keystroke or surface an error to
    // someone sitting an exam — the wrapper swallows failures for that reason.
    void recordCodeTelemetry({ attemptId: att.id, questionId, seq, events });
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

  // ── Re-entry extension gate (covers refresh / direct URL) ──────
  //
  // The briefing page refuses entry on any injected DOM. `/shell` is a
  // SEPARATE ROUTE with no guard in routes.tsx, so every one of those refusals
  // was one address bar away from being skipped: open the briefing clean, then
  // reload the shell — or navigate straight to it — with the extension back
  // on. Nothing re-checked. The same hole is what a student walks through
  // without meaning to on an ordinary refresh, which is the far more common
  // case and the one that made this worth fixing.
  //
  // Note the shape it borrows. This is the same argument as the fullscreen
  // effect directly above: the requirement was enforced on one route, and the
  // shell is reachable without passing through it.
  //
  // WHY AN OVERLAY AND NOT A REDIRECT. A redirect to the briefing would look
  // like the honest fix and would be worse. The attempt already exists and its
  // clocks are running server-side, so bouncing a student between routes costs
  // them exam time and risks a loop if the briefing then resumes them straight
  // back here. The overlay stops interaction where they stand, states what was
  // found, and clears the moment they fix it.
  //
  // It gates rather than punishes: no violation is fired from here. The
  // watchdog is already running and reports what it sees on its own terms;
  // firing again from this effect would double-count a single extension, and
  // on a warning type that is a third of the way to a termination for one
  // reload.
  useEffect(() => {
    if (assessment?.requireExtensionCheck !== true) return;
    let cancelled = false;
    // Short settle: the shell has already been open long enough to load an
    // assessment and an attempt, so a slow-injecting extension has had its
    // beat. The briefing's full delay would leave the exam interactive while
    // it ran.
    scanForExtensionsWithSettle(300).then((result) => {
      if (cancelled) return;
      if (!extensionGateBlocks(result)) return;
      // Never displace a terminal or higher-priority overlay. A student being
      // terminated, or in a session conflict, must not have that replaced by a
      // recoverable extension prompt.
      setOverlay((current) => (current === null || current.kind === 'fullscreen_required')
        ? { kind: 'extension_required', found: [...result.named, ...result.foreign] }
        : current);
    }).catch(() => { /* a detector must never break an exam */ });
    return () => { cancelled = true; };
  }, [assessment?.requireExtensionCheck]);

  const handleRecheckExtensions = useCallback(async () => {
    const result = await scanForExtensionsWithSettle(300)
      .catch(() => ({ named: [], foreign: [] } as ExtensionScanResult));
    setOverlay((current) => {
      if (current?.kind !== 'extension_required') return current;
      return extensionGateBlocks(result)
        ? { kind: 'extension_required', found: [...result.named, ...result.foreign] }
        : null;
    });
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
            // D-33: claimed at creation, so registerSession drops out of the
            // fresh-start path below and one cold start stops being charged to
            // the student's already-running clocks.
            sessionId: localSessionId.current,
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
        // ── D-33: everything from here is CHARGED TO THE STUDENT ────
        //
        // startExam stamps startedAt, the first section's startedAt and the
        // first question's servedAt from one `nowIso` inside its transaction.
        // The moment it returns, the section clock, the overall clock and the
        // 30-second question clock are all running — while the student is
        // still looking at "Preparing your exam…".
        //
        // This stretch used to be TWO sequential callables. In Functions Gen2
        // each one is its own Cloud Run service with its own bundle, and
        // EXAM_HOT_PATH deliberately sets minInstances: 0, so on a quiet
        // project both start cold: roughly 8s each, ~16s of a 35s first
        // question gone before it appears. Under a real cohort it is worse,
        // not better — the burst is exactly what makes handlers slow.
        //
        // Two changes, no clock semantics touched:
        //
        //   1. registerSession is SKIPPED on a fresh start. startExam already
        //      stamped activeSessionId with the id we passed it, so a second
        //      call would re-claim a session we already own. It still runs on
        //      RESUME, where the attempt carries a previous device's id and
        //      this browser genuinely has to take over.
        //   2. Whatever remains runs alongside getExamQuestions rather than
        //      after it. They share no data — registerSession needs only
        //      att.id, which exists the instant startExam returns.
        //
        // Ordering is safe today: getExamQuestions sends no sessionId at all,
        // so it cannot race the claim. It is safe TOMORROW too, which was not
        // true before — with the claim now made inside startExam, flipping
        // REQUIRE_SESSION_ID to true no longer breaks this path.
        const needsSessionClaim = att.activeSessionId !== localSessionId.current;

        const [paper] = await Promise.all([
          getExamQuestionsForStudent(a.id, 'exam'),
          // Fails soft internally — a session claim must never stop a student
          // sitting an exam — so its rejection cannot poison the Promise.all
          // and lose the paper alongside it.
          needsSessionClaim
            ? registerSession(att.id, localSessionId.current)
            : Promise.resolve(),
        ]);

        const qMap = new Map<string, Question>();
        const wanted = new Set(allQIds);
        paper.questions.forEach((q) => { if (wanted.has(q.id)) qMap.set(q.id, q); });

        // Stimulus, keyed by group id. Not filtered against `wanted`: the
        // server only returns groups referenced by this paper's questions.
        const gMap = new Map<string, ExamQuestionGroup>();
        paper.groups.forEach((g) => gMap.set(g.id, g));

        // 5. Build marks map
        const mMap = new Map<string, number>();
        effSections.forEach((s) => {
          s.questions.forEach((aq) => mMap.set(aq.questionId, aq.marks));
        });

        // The session claim happened above — inside startExam on a fresh
        // start, or alongside getExamQuestions on a resume. Takeover semantics
        // are unchanged: the joining device wins, the snapshot listener on the
        // older device sees the mismatch and locks.

        // Sync initial freeze state (including accumulated paused time so the
        // timer resumes fairly, and the current freeze instant so it stays paused)
        setTotalFrozenSeconds(att.totalFrozenSeconds ?? 0);
        setFreezeCredits(att.freezeCredits
          ?? { overallMs: 0, sectionMs: 0, questionMs: 0, breakMs: 0 });
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
        // Phase 4.1: seed confirmations from what the server already holds, so
        // a resumed sitting does not open reporting every prior answer unsaved.
        confirmFromServer(att.answers);
        setQuestionMap(qMap);
        setGroupMap(gMap);
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
          const localBrk = breakAfterCompletion(a.sections, att.sectionIds, completedCount);

          // ── Phase 3e: the SERVER decides whether a break is running ──
          //
          // breakAfterCompletion is a labelled client MIRROR of the function
          // in functions/src/index.ts, and on this path it was the only thing
          // deciding whether to show a break screen — the D-14 shape, where
          // one rule exists in two places and nothing forces them to agree.
          //
          // The verdict endpoint answers from the same resolver the server
          // enforces with, so it wins when reachable. The mirror stays as the
          // FALLBACK rather than being deleted: a resume that cannot reach the
          // endpoint must still put the student somewhere sensible, and a
          // student stranded on a blank screen is a worse outcome than a
          // duplicated rule that the server independently re-checks anyway.
          //
          // jitter off deliberately — this is a blocking load, not a
          // synchronised countdown burst, so spreading it only adds latency.
          const vres = await getExamVerdict(att.id, { jitter: false });
          const svrBreak = vres && vres.verdict.kind === 'break' ? vres.verdict : null;

          if (vres && !svrBreak && localBrk) {
            console.warn('[ExamShell] break mirror disagrees with server verdict',
              { local: localBrk, verdict: vres.verdict.kind });
          }

          // Server reachable -> trust it. Unreachable -> fall back to the mirror.
          const brk = vres ? (svrBreak ? localBrk : null) : localBrk;
          const endsAt = svrBreak
            ? svrBreak.endsAt
            : brk
              ? new Date(curTiming.submittedAt).getTime() + brk.durationMinutes * 60 * 1000
              : 0;
          if (brk) {
            // Shared builder (Phase 0.1) — same function the in-session
            // transition uses, so a break cannot read as live on one path and
            // elapsed on the other. Handles both cases: still running, or
            // already over (in which case it comes back non-mandatory so the
            // Continue click goes straight through).
            if (endsAt <= Date.now() && isChoice) {
              setShellStatus('choosing_section');
              return;
            }
            setBreakState(buildBreakState({
              submittedAtIso: curTiming.submittedAt,
              durationMinutes: brk.durationMinutes,
              mandatory: brk.mandatory,
              sectionId: curSec.id,
              sectionName: curSec.name,
              isChoice,
              nextSectionId: nextSec.id,
              nextSectionIdx: att.currentSectionIdx + 1,
              nextSectionName: nextSec.name,
              breakCreditMs: att.freezeCredits?.breakMs ?? 0,
            }));
            setShellStatus('on_break');
            return;
          }
          if (isChoice) {
            setShellStatus('choosing_section');
            return;
          }
          // No break configured, but the server force-paused one an older
          // bundle didn't schedule. Show the expired break screen so the
          // Continue click (a real gesture, needed for fullscreen re-entry)
          // drives endBreak → startSection.
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
      // Phase 4.1: the stored doc IS the definition of "saved". Reconciling
      // here means the indicator self-heals no matter WHY client and server
      // diverged — a failed write, a dropped acknowledgement, or a bug we have
      // not found. It never needs to know the cause.
      confirmFromServer(live.answers);
      setTotalFrozenSeconds(live.totalFrozenSeconds ?? 0);
      setFreezeCredits(live.freezeCredits
        ?? { overallMs: 0, sectionMs: 0, questionMs: 0, breakMs: 0 });
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

  // ── Grouped-set context for the current question (Phase 1) ──────
  // The stimulus to show beside it, and where it sits within its set.
  //
  // The position is computed from the SERVED ORDER rather than the question's
  // stored groupOrder, because the two can disagree: a rule may draw 3 of a
  // set's 8 children, so the paper's members carry positions 0,1,2 while the
  // authored set numbered them differently. What a candidate needs to read is
  // "question 2 of 3 in this set" — the set as it appears on THEIR paper.
  const currentGroup = currentQuestion?.groupId
    ? groupMap.get(currentQuestion.groupId) ?? null
    : null;

  const currentGroupPosition = useMemo(() => {
    if (!currentQuestion?.groupId || !currentQId) return null;
    const siblings = currentSectionQIds.filter(
      (qid) => questionMap.get(qid)?.groupId === currentQuestion.groupId,
    );
    const idx = siblings.indexOf(currentQId);
    if (idx < 0 || siblings.length === 0) return null;
    return { index: idx + 1, total: siblings.length };
  }, [currentQuestion, currentQId, currentSectionQIds, questionMap]);

  // Lookup maps the navigator needs to band grouped runs. Derived rather than
  // stored so they cannot drift from questionMap/groupMap.
  const groupIdByQuestion = useMemo(() => {
    const out: Record<string, string | null | undefined> = {};
    currentSectionQIds.forEach((qid) => { out[qid] = questionMap.get(qid)?.groupId; });
    return out;
  }, [currentSectionQIds, questionMap]);

  const groupKindById = useMemo(() => {
    const out: Record<string, GroupKind> = {};
    groupMap.forEach((g, id) => { out[id] = g.kind; });
    return out;
  }, [groupMap]);

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
  // ── D-26: recognise the last question BEFORE the student leaves it ──
  //
  // This used to be `linearSectionComplete`, which the SERVER only reports
  // once the student has already advanced PAST the final question. So the
  // button read "Save & next" on the last question, the student clicked it,
  // nothing appeared to happen, and only then did a separate "Submit section"
  // button show up. Two actions for one intent, and on a timer expiry the
  // section just sat there until the section clock caught up.
  //
  // questionOrder holds the section's full ordered list and is on the attempt
  // already. Using its LENGTH reveals nothing — knowing a section has five
  // questions is not knowing what they are, which is why the display still
  // draws from servedQuestions. Falls back to the server's flag when
  // questionOrder is missing, so nothing regresses on an older attempt.
  const linearOnFinalQuestion = useMemo(() => {
    if (!isLinear || !attempt || !currentSection || !currentQId) return false;
    const order = attempt.questionOrder?.[currentSection.id] ?? [];
    if (order.length === 0) return false;
    return order.indexOf(currentQId) === order.length - 1;
  }, [isLinear, attempt, currentSection, currentQId]);

  const isLastQuestion = isLinear
    ? (linearSectionComplete || linearOnFinalQuestion)
    : currentQIdx >= currentSectionQIds.length - 1;
  isLastQuestionRef.current = isLastQuestion;

  // ── Count unanswered in current section ─────────────────────────

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
    // NOT a ternary over the engines this file happens to remember. That is
    // what this was, and the missing arm sent every coding answer to storage
    // typed as 'match' — see answerTypeForEngine in itemTypes.ts.
    const type = answerTypeForEngine(q.engine);
    const answer: AttemptAnswer = {
      type,
      value,
      answeredAt: new Date().toISOString(),
      sectionId,
    };

    // ── D-27: refuse edits while an answer is in flight ────────────
    // submitAnswerAndAdvance takes a couple of seconds, and the inputs stayed
    // live for all of it — so a student could change their selection AFTER the
    // answer had already been sent. The sent one counts; the screen showed the
    // other. Whichever way that resolves, the student has been misled about
    // what they submitted, which is worse than the wait itself.
    if (linearAdvancingRef.current) return;

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
        // Phase 4.1: optimistic confirmation. The snapshot will assert the same
        // thing shortly, but waiting for it would flash "1 unsaved" after every
        // successful keystroke.
        setConfirmedAnswers((prev) => ({ ...prev, [questionId]: answerFingerprint(answer) }));
      } catch (e) {
        // Deliberately NOT retried here (B2). The 20-30s sweep re-sends
        // anything still unconfirmed, and it self-heals regardless of WHY
        // client and server diverged — a failed write, a lost acknowledgement,
        // or a bug not yet found. A per-write retry only fixes the first of
        // those, and adds a second retry policy to keep in step with this one.
        //
        // What changed from D-31 is not the logging, it is that the failure is
        // now VISIBLE: the fingerprint stays unconfirmed, so the indicator
        // reports it and the sweep will act on it.
        console.error('[ExamShell] saveAnswer failed (left unconfirmed for sweep)', e);
      }
      answerTimersRef.current.delete(questionId);
    }, 1500);
    answerTimersRef.current.set(questionId, timer);
  }, [questionMap, currentSection]);

  // ══════════════════════════════════════════════════════════════════
  // PHASE 4.1 — ANSWER DURABILITY  (D-31)
  //
  // Three layers, one mechanism (B2):
  //
  //   per change   1.5s debounce, in handleAnswer above  — primary
  //   sweep        every 25s, ONLY when something is unconfirmed — backstop
  //   page hide    tab closing — last push
  //
  // Freeze is a fourth trigger on the same machinery, not a separate feature
  // (B5); flushAnswers is already wired into the freeze effect.
  //
  // Deliberately NOT offline persistence (B4). It would survive a browser
  // restart, but it also parks the question paper and the student's answers in
  // storage on their own machine. On a high-stakes exam that is a leak
  // surface, and retry-and-flush gets most of the benefit without it.
  // ══════════════════════════════════════════════════════════════════

  /**
   * Answers the student can see that the server has not confirmed.
   *
   * Empty answers never count: nothing selected is nothing at risk. In
   * sequential delivery this is 0 or 1, because everything before the open
   * question is locked server-side and therefore confirmed by definition.
   */
  const unsavedCount = useMemo(() => {
    let n = 0;
    for (const [qid, ans] of Object.entries(localAnswers)) {
      const fp = answerFingerprint(ans);
      if (!fp) continue;
      if (confirmedAnswers[qid] !== fp) n += 1;
    }
    return n;
  }, [localAnswers, confirmedAnswers]);

  const unsavedCountRef = useRef(0);
  useEffect(() => { unsavedCountRef.current = unsavedCount; }, [unsavedCount]);

  // Flush all pending answer saves immediately — as ONE write. The previous
  // version fired one updateDoc per answered question in parallel against the
  // same attempt doc, which caused heavy write contention (aborted/retried
  // commits) exactly at submit time on long papers.
  /**
   * Commit the one uncommitted answer in sequential delivery (D-25).
   *
   * Only fires when there is something to lose: a served question that is
   * still UNLOCKED (so the server has not recorded an answer for it) and a
   * local selection to send. Anything else is a no-op, so this is safe to call
   * on every submit path including the ordinary ones.
   *
   * Bounded by a timeout. This runs inside the expiry path now, and a slow
   * network must not be able to hang a student's section submit — losing one
   * answer is bad, failing to submit at all is worse.
   */
  const flushSequentialCurrent = useCallback(async () => {
    const att = attemptRef.current;
    const qid = currentQIdRef.current;
    if (!att || !qid || linearAdvancingRef.current) return;

    const entry = (att.servedQuestions ?? []).find((sq) => sq.questionId === qid);
    if (!entry || entry.locked === true) return;      // already committed

    const ans = localAnswersRef.current[qid];
    if (!ans || isAnswerEmpty(ans)) return;           // nothing selected

    try {
      await Promise.race([
        submitAnswerAndAdvance({
          attemptId: att.id,
          questionId: qid,
          answer: { type: ans.type, value: ans.value as unknown },
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
      ]);
    } catch (e) {
      console.error('[ExamShell] final sequential answer flush failed', e);
    }
  }, []);

  const flushAnswers = useCallback(async () => {
    for (const [, timer] of answerTimersRef.current) clearTimeout(timer);
    answerTimersRef.current.clear();

    const att = attemptRef.current;
    if (!att) return;

    // ── D-25 / Phase 4.2: the CURRENT sequential answer ─────────────
    //
    // In linear/adaptive, answers reach the server only through a callable —
    // a direct client write is rejected by rules. This function used to RETURN
    // here, which was correct for every question the student had already
    // advanced past and WRONG for the one in front of them: their selection
    // lived only in localAnswers and was discarded the moment the section or
    // overall clock expired, or a paused tab was closed.
    //
    // It could not simply call flushSequentialCurrent(), and the old comment
    // here explained why: that helper uses submitAnswerAndAdvance, which does
    // not merely save — it LOCKS the question and SERVES the next one.
    // flushAnswers also runs the instant a FREEZE lands, and moving a student
    // you have just paused past their question would be a worse bug than the
    // one being fixed. So the honest options were "lose the answer" or
    // "advance the frozen student", and it chose the first.
    //
    // Phase 4.2 removes the dilemma instead of picking a side.
    // saveAnswerNoAdvance persists the selection and does nothing else, so the
    // freeze path can finally satisfy FREEZE_AND_ROADMAP A2 step 1 ("their
    // answer is saved") without advancing anyone.
    //
    // NO DOUBLE WRITE on the submit paths. Both of them call
    // flushSequentialCurrent() first, which locks the question; the
    // `entry.locked` guard below then makes this a no-op. The two are
    // complementary, not redundant.
    //
    // Still bounded by a timeout: losing one answer is bad, hanging a submit
    // or a freeze is worse.
    const dMode = att.securityConfig?.deliveryMode;
    if (dMode === 'linear' || dMode === 'adaptive') {
      const qid = currentQIdRef.current;
      if (!qid || linearAdvancingRef.current) return;

      const entry = (att.servedQuestions ?? []).find((sq) => sq.questionId === qid);
      if (!entry || entry.locked === true) return;      // already committed

      const ans = localAnswersRef.current[qid];
      if (!ans || isAnswerEmpty(ans)) return;           // nothing selected

      // CONTAINED, unlike the standard-mode branch below — and the asymmetry
      // is deliberate.
      //
      // flushAnswers runs inside doSectionSubmit and the final submit, whose
      // catch blocks the submit and shows an error on anything that is not a
      // closed answer window. That is right for standard mode, where this call
      // is the ONLY thing carrying the answers. It is wrong here: both submit
      // paths already ran flushSequentialCurrent, so reaching this line means
      // that one had already failed, and a second 6s timeout on top would
      // strand a student whose SECTION CLOCK JUST EXPIRED behind an error
      // screen. Failing to submit is worse than losing one answer — the same
      // trade flushSequentialCurrent makes, for the same reason.
      //
      // This is not a licence to fail silently (D7). Making an unconfirmed
      // answer VISIBLE and RETRYABLE is Phase 4.1's whole job, and it needs
      // the tracking layer to do it properly. Doing half of it here, by
      // blocking submits, would be worse than waiting.
      try {
        const res = await Promise.race([
          saveAnswerNoAdvance({
            attemptId: att.id,
            questionId: qid,
            answer: { type: ans.type, value: ans.value as unknown },
          }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
        ]);
        // Only on `saved: true`. A no-op response means the server wrote
        // nothing, and calling that confirmed would be exactly the lie D-31
        // was (Phase 4.1).
        if (res && res.saved) {
          setConfirmedAnswers((prev) => ({ ...prev, [qid]: answerFingerprint(ans) }));
        }
      } catch (e) {
        console.error('[ExamShell] sequential answer flush (no-advance) failed', e);
      }
      return;
    }

    // Standard delivery: one write carrying every answer, then confirm the
    // lot. Deliberately sends ALL of them rather than only the unconfirmed —
    // it is a single updateDoc either way, and on a submit path the safest
    // payload is the complete one. The SWEEP is where being selective matters,
    // and it is selective by only running at all when something is unconfirmed
    // (B2).
    const snapshot = { ...localAnswersRef.current };
    await saveAnswers(att.id, snapshot);
    setConfirmedAnswers((prev) => {
      const next = { ...prev };
      for (const [qid, ans] of Object.entries(snapshot)) {
        const fp = answerFingerprint(ans);
        if (fp) next[qid] = fp;
      }
      return next;
    });
  }, []);

  // ── Layer 2: the conditional sweep ──────────────────────────────
  //
  // CONDITIONAL IS THE WHOLE DESIGN (B2). Firing regardless would re-send
  // answers that already landed — pure cost, multiplied by the cohort. Firing
  // only on a gap makes it free in the normal case and a genuine net when it
  // is not.
  //
  // 25s, not minutes: no answer should sit unconfirmed for longer than about
  // half a minute. And the per-change save stays primary — a sweep alone would
  // mean routinely holding answers in the browser for 25 seconds, which is
  // worse than what shipped.
  useEffect(() => {
    const iv = setInterval(() => {
      if (unsavedCountRef.current === 0) return;           // free when all is well
      if (shellStatusRef.current !== 'ready') return;      // mid-submit or on a break
      if (submittingRef.current) return;
      if (isFrozenRef.current) return;                     // the freeze flush owns this
      void flushAnswers().catch((e) => {
        console.error('[ExamShell] durability sweep failed', e);
      });
    }, 25_000);
    return () => clearInterval(iv);
  }, [flushAnswers]);

  // ── Layer 3: the page is going away ─────────────────────────────
  //
  // BEST EFFORT, and honestly so. A Firestore write cannot be guaranteed to
  // leave the tab during teardown — sendBeacon is the only thing that can, and
  // it cannot speak the Firestore protocol. Not awaited, because nothing will
  // await it.
  //
  // pagehide AND visibilitychange: pagehide is the reliable one on desktop,
  // while an app switch on mobile often only ever fires visibilitychange. The
  // flush is idempotent, so firing on both costs nothing.
  useEffect(() => {
    const push = () => {
      if (unsavedCountRef.current === 0) return;
      void flushAnswers().catch(() => {});
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') push(); };
    window.addEventListener('pagehide', push);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', push);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flushAnswers]);


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
    linearAdvancingRef.current = true;
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
      linearAdvancingRef.current = false;
    }
  }, [currentQId, linearAdvancing, currentSection]);

  // A new section starts fresh (not complete).
  useEffect(() => { setLinearSectionComplete(false); }, [currentSectionIdx]);

  // Clear any advance error once the student is on a new question.
  useEffect(() => {
    setLinearError(undefined);
    currentQIdRef.current = currentQId ?? null;
  }, [currentQId]);

  useEffect(() => { currentSectionIdxRef.current = currentSectionIdx; }, [currentSectionIdx]);

  useEffect(() => { shellStatusRef.current = shellStatus; }, [shellStatus]);

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

  // Grace is part of the deadline (R1), and it is the SAME number the server
  // uses. D-14: the server allowed qLimit + 5s while this allowed qLimit + 0,
  // so the client auto-advanced five seconds before the server would even flag
  // the answer late — the student lost five seconds of every question to a
  // disagreement between two copies of one rule.
  const questionGraceSeconds =
    assessment?.questionGraceSeconds ?? DEFAULT_QUESTION_GRACE_SECONDS;

  useEffect(() => {
    // `isLastQuestion` was in this guard, so the final question of EVERY
    // section was untimed — the one place a student could sit indefinitely.
    // It is now treated exactly like any other: the clock runs, and on expiry
    // handleLinearNext advances, which for the last question completes the
    // section. That is what the timing spec asks for and what the resolver
    // already does server-side.
    if (!questionTimeLimit || !currentServedAt) {
      setQSecondsLeft(null);
      return;
    }
    // ── D-32: this clock has to respect a freeze, in BOTH halves ────
    //
    // It was the one expiry path with no freeze guard. Its three siblings —
    // handleSectionTimerExpire, handleOverallTimerExpire and the expiredClock
    // sweep — all check isFrozenRef; this one checked only shellStatus, and
    // freeze does not touch shellStatus (there is no 'frozen' member of the
    // ShellStatus union; isFrozen is a separate flag that drives the overlay).
    //
    // So while a paused student sat behind a blocking overlay, unable to
    // answer anything (handleAnswer rejects input while frozen), this tick
    // kept firing, calling handleLinearNext() — which LOCKS the question and
    // serves the next one. On the last question of a section it then called
    // doSectionSubmit('time_expired') directly, walking straight past
    // handleSectionTimerExpire's guard. Observed on a real sitting: 16 of 20
    // questions served after the freeze, two whole sections started AND
    // submitted, one answer recorded. The pause meant to protect a student
    // consumed their paper instead.
    //
    // GUARDING ALONE IS NOT ENOUGH. The deadline used to be a fixed instant
    // (servedAt + limit + grace), so it elapses during the pause and `left`
    // is already <= 0 the moment the student is released — the guard lifts and
    // the question expires instantly. The pause must come OUT of the clock,
    // which is the same thing SectionTimer already does: pin the elapsed
    // reference at the freeze instant, then credit accumulated paused time.
    //
    // Mirrored deliberately rather than reinvented. totalFrozenSeconds is
    // GRANTED time, not elapsed — unfreezeAttempt derives it from the ledger's
    // sum of grantedMs — so this credits exactly what the invigilator decided,
    // and the question clock agrees with the section clock instead of becoming
    // a second opinion. A grant of zero therefore does expire the question on
    // release; that is the decision being applied, not a bug, though telling
    // the student it happened belongs to the notice work in step 3.
    //
    // nowFn, not Date.now: the section and overall clocks are skew-corrected
    // and this one was not. Same rule, two implementations, which is the shape
    // D-14 already cost five seconds a question.
    const servedMs  = Date.parse(currentServedAt);
    const budgetSec = questionTimeLimit + questionGraceSeconds;
    let fired = false;
    const tick = () => {
      const refNow = (isFrozenRef.current && frozenAtRef.current)
        ? Date.parse(frozenAtRef.current)
        : nowFn();
      const elapsedSec = (refNow - servedMs) / 1000 - frozenOffsetRef.current;
      const left = Math.max(0, Math.ceil(budgetSec - elapsedSec));
      setQSecondsLeft(left);
      if (left <= 0 && !fired) {
        // Once per question, and only while the exam is actually running. On a
        // break or mid-submit, shellStatus is not 'ready' and there is nothing
        // to expire.
        if (shellStatusRef.current !== 'ready') return;
        // Paused by an invigilator: do not advance, do not submit. Returning
        // WITHOUT setting `fired` is deliberate — the question must still be
        // able to expire normally once the student is released.
        if (isFrozenRef.current) return;
        if (questionExpiryHandledRef.current === currentQIdRef.current) return;
        questionExpiryHandledRef.current = currentQIdRef.current;
        fired = true;
        // D-26: on the LAST question, save AND close the section.
        //
        // This called handleLinearNext() alone, which commits the answer and
        // stops — so the student sat on a finished section watching the
        // section clock run down with nothing left to do. The spec is explicit
        // (Assignment-Timers-Explained §9): the last question's clock running
        // out is the section running out.
        //
        // Sequenced, not fired in parallel: doSectionSubmit must see the
        // answer already committed, or it races its own flush.
        void (async () => {
          await handleLinearNext();
          if (isLastQuestionRef.current) await doSectionSubmit('time_expired');
        })();
      }
    };
    tick();
    const iv = setInterval(tick, 500);
    return () => clearInterval(iv);
  }, [questionTimeLimit, currentServedAt, questionGraceSeconds, handleLinearNext, nowFn]);

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
    // Backstop against a re-entrant submit. submitSection re-stamps
    // submittedAt, and that timestamp is the BREAK's anchor — so submitting a
    // section that is already closed pushes the break end forward and the
    // student watches a break clock that never moves. Belt and braces
    // alongside the one-shot guard on the question timer.
    if (att.sectionTimings?.[currentSection.id]?.submittedAt) return;
    submittingRef.current = true;

    // D-25: commit the one uncommitted sequential answer before anything
    // closes. No-op in standard delivery and no-op when nothing is pending,
    // so it is safe on the ordinary path as well as on expiry.
    await flushSequentialCurrent();

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
      // Window closed -> keep going. The submit itself runs through
      // submitSection (Admin SDK, rules do not apply), so the section can
      // still be closed out properly even though this last write was refused.
      // ── B3: NEVER BLOCK SUBMISSION ON UNSAVED ANSWERS ───────────
      //
      // This used to abort the section submit and show an error screen. The
      // intent was protective — do not grade a stale snapshot — but the effect
      // was worse than the problem: a student whose section clock had just run
      // out was stranded behind an error, unable to move on, while the server
      // went on refusing their writes anyway.
      //
      // Try hard, warn clearly, submit anyway. "Try hard" is now real rather
      // than aspirational: by this point the answer has been through a 1.5s
      // debounced write, a 25s sweep, a page-hide flush and this final flush.
      // If it still has not landed, one more error screen will not land it.
      //
      // The warning is NOT swallowed — saveWarning surfaces after the submit,
      // and unsavedCount stays visible in the top bar throughout.
      submittingRef.current = true;
      if (!isAnswerWindowClosed(e)) {
        console.error('[ExamShell] flush before section submit failed — submitting anyway (B3)', e);
        setSaveWarning('Some answers could not be sent before this section closed. Your section has been submitted; please tell your invigilator.');
      } else {
        console.warn('[ExamShell] answer window closed before section submit — submitting anyway');
      }
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
      // AUTHORITATIVE submit time (Phase 0.1). submitSection clamps this to the
      // section's true deadline when the submit arrives late, so on a
      // return-from-away it is far in the past and the break is correctly
      // already over. Using Date.now() here — which is what this did — handed
      // the student a fresh break starting the moment they walked back, and
      // made an hours-overdue mandatory break block them for its full duration.
      //
      // One extra read, only on section transitions that actually have a
      // break. Falls back to the local clock only if the read fails, which
      // reproduces the old behaviour rather than stranding the student.
      let submittedAtIso = new Date().toISOString();
      try {
        const fresh = await getAttempt(att.id);
        const serverIso = fresh?.sectionTimings?.[sectionId]?.submittedAt;
        if (serverIso) submittedAtIso = serverIso;
      } catch {
        console.warn('[ExamShell] could not read authoritative submittedAt; using local clock');
      }
      const submittedAtMs = new Date(submittedAtIso).getTime();
      setBreakState(buildBreakState({
        submittedAtIso,
        durationMinutes: breakCfg.durationMinutes,
        mandatory: breakCfg.mandatory,
        sectionId,
        sectionName: currentSection.name,
        isChoice: isStudentChoice,
        nextSectionId: nextSection.id,
        nextSectionIdx: nextIdx,
        nextSectionName: nextSection.name,
        breakCreditMs: attemptRef.current?.freezeCredits?.breakMs ?? 0,
      }));
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
    // D-36: never leave a break while paused. BreakScreen's countdown is now
    // frozen too, so this should be unreachable from the auto-continue — but
    // this is the function that actually MOVES a student, and the cost of a
    // second guard here is one comparison.
    if (isFrozenRef.current) return;
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

      // ── Phase 0.3 (2026-07-31) ────────────────────────────────
      // 'Section already started' is NOT a failure — it means a previous
      // click already started this section server-side and the client never
      // got to record it (a crash, a lost response, a double click). The
      // section IS running; the only correct move is to fall through and
      // enter it. Treating it as a refusal left the student on a dead break
      // screen forever, because the condition can never clear: the section
      // stays started, so every retry hits the same refusal. Reported live as
      // "stuck at Continue to Section B".
      const alreadyStarted = msg.includes('Section already started');

      // A genuinely un-elapsed mandatory break is the ONE case where staying
      // put is right — the countdown is still running and will retry.
      if (!alreadyStarted && msg.includes('Mandatory break')) {
        return;
      }

      if (!alreadyStarted) {
        // Previously this also swallowed any 'failed-precondition', which hid
        // 'Attempt is not in progress' and every future refusal behind the
        // same silent no-op. Anything unrecognised now surfaces instead of
        // stranding the student without a message.
        setErrorMsg(
          msg.includes('not in progress')
            ? 'This attempt is no longer active. Reload to see your result.'
            : 'Could not start the next section. Check your connection and try again.',
        );
        setShellStatus('error');
        return;
      }
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

    // D-25: commit the one uncommitted sequential answer before anything
    // closes. No-op in standard delivery and no-op when nothing is pending,
    // so it is safe on the ordinary path as well as on expiry.
    await flushSequentialCurrent();
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
      // Same reasoning as the section flush: a closed window must not block
      // finalising. gradeAttempt is a callable and is unaffected by the rule.
      // B3, same rule as the section path above: a failed flush must not stop
      // a student finalising. Refusing to submit does not rescue the answer —
      // it only adds "and the exam never submitted" to "an answer was lost".
      //
      // gradeAttempt failing is a DIFFERENT matter and still blocks, correctly:
      // that one means the sitting genuinely did not finalise, which is
      // recoverable by retrying. See its own catch below.
      submittingRef.current = true;
      if (!isAnswerWindowClosed(e)) {
        console.error('[ExamShell] flush before final submit failed — submitting anyway (B3)', e);
        const w = 'Some answers could not be sent before submission. Your exam has been submitted; please tell your invigilator.';
        saveWarningRef.current = w;   // same tick as navigate — the effect has not run yet
        setSaveWarning(w);
      } else {
        console.warn('[ExamShell] answer window closed before final submit — submitting anyway');
      }
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
    // B3: carry the unsent-answer warning ACROSS the navigation. Set on this
    // page it would render for a few milliseconds and then be destroyed with
    // the shell — a warning nobody can see is the same silence D-31 was.
    // Router state survives the hop and dies on refresh, which is right: it
    // describes this submission, not the attempt.
    navigate(`/student/exam/${assessmentId}/results`, {
      replace: true,
      ...(saveWarningRef.current ? { state: { saveWarning: saveWarningRef.current } } : {}),
    });
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

    // ── Where the student was ─────────────────────────────────────
    //
    // Attached HERE rather than in each detector, and that is the point: every
    // detector in the shell reports through this one handler, so a detector
    // added later carries the same context without knowing it exists. The
    // alternative — each detector supplying its own — is how "consistent
    // payloads" decays into four different shapes.
    //
    // Read from refs, because this callback is not re-created as the student
    // moves through the paper and the position must be the one at the instant
    // the violation fired, not the one when the handler was built.
    //
    // The section index is the SHELL's, not the attempt document's: during a
    // transition the document lags the screen by a round trip, and what a
    // reviewer needs is where the student was looking. Server-side these ids
    // are checked against the attempt's own paper before being stored.
    const sectionIdx = currentSectionIdxRef.current;
    const questionId = currentQIdRef.current ?? undefined;
    const sectionId = att.sectionIds?.[sectionIdx];
    const qIdx = questionId && sectionId
      ? (att.questionOrder?.[sectionId] ?? []).indexOf(questionId)
      : -1;
    const context = {
      ...(questionId ? { questionId } : {}),
      ...(sectionId ? { sectionId } : {}),
      ...(qIdx >= 0 ? { questionNumber: qIdx + 1 } : {}),
      ...(sectionIdx >= 0 ? { sectionNumber: sectionIdx + 1 } : {}),
    };

    // Log to Firestore, and BELIEVE WHAT COMES BACK.
    //
    // The server counts warnings itself, from counters only it can write, and
    // returns both the running total and its own threshold verdict. Until now
    // that reply was discarded and termination was decided purely from
    // `warningCountRef` — a number living in client memory, which is the one
    // place a student with devtools can reach. `enforceIntegrityThreshold`
    // caught the divergence, but only at RESUME: a student who patched the
    // local counter and never reloaded finished the sitting untouched, with
    // the true count sitting in the server log unread.
    //
    // It is not only a tampering hole. `warningCount` is `useState(0)` and the
    // shell remounts on every reload, so two warnings followed by a refresh
    // honestly reset the count to zero. Adopting the server's total repairs
    // that case too, and that is the case that actually happens.
    //
    // The local count is kept as the floor, not replaced: it is incremented
    // before this await and is correct for the violation in flight even if the
    // call fails or the callable is mid-deploy (logViolation fails soft and
    // returns {}). So the two are combined, never swapped.
    const verdict = await logViolation(
      att.id, type, detail, isWarningType ? newWarningCount : undefined,
      { skipEventDetail, context },
    ).catch((e) => {
      console.error('[ExamShell] logViolation failed', e);
      return {} as { warnings?: number; thresholdReached?: boolean };
    });

    if (isWarningType && typeof verdict.warnings === 'number'
        && verdict.warnings > newWarningCount) {
      newWarningCount = verdict.warnings;
      setWarningCount(newWarningCount);
      warningCountRef.current = newWarningCount;
    }
    // The server's own verdict, not a re-derivation of it from the count it
    // sent. If the two ever disagree the threshold belongs to the side that
    // owns the counters.
    const thresholdReached = verdict.thresholdReached === true
      || newWarningCount >= MAX_WARNINGS;

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

    if (!isWarningType) return; // Non-warning types are logged but don't show overlay

    // ── Why fullscreen_exit is no longer skipped up here ──────────
    //
    // This used to read `if (type === 'fullscreen_exit') return;` ABOVE the
    // threshold check below, to avoid stacking a warning card on top of the
    // fullscreen_required overlay that onFullscreenChange raises. The comment
    // said termination was "owned by handleViolation" — and this return is
    // what stopped it from ever happening.
    //
    // fullscreen_exit IS one of the three WARNING_VIOLATION_TYPES, so every
    // exit incremented the count and pushed the counters up server-side, and
    // then left before the block that acts on them. onFullscreenChange doesn't
    // cover for it either: it only raises its overlay while the count is BELOW
    // the maximum, so the third exit produced no warning card, no final
    // warning, and no termination. A student could leave fullscreen without
    // limit — the one deterrent this whole gate exists to enforce — and the
    // only thing that ever caught up with them was enforceIntegrityThreshold
    // at resume, which needs a reload they had no reason to perform.
    //
    // So the skip now applies ONLY below the threshold, which is the case it
    // was actually written for.
    if (thresholdReached) {
      // Server-authoritative: finalize the attempt BEFORE the 30-second overlay
      // countdown so killing the tab can't dodge termination. This goes through
      // gradeAttempt (Cloud Function, admin SDK) because student-side writes to
      // `status` are — correctly — denied by the tightened Firestore rules.
      //
      // ── Audit 2026-08-06: FLUSH FIRST, BUT BOUNDED ──────────────
      //
      // This used to call gradeAttempt with no flush at all, and the answer
      // sitting in the 1.5s autosave debounce at the instant of the third
      // violation was lost. Not as a race — deterministically.
      //
      // The reason it was deterministic is the SECOND grade. handleTerminate
      // runs after the countdown, flushes, and calls gradeAttempt again — but
      // that second call is an idempotent NO-OP ("a non-grader may never
      // re-finalise a finished attempt", index.ts). The attempt was finalised
      // here, 30 seconds earlier. So the flush down there wrote answers into
      // an already-graded document: saved, and never marked. The terminated
      // overlay then told the student their answers had been submitted, which
      // was true of the write and false of the marking.
      //
      // WHY NOT JUST AWAIT THE FLUSH. Because the unflushed grade is not an
      // oversight — it is the whole point of grading here rather than after
      // the countdown. A student who sees the final warning and kills the tab
      // must still be terminated. Awaiting an unbounded flush reopens exactly
      // that hole: a dead network hangs the promise and the attempt is never
      // finalised at all.
      //
      // So: race the flush against a timeout, then grade either way. The
      // dodge window goes from 0 to at most 1.5s, and the answer survives in
      // every case that isn't already a network failure. 1.5s rather than the
      // 6s used elsewhere in this file because this budget is paid before a
      // TERMINATION lands, not before a submit the student is waiting on.
      //
      // `.finally` not `.then` — a rejected or timed-out flush must still
      // grade. Losing the answer is bad; failing to terminate is the thing
      // this call exists to prevent.
      const attemptId = att.id;
      void (async () => {
        // Which of the three outcomes we got matters, so the race resolves a
        // TAG rather than just settling. A bare `.catch` would not see the
        // timeout at all — the timer resolves, it does not reject.
        const outcome = await Promise.race([
          flushAnswers().then(() => 'flushed' as const).catch(() => 'failed' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1500)),
        ]);
        if (outcome !== 'flushed') {
          // Recorded, not acted on. handleTerminate reads this 30 seconds
          // later and tells the student, because THIS is the moment their
          // last answer is at risk — not the no-op flush down there. Without
          // it the overlay reassures on exactly the run where it shouldn't.
          preTerminateFlushFailedRef.current = true;
          console.error(`[ExamShell] flush before pre-countdown terminate: ${outcome}`);
        }
        gradeAttempt({
          attemptId,
          reason: 'terminated',
          terminateReason: 'Exam terminated due to repeated integrity violations.',
        }).catch((e) => console.error('[ExamShell] pre-countdown terminate failed', e));
      })();
      setOverlay({ kind: 'final_warning', violationType: type });
    } else if (type === 'fullscreen_exit') {
      // Below the threshold the student is already looking at the
      // fullscreen_required overlay raised by onFullscreenChange, which both
      // names the violation and gates interaction until they return. A warning
      // card on top would say the same thing twice and bury the way back.
      return;
    } else {
      setOverlay({
        kind: 'warning',
        violationType: type,
        warningNumber: newWarningCount as 1 | 2,
      });
    }
    // flushAnswers is itself useCallback(…, []) — one instance for the
    // component's lifetime — so listing it cannot recreate this callback, and
    // the closure above cannot capture a stale copy. Listed anyway so the
    // dependency is declared rather than assumed.
  }, [flushAnswers]);

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
    //
    // H2 (audit 2026-08-06): this was `await flushAnswers().catch(() => {})` —
    // the rejection discarded with no log and no student-visible signal —
    // followed by an unconditional gradeAttempt. Grading then ran against
    // server state, marking every unflushed answer unattempted, and the
    // overlay told the student their answers had been saved.
    //
    // Of the six flushAnswers call sites this was the only one that swallowed
    // silently AND had a consequence. The durability sweep at :2143 logs; the
    // teardown at :2163 swallows, but that one is honest — a Firestore write
    // genuinely cannot be guaranteed to leave the tab during pagehide, and it
    // is documented as best-effort.
    //
    // WHY THIS STILL GRADES. Termination is an integrity outcome, not a
    // student action: refusing to grade would leave the attempt in_progress
    // after the shell has already torn down, so the sitting would hang open
    // until the sweep closed it — worse for the student than a graded attempt
    // with a recorded caveat. So the flush failure does not block grading; it
    // becomes evidence. It is logged, and the student is told plainly, because
    // termination is precisely the outcome they are least placed to dispute
    // and they need to know there is something to dispute.
    // Seeded from the PRE-COUNTDOWN flush (handleViolation), because that is
    // the one whose result decides whether the student's last answer was
    // marked. By the time we get here the attempt was finalised 30 seconds
    // ago and the gradeAttempt below is an idempotent no-op, so this flush
    // can succeed while the answer it wrote goes unmarked. Reporting only on
    // THIS flush would reassure on exactly the runs that need a warning.
    let answersMayBeUnsaved = preTerminateFlushFailedRef.current;
    try {
      await flushAnswers();
    } catch (e) {
      answersMayBeUnsaved = true;
      console.error('[ExamShell] flush before terminate failed — answers may be lost', e);
    }
    if (a) {
      await gradeAttempt({
        attemptId: att.id,
        reason: 'terminated',
        terminateReason: reason,
      }).catch((e) => console.error('[ExamShell] gradeAttempt(terminate) failed', e));
    }
    setOverlay({ kind: 'terminated', reason, answersMayBeUnsaved });
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
  // EXPIRED-ON-ARRIVAL (audit 2026-07-28)
  // ══════════════════════════════════════════════════════════════════
  // Finalise an attempt whose window shut while nobody was watching.
  //
  // The two handlers above are TRANSITION-driven: they need a tick that
  // crosses zero while the timer is mounted. A student who leaves mid-exam and
  // returns after the clock ran out never produces that transition — the
  // crossing happened with the tab closed. They arrive on a live question with
  // 00:00 on both clocks, which is exactly what was reported.
  //
  // This is STATE-driven instead: it asks "is the window shut?" rather than
  // "did it just shut?", so it is correct on arrival as well as mid-sitting.
  // It re-runs on every attempt update, so it also covers the case where the
  // lock moves (a new section starting) or the subscription delivers late.
  //
  // Server-side enforcement does not depend on this — firestore.rules already
  // refuses the answers and scheduledCloseExpiredAttempts closes the attempt
  // within the hour. This exists so the STUDENT gets a truthful screen and a
  // graded result immediately, instead of a question they cannot answer.
  //
  // ── Phase 0 (timer plan, 2026-07-31) ────────────────────────────
  // This used to call handleFinalSubmit unconditionally, because the only
  // thing it could read was min(section, overall) — which says that SOMETHING
  // expired but not WHAT. Ending the whole sitting is the right answer for the
  // overall clock and much too blunt for the section clock: a student who
  // stepped away during section 2 of 4 lost sections 3 and 4.
  //
  // Now it routes to the same two handlers the live (transition-driven) path
  // already uses, so a clock that runs out at the desk and one that runs out
  // while the tab is closed reach an identical outcome. doSectionSubmit
  // already tolerates the flush being refused on an expired section, and
  // already evaluates the break and advances, so nothing new is needed here.
  useEffect(() => {
    if (shellStatus !== 'ready') return;
    if (isFrozenRef.current) return;
    if (submittingRef.current) return;
    // H4 (audit 2026-08-06): hoisted out of expiredClock, which already
    // returns null for a null attempt (:407) — so `!expired` below has always
    // covered this case and the deref at the getExamVerdict call was never
    // reachable with null. The guard is here to make the invariant local and
    // checkable rather than an inference across two functions; under
    // `strict: true` this was the single genuine error in the whole
    // application. An assertion would have silenced the compiler and left the
    // reasoning where it was.
    if (!attempt) return;
    const expired = expiredClock(
      attempt,
      Date.now(),
      currentSection ? attempt.sectionTimings?.[currentSection.id]?.startedAt : undefined,
    );
    if (!expired) return;

    // ── The server decides what expiry MEANS (D1 / D4, Phase 3d) ────
    //
    // The tick above is local — a countdown has to be, or it stutters. The
    // CONSEQUENCE is not: the shell used to read its own copy of the rules and
    // act, which is how it came to disagree with the server about question
    // grace and about what a section running out should do.
    //
    // Now the local reading only decides WHEN to ask. getExamVerdict answers
    // from the same resolver the server enforces with, so the student's screen
    // and the write gate cannot reach different conclusions.
    //
    // Fails soft on purpose: a verdict we cannot fetch falls back to the local
    // reading, which is what ran exclusively until this phase. An unreachable
    // endpoint must never strand a student on a dead countdown.
    let cancelled = false;
    (async () => {
      const res = await getExamVerdict(attempt.id);
      if (cancelled) return;

      if (!res) {
        if (expired === 'section') doSectionSubmit('time_expired');
        else handleFinalSubmit('time_expired');
        return;
      }

      const v = res.verdict;
      if (v.kind === 'ended') {
        handleFinalSubmit('time_expired');
        return;
      }
      // Anything else means the student still has somewhere to go. Advancing
      // the section is the move for every one of them — the break, choose and
      // next-section paths all begin with the current section being submitted.
      if (expired === 'section' || v.kind === 'break' || v.kind === 'choose'
          || v.kind === 'section' || v.kind === 'question') {
        doSectionSubmit('time_expired');
      }
    })();
    return () => { cancelled = true; };
  }, [shellStatus, attempt, handleFinalSubmit, doSectionSubmit, currentSection]);

  // ══════════════════════════════════════════════════════════════════
  // RENDER: LOADING / ERROR
  // ══════════════════════════════════════════════════════════════════

  if (shellStatus === 'loading') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: 'var(--ef-canvas)' }}>
        <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
        {/* Copy varies with startPhase so a staggered wait reads as progress
            rather than a stalled spinner. Deliberately NOT a countdown or a
            queue position: both invite students to compare with a neighbour
            and conclude something is wrong, when in fact the delay costs them
            nothing — their timer starts when their attempt does. */}
        <p className="text-xs mt-4" style={{ color: 'var(--ef-text-muted)' }}>
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
        <div className="fixed inset-0 flex flex-col items-center justify-center px-6" style={{ background: 'var(--ef-canvas)' }}>
          <div className="flex items-center justify-center mb-5"
            style={{ width: 52, height: 52, borderRadius: '50%', background: '#FBF3F3', border: '1px solid #E3C9C9' }}>
            <AlertTriangle size={22} strokeWidth={1} style={{ color: 'var(--ef-danger)' }} />
          </div>
          <p className="text-xs mb-2" style={{ color: 'var(--ef-danger)', letterSpacing: '0.1em' }}>
            SAFE EXAM BROWSER REQUIRED
          </p>
          <p className="text-xs text-center mb-1" style={{ color: 'var(--ef-text-subtle)', lineHeight: 1.7, maxWidth: 420 }}>
            {errorMsg}
          </p>
          <p className="text-xs text-center mb-6" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6, maxWidth: 420 }}>
            Your progress is saved — resuming inside Safe Exam Browser continues where you left off.
          </p>
          <div className="flex items-center gap-2 flex-wrap justify-center">
            <a
              href="https://safeexambrowser.org/download_en.html"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-4 py-2"
              style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, textDecoration: 'none' }}
            >
              Download Safe Exam Browser
            </a>
            {(assessment?.sebConfigFileUrl || platformSebUrl) && (
              <a
                href={assessment?.sebConfigFileUrl || platformSebUrl}
                className="text-xs px-4 py-2"
                style={{ color: 'var(--ef-text-subtle)', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', textDecoration: 'none' }}
              >
                Exam configuration (.seb)
              </a>
            )}
            <button
              onClick={() => navigate('/student/assessments')}
              className="text-xs px-4 py-2"
              style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2, background: 'var(--ef-surface)', cursor: 'pointer' }}
            >
              Return to assessments
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: 'var(--ef-canvas)' }}>
        <AlertTriangle size={20} strokeWidth={1} style={{ color: 'var(--ef-danger)' }} />
        <p className="text-xs mt-4" style={{ color: 'var(--ef-danger)' }}>{errorMsg}</p>
        <button
          onClick={() => navigate('/student/assessments')}
          className="text-xs mt-6 px-4 py-2"
          style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2 }}
        >
          Return to assessments
        </button>
      </div>
    );
  }

  if (shellStatus === 'submit_failed') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: 'var(--ef-canvas)' }}>
        <AlertTriangle size={20} strokeWidth={1} style={{ color: 'var(--ef-danger)' }} />
        <p className="text-xs mt-4 px-8 text-center" style={{ color: 'var(--ef-danger)' }}>{errorMsg}</p>
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
          style={{ background: '#2F2F2B', color: 'var(--ef-surface)', borderRadius: 2 }}
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
      <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: 'var(--ef-canvas)' }}>
        <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
        <p className="text-xs mt-4" style={{ color: 'var(--ef-text-muted)' }}>Submitting this section…</p>
      </div>
    );
  }

  if (shellStatus === 'submitting_exam' || shellStatus === 'submitted') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: 'var(--ef-canvas)' }}>
        <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
        <p className="text-xs mt-4" style={{ color: 'var(--ef-text-muted)' }}>Submitting your exam…</p>
      </div>
    );
  }

  if (shellStatus === 'on_break' && breakState) {
    return (
      <BreakScreen
        state={breakState}
        onContinue={handleEndBreak}
        frozenAtISO={isFrozen ? frozenAtISO : null}
      />
    );
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
      style={{ background: 'var(--ef-canvas)', userSelect: 'none' }}
    >
      {/* ── Invisible engines ── */}
      <IntegrityEngine
        active={isIntegrityActive}
        onViolation={handleViolation}
        onFullscreenChange={handleFullscreenChange}
        // Narrow exemption for the code answer editor only, resolved from the
        // security tier: practice allows it, proctored and high-stake do not.
        // A missing tier is a legacy attempt and resolves to the strict side.
        allowCodeEditorPaste={codeEditorPasteAllowed(assessment?.securityTier)}
      />
      <ExtensionWatchdog
        active={isIntegrityActive}
        onViolation={(type, detail) => handleViolation(type, detail)}
      />

      {/* ── TOP BAR ── */}
      <div
        className="flex items-center gap-4 px-5 py-2.5 flex-shrink-0"
        style={{
          background: 'var(--ef-surface)',
          borderBottom: '1px solid var(--ef-border)',
          height: 52,
        }}
      >
        {/* Section name + progress */}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <Layers size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
            <span className="text-xs" style={{ color: 'var(--ef-ink)' }}>
              {currentSection.name}
            </span>
            {totalSections > 1 && (
              <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
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
                    ? 'var(--ef-success-strong)'
                    : idx === currentSectionIdx
                      ? 'var(--ef-ink)'
                      : 'var(--ef-border)',
                }}
              />
            ))}
          </div>
        </div>

        {/*
          ── Phase 4.1 (B3): a quiet, honest save indicator ────────────
          Students trust autosave blindly today, so give them something true
          to trust. Green "All answers saved" is the normal state and stays
          unobtrusive; amber names a number, because "some" invites panic and a
          count invites patience — the sweep will clear it within 25 seconds.

          Deliberately not a spinner or a toast. It should be checkable at a
          glance and ignorable the rest of the time.

          Hidden when nothing has been answered yet: reporting "all saved" over
          an empty paper is noise, and it teaches the student to stop reading
          the one indicator we want them to believe.
        */}
        {/*
          B3: a submit that went ahead with answers unconfirmed. Sits in front
          of the save indicator because it supersedes it — once this is
          showing, "all answers saved" would be false and misleading.

          Persistent, with no dismiss control. A student who taps it away and
          then cannot recall what it said has lost the only notice they were
          given, and this is the one message an invigilator needs to see.
        */}
        {saveWarning && (
          <div
            className="flex items-center gap-1.5 flex-shrink-0 px-2 py-1"
            style={{ background: '#FBF3F3', border: '1px solid #E3C9C9', borderRadius: 2 }}
          >
            <AlertTriangle size={12} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />
            <span className="text-xs" style={{ color: 'var(--ef-danger)' }}>Some answers unsent</span>
          </div>
        )}

        {!saveWarning && Object.values(localAnswers).some((a) => !isAnswerEmpty(a)) && (
          <div
            className="flex items-center gap-1.5 flex-shrink-0"
            title={unsavedCount > 0
              ? 'Still sending some answers to the server. You can keep working — this usually clears within a few seconds.'
              : 'Every answer you have given is stored on the server.'}
          >
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: unsavedCount > 0 ? '#B7791F' : 'var(--ef-success-strong)',
            }} />
            <span className="text-xs" style={{ color: unsavedCount > 0 ? '#B7791F' : 'var(--ef-text-muted)' }}>
              {unsavedCount > 0
                ? `${unsavedCount} unsaved`
                : 'All answers saved'}
            </span>
          </div>
        )}

        {/* Section timer */}
        {currentSection.timeLimit && sectionStartedAt && (
          <TimerChip label="Section">
            <SectionTimer
              timeLimitMinutes={currentSection.timeLimit}
              startedAtISO={sectionStartedAt}
              onExpire={handleSectionTimerExpire}
              frozenOffsetSeconds={creditSeconds(freezeCredits.sectionMs)}
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
              frozenOffsetSeconds={creditSeconds(freezeCredits.overallMs)}
              frozenAtISO={isFrozen ? frozenAtISO : null}
              nowFn={nowFn}
            />
          </TimerChip>
        )}
        {/* Session conflict badge */}
        {hasConflict && (
          <div className="flex items-center gap-1.5 px-3 py-1.5"
            style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
            <MonitorSmartphone size={11} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />
            <span className="text-xs" style={{ color: 'var(--ef-danger)' }}>Multi-device</span>
          </div>
        )}

        {/* Violation indicator */}
        <div
          className="flex items-center gap-1.5 px-3 py-1.5"
          style={{
            background: warningCount >= 2 ? 'var(--ef-danger-bg)' : warningCount >= 1 ? '#FEF9EC' : 'var(--ef-canvas)',
            border: `1px solid ${warningCount >= 2 ? 'var(--ef-danger-border)' : warningCount >= 1 ? 'var(--ef-warning-border)' : 'var(--ef-border)'}`,
            borderRadius: 2,
          }}
        >
          <Shield
            size={11}
            strokeWidth={1.5}
            style={{ color: warningCount >= 2 ? 'var(--ef-danger)' : warningCount >= 1 ? 'var(--ef-warning)' : 'var(--ef-text-muted)' }}
          />
          <span
            className="text-xs"
            style={{ color: warningCount >= 2 ? 'var(--ef-danger)' : warningCount >= 1 ? 'var(--ef-warning)' : 'var(--ef-text-muted)' }}
          >
            {warningCount}/{MAX_WARNINGS}
          </span>
        </div>

        {/* Submit button.
            Hidden on the final question of a sequential section, where the
            action bar already carries "Save & submit section" — that one also
            commits the current answer, so showing both offered the student two
            visually identical buttons for one intent and no way to tell which
            was safe. One control, in the place they are already looking. */}
        {!(isLinear && isLastQuestion) && (
        <button
          onClick={() => setShowSubmitModal(true)}
          disabled={shellStatus !== 'ready'}
          className="flex items-center gap-1.5 text-xs px-4 py-2"
          style={{
            background: 'var(--ef-ink)', color: 'var(--ef-surface)',
            borderRadius: 2, cursor: 'pointer',
          }}
        >
          <Send size={11} strokeWidth={1.5} />
          {isLastSection ? 'Submit exam' : `Submit ${currentSection.name}`}
        </button>
        )}
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
              groupIdByQuestion={groupIdByQuestion}
              groupKindById={groupKindById}
            />
            )}
          </div>

          {/* Webcam PiP */}
          <div className="flex-shrink-0 p-3" style={{ borderTop: '1px solid var(--ef-border)' }}>
            <FaceMonitor
              enabled={cameraGranted}
              active={isIntegrityActive}
              onViolation={handleViolation}
              onStateChange={setFaceDetectionState}
            />
          </div>
        </div>

        {/* ── MAIN QUESTION AREA ── */}
        <div className="flex-1 flex flex-col overflow-hidden" style={{ background: 'var(--ef-surface)' }}>

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
                  group={currentGroup}
                  groupPosition={currentGroupPosition}
                  onRunCode={handleRunCode}
                  onCodeTelemetry={telemetryOn ? handleCodeTelemetry : undefined}
                />
              </div>

              {/* Bottom navigation bar */}
              <div
                className="flex items-center justify-between px-8 py-4 flex-shrink-0"
                style={{ borderTop: '1px solid var(--ef-border-subtle)' }}
              >
                {isLinear ? (
                  <span className="flex items-center gap-1.5 text-xs px-1 py-2"
                    style={{ color: 'var(--ef-text-muted)' }}>
                    <Shield size={12} strokeWidth={1.5} />
                    Answers are final — you cannot return to a question
                  </span>
                ) : (
                <button
                  onClick={() => setCurrentQIdx((i) => Math.max(0, i - 1))}
                  disabled={currentQIdx === 0}
                  className="flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity"
                  style={{
                    border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2,
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
                      <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                        Question {currentSectionQIds.length}
                      </span>
                      {qSecondsLeft !== null && (
                        <span className="flex items-center gap-1 text-xs px-2 py-0.5"
                          style={{
                            background: qSecondsLeft <= 10 ? '#FBF3F3' : 'var(--ef-success-bg)',
                            border: `1px solid ${qSecondsLeft <= 10 ? '#E3C9C9' : 'var(--ef-success-border)'}`,
                            borderRadius: 2,
                            color: qSecondsLeft <= 10 ? 'var(--ef-danger)' : 'var(--ef-success-strong)',
                          }}>
                          <span className="text-[10px] uppercase" style={{ letterSpacing: '0.06em', opacity: 0.7 }}>
                            Per Q
                          </span>
                          <Clock size={10} strokeWidth={1.5} />
                          {Math.floor(qSecondsLeft / 60)}:{String(qSecondsLeft % 60).padStart(2, '0')}
                        </span>
                      )}
                      {linearError && (
                        <span className="text-xs" style={{ color: 'var(--ef-danger)' }}>{linearError}</span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                        {currentSectionQIds.length - unansweredInSection}
                        /{currentSectionQIds.length} answered in this section
                      </span>
                      {!isAnswerEmpty(localAnswers[currentQId!]) && (
                        <CheckCircle2 size={12} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)' }} />
                      )}
                    </>
                  )}
                </div>

                {isLastQuestion ? (
                  <button
                    disabled={isLinear && linearAdvancing}
                    onClick={async () => {
                      // D-26: one action. On the final question of a sequential
                      // section the answer has not been committed yet — it is
                      // only sent by submitAnswerAndAdvance — so save it first,
                      // THEN offer the submit. Splitting these was how a
                      // student could answer the last question, see nothing
                      // happen, and lose the answer if they walked away.
                      if (isLinear && !linearSectionComplete) {
                        await handleLinearNext();
                      }
                      setShowSubmitModal(true);
                    }}
                    className="flex items-center gap-1.5 text-xs px-4 py-2"
                    style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: 'pointer' }}
                  >
                    <Send size={11} strokeWidth={1.5} />
                    {isLinear && linearAdvancing
                      ? 'Saving…'
                      : isLinear && !linearSectionComplete
                        ? (isLastSection ? 'Save & submit exam' : 'Save & submit section')
                        : (isLastSection ? 'Submit exam' : `Submit ${currentSection.name}`)}
                  </button>
                ) : (
                  <button
                    onClick={isLinear
                      ? handleLinearNext
                      : () => setCurrentQIdx((i) => Math.min(currentSectionQIds.length - 1, i + 1))}
                    disabled={isLinear && linearAdvancing}
                    className="flex items-center gap-1.5 text-xs px-4 py-2"
                    style={{
                      border: '1px solid var(--ef-border)',
                      color: isLinear ? 'var(--ef-surface)' : 'var(--ef-text-subtle)',
                      background: isLinear ? 'var(--ef-ink)' : 'transparent',
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
              <AlertTriangle size={16} strokeWidth={1} style={{ color: 'var(--ef-text-muted)' }} />
              <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
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
        {overlay?.kind === 'extension_required' && (
          <ExtensionRequiredOverlay
            key="extension"
            found={overlay.found}
            onRecheck={handleRecheckExtensions}
          />
        )}
        {overlay?.kind === 'terminated' && (
          <TerminatedOverlay
            key="terminated"
            reason={overlay.reason}
            answersMayBeUnsaved={overlay.answersMayBeUnsaved}
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