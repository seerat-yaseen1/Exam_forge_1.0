/**
 * AssessmentRosterCore
 *
 * Shared live roster UI used by Web Owner, Institute Admin, and Faculty.
 * Caller supplies:
 *   - assessmentId: from route param
 *   - invigId:      ID written to Firestore `frozenBy` (facultyId / instituteId / 'webOwner')
 *   - instituteId:  scope student lookup (null = fetch all students, Web Owner view)
 *   - onBack:       navigation callback for the back breadcrumb
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowLeft, Loader2, AlertTriangle, Shield, Users,
  CheckCircle2, Clock, PauseCircle, PlayCircle, MonitorSmartphone,
  ChevronRight, X, BookOpen, Search, Activity, WifiOff,
  Ban, CircleSlash, Hash, RotateCcw, XCircle, Minus,
  FileText, Eye, Trash2, AlertCircle, Flag, Download,
} from 'lucide-react';
import { getAssessment, blockStudent, unblockStudent, setAttemptOverride, statusColor, resolveAllocatedStudents, isRuleAllocated, type Assessment, type AssessmentSection } from '../../../lib/assessmentService';
import { reviewAudienceAllows, resultsAudienceAllows, type VisibilityAudience } from '../../../lib/visibility';
import { AssessmentReportsPanel } from './AssessmentReportsPanel';
import {
  getStudentsByInstitute,
  getAllStudents,
  type Student,
} from '../../../lib/firebaseService';
import {
  subscribeToAttemptsByAssessment,
  getAllAttemptsByStudentAndAssessment,
  freezeAttempt,
  unfreezeAttempt,
  softDeleteAttempt,
  getBreakState,
  type Attempt,
  type AttemptAnswer,
  type GradedAnswer,
} from '../../../lib/submissionService';
import { getQuestionsByIdsForReview, type Question } from '../../../lib/questionBankService';
import { ResultsExportModal } from './ResultsExportModal';

// ══════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════

type RosterStatus =
  | 'not_started'
  | 'in_progress'
  | 'frozen'
  | 'submitted'
  | 'auto_submitted'
  | 'terminated';

/** Which score the roster emphasises when a student has sat more than once. */
type ScoreView = 'latest' | 'best';

type RosterRow = {
  student: Student;
  /**
   * The student's MOST RECENT attempt — and the only one that drives status,
   * live progress, freeze/unfreeze and the drawer.
   *
   * This deliberately does NOT follow the Latest/Best toggle. Switching to
   * "Best" while a student is mid-sitting would otherwise point the status
   * chip and the freeze button at a finished attempt, so an invigilator
   * clicking Pause would act on the wrong sitting — or on nothing. The toggle
   * changes what is DISPLAYED; it never changes what is ACTED ON.
   */
  attempt: Attempt | null;
  /**
   * Highest-scoring attempt, or null when the student has no graded attempt.
   * May be the same object as `attempt` when their latest is also their best.
   */
  bestAttempt: Attempt | null;
  /**
   * How many non-deleted attempts this student has on this assessment.
   * >1 means `attempt` above is only the most recent one — the full list
   * lives in the drawer's HISTORY panel.
   */
  attemptCount: number;
  rosterStatus: RosterStatus;
  isBlocked: boolean;
};

/**
 * Pick the best attempt: highest percentage among GRADED, NON-TERMINATED
 * attempts. Ties go to the more recent one.
 *
 * Terminated attempts are excluded on purpose. "Best demonstrated performance"
 * should not be a score the student obtained in a sitting that was voided for
 * misconduct — surfacing it on the roster as their best would be actively
 * misleading. They remain visible in the drawer's HISTORY panel, which is the
 * right place to see a voided sitting and its mark. If you would rather
 * include them, drop the status check on the next line and nothing else
 * changes.
 */
function pickBestAttempt(attempts: Attempt[]): Attempt | null {
  const eligible = attempts.filter(
    (a) => a.scores != null && a.status !== 'terminated'
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((best, cur) => {
    const d = (cur.scores!.percentage ?? 0) - (best.scores!.percentage ?? 0);
    if (d !== 0) return d > 0 ? cur : best;
    return attemptStartedMs(cur) >= attemptStartedMs(best) ? cur : best;
  });
}

/** Sort key for "most recent". Missing/garbage timestamps sort as epoch. */
function attemptStartedMs(a: Attempt): number {
  const raw = a.startedAt ?? (a as { createdAt?: string }).createdAt;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// ══════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════

/**
 * Can this attempt's responses be reviewed? Only a finished sitting has a
 * settled answer set; an in-progress one is still moving.
 *
 * `terminated` counts — a voided sitting is often the one a reviewer most
 * wants to read.
 */
function isReviewable(a: Attempt | null | undefined): boolean {
  return !!a && (a.status === 'submitted' || a.status === 'auto_submitted' || a.status === 'terminated');
}

function deriveRosterStatus(attempt: Attempt | null): RosterStatus {
  if (!attempt) return 'not_started';
  if (attempt.frozenAt) return 'frozen';
  return attempt.status as RosterStatus;
}

function formatRelative(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function totalAnswered(attempt: Attempt): number {
  return Object.keys(attempt.answers).length;
}

function totalQuestions(attempt: Attempt): number {
  return Object.values(attempt.questionOrder).reduce((s, arr) => s + arr.length, 0);
}

// ── Status chip ───────────────────────────────────────────────────

const STATUS_CONFIG: Record<RosterStatus, { label: string; bg: string; text: string; border: string; dot: string }> = {
  not_started:   { label: 'Not started',     bg: '#F7F6F3', text: '#9A9891', border: '#E3E1DB', dot: '#C4C3BD' },
  in_progress:   { label: 'Live',            bg: '#F0F9F4', text: '#1E7B3C', border: '#B8E6C8', dot: '#1E7B3C' },
  frozen:        { label: 'Flagged',         bg: '#FFFBF0', text: '#92680A', border: '#F5DFA0', dot: '#D4A017' },
  submitted:     { label: 'Submitted',       bg: '#F7F6F3', text: '#6B6B66', border: '#DDDBD5', dot: '#6B6B66' },
  auto_submitted:{ label: 'Auto-submitted',  bg: '#FEF9EC', text: '#92680A', border: '#F5DFA0', dot: '#92680A' },
  terminated:    { label: 'Terminated',      bg: '#FDF5F5', text: '#9B2828', border: '#F2CECE', dot: '#9B2828' },
};

function StatusChip({ status }: { status: RosterStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5"
      style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 2 }}>
      <div style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.dot,
        animation: status === 'in_progress' ? 'rosterBlip 1.4s ease-in-out infinite' : 'none' }} />
      <span className="text-xs" style={{ color: cfg.text }}>{cfg.label}</span>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// FREEZE CONFIRM MODAL
// ══════════════════════════════════════════════════════════════════

function FreezeConfirmModal({
  studentName,
  loading,
  onConfirm,
  onCancel,
}: {
  studentName: string;
  loading: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.36)' }}
      onClick={onCancel}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="w-full"
        style={{ maxWidth: 400, background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid #E3E1DB' }}>
          <div className="flex items-center gap-2">
            <PauseCircle size={13} strokeWidth={1.5} style={{ color: '#1D4ED8' }} />
            <p className="text-xs" style={{ color: '#0C0C0B', letterSpacing: '0.06em' }}>FREEZE SESSION</p>
          </div>
          <button onClick={onCancel} className="p-1 hover:opacity-60 transition-opacity" style={{ color: '#C4C3BD' }}>
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-4">
          <div className="px-3 py-3 flex items-start gap-2.5"
            style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 2 }}>
            <PauseCircle size={12} strokeWidth={1.5} style={{ color: '#1D4ED8', flexShrink: 0, marginTop: 1 }} />
            <p className="text-xs" style={{ color: '#1D4ED8', lineHeight: 1.6 }}>
              Freezing will pause <strong>{studentName}</strong>'s exam timer and lock their
              interface until you unfreeze the session. Their progress is preserved.
            </p>
          </div>

          <div>
            <label className="text-xs mb-1.5 block" style={{ color: '#6B6B66' }}>
              Reason{' '}
              <span style={{ color: '#C4C3BD' }}>(optional — visible in the audit log)</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Technical issue, student complaint…"
              rows={3}
              className="w-full outline-none resize-none text-xs"
              style={{
                border: '1px solid #E3E1DB', borderRadius: 2,
                background: '#FAFAF8', color: '#0C0C0B',
                padding: '8px 10px', lineHeight: 1.6,
              }}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderTop: '1px solid #E3E1DB' }}>
          <button
            onClick={() => onConfirm(reason.trim())}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
            style={{
              background: loading ? '#93C5FD' : '#1D4ED8',
              color: '#FFFFFF', borderRadius: 2,
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading
              ? <><Loader2 size={10} className="animate-spin" /> Freezing…</>
              : <><PauseCircle size={10} strokeWidth={1.5} /> Freeze session</>}
          </button>
          <button
            onClick={onCancel}
            disabled={loading}
            className="text-xs px-4 py-2.5 transition-opacity hover:opacity-70"
            style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}
          >
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// UNFREEZE CONFIRM MODAL
// ══════════════════════════════════════════════════════════════════

function UnfreezeConfirmModal({
  studentName,
  attempt,
  loading,
  onConfirm,
  onCancel,
}: {
  studentName: string;
  attempt: Attempt;
  loading: boolean;
  onConfirm: (grantedMs: number, note?: string) => void;
  onCancel: () => void;
}) {
  const [frozenSecs, setFrozenSecs] = useState(() =>
    attempt.frozenAt ? Math.floor((Date.now() - new Date(attempt.frozenAt).getTime()) / 1000) : 0
  );

  useEffect(() => {
    if (!attempt.frozenAt) return;
    const iv = setInterval(() => {
      setFrozenSecs(Math.floor((Date.now() - new Date(attempt.frozenAt!).getTime()) / 1000));
    }, 1000);
    return () => clearInterval(iv);
  }, [attempt.frozenAt]);

  function secsToLabel(s: number): string {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }

  // ── The credit decision (Phase 4) ──────────────────────────────
  //
  // Pre-filled with the FULL elapsed time, because that is the fair default
  // and the invigilator should have to act deliberately to give less. Any
  // value from zero upward is accepted — a student who wandered off and a
  // student whose machine died are not the same case, and the system cannot
  // tell them apart. What it can do is make the difference a recorded human
  // decision instead of a silent one.
  //
  // Held in seconds for the input and converted at submit; the ledger works in
  // milliseconds and the server clamps to elapsed regardless (INV-4c).
  const [grantSecs, setGrantSecs] = useState<string>('');
  const [note, setNote] = useState('');
  useEffect(() => {
    // Track elapsed until the invigilator edits it — after that it is theirs.
    setGrantSecs((prev) => (prev === '' || prev === String(frozenSecs - 1) ? String(frozenSecs) : prev));
  }, [frozenSecs]);

  const grantNum = Math.max(0, Math.min(parseInt(grantSecs || '0', 10) || 0, frozenSecs));
  const givingLess = grantNum < frozenSecs;

  const thisFreeze  = secsToLabel(frozenSecs);
  const totalAfter  = secsToLabel((attempt.totalFrozenSeconds ?? 0) + frozenSecs);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.36)' }}
      onClick={onCancel}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="w-full"
        style={{ maxWidth: 400, background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid #E3E1DB' }}>
          <div className="flex items-center gap-2">
            <PlayCircle size={13} strokeWidth={1.5} style={{ color: '#1E7B3C' }} />
            <p className="text-xs" style={{ color: '#0C0C0B', letterSpacing: '0.06em' }}>UNFREEZE SESSION</p>
          </div>
          <button onClick={onCancel} className="p-1 hover:opacity-60 transition-opacity" style={{ color: '#C4C3BD' }}>
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-4">
          <div className="px-3 py-3 flex items-start gap-2.5"
            style={{ background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2 }}>
            <PlayCircle size={12} strokeWidth={1.5} style={{ color: '#1E7B3C', flexShrink: 0, marginTop: 1 }} />
            <p className="text-xs" style={{ color: '#1E7B3C', lineHeight: 1.6 }}>
              Resuming <strong>{studentName}</strong>'s session. Their timer continues from
              where it was paused — the frozen time will <strong>not</strong> count against their limit.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="px-3 py-3"
              style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}>
              <p className="text-xs mb-1" style={{ color: '#9A9891' }}>This freeze</p>
              <p className="text-xs" style={{ color: '#1D4ED8' }}>{thisFreeze}</p>
            </div>
            <div className="px-3 py-3"
              style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}>
              <p className="text-xs mb-1" style={{ color: '#9A9891' }}>Total frozen (cumulative)</p>
              <p className="text-xs" style={{ color: '#0C0C0B' }}>{totalAfter}</p>
            </div>
          </div>

          {attempt.frozenReason && (
            <div className="px-3 py-2.5"
              style={{ background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2 }}>
              <p className="text-xs mb-0.5" style={{ color: '#9A9891' }}>Freeze reason on record</p>
              <p className="text-xs" style={{ color: '#4A4A45', lineHeight: 1.5 }}>{attempt.frozenReason}</p>
            </div>
          )}

          {/* ── Time to give back ────────────────────────────────── */}
          <div className="px-3 py-3"
            style={{ background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2 }}>
            <p className="text-xs mb-2" style={{ color: '#0C0C0B' }}>
              Time to give back
            </p>
            <div className="flex items-center gap-2">
              <input
                type="number" min={0} max={frozenSecs} value={grantSecs}
                onChange={(e) => setGrantSecs(e.target.value)}
                disabled={loading}
                className="text-xs px-2 py-1.5 w-24"
                style={{ border: '1px solid #D8D6CF', borderRadius: 2, color: '#0C0C0B' }}
              />
              <span className="text-xs" style={{ color: '#9A9891' }}>
                seconds of {thisFreeze}
              </span>
              {givingLess && (
                <button
                  onClick={() => setGrantSecs(String(frozenSecs))}
                  className="text-xs px-2 py-1"
                  style={{ color: '#1D4ED8', cursor: 'pointer', background: 'transparent' }}
                >
                  give all
                </button>
              )}
            </div>
            <p className="text-xs mt-2" style={{ color: givingLess ? '#92680A' : '#9A9891', lineHeight: 1.5 }}>
              {givingLess
                ? `${secsToLabel(frozenSecs - grantNum)} of this pause will NOT be returned. The student is told either way.`
                : 'The full pause is returned to their clocks.'}
            </p>
            <input
              type="text" value={note} onChange={(e) => setNote(e.target.value)}
              disabled={loading} placeholder="Note (optional) — recorded in the audit trail"
              className="text-xs px-2 py-1.5 w-full mt-2"
              style={{ border: '1px solid #D8D6CF', borderRadius: 2, color: '#0C0C0B' }}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderTop: '1px solid #E3E1DB' }}>
          <button
            onClick={() => onConfirm(grantNum * 1000, note.trim() || undefined)}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
            style={{
              background: loading ? '#86EFAC' : '#1E7B3C',
              color: '#FFFFFF', borderRadius: 2,
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading
              ? <><Loader2 size={10} className="animate-spin" /> Unfreezing…</>
              : <><PlayCircle size={10} strokeWidth={1.5} />
                  {grantNum > 0 ? `Resume, giving back ${secsToLabel(grantNum)}` : 'Resume, giving back nothing'}
                </>}
          </button>
          <button
            onClick={onCancel}
            disabled={loading}
            className="text-xs px-4 py-2.5 transition-opacity hover:opacity-70"
            style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}
          >
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// BLOCK CONFIRM MODAL
// ══════════════════════════════════════════════════════════════════

function BlockConfirmModal({
  studentName, loading, onConfirm, onCancel,
}: { studentName: string; loading: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.36)' }}
      onClick={onCancel}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="w-full"
        style={{ maxWidth: 400, background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid #E3E1DB' }}>
          <div className="flex items-center gap-2">
            <Ban size={13} strokeWidth={1.5} style={{ color: '#9A3412' }} />
            <p className="text-xs" style={{ color: '#0C0C0B', letterSpacing: '0.06em' }}>BLOCK STUDENT</p>
          </div>
          <button onClick={onCancel} className="p-1 hover:opacity-60 transition-opacity" style={{ color: '#C4C3BD' }}>
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        <div className="px-5 py-5 space-y-4">
          <div className="px-3 py-3 flex items-start gap-2.5"
            style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 2 }}>
            <Ban size={12} strokeWidth={1.5} style={{ color: '#9A3412', flexShrink: 0, marginTop: 1 }} />
            <p className="text-xs" style={{ color: '#9A3412', lineHeight: 1.6 }}>
              Blocking will prevent <strong>{studentName}</strong> from entering or
              re-entering this exam. Any attempt already in progress is unaffected —
              they can still complete and submit their current session.
            </p>
          </div>
          <p className="text-xs" style={{ color: '#6B6B66', lineHeight: 1.6 }}>
            You can unblock this student at any time to restore their access.
          </p>
        </div>
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderTop: '1px solid #E3E1DB' }}>
          <button
            onClick={onConfirm} disabled={loading}
            className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
            style={{ background: loading ? '#FDBA74' : '#9A3412', color: '#FFFFFF', borderRadius: 2,
              cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}
          >
            {loading ? <><Loader2 size={10} className="animate-spin" /> Blocking…</> : <><Ban size={10} strokeWidth={1.5} /> Block student</>}
          </button>
          <button onClick={onCancel} disabled={loading}
            className="text-xs px-4 py-2.5 transition-opacity hover:opacity-70"
            style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}>
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// UNBLOCK CONFIRM MODAL
// ══════════════════════════════════════════════════════════════════

function UnblockConfirmModal({
  studentName, loading, onConfirm, onCancel,
}: { studentName: string; loading: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.36)' }}
      onClick={onCancel}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="w-full"
        style={{ maxWidth: 400, background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid #E3E1DB' }}>
          <div className="flex items-center gap-2">
            <CircleSlash size={13} strokeWidth={1.5} style={{ color: '#1E7B3C' }} />
            <p className="text-xs" style={{ color: '#0C0C0B', letterSpacing: '0.06em' }}>UNBLOCK STUDENT</p>
          </div>
          <button onClick={onCancel} className="p-1 hover:opacity-60 transition-opacity" style={{ color: '#C4C3BD' }}>
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        <div className="px-5 py-5">
          <div className="px-3 py-3 flex items-start gap-2.5"
            style={{ background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2 }}>
            <CircleSlash size={12} strokeWidth={1.5} style={{ color: '#1E7B3C', flexShrink: 0, marginTop: 1 }} />
            <p className="text-xs" style={{ color: '#1E7B3C', lineHeight: 1.6 }}>
              Unblocking <strong>{studentName}</strong> will immediately restore their
              ability to enter this exam. If the assessment window is still open,
              they can enter and start a new attempt.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderTop: '1px solid #E3E1DB' }}>
          <button
            onClick={onConfirm} disabled={loading}
            className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
            style={{ background: loading ? '#86EFAC' : '#1E7B3C', color: '#FFFFFF', borderRadius: 2,
              cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}
          >
            {loading ? <><Loader2 size={10} className="animate-spin" /> Unblocking…</> : <><CircleSlash size={10} strokeWidth={1.5} /> Unblock student</>}
          </button>
          <button onClick={onCancel} disabled={loading}
            className="text-xs px-4 py-2.5 transition-opacity hover:opacity-70"
            style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}>
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// RESPONSE VIEWER — Correct / Wrong / Partial / Unattempted / Text
// ══════════════════════════════════════════════════════════════════

type AnswerCategory = 'correct' | 'wrong' | 'penalized' | 'partial' | 'unattempted' | 'text';

type ClassifiedItem = {
  question: Question;
  sectionName: string;
  marks: number;
  awarded: number;
  category: AnswerCategory;
  studentAnswer?: AttemptAnswer;
};

function classifyAnswer(
  q: Question,
  answer: AttemptAnswer | undefined,
  marks: number,
  graded?: GradedAnswer
): { category: AnswerCategory; awarded: number } {
  if (!answer) return { category: 'unattempted', awarded: 0 };

  // Prefer the server-written verdict (gradedAnswers, populated by the
  // gradeAttempt / regradeAttempts Cloud Functions). It is the source of
  // truth, exists on every finalised attempt, and — unlike the local
  // re-derivation below — doesn't depend on the reviewer being able to
  // read the question's answer key (owner-scoped by the rules).
  if (graded) {
    if (q.engine === 'text' && graded.isCorrect === null) {
      return { category: 'text', awarded: graded.marksAwarded };
    }
    if (graded.isCorrect === true)  return { category: 'correct', awarded: graded.marksAwarded };
    if (graded.isCorrect === false) {
      // marksAwarded > 0 → partial credit kept; < 0 → negative marking bit
      // (a wrong answer that cost marks); 0 → plain wrong.
      const cat: AnswerCategory =
        graded.marksAwarded > 0 ? 'partial'
        : graded.marksAwarded < 0 ? 'penalized'
        : 'wrong';
      return { category: cat, awarded: Math.round(graded.marksAwarded * 100) / 100 };
    }
    // isCorrect null on a non-text question: invalidated (full marks) or
    // ungradeable — surface the awarded marks either way.
    return { category: graded.marksAwarded > 0 ? 'correct' : 'unattempted', awarded: graded.marksAwarded };
  }

  // Fallback for attempts that predate server grading (no gradedAnswers).
  if (q.engine === 'text') return { category: 'text', awarded: 0 };

  if (q.engine === 'mcq') {
    if (q.variant === 'single' || q.variant === 'truefalse' || q.variant === 'fillblank') {
      const selected = typeof answer.value === 'string' ? answer.value : '';
      const m = q.correctIds.includes(selected) ? 1 : 0;
      return { category: m === 1 ? 'correct' : 'wrong', awarded: m * marks };
    }
    if (q.variant === 'multi') {
      const selected = Array.isArray(answer.value) ? answer.value : [];
      const correct = new Set(q.correctIds);
      let hits = 0, wrongs = 0;
      for (const id of selected) { if (correct.has(id)) hits++; else wrongs++; }
      const m = Math.max(0, (hits - wrongs) / Math.max(correct.size, 1));
      const cat: AnswerCategory = m >= 1 ? 'correct' : m > 0 ? 'partial' : 'wrong';
      return { category: cat, awarded: Math.round(m * marks * 100) / 100 };
    }
  }

  if (q.engine === 'match') {
    const val = answer.value;
    if (typeof val !== 'object' || Array.isArray(val)) return { category: 'wrong', awarded: 0 };
    const studentMap = val as Record<string, string>;
    if (q.correctPairs.length === 0) return { category: 'correct', awarded: marks };
    let correct = 0;
    for (const pair of q.correctPairs) {
      if (studentMap[pair.leftId] === pair.rightId) correct++;
    }
    const m = correct / q.correctPairs.length;
    const cat: AnswerCategory = m >= 1 ? 'correct' : m > 0 ? 'partial' : 'wrong';
    return { category: cat, awarded: Math.round(m * marks * 100) / 100 };
  }

  return { category: 'unattempted', awarded: 0 };
}

const CATEGORY_CONFIG: Record<AnswerCategory, {
  label: string; bg: string; text: string; border: string; dot: string;
  icon: React.ReactNode;
}> = {
  correct:     { label: 'Correct',     bg: '#F0F9F4', text: '#1E7B3C', border: '#B8E6C8', dot: '#1E7B3C',  icon: <CheckCircle2 size={11} strokeWidth={1.5} /> },
  wrong:       { label: 'Wrong',       bg: '#FDF5F5', text: '#9B2828', border: '#F2CECE', dot: '#9B2828',  icon: <XCircle size={11} strokeWidth={1.5} /> },
  penalized:   { label: 'Penalized',   bg: '#FBEFEF', text: '#7F1D1D', border: '#E9B8B8', dot: '#7F1D1D',  icon: <XCircle size={11} strokeWidth={1.5} /> },
  partial:     { label: 'Partial',     bg: '#FFFBF0', text: '#92680A', border: '#F5DFA0', dot: '#D4A017',  icon: <AlertCircle size={11} strokeWidth={1.5} /> },
  unattempted: { label: 'Unattempted', bg: '#F7F6F3', text: '#9A9891', border: '#E3E1DB', dot: '#C4C3BD',  icon: <Minus size={11} strokeWidth={1.5} /> },
  text:        { label: 'Text',        bg: '#EFF6FF', text: '#1D4ED8', border: '#BFDBFE', dot: '#1D4ED8',  icon: <FileText size={11} strokeWidth={1.5} /> },
};

function ResponseViewer({
  attempt,
  assessment,
}: {
  attempt: Attempt;
  assessment: Assessment;
}) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading]     = useState(true);
  const [activeTab, setActiveTab] = useState<AnswerCategory | 'all'>('all');
  const [expanded, setExpanded]   = useState<string | null>(null);

  // Build marks + section-name lookup from assessment sections
  const marksMap = useMemo<Map<string, number>>(() => {
    const m = new Map<string, number>();
    (assessment.sections ?? []).forEach((sec: AssessmentSection) =>
      sec.questions.forEach((aq) => m.set(aq.questionId, aq.marks))
    );
    return m;
  }, [assessment]);

  const sectionNameMap = useMemo<Map<string, string>>(() => {
    const m = new Map<string, string>();
    (assessment.sections ?? []).forEach((sec: AssessmentSection) =>
      sec.questions.forEach((aq) => m.set(aq.questionId, sec.name))
    );
    return m;
  }, [assessment]);

  // Collect all unique question IDs from the attempt's frozen question order
  const allIds = useMemo<string[]>(() => {
    const set = new Set<string>();
    Object.values(attempt.questionOrder).forEach((ids) => ids.forEach((id) => set.add(id)));
    return Array.from(set);
  }, [attempt.questionOrder]);

  useEffect(() => {
    setLoading(true);
    // Review path: assessment-scoped callable merges answer keys so graders
    // see correct answers even for questions they don't own (owner-scoped
    // questionAnswers rules deny those direct reads).
    getQuestionsByIdsForReview(attempt.assessmentId, allIds)
      .then(setQuestions)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [allIds.join(',')]); // eslint-disable-line

  // Classify every question
  const classified = useMemo<ClassifiedItem[]>(() => {
    return questions.map((q) => {
      const marks  = marksMap.get(q.id) ?? 0;
      const ans    = attempt.answers[q.id];
      const { category, awarded } = classifyAnswer(q, ans, marks, attempt.gradedAnswers?.[q.id]);
      return { question: q, sectionName: sectionNameMap.get(q.id) ?? '—', marks, awarded, category, studentAnswer: ans };
    });
  }, [questions, attempt.answers, marksMap, sectionNameMap]);

  const counts = useMemo(() => {
    const c = { correct: 0, wrong: 0, penalized: 0, partial: 0, unattempted: 0, text: 0 };
    classified.forEach((item) => { c[item.category]++; });
    return c;
  }, [classified]);

  const visible = useMemo(() =>
    activeTab === 'all' ? classified : classified.filter((i) => i.category === activeTab),
    [classified, activeTab]
  );

  type RosterTab = { key: AnswerCategory | 'all'; label: string; count: number };
  const tabs: RosterTab[] = ([
    { key: 'all',         label: 'All',        count: classified.length },
    { key: 'correct',     label: 'Correct',    count: counts.correct },
    { key: 'wrong',       label: 'Wrong',      count: counts.wrong },
    { key: 'penalized',   label: 'Penalized',  count: counts.penalized },
    { key: 'partial',     label: 'Partial',    count: counts.partial },
    { key: 'unattempted', label: 'Unattempted',count: counts.unattempted },
    { key: 'text',        label: 'Text',       count: counts.text },
  ] as RosterTab[]).filter((t) => t.key === 'all' || t.count > 0);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 size={12} className="animate-spin" style={{ color: '#C4C3BD' }} />
        <span className="text-xs" style={{ color: '#C4C3BD' }}>Loading questions…</span>
      </div>
    );
  }

  if (questions.length === 0) {
    return <p className="text-xs py-2" style={{ color: '#C4C3BD' }}>No question data available.</p>;
  }

  return (
    <div>
      {/* Tab bar */}
      <div className="flex items-center gap-1 flex-wrap mb-3">
        {tabs.map((tab) => {
          const cfg = tab.key !== 'all' ? CATEGORY_CONFIG[tab.key as AnswerCategory] : null;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className="flex items-center gap-1 text-xs px-2.5 py-1 transition-all"
              style={{
                borderRadius: 2,
                background: isActive ? (cfg?.bg ?? '#0C0C0B') : 'transparent',
                color: isActive ? (cfg?.text ?? '#FFFFFF') : '#9A9891',
                border: isActive
                  ? `1px solid ${cfg?.border ?? '#0C0C0B'}`
                  : '1px solid #E3E1DB',
                cursor: 'pointer',
              }}
            >
              {cfg && isActive && <span style={{ color: cfg.text }}>{cfg.icon}</span>}
              {tab.label}
              <span style={{
                background: isActive ? (cfg ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.2)') : '#F0EFEB',
                color: isActive ? (cfg?.text ?? '#FFFFFF') : '#9A9891',
                borderRadius: 2, padding: '0 4px', fontSize: 10,
              }}>{tab.count}</span>
            </button>
          );
        })}
      </div>

      {/* Question list */}
      <div className="flex flex-col gap-1.5">
        {visible.map((item, idx) => {
          const cfg = CATEGORY_CONFIG[item.category];
          const isOpen = expanded === item.question.id;
          const q = item.question;

          // Resolve student's readable answer
          let studentAnswerText = '—';
          if (item.studentAnswer) {
            const val = item.studentAnswer.value;
            if (q.engine === 'text') {
              studentAnswerText = typeof val === 'string' ? val : '—';
            } else if (q.engine === 'mcq') {
              if (typeof val === 'string') {
                const opt = q.options.find((o) => o.id === val);
                studentAnswerText = opt ? opt.text : val;
              } else if (Array.isArray(val)) {
                studentAnswerText = val
                  .map((id) => q.options.find((o) => o.id === id)?.text ?? id)
                  .join(', ');
              }
            } else if (q.engine === 'match') {
              if (typeof val === 'object' && !Array.isArray(val)) {
                studentAnswerText = Object.entries(val as Record<string, string>)
                  .map(([lId, rId]) => {
                    const left  = q.pairs.find((p) => p.leftId === lId)?.leftText ?? lId;
                    const right = q.pairs.find((p) => p.rightId === rId)?.rightText ?? rId;
                    return `${left} → ${right}`;
                  }).join(' · ');
              }
            }
          }

          // Correct answer text
          let correctAnswerText = '';
          if (q.engine === 'mcq') {
            correctAnswerText = q.correctIds
              .map((id) => q.options.find((o) => o.id === id)?.text ?? id)
              .join(', ');
          } else if (q.engine === 'match') {
            correctAnswerText = q.correctPairs
              .map((p) => {
                const left  = q.pairs.find((x) => x.leftId === p.leftId)?.leftText ?? p.leftId;
                const right = q.pairs.find((x) => x.rightId === p.rightId)?.rightText ?? p.rightId;
                return `${left} → ${right}`;
              }).join(' · ');
          } else if (q.engine === 'text' && q.modelAnswer) {
            correctAnswerText = q.modelAnswer;
          }

          return (
            <div key={q.id}
              style={{ border: `1px solid ${cfg.border}`, borderRadius: 2, overflow: 'hidden' }}>
              {/* Row header */}
              <button
                className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left"
                style={{ background: cfg.bg, cursor: 'pointer' }}
                onClick={() => setExpanded(isOpen ? null : q.id)}
              >
                <span style={{ color: cfg.text, flexShrink: 0, marginTop: 1 }}>{cfg.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs" style={{ color: '#0C0C0B', lineHeight: 1.5 }}>
                    <span style={{ color: '#C4C3BD', marginRight: 6 }}>Q{idx + 1}</span>
                    {q.stem.length > 80 ? q.stem.slice(0, 80) + '…' : q.stem}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: '#9A9891' }}>
                    {item.sectionName} · {item.marks} mark{item.marks !== 1 ? 's' : ''}
                    {item.awarded > 0 && item.awarded < item.marks && (
                      <span style={{ color: cfg.text }}> · {item.awarded} awarded</span>
                    )}
                  </p>
                </div>
                <span className="text-xs flex-shrink-0" style={{ color: cfg.text, marginTop: 1 }}>
                  {item.category === 'correct'
                    ? `+${item.marks}`
                    : item.category === 'partial'
                    ? `+${item.awarded}`
                    : item.category === 'text'
                    ? 'Manual'
                    : '—'}
                </span>
                <Eye
                  size={11} strokeWidth={1.5}
                  style={{ color: '#C4C3BD', flexShrink: 0, marginTop: 2, transform: isOpen ? 'rotate(0deg)' : 'rotate(0deg)', opacity: isOpen ? 0.8 : 0.4 }}
                />
              </button>

              {/* Expanded detail */}
              {isOpen && (
                <div className="px-3 py-3 flex flex-col gap-2.5"
                  style={{ background: '#FFFFFF', borderTop: `1px solid ${cfg.border}` }}>

                  {/* Full stem */}
                  <div>
                    <p className="text-xs mb-1" style={{ color: '#9A9891' }}>Question</p>
                    <p className="text-xs" style={{ color: '#0C0C0B', lineHeight: 1.6 }}>{q.stem}</p>
                  </div>

                  {/* Student answer */}
                  <div>
                    <p className="text-xs mb-1" style={{ color: '#9A9891' }}>Student's answer</p>
                    <p className="text-xs px-2.5 py-2"
                      style={{
                        background: item.category === 'unattempted' ? '#F7F6F3' : cfg.bg,
                        border: `1px solid ${item.category === 'unattempted' ? '#E3E1DB' : cfg.border}`,
                        borderRadius: 2, color: '#0C0C0B', lineHeight: 1.6,
                      }}>
                      {item.category === 'unattempted'
                        ? <span style={{ color: '#C4C3BD' }}>Not answered</span>
                        : studentAnswerText}
                    </p>
                  </div>

                  {/* Correct answer (MCQ / match / text model) */}
                  {correctAnswerText && item.category !== 'correct' && (
                    <div>
                      <p className="text-xs mb-1" style={{ color: '#9A9891' }}>
                        {q.engine === 'text' ? 'Model answer' : 'Correct answer'}
                      </p>
                      <p className="text-xs px-2.5 py-2"
                        style={{
                          background: '#F0F9F4', border: '1px solid #B8E6C8',
                          borderRadius: 2, color: '#1E7B3C', lineHeight: 1.6,
                        }}>
                        {correctAnswerText}
                      </p>
                    </div>
                  )}

                  {/* Explanation */}
                  {q.explanation && (
                    <div>
                      <p className="text-xs mb-1" style={{ color: '#9A9891' }}>Explanation</p>
                      <p className="text-xs" style={{ color: '#4A4A45', lineHeight: 1.6 }}>{q.explanation}</p>
                    </div>
                  )}

                  {/* Text note */}
                  {item.category === 'text' && (
                    <div className="flex items-start gap-2 px-2.5 py-2"
                      style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 2 }}>
                      <FileText size={11} strokeWidth={1.5} style={{ color: '#1D4ED8', flexShrink: 0, marginTop: 1 }} />
                      <p className="text-xs" style={{ color: '#1D4ED8', lineHeight: 1.5 }}>
                        Text answers require manual review and grading.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SOFT-DELETE CONFIRM MODAL
// ══════════════════════════════════════════════════════════════════

function SoftDeleteConfirmModal({
  attemptNumber,
  loading,
  onConfirm,
  onCancel,
}: {
  attemptNumber: number;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.36)' }}
      onClick={onCancel}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="w-full"
        style={{ maxWidth: 380, background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid #E3E1DB' }}>
          <div className="flex items-center gap-2">
            <Trash2 size={13} strokeWidth={1.5} style={{ color: '#9B2828' }} />
            <p className="text-xs" style={{ color: '#0C0C0B', letterSpacing: '0.06em' }}>DELETE ATTEMPT</p>
          </div>
          <button onClick={onCancel} className="p-1 hover:opacity-60 transition-opacity" style={{ color: '#C4C3BD' }}>
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        <div className="px-5 py-5 space-y-4">
          <div className="px-3 py-3 flex items-start gap-2.5"
            style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
            <Trash2 size={12} strokeWidth={1.5} style={{ color: '#9B2828', flexShrink: 0, marginTop: 1 }} />
            <p className="text-xs" style={{ color: '#9B2828', lineHeight: 1.6 }}>
              Attempt #{attemptNumber} will be hidden from the live roster. The record is
              preserved and will appear in this student's history with a "Deleted" label.
              This cannot be undone from the UI.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderTop: '1px solid #E3E1DB' }}>
          <button
            onClick={onConfirm} disabled={loading}
            className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
            style={{
              background: loading ? '#FCA5A5' : '#9B2828', color: '#FFFFFF', borderRadius: 2,
              cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? <><Loader2 size={10} className="animate-spin" /> Deleting…</> : <><Trash2 size={10} strokeWidth={1.5} /> Delete attempt</>}
          </button>
          <button onClick={onCancel} disabled={loading}
            className="text-xs px-4 py-2.5 transition-opacity hover:opacity-70"
            style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}>
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// ATTEMPTS HISTORY + OVERRIDE PANEL (inside drawer)
// ══════════════════════════════════════════════════════════════════

function AttemptsPanel({
  assessmentId,
  studentId,
  assessment,
  canManageAttempts,
  canDeleteAttempts,
  onOverrideSaved,
  onRequestDelete,
}: {
  assessmentId: string;
  studentId: string;
  assessment: Assessment;
  /** Owner-only (rules: canWriteOwned) — hides the override control on
   *  exams this viewer doesn't own instead of offering a button that
   *  always fails permission-denied. */
  canManageAttempts: boolean;
  /** webOwner ONLY (audit S-03). Deliberately NOT canManageAttempts,
   *  which is owner-based: the owning institute is exactly the principal
   *  that must not be able to delete attempts, since they are the
   *  evidence of what happened in its own exam. */
  canDeleteAttempts: boolean;
  onOverrideSaved: () => void;
  onRequestDelete: (attemptId: string, attemptNumber: number) => void;
}) {
  const [allAttempts, setAllAttempts] = useState<Attempt[]>([]);
  const [histLoading, setHistLoading] = useState(true);
  const [overrideInput, setOverrideInput] = useState('');
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [overrideFeedback, setOverrideFeedback] = useState('');

  // Load all attempts (including soft-deleted — shown in history with badge)
  const loadHistory = useCallback(() => {
    setHistLoading(true);
    getAllAttemptsByStudentAndAssessment(studentId, assessmentId)
      .then(setAllAttempts)
      .catch(() => {})
      .finally(() => setHistLoading(false));
  }, [studentId, assessmentId]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Derive limits
  const globalMax  = assessment.maxAttempts ?? 1;
  const override   = assessment.attemptOverrides?.[studentId];
  const effectiveMax = override ?? globalMax;

  const finished = allAttempts.filter(
    (a) => a.status === 'submitted' || a.status === 'auto_submitted' || a.status === 'terminated'
  ).length;
  const inProgress = allAttempts.some((a) => a.status === 'in_progress');

  // Initialise input from existing override
  useEffect(() => {
    setOverrideInput(override !== undefined ? String(override) : '');
  }, [override]);

  const saveOverride = async () => {
    const parsed = overrideInput === '' ? null : parseInt(overrideInput, 10);
    if (parsed !== null && (isNaN(parsed) || parsed < 1)) return;
    setOverrideSaving(true);
    try {
      await setAttemptOverride(assessmentId, studentId, parsed);
      onOverrideSaved();
      setOverrideFeedback('Saved');
      setTimeout(() => setOverrideFeedback(''), 2000);
    } catch {
      setOverrideFeedback('Failed');
      setTimeout(() => setOverrideFeedback(''), 2000);
    } finally {
      setOverrideSaving(false);
    }
  };

  const clearOverride = async () => {
    setOverrideSaving(true);
    try {
      await setAttemptOverride(assessmentId, studentId, null);
      onOverrideSaved();
      setOverrideInput('');
      setOverrideFeedback('Cleared');
      setTimeout(() => setOverrideFeedback(''), 2000);
    } catch {
      setOverrideFeedback('Failed');
      setTimeout(() => setOverrideFeedback(''), 2000);
    } finally {
      setOverrideSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Attempt count summary */}
      <div className="flex items-center gap-4">
        <div className="flex-1 px-3 py-3"
          style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}>
          <p className="text-xs mb-0.5" style={{ color: '#9A9891' }}>Attempts used</p>
          <p className="text-xs" style={{ color: '#0C0C0B' }}>
            {histLoading ? '…' : finished}
            {effectiveMax !== undefined && !histLoading && (
              <span style={{ color: '#9A9891' }}> / {effectiveMax}</span>
            )}
            {effectiveMax === undefined && !histLoading && (
              <span style={{ color: '#C4C3BD' }}> / ∞</span>
            )}
          </p>
        </div>
        {effectiveMax !== undefined && !histLoading && (
          <div className="flex-1 px-3 py-3"
            style={{
              background: finished >= effectiveMax ? '#FDF5F5' : '#F0F9F4',
              border: `1px solid ${finished >= effectiveMax ? '#F2CECE' : '#B8E6C8'}`,
              borderRadius: 2,
            }}>
            <p className="text-xs mb-0.5" style={{ color: '#9A9891' }}>Status</p>
            <p className="text-xs"
              style={{ color: finished >= effectiveMax ? '#9B2828' : '#1E7B3C' }}>
              {finished >= effectiveMax
                ? 'Limit reached'
                : inProgress
                ? 'In progress'
                : `${effectiveMax - finished} remaining`}
            </p>
          </div>
        )}
      </div>

      {/* Global limit display */}
      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: '#9A9891' }}>
          Global limit:{' '}
          <span style={{ color: '#4A4A45' }}>
            {globalMax !== undefined ? `${globalMax} attempt${globalMax !== 1 ? 's' : ''}` : 'Unlimited'}
          </span>
        </p>
        {override !== undefined && (
          <div className="flex items-center gap-1 px-2 py-0.5"
            style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 2 }}>
            <Hash size={9} strokeWidth={1.5} style={{ color: '#1D4ED8' }} />
            <span className="text-xs" style={{ color: '#1D4ED8' }}>Override active: {override}</span>
          </div>
        )}
      </div>

      {/* Per-student override control — owner-only (writes are blocked by
          rules for non-owners; don't render a control that can only fail) */}
      {canManageAttempts && (
      <div>
        <p className="text-xs mb-1.5" style={{ color: '#6B6B66' }}>
          Student override <span style={{ color: '#C4C3BD' }}>(blank = use global limit)</span>
        </p>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 px-2.5 py-1.5 flex-1"
            style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
            <Hash size={10} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
            <input
              type="number"
              min="1"
              value={overrideInput}
              onChange={(e) => setOverrideInput(e.target.value)}
              placeholder={globalMax !== undefined ? String(globalMax) : 'unlimited'}
              className="flex-1 outline-none text-xs"
              style={{ background: 'transparent', color: '#0C0C0B' }}
            />
          </div>
          <button
            onClick={saveOverride}
            disabled={overrideSaving}
            className="text-xs px-3 py-1.5 transition-opacity flex items-center gap-1"
            style={{
              background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2,
              cursor: overrideSaving ? 'not-allowed' : 'pointer',
              opacity: overrideSaving ? 0.6 : 1,
            }}
          >
            {overrideSaving ? <Loader2 size={9} className="animate-spin" /> : null}
            Save
          </button>
          {override !== undefined && (
            <button
              onClick={clearOverride}
              disabled={overrideSaving}
              className="text-xs px-2.5 py-1.5 transition-opacity flex items-center gap-1"
              style={{
                border: '1px solid #E3E1DB', color: '#9A9891', borderRadius: 2,
                cursor: overrideSaving ? 'not-allowed' : 'pointer',
                background: '#FFFFFF',
              }}
              title="Clear override"
            >
              <RotateCcw size={9} strokeWidth={1.5} />
              Clear
            </button>
          )}
        </div>
        {overrideFeedback && (
          <p className="text-xs mt-1"
            style={{ color: overrideFeedback === 'Saved' || overrideFeedback === 'Cleared' ? '#1E7B3C' : '#9B2828' }}>
            {overrideFeedback}
          </p>
        )}
      </div>
      )}

      {/* Attempt history mini-list */}
      {!histLoading && allAttempts.length > 0 && (
        <div>
          <p className="text-xs mb-2" style={{ color: '#9A9891', letterSpacing: '0.07em' }}>
            HISTORY ({allAttempts.length})
          </p>
          <div className="flex flex-col gap-1">
            {allAttempts.map((a, i) => {
              const done = a.status === 'submitted' || a.status === 'auto_submitted' || a.status === 'terminated';
              const isDeleted = !!a.isDeleted;
              const scoreStr = a.scores
                ? `${a.scores.total}/${a.scores.available} · ${a.scores.percentage}%`
                : null;
              return (
                <div key={a.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                  style={{
                    background: isDeleted ? '#FAFAF8' : '#FAFAF8',
                    border: `1px solid ${isDeleted ? '#F2CECE' : '#F0EFEB'}`,
                    borderRadius: 2, opacity: isDeleted ? 0.65 : 1,
                  }}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs"
                      style={{
                        width: 18, height: 18, borderRadius: 2, display: 'flex', alignItems: 'center',
                        justifyContent: 'center',
                        background: isDeleted ? '#F2CECE' : '#F0EFEB',
                        color: isDeleted ? '#9B2828' : '#9A9891',
                        fontSize: 10, flexShrink: 0,
                      }}>
                      {i + 1}
                    </span>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs" style={{
                          color: isDeleted ? '#9B2828' : '#4A4A45',
                          textTransform: 'capitalize',
                          textDecoration: isDeleted ? 'line-through' : 'none',
                        }}>
                          {a.status.replace('_', ' ')}
                        </p>
                        {isDeleted && (
                          <span className="text-xs px-1.5 py-0.5"
                            style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2, color: '#9B2828', fontSize: 9 }}>
                            Deleted
                          </span>
                        )}
                      </div>
                      <p className="text-xs" style={{ color: '#C4C3BD' }}>
                        {formatRelative(a.startedAt)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {/* Anomaly flag (Phase 1) — at-a-glance signal without expanding */}
                    {a.timingAnalysis && (a.timingAnalysis.anomalyScore ?? 0) >= 40 && (
                      <span
                        title={`Anomaly score ${a.timingAnalysis.anomalyScore}/100`}
                        className="flex items-center gap-1 text-xs px-1.5 py-0.5"
                        style={{
                          background: (a.timingAnalysis.anomalyScore ?? 0) >= 70 ? '#FBF3F3' : '#FEF9EC',
                          border: `1px solid ${(a.timingAnalysis.anomalyScore ?? 0) >= 70 ? '#E3C9C9' : '#F5DFA0'}`,
                          borderRadius: 2,
                          color: (a.timingAnalysis.anomalyScore ?? 0) >= 70 ? '#9B2828' : '#92680A',
                          fontSize: 9,
                        }}>
                        <Flag size={9} strokeWidth={1.5} />
                        {a.timingAnalysis.anomalyScore}
                      </span>
                    )}
                    {scoreStr ? (
                      <span className="text-xs"
                        style={{ color: a.scores?.passed ? '#1E7B3C' : '#9B2828' }}>
                        {scoreStr}
                      </span>
                    ) : done ? (
                      <span className="text-xs" style={{ color: '#C4C3BD' }}>No score</span>
                    ) : (
                      <span className="text-xs" style={{ color: '#1E7B3C' }}>Live</span>
                    )}
                    {/* Soft-delete button — completed, non-deleted attempts, and
                        webOwner ONLY (audit S-03). Attempts are the evidence of
                        what happened in an exam, so no tenant may remove them —
                        not even the institute that owns the assessment. The
                        softDeleteAttempt callable enforces this server-side; this
                        gate exists so staff are not shown a control that can only
                        fail. Previously the button had NO permission gate at all. */}
                    {canDeleteAttempts && done && !isDeleted && (
                      <button
                        onClick={() => onRequestDelete(a.id, i + 1)}
                        className="p-1 transition-opacity hover:opacity-70"
                        title="Delete attempt"
                        style={{ color: '#C4C3BD' }}
                      >
                        <Trash2 size={10} strokeWidth={1.5} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!histLoading && allAttempts.length === 0 && (
        <p className="text-xs" style={{ color: '#C4C3BD' }}>No attempts recorded yet.</p>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// ATTEMPT DETAIL DRAWER
// ══════════════════════════════════════════════════════════════════

function AttemptDrawer({
  row, onClose, onRequestFreeze, onRequestUnfreeze, freezeLoading,
  onRequestBlock, onRequestUnblock, blockLoading,
  assessment, onOverrideSaved, onRequestDelete,
  canSeeResults, canReview, canManageAttempts, canDeleteAttempts,
}: {
  row: RosterRow;
  canSeeResults: boolean;
  canReview: boolean;
  canManageAttempts: boolean;
  canDeleteAttempts: boolean;
  onClose: () => void;
  onRequestFreeze: (attemptId: string, studentName: string) => void;
  onRequestUnfreeze: (attempt: Attempt, studentName: string) => void;
  freezeLoading: boolean;
  onRequestBlock: (studentId: string, studentName: string) => void;
  onRequestUnblock: (studentId: string, studentName: string) => void;
  blockLoading: boolean;
  assessment: Assessment;
  onOverrideSaved: () => void;
  onRequestDelete: (attemptId: string, attemptNumber: number) => void;
}) {
  const { student, attempt, bestAttempt, rosterStatus, isBlocked } = row;
  const canFreeze   = (rosterStatus === 'in_progress') && !!attempt;
  const canUnfreeze = rosterStatus === 'frozen' && !!attempt;

  // ── Which attempt's responses to show ─────────────────────────
  //
  // ResponseViewer used to be hardwired to `attempt` (the latest), so a
  // student's best sitting was unreachable from the drawer — and worse, the
  // whole RESPONSES section was gated on the LATEST attempt's status. A
  // student part-way through a retake therefore showed no responses at all,
  // even though a completed earlier sitting was sitting right there. That is
  // precisely when an invigilator wants to look at the previous one.
  //
  // Tabs appear only when the two are genuinely different attempts. With a
  // single sitting — or when the latest IS the best — Latest and Best would
  // render identical content, so a chooser would be noise.
  const canSwitchResponses =
    !!attempt && !!bestAttempt && bestAttempt.id !== attempt.id;

  const [responseView, setResponseView] = useState<ScoreView>('latest');

  // Default to whichever is actually reviewable. Latest wins when both are,
  // because the drawer's first job is "how did they just do".
  useEffect(() => {
    setResponseView(
      isReviewable(attempt) ? 'latest' : (isReviewable(bestAttempt) ? 'best' : 'latest')
    );
  }, [attempt?.id, bestAttempt?.id]); // eslint-disable-line

  const shownAttempt =
    responseView === 'best' && bestAttempt ? bestAttempt : attempt;

  return (
    <motion.div
      initial={{ x: 380, opacity: 0 }} animate={{ x: 0, opacity: 1 }}
      exit={{ x: 380, opacity: 0 }}
      transition={{ type: 'spring', damping: 28, stiffness: 260 }}
      className="fixed top-0 right-0 bottom-0 z-40 flex flex-col overflow-hidden w-full sm:w-[380px] sm:max-w-full"
      style={{ background: '#FFFFFF', borderLeft: '1px solid #E3E1DB' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 sm:px-5 py-4 flex-shrink-0"
        style={{ borderBottom: '1px solid #E3E1DB' }}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-xs" style={{ color: '#0C0C0B' }}>{student.name}</p>
            {isBlocked && (
              <div className="flex items-center gap-1 px-1.5 py-0.5"
                style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 2 }}>
                <Ban size={9} strokeWidth={1.5} style={{ color: '#9A3412' }} />
                <span style={{ color: '#9A3412', fontSize: 10 }}>Blocked</span>
              </div>
            )}
          </div>
          <p className="text-xs mt-0.5 truncate" style={{ color: '#9A9891' }}>{student.email}</p>
        </div>
        <button onClick={onClose} className="p-1 flex-shrink-0" style={{ color: '#C4C3BD' }}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>

      {/* Status + flag action */}
      <div className="px-4 sm:px-5 py-4 flex-shrink-0" style={{ borderBottom: '1px solid #F0EFEB' }}>
        <div className="flex items-center justify-between">
          <StatusChip status={rosterStatus} />
          {canFreeze && (
            <button
              onClick={() => onRequestFreeze(attempt.id, student.name)}
              disabled={freezeLoading}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-opacity"
              style={{
                background: '#FFFBF0', border: '1px solid #F5DFA0',
                color: '#92680A', borderRadius: 2,
                cursor: freezeLoading ? 'not-allowed' : 'pointer',
                opacity: freezeLoading ? 0.5 : 1,
              }}
            >
              {freezeLoading ? <Loader2 size={10} className="animate-spin" /> : <PauseCircle size={11} strokeWidth={1.5} />}
              Flag session
            </button>
          )}
          {canUnfreeze && (
            <button
              onClick={() => onRequestUnfreeze(attempt, student.name)}
              disabled={freezeLoading}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-opacity"
              style={{
                background: '#F0F9F4', border: '1px solid #B8E6C8',
                color: '#1E7B3C', borderRadius: 2,
                cursor: freezeLoading ? 'not-allowed' : 'pointer',
                opacity: freezeLoading ? 0.5 : 1,
              }}
            >
              {freezeLoading ? <Loader2 size={10} className="animate-spin" /> : <PlayCircle size={11} strokeWidth={1.5} />}
              Clear flag
            </button>
          )}
        </div>

        {rosterStatus === 'frozen' && attempt?.frozenAt && (
          <div className="flex items-start gap-2 mt-3 px-3 py-2.5"
            style={{ background: '#FFFBF0', border: '1px solid #F5DFA0', borderRadius: 2 }}>
            <PauseCircle size={12} strokeWidth={1.5} style={{ color: '#92680A', flexShrink: 0, marginTop: 1 }} />
            <div>
              <p className="text-xs" style={{ color: '#92680A' }}>Flagged {formatRelative(attempt.frozenAt)}</p>
              {attempt.frozenReason && (
                <p className="text-xs mt-0.5" style={{ color: '#92680A', opacity: 0.7 }}>{attempt.frozenReason}</p>
              )}
            </div>
          </div>
        )}

        {attempt?.sessionConflictAt && (
          <div className="flex items-start gap-2 mt-3 px-3 py-2.5"
            style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
            <MonitorSmartphone size={12} strokeWidth={1.5} style={{ color: '#9B2828', flexShrink: 0, marginTop: 1 }} />
            <div>
              <p className="text-xs" style={{ color: '#9B2828' }}>Multi-device conflict detected</p>
              <p className="text-xs mt-0.5" style={{ color: '#9B2828', opacity: 0.7 }}>
                {formatRelative(attempt.sessionConflictAt)}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Block / Unblock section */}
      <div className="px-4 sm:px-5 py-3 flex-shrink-0" style={{ borderBottom: '1px solid #F0EFEB' }}>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
          <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.07em' }}>EXAM ACCESS</p>
          {isBlocked ? (
            <button
              onClick={() => onRequestUnblock(student.id, student.name)}
              disabled={blockLoading}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-opacity"
              style={{
                background: '#F0F9F4', border: '1px solid #B8E6C8',
                color: '#1E7B3C', borderRadius: 2,
                cursor: blockLoading ? 'not-allowed' : 'pointer',
                opacity: blockLoading ? 0.5 : 1,
              }}
            >
              {blockLoading ? <Loader2 size={10} className="animate-spin" /> : <CircleSlash size={10} strokeWidth={1.5} />}
              Unblock student
            </button>
          ) : (
            <button
              onClick={() => onRequestBlock(student.id, student.name)}
              disabled={blockLoading}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-opacity"
              style={{
                background: '#FFF7ED', border: '1px solid #FED7AA',
                color: '#9A3412', borderRadius: 2,
                cursor: blockLoading ? 'not-allowed' : 'pointer',
                opacity: blockLoading ? 0.5 : 1,
              }}
            >
              {blockLoading ? <Loader2 size={10} className="animate-spin" /> : <Ban size={10} strokeWidth={1.5} />}
              Block student
            </button>
          )}
        </div>
        {isBlocked && (
          <p className="text-xs" style={{ color: '#9A3412', lineHeight: 1.5 }}>
            Blocked from entering or re-entering this exam. Any in-progress attempt continues unaffected.
          </p>
        )}
      </div>

      {/* Scrollable detail */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4">
        {!attempt ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <BookOpen size={18} strokeWidth={1} style={{ color: '#C4C3BD' }} />
            <p className="text-xs" style={{ color: '#C4C3BD' }}>Student hasn't started yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div>
              <p className="text-xs mb-2.5" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>PROGRESS</p>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs" style={{ color: '#4A4A45' }}>Questions answered</span>
                  <span className="text-xs" style={{ color: '#0C0C0B' }}>{totalAnswered(attempt)} / {totalQuestions(attempt)}</span>
                </div>
                <div style={{ height: 3, background: '#F0EFEB', borderRadius: 2 }}>
                  <div style={{
                    height: '100%', borderRadius: 2, background: '#0C0C0B',
                    width: `${totalQuestions(attempt) > 0 ? Math.round((totalAnswered(attempt) / totalQuestions(attempt)) * 100) : 0}%`,
                    transition: 'width 0.4s',
                  }} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs" style={{ color: '#4A4A45' }}>Current section</span>
                  <span className="text-xs" style={{ color: '#0C0C0B' }}>{attempt.currentSectionIdx + 1} / {attempt.sectionIds.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs" style={{ color: '#4A4A45' }}>Started</span>
                  <span className="text-xs" style={{ color: '#0C0C0B' }}>{formatRelative(attempt.startedAt)}</span>
                </div>
                {attempt.submittedAt && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: '#4A4A45' }}>Submitted</span>
                    <span className="text-xs" style={{ color: '#0C0C0B' }}>{formatRelative(attempt.submittedAt)}</span>
                  </div>
                )}
              </div>
            </div>

            {attempt.scores && canSeeResults && (
              <div>
                <p className="text-xs mb-2.5" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>SCORE</p>
                <div className="px-4 py-3" style={{ background: '#F7F6F3', borderRadius: 2 }}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs" style={{ color: '#4A4A45' }}>Total marks</span>
                    <span className="text-xs" style={{ color: '#0C0C0B' }}>{attempt.scores.total} / {attempt.scores.available}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: '#4A4A45' }}>Percentage</span>
                    <span className="text-xs" style={{ color: attempt.scores.passed ? '#1E7B3C' : '#9B2828' }}>
                      {attempt.scores.percentage}%{attempt.scores.passed ? ' ✓ Passed' : ' ✗ Failed'}
                    </span>
                  </div>
                  {attempt.scores.requiresManualReview && (
                    <p className="text-xs mt-2" style={{ color: '#92680A' }}>⚠ Contains text answers requiring manual review</p>
                  )}
                </div>
              </div>
            )}

            {/* ── RESPONSES — gated on the SHOWN attempt, not the latest ── */}
            {canReview && isReviewable(shownAttempt) && (
              <div>
                <div className="flex items-center gap-2 mb-2.5 flex-wrap">
                  <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>RESPONSES</p>

                  {/* Latest | Best — only when they are different sittings. */}
                  {canSwitchResponses && (
                    <div className="flex items-center gap-1 ml-auto">
                      {(['latest', 'best'] as const).map((rv) => {
                        const target = rv === 'best' ? bestAttempt! : attempt;
                        const pct = target?.scores?.percentage;
                        const active = responseView === rv;
                        return (
                          <button key={rv} onClick={() => setResponseView(rv)}
                            className="text-xs px-2 py-0.5"
                            style={{
                              borderRadius: 2, cursor: 'pointer',
                              background: active ? '#F0EFEA' : 'transparent',
                              color: active ? '#0C0C0B' : '#9A9891',
                              border: `1px solid ${active ? '#D8D6CF' : 'transparent'}`,
                              fontVariantNumeric: 'tabular-nums',
                            }}>
                            {rv === 'latest' ? 'Latest' : 'Best'}
                            {typeof pct === 'number' && ` · ${pct}%`}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Say plainly which sitting is on screen. Without this the
                    reviewer has no way to tell an older attempt from the
                    current one, and a mark read off the wrong sitting is
                    worse than no mark. */}
                {canSwitchResponses && (
                  <p className="text-xs mb-2" style={{ color: '#9A9891' }}>
                    {responseView === 'best' ? 'Best attempt' : 'Most recent attempt'}
                    {shownAttempt?.startedAt && ` · started ${formatRelative(shownAttempt.startedAt)}`}
                    {shownAttempt?.status === 'terminated' && (
                      <span style={{ color: '#9B2828' }}> · voided</span>
                    )}
                  </p>
                )}

                {/* Latest is still running: the reviewer is looking at an
                    earlier sitting, and should know that. */}
                {!isReviewable(attempt) && responseView === 'best' && (
                  <p className="text-xs mb-2" style={{ color: '#92680A' }}>
                    Their current sitting is still in progress — this is an earlier attempt.
                  </p>
                )}

                <ResponseViewer attempt={shownAttempt!} assessment={assessment} />
              </div>
            )}
            {!canReview && isReviewable(shownAttempt) && (
              <p className="text-xs" style={{ color: '#9A9891', lineHeight: 1.6 }}>
                Question review is not enabled for your role on this exam — the
                exam owner controls this in the assessment's visibility settings.
              </p>
            )}

            <div>
              <p className="text-xs mb-2.5" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>INTEGRITY</p>

              {/* Anomaly score (Phase 1 timing analytics) — headline reviewer signal */}
              {attempt.timingAnalysis && (() => {
                const a = attempt.timingAnalysis;
                const score = a.anomalyScore ?? 0;
                const band =
                  score >= 70 ? { bg: '#FBF3F3', bd: '#E3C9C9', fg: '#9B2828', label: 'High anomaly' }
                  : score >= 40 ? { bg: '#FEF9EC', bd: '#F5DFA0', fg: '#92680A', label: 'Some anomaly' }
                  : { bg: '#F0F9F4', bd: '#B8E6C8', fg: '#1E7B3C', label: 'Low anomaly' };
                return (
                  <div className="mb-2.5">
                    <div className="flex items-center justify-between px-3 py-2.5 mb-1.5"
                      style={{ background: band.bg, border: `1px solid ${band.bd}`, borderRadius: 2 }}>
                      <span className="text-xs" style={{ color: band.fg }}>{band.label}</span>
                      <span className="text-xs" style={{ color: band.fg, fontWeight: 500 }}>
                        {score}/100
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      {[
                        { label: 'Answers in final 30s', value: `${a.burstLast30s}/${a.totalAnswers}` },
                        { label: 'Fastest answer gap', value: a.minGapSeconds !== null ? `${a.minGapSeconds.toFixed(1)}s` : '—' },
                        ...(a.heartbeatGaps > 0
                          ? [{ label: 'Connectivity/heartbeat gap', value: `${a.maxHeartbeatGapSeconds}s` }]
                          : []),
                      ].map((item) => (
                        <div key={item.label} className="flex items-center justify-between px-3 py-1.5"
                          style={{ background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                          <span className="text-xs" style={{ color: '#6B6B66' }}>{item.label}</span>
                          <span className="text-xs" style={{ color: '#4A4A45' }}>{item.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Finalized-while-frozen flag (Phase 1c) */}
              {(attempt.integrityLog as { finalizedWhileFrozen?: boolean }).finalizedWhileFrozen && (
                <div className="flex items-center gap-2 px-3 py-2 mb-2.5"
                  style={{ background: '#FBF3F3', border: '1px solid #E3C9C9', borderRadius: 2 }}>
                  <Flag size={11} strokeWidth={1.5} style={{ color: '#9B2828' }} />
                  <span className="text-xs" style={{ color: '#9B2828' }}>
                    Submitted while frozen (unresolved extension freeze)
                  </span>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                {[
                  { label: 'Tab switches', value: attempt.integrityLog.tabSwitches },
                  { label: 'Focus losses', value: attempt.integrityLog.focusLosses },
                  { label: 'Fullscreen exits', value: attempt.integrityLog.fullscreenExits },
                  { label: 'Copy attempts', value: attempt.integrityLog.copyAttempts },
                  { label: 'Multi-person events', value: attempt.integrityLog.multiPersonEvents },
                  { label: 'Face absence events', value: attempt.integrityLog.faceAbsenceEvents },
                  { label: 'Extension events', value: attempt.integrityLog.extensionEvents },
                ].map((item) => item.value > 0 ? (
                  <div key={item.label} className="flex items-center justify-between px-3 py-2"
                    style={{ background: '#FEF9EC', border: '1px solid #F5DFA0', borderRadius: 2 }}>
                    <span className="text-xs" style={{ color: '#92680A' }}>{item.label}</span>
                    <span className="text-xs" style={{ color: '#92680A' }}>{item.value}</span>
                  </div>
                ) : null)}
                {attempt.integrityLog.totalViolations === 0 && (
                  <div className="flex items-center gap-2 px-3 py-2"
                    style={{ background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2 }}>
                    <Shield size={11} strokeWidth={1.5} style={{ color: '#1E7B3C' }} />
                    <span className="text-xs" style={{ color: '#1E7B3C' }}>No violations recorded</span>
                  </div>
                )}
              </div>
            </div>

            {attempt.integrityLog.violations.length > 0 && (
              <div>
                <p className="text-xs mb-2.5" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>VIOLATION TIMELINE</p>
                <div className="flex flex-col gap-1">
                  {[...attempt.integrityLog.violations]
                    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                    .slice(0, 15)
                    .map((v, i) => (
                      <div key={i} className="flex items-start justify-between gap-2 py-1.5"
                        style={{ borderBottom: '1px solid #F0EFEB' }}>
                        <span className="text-xs" style={{ color: '#4A4A45', textTransform: 'capitalize' }}>
                          {v.type.replace(/_/g, ' ')}{v.warningNumber ? ` (warning ${v.warningNumber})` : ''}
                        </span>
                        <span className="text-xs flex-shrink-0" style={{ color: '#C4C3BD' }}>
                          {formatRelative(v.timestamp)}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* ── ATTEMPTS section ── */}
            <div>
              <p className="text-xs mb-2.5" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>ATTEMPTS</p>
              <AttemptsPanel
                assessmentId={assessment.id}
                studentId={student.id}
                assessment={assessment}
                canManageAttempts={canManageAttempts}
                canDeleteAttempts={canDeleteAttempts}
                onOverrideSaved={onOverrideSaved}
                onRequestDelete={onRequestDelete}
              />
            </div>

          </div>
        )}
      </div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// ROSTER TABLE ROW
// ══════════════════════════════════════════════════════════════════

function RosterTableRow({
  row, onSelect, onRequestFreeze, onRequestUnfreeze, freezeLoadingId,
  onRequestBlock, onRequestUnblock, blockLoadingId,
  attemptOverrides, sections, nowMs, scoreView,
}: {
  row: RosterRow;
  scoreView: ScoreView;
  onSelect: () => void;
  onRequestFreeze: (attemptId: string, studentName: string) => void;
  onRequestUnfreeze: (attempt: Attempt, studentName: string) => void;
  freezeLoadingId: string | null;
  onRequestBlock: (studentId: string, studentName: string) => void;
  onRequestUnblock: (studentId: string, studentName: string) => void;
  blockLoadingId: string | null;
  attemptOverrides?: Record<string, number>;
  sections: AssessmentSection[];
  nowMs: number;
}) {
  const { student, attempt, bestAttempt, rosterStatus, isBlocked } = row;
  const isLive    = rosterStatus === 'in_progress';
  const breakInfo = attempt && isLive ? getBreakState(attempt, sections, nowMs) : null;
  const isFrozen  = rosterStatus === 'frozen';
  const isDone    = rosterStatus === 'submitted' || rosterStatus === 'auto_submitted' || rosterStatus === 'terminated';
  const freezeLoading = freezeLoadingId === (attempt?.id ?? '');
  const blockLoading  = blockLoadingId === student.id;
  const violations = attempt?.integrityLog.totalViolations ?? 0;
  const hasConflict = !!attempt?.sessionConflictAt;
  const attemptCount = row.attemptCount ?? (attempt ? 1 : 0);
  // Two figures are only worth the space when they actually differ. When the
  // latest sitting is also the best one, a single score plus a marker says
  // more with less.
  const showBothScores =
    attemptCount > 1 &&
    !!bestAttempt?.scores &&
    !!attempt?.scores &&
    bestAttempt.id !== attempt.id;

  return (
    <div
      className="flex flex-wrap sm:flex-nowrap items-start sm:items-center gap-x-3 gap-y-2 sm:gap-4 px-4 sm:px-5 py-3 sm:py-3.5 cursor-pointer transition-colors"
      style={{ borderBottom: '1px solid #F7F6F3' }}
      onClick={onSelect}
      onMouseEnter={(e) => (e.currentTarget.style.background = '#FAFAF9')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <div className="w-full sm:w-[200px] sm:flex-shrink-0 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className="text-xs truncate" style={{ color: '#0C0C0B' }}>{student.name}</p>
          {/* Multiple sittings: the row shows only the LATEST. Without this
              badge a second attempt is invisible from the list, and staff have
              no cue that the score they are reading is one of several. */}
          {attemptCount > 1 && (
            <span
              className="text-xs px-1.5 flex-shrink-0"
              title={`${attemptCount} attempts — showing the most recent. Open to see all.`}
              style={{
                background: '#F0EFEA', border: '1px solid #E3E1DB', borderRadius: 2,
                color: '#6B6A64', fontVariantNumeric: 'tabular-nums', lineHeight: '16px',
              }}
            >
              ×{attemptCount}
            </span>
          )}
        </div>
        <p className="text-xs mt-0.5 truncate" style={{ color: '#C4C3BD' }}>{student.email}</p>
      </div>

      <div className="sm:w-[130px] sm:flex-shrink-0">
        {breakInfo ? (
          <div className="flex items-center gap-1.5 px-2 py-0.5"
            style={{ background: '#FEF9EC', border: '1px dashed #F5DFA0', borderRadius: 2 }}>
            <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#D4A017' }} />
            <span className="text-xs" style={{ color: '#92680A', fontVariantNumeric: 'tabular-nums' }}>
              {breakInfo.expired
                ? 'Break ended'
                : `On break · ${Math.floor(breakInfo.secondsRemaining / 60)}:${(breakInfo.secondsRemaining % 60).toString().padStart(2, '0')}`}
            </span>
          </div>
        ) : (
          <StatusChip status={rosterStatus} />
        )}
      </div>

      <div className="w-full sm:flex-1 sm:min-w-0">
        {attempt && isLive && breakInfo && (
          <p className="text-xs" style={{ color: '#92680A' }}>
            After: {breakInfo.nextSectionName}
          </p>
        )}
        {attempt && isLive && !breakInfo && (
          <p className="text-xs" style={{ color: '#4A4A45' }}>
            Section {attempt.currentSectionIdx + 1}/{attempt.sectionIds.length}
            {' · '}{totalAnswered(attempt)}/{totalQuestions(attempt)} answered
          </p>
        )}
        {attempt && isFrozen && (
          <p className="text-xs" style={{ color: '#1D4ED8' }}>Paused {formatRelative(attempt.frozenAt!)}</p>
        )}
        {attempt && isDone && attempt.scores && (
          showBothScores ? (
            /* ── Multiple sittings with different marks ──────────────
               Both figures inline, the one matching the current view in full
               contrast and the other muted. Seeing the pair at a glance is the
               point: a wide gap between latest and best is exactly the signal
               — a student who peaked and fell back reads very differently from
               one still climbing, and neither is visible from a single mark. */
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs" style={{
                color: scoreView === 'latest' ? '#0C0C0B' : '#9A9891',
                fontVariantNumeric: 'tabular-nums',
              }}>
                Latest: {attempt.scores.percentage}%
              </span>
              <span className="text-xs" style={{ color: '#E3E1DB' }}>|</span>
              <span className="text-xs" style={{
                color: scoreView === 'best' ? '#1E7B3C' : '#9A9891',
                fontVariantNumeric: 'tabular-nums',
              }}>
                Best: {bestAttempt!.scores!.percentage}%
              </span>
            </div>
          ) : (
            <p className="text-xs" style={{ color: '#4A4A45' }}>
              {attempt.scores.total}/{attempt.scores.available} marks · {attempt.scores.percentage}%
              {/* Their most recent sitting IS their best — worth saying, so a
                  ×3 badge with no second figure isn't read as missing data. */}
              {attemptCount > 1 && <span style={{ color: '#1E7B3C' }}> · best</span>}
            </p>
          )
        )}
        {attempt && isDone && !attempt.scores && (
          <p className="text-xs" style={{ color: '#C4C3BD' }}>
            Awaiting score
            {/* An ungraded latest attempt would otherwise hide a graded earlier
                one entirely — the row would read as if nothing was marked. */}
            {bestAttempt?.scores && (
              <span style={{ color: '#4A4A45' }}>
                {' · '}Best: {bestAttempt.scores.percentage}%
              </span>
            )}
          </p>
        )}
        {!attempt && <p className="text-xs" style={{ color: '#C4C3BD' }}>—</p>}
      </div>

      {/* Badges */}
      <div className="flex flex-wrap items-center gap-2 flex-shrink-0">
        {/* Override badge */}
        {attemptOverrides?.[student.id] !== undefined && (
          <div className="flex items-center gap-1 px-2 py-1"
            style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 2 }}>
            <Hash size={9} strokeWidth={1.5} style={{ color: '#1D4ED8' }} />
            <span className="text-xs" style={{ color: '#1D4ED8' }}>
              {attemptOverrides[student.id]}
            </span>
          </div>
        )}
        {isBlocked && (
          <div className="flex items-center gap-1 px-2 py-1"
            style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 2 }}>
            <Ban size={10} strokeWidth={1.5} style={{ color: '#9A3412' }} />
            <span className="text-xs" style={{ color: '#9A3412' }}>Blocked</span>
          </div>
        )}
        {hasConflict && (
          <div className="flex items-center gap-1 px-2 py-1"
            style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
            <MonitorSmartphone size={10} strokeWidth={1.5} style={{ color: '#9B2828' }} />
            <span className="text-xs" style={{ color: '#9B2828' }}>Conflict</span>
          </div>
        )}
        {violations > 0 && (
          <div className="flex items-center gap-1 px-2 py-1"
            style={{
              background: violations >= 3 ? '#FDF5F5' : '#FEF9EC',
              border: `1px solid ${violations >= 3 ? '#F2CECE' : '#F5DFA0'}`, borderRadius: 2,
            }}>
            <Shield size={10} strokeWidth={1.5} style={{ color: violations >= 3 ? '#9B2828' : '#92680A' }} />
            <span className="text-xs" style={{ color: violations >= 3 ? '#9B2828' : '#92680A' }}>{violations}</span>
          </div>
        )}
      </div>

      {/* Primary action — click intercepted, does NOT propagate to row select */}
      <div className="flex-shrink-0" onClick={(e) => e.stopPropagation()}>
        {isLive && attempt && (
          <button
            onClick={() => onRequestFreeze(attempt.id, student.name)}
            disabled={freezeLoading}
            className="flex items-center gap-1 text-xs px-3 py-1.5 transition-opacity"
            style={{
              border: '1px solid #F5DFA0', color: '#92680A', background: '#FFFBF0', borderRadius: 2,
              cursor: freezeLoading ? 'not-allowed' : 'pointer',
              opacity: freezeLoading ? 0.5 : 1,
            }}
          >
            {freezeLoading ? <Loader2 size={9} className="animate-spin" /> : <PauseCircle size={10} strokeWidth={1.5} />}
            Flag
          </button>
        )}
        {isFrozen && attempt && (
          <button
            onClick={() => onRequestUnfreeze(attempt, student.name)}
            disabled={freezeLoading}
            className="flex items-center gap-1 text-xs px-3 py-1.5 transition-opacity"
            style={{
              border: '1px solid #B8E6C8', color: '#1E7B3C', background: '#F0F9F4', borderRadius: 2,
              cursor: freezeLoading ? 'not-allowed' : 'pointer',
              opacity: freezeLoading ? 0.5 : 1,
            }}
          >
            {freezeLoading ? <Loader2 size={9} className="animate-spin" /> : <PlayCircle size={10} strokeWidth={1.5} />}
            Clear
          </button>
        )}
        {!isLive && !isFrozen && isBlocked && (
          <button
            onClick={() => onRequestUnblock(student.id, student.name)}
            disabled={blockLoading}
            className="flex items-center gap-1 text-xs px-3 py-1.5 transition-opacity"
            style={{
              border: '1px solid #B8E6C8', color: '#1E7B3C', background: '#F0F9F4', borderRadius: 2,
              cursor: blockLoading ? 'not-allowed' : 'pointer',
              opacity: blockLoading ? 0.5 : 1,
            }}
          >
            {blockLoading ? <Loader2 size={9} className="animate-spin" /> : <CircleSlash size={10} strokeWidth={1.5} />}
            Unblock
          </button>
        )}
        {!isLive && !isFrozen && !isBlocked && rosterStatus === 'not_started' && (
          <button
            onClick={() => onRequestBlock(student.id, student.name)}
            disabled={blockLoading}
            className="flex items-center gap-1 text-xs px-3 py-1.5 transition-opacity"
            style={{
              border: '1px solid #FED7AA', color: '#9A3412', background: '#FFF7ED', borderRadius: 2,
              cursor: blockLoading ? 'not-allowed' : 'pointer',
              opacity: blockLoading ? 0.5 : 1,
            }}
          >
            {blockLoading ? <Loader2 size={9} className="animate-spin" /> : <Ban size={10} strokeWidth={1.5} />}
            Block
          </button>
        )}
      </div>

      <ChevronRight size={13} strokeWidth={1.5} className="hidden sm:block" style={{ color: '#E3E1DB', flexShrink: 0 }} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════════

interface AssessmentRosterCoreProps {
  assessmentId: string;
  invigId: string;
  instituteId: string | null;
  onBack: () => void;
  reviewerRole?: 'web_owner' | 'institute' | 'faculty';
}

export function AssessmentRosterCore({
  assessmentId, invigId, instituteId, onBack,
  reviewerRole = 'web_owner',
}: AssessmentRosterCoreProps) {
  const [view, setView] = useState<'roster' | 'reports'>('roster');
  // Latest vs Best is a DISPLAY choice only — see the note on RosterRow.attempt.
  // Latest is the default because the roster's first job is live monitoring.
  const [scoreView, setScoreView] = useState<ScoreView>('latest');
  // (guarded below: the reports view renders only when canReview)
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [students, setStudents]     = useState<Student[]>([]);
  // False when the roster is a conservative superset rather than the exact
  // allocated list — see resolveAllocatedStudents. Drives the banner below.
  const [rosterExact, setRosterExact] = useState(true);
  const [attempts, setAttempts]     = useState<Attempt[]>([]);
  const [loading, setLoading]       = useState(true);
  const [errorMsg, setErrorMsg]     = useState('');
  const [liveConnected, setLiveConnected] = useState(false);

  const [search, setSearch]             = useState('');
  const [filterStatus, setFilterStatus] = useState<RosterStatus | 'all' | 'blocked'>('all');
  const [selectedRow, setSelectedRow]   = useState<RosterRow | null>(null);
  const [freezeLoadingId, setFreezeLoadingId] = useState<string | null>(null);
  const [blockLoadingId,  setBlockLoadingId]  = useState<string | null>(null);

  // ── Confirmation modal state ───────────────────────────────────
  const [pendingFreeze,   setPendingFreeze]   = useState<{ attemptId: string; studentName: string } | null>(null);
  const [pendingUnfreeze, setPendingUnfreeze] = useState<{ attempt: Attempt; studentName: string } | null>(null);
  const [pendingBlock,    setPendingBlock]    = useState<{ studentId: string; studentName: string } | null>(null);
  const [pendingUnblock,  setPendingUnblock]  = useState<{ studentId: string; studentName: string } | null>(null);
  const [pendingDelete,   setPendingDelete]   = useState<{ attemptId: string; attemptNumber: number } | null>(null);
  const [deleteLoading,   setDeleteLoading]   = useState(false);
  const [showExport,      setShowExport]      = useState(false);

  // Per-second tick to drive the "On break" countdown pill on roster rows.
  // A single shared timer avoids one interval per row.
  const [breakTick, setBreakTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setBreakTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Initial load ───────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [a, allStudents] = await Promise.all([
          getAssessment(assessmentId),
          instituteId ? getStudentsByInstitute(instituteId) : getAllStudents(),
        ]);
        if (!a) { setErrorMsg('Assessment not found.'); setLoading(false); return; }
        setAssessment(a);

        // Targeting is resolved centrally — this component must NOT branch on
        // assignedTo. A rule-allocated exam stores an empty assignedTo, so the
        // old inline filter returned zero students for every hierarchy exam
        // while they were in fact allocated and sitting it.
        //
        // canReadMembers: assessmentMembers is webOwner-only in firestore.rules.
        const { students: relevant, exact } = await resolveAllocatedStudents(
          a,
          allStudents,
          { canReadMembers: reviewerRole === 'web_owner' },
        );
        setStudents(relevant);
        setRosterExact(exact);
      } catch (e: any) {
        setErrorMsg(e.message || 'Failed to load roster.');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [assessmentId, instituteId, reviewerRole]);

  // ── Live attempts — filter out soft-deleted from active roster ─
  useEffect(() => {
    // instituteId scopes the query so the attempts read rule is provable for
    // institute/faculty; webOwner passes null and subscribes unscoped.
    const unsub = subscribeToAttemptsByAssessment(assessmentId, (live) => {
      setAttempts(live.filter((a) => !a.isDeleted));
      setLiveConnected(true);
    }, instituteId);
    return () => unsub();
  }, [assessmentId, instituteId]);

  // ── Live assessment refresh (to keep blockedStudents fresh) ────
  const refreshAssessment = useCallback(async () => {
    const a = await getAssessment(assessmentId);
    if (a) setAssessment(a);
  }, [assessmentId]);

  // ── Build roster rows ──────────────────────────────────────────
  const blockedSet = useMemo(
    () => new Set(assessment?.blockedStudents ?? []),
    [assessment?.blockedStudents]
  );

  // ── Viewer visibility (N5 final form) ──────────────────────────
  // fullAccess: webOwner anywhere, or the assessment's owning institute /
  // faculty. Non-owners are gated by the owner's audience settings:
  //   canSeeResults → SCORE detail in the drawer
  //   canReview     → RESPONSES (questions + answers + keys) and the
  //                   Reports (triage) view — a triage queue without
  //                   question access can't be actioned, so it's hidden.
  // Server enforces the keys (getAnswerKeysForReview); this drives the UI.
  // Attempt-override writes are owner-only in the rules (canWriteOwned),
  // so the override control follows fullAccess.
  const viewerAudience: VisibilityAudience | null =
    reviewerRole === 'web_owner' ? null : reviewerRole;
  const fullAccess = !assessment ? false
    : reviewerRole === 'web_owner' ? true
    : reviewerRole === 'institute'
      ? assessment.ownerType === 'institute' && assessment.ownerId === instituteId
      : assessment.ownerType === 'faculty'   && assessment.ownerId === invigId;
  const canSeeResults = !assessment ? false
    : fullAccess || (viewerAudience !== null && resultsAudienceAllows(assessment, viewerAudience));
  const canReview = !assessment ? false
    : fullAccess || (viewerAudience !== null && reviewAudienceAllows(assessment, viewerAudience));

  const rows: RosterRow[] = useMemo(() => {
    // ── One row per student, showing their LATEST attempt ─────────
    //
    // This used to be `new Map(attempts.map(a => [a.studentId, a]))`, which is
    // last-write-wins over an UNORDERED snapshot — subscribeToAttemptsByAssessment
    // issues no orderBy. So for a student with several attempts the row showed
    // an arbitrarily chosen one: not the newest, not the best, and liable to
    // change between snapshots. Staff comparing a score against what the
    // student reported could be looking at a different sitting each refresh.
    //
    // Deterministic now: most recent by startedAt, falling back to createdAt
    // and then the doc id so the choice is still stable when timestamps are
    // missing or tie. The count rides along so the row can say "there is more
    // here" — the full list is in the drawer's HISTORY panel, which reads its
    // own query and already handles soft-deleted attempts.
    const grouped = new Map<string, Attempt[]>();
    for (const a of attempts) {
      const list = grouped.get(a.studentId);
      if (list) list.push(a); else grouped.set(a.studentId, [a]);
    }

    return students.map((s) => {
      const mine = grouped.get(s.id) ?? [];
      const latest = mine.length === 0 ? null : mine.reduce((best, cur) => {
        const d = attemptStartedMs(cur) - attemptStartedMs(best);
        if (d !== 0) return d > 0 ? cur : best;
        return cur.id > best.id ? cur : best;   // stable tiebreak
      });
      return {
        student: s,
        attempt: latest,
        bestAttempt: pickBestAttempt(mine),
        attemptCount: mine.length,
        rosterStatus: deriveRosterStatus(latest),
        isBlocked: blockedSet.has(s.id),
      };
    });
  }, [students, attempts, blockedSet]);

  // Only surface the Latest/Best toggle when somebody has actually sat more
  // than once. On a first-run exam it would be a control with no effect, and
  // the roster is busy enough already.
  const anyRetakes = useMemo(() => rows.some((r) => r.attemptCount > 1), [rows]);

  // ── Filter ─────────────────────────────────────────────────────
  const filtered = useMemo(() => rows.filter((row) => {
    const matchSearch = !search ||
      row.student.name.toLowerCase().includes(search.toLowerCase()) ||
      row.student.email.toLowerCase().includes(search.toLowerCase());
    const matchStatus =
      filterStatus === 'all'     ? true :
      filterStatus === 'blocked' ? row.isBlocked :
      row.rosterStatus === filterStatus;
    return matchSearch && matchStatus;
  }), [rows, search, filterStatus]);

  // ── Stats ──────────────────────────────────────────────────────
  const stats = useMemo(() => ({
    total:      rows.length,
    live:       rows.filter((r) => r.rosterStatus === 'in_progress').length,
    frozen:     rows.filter((r) => r.rosterStatus === 'frozen').length,
    submitted:  rows.filter((r) => r.rosterStatus === 'submitted' || r.rosterStatus === 'auto_submitted').length,
    notStarted: rows.filter((r) => r.rosterStatus === 'not_started').length,
    terminated: rows.filter((r) => r.rosterStatus === 'terminated').length,
    conflicts:  rows.filter((r) => !!r.attempt?.sessionConflictAt).length,
    blocked:    rows.filter((r) => r.isBlocked).length,
  }), [rows]);

  // ── Keep drawer in sync with live data ────────────────────────
  useEffect(() => {
    if (!selectedRow) return;
    // Same latest-wins selection as the row list. `find` returned whichever
    // attempt happened to come first in an unordered snapshot, so a student
    // with several sittings could have the drawer re-point at a different one
    // on every tick.
    const mine = attempts.filter((a) => a.studentId === selectedRow.student.id);
    const updatedAttempt = mine.length === 0 ? null : mine.reduce((best, cur) => {
      const d = attemptStartedMs(cur) - attemptStartedMs(best);
      if (d !== 0) return d > 0 ? cur : best;
      return cur.id > best.id ? cur : best;
    });
    setSelectedRow({
      ...selectedRow,
      attempt: updatedAttempt,
      bestAttempt: pickBestAttempt(mine),
      attemptCount: mine.length,
      rosterStatus: deriveRosterStatus(updatedAttempt),
      isBlocked: blockedSet.has(selectedRow.student.id),
    });
  }, [attempts, blockedSet]); // eslint-disable-line

  // ── Keep pendingUnfreeze in sync with live data ────────────────
  // (so the live frozen duration in the modal stays accurate)
  useEffect(() => {
    if (!pendingUnfreeze) return;
    const updatedAttempt = attempts.find((a) => a.id === pendingUnfreeze.attempt.id);
    if (updatedAttempt) {
      setPendingUnfreeze((prev) => prev ? { ...prev, attempt: updatedAttempt } : null);
    }
  }, [attempts]); // eslint-disable-line

  // ── Intercept handlers (open modals) ──────────────────────────
  const handleRequestFreeze = useCallback((attemptId: string, studentName: string) => {
    setPendingFreeze({ attemptId, studentName });
  }, []);

  const handleRequestUnfreeze = useCallback((attempt: Attempt, studentName: string) => {
    setPendingUnfreeze({ attempt, studentName });
  }, []);

  const handleRequestBlock = useCallback((studentId: string, studentName: string) => {
    setPendingBlock({ studentId, studentName });
  }, []);

  const handleRequestUnblock = useCallback((studentId: string, studentName: string) => {
    setPendingUnblock({ studentId, studentName });
  }, []);

  const handleRequestDelete = useCallback((attemptId: string, attemptNumber: number) => {
    setPendingDelete({ attemptId, attemptNumber });
  }, []);

  // ── Execute freeze (called from modal confirm) ─────────────────
  const executeFreeze = useCallback(async (attemptId: string, reason: string) => {
    setPendingFreeze(null);
    setFreezeLoadingId(attemptId);
    try { await freezeAttempt(attemptId, invigId, reason || undefined); }
    catch (e) { console.error('[Roster] freeze failed', e); }
    finally { setFreezeLoadingId(null); }
  }, [invigId]);

  // ── Execute unfreeze (called from modal confirm) ───────────────
  const executeUnfreeze = useCallback(async (
    attempt: Attempt, grantedMs: number, note?: string
  ) => {
    setPendingUnfreeze(null);
    setFreezeLoadingId(attempt.id);
    try { await unfreezeAttempt(attempt.id, grantedMs, note); }
    catch (e) { console.error('[Roster] unfreeze failed', e); }
    finally { setFreezeLoadingId(null); }
  }, []);

  // ── Execute block ──────────────────────────────────────────────
  const executeBlock = useCallback(async (studentId: string) => {
    setPendingBlock(null);
    setBlockLoadingId(studentId);
    try {
      await blockStudent(assessmentId, studentId);
      await refreshAssessment();
    } catch (e) { console.error('[Roster] block failed', e); }
    finally { setBlockLoadingId(null); }
  }, [assessmentId, refreshAssessment]);

  // ── Execute soft delete ────────────────────────────────────────
  const executeSoftDelete = useCallback(async (attemptId: string) => {
    setPendingDelete(null);
    setDeleteLoading(true);
    try { await softDeleteAttempt(attemptId); }
    catch (e) { console.error('[Roster] softDelete failed', e); }
    finally { setDeleteLoading(false); }
  }, []);

  // ── Execute unblock ────────────────────────────────────────────
  const executeUnblock = useCallback(async (studentId: string) => {
    setPendingUnblock(null);
    setBlockLoadingId(studentId);
    try {
      await unblockStudent(assessmentId, studentId);
      await refreshAssessment();
    } catch (e) { console.error('[Roster] unblock failed', e); }
    finally { setBlockLoadingId(null); }
  }, [assessmentId, refreshAssessment]);

  // ── Inject CSS once ────────────────────────────────────────────
  if (typeof document !== 'undefined' && !document.getElementById('roster-blip-css')) {
    const s = document.createElement('style');
    s.id = 'roster-blip-css';
    s.textContent = `@keyframes rosterBlip { 0%,100%{opacity:1} 50%{opacity:0.3} }`;
    document.head.appendChild(s);
  }

  const sc = assessment ? statusColor(assessment.status) : { bg: '#F7F6F3', text: '#9A9891', border: '#E3E1DB' };

  const filterTabs: Array<{ value: RosterStatus | 'all' | 'blocked'; label: string; count: number }> = [
    { value: 'all',          label: 'All',         count: stats.total },
    { value: 'in_progress',  label: 'Live',        count: stats.live },
    { value: 'frozen',       label: 'Flagged',     count: stats.frozen },
    { value: 'blocked',      label: 'Blocked',     count: stats.blocked },
    { value: 'not_started',  label: 'Not started', count: stats.notStarted },
    { value: 'submitted',    label: 'Submitted',   count: stats.submitted },
    { value: 'terminated',   label: 'Terminated',  count: stats.terminated },
  ].filter((t) => t.value === 'all' || t.count > 0);

  // ── Loading / error states ─────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center" style={{ background: '#F7F6F3' }}>
        <Loader2 size={18} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
        <p className="text-xs mt-4" style={{ color: '#C4C3BD' }}>Loading roster…</p>
      </div>
    );
  }

  if (errorMsg || !assessment) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3" style={{ background: '#F7F6F3' }}>
        <AlertTriangle size={18} strokeWidth={1} style={{ color: '#9B2828' }} />
        <p className="text-xs" style={{ color: '#9B2828' }}>{errorMsg || 'Assessment not found.'}</p>
        <button onClick={onBack} className="text-xs px-4 py-2 mt-2"
          style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, cursor: 'pointer' }}>
          Back to Assessments
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F6F3' }}>

      {/* ── Page header ── */}
      <div style={{ background: '#FFFFFF', borderBottom: '1px solid #E3E1DB' }}>
        <div className="px-4 py-4 sm:px-6" style={{ maxWidth: 1100, margin: '0 auto' }}>
          {/* Breadcrumb + title */}
          <div className="flex items-center gap-2 sm:gap-3 mb-4 flex-wrap">
            <button onClick={onBack} className="flex items-center gap-1.5 text-xs flex-shrink-0" style={{ color: '#9A9891', cursor: 'pointer' }}>
              <ArrowLeft size={12} strokeWidth={1.5} /> Assessments
            </button>
            <span className="hidden sm:inline" style={{ color: '#E3E1DB' }}>·</span>
            <p className="text-xs min-w-0 truncate" style={{ color: '#0C0C0B' }}>{assessment.title}</p>
            <span className="text-xs px-2 py-0.5 flex-shrink-0"
              style={{ background: sc.bg, color: sc.text, border: `1px solid ${sc.border}`, borderRadius: 2 }}>
              {assessment.status}
            </span>
            <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
              {liveConnected ? (
                <>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1E7B3C',
                    animation: 'rosterBlip 1.4s ease-in-out infinite' }} />
                  <span className="text-xs" style={{ color: '#1E7B3C' }}>Live</span>
                </>
              ) : (
                <>
                  <WifiOff size={11} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
                  <span className="text-xs" style={{ color: '#C4C3BD' }}>Connecting…</span>
                </>
              )}
            </div>
          </div>

          {/* Approximate-roster notice — only when we could not read the exact
              member list (non-owner staff on a hierarchy exam). Better to say
              so than to present a superset as if it were the allocation. */}
          {!rosterExact && isRuleAllocated(assessment) && (
            <div className="flex items-start gap-2 px-3 py-2 mb-4"
              style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}>
              <AlertCircle size={12} strokeWidth={1.5} style={{ color: '#9A9891', marginTop: 2, flexShrink: 0 }} />
              <p className="text-xs" style={{ color: '#6B6B66', lineHeight: 1.6 }}>
                This exam is allocated by hierarchy. Showing all students in your institute —
                the exact allocated list is visible to the Web Owner. Attempt data below is exact.
              </p>
            </div>
          )}

          {/* Stats */}
          <div className="flex items-center gap-x-4 gap-y-2 sm:gap-5 flex-wrap">
            {[
              { label: 'Total allocated', value: stats.total,      icon: <Users size={11} strokeWidth={1.5} /> },
              { label: 'Live now',        value: stats.live,       icon: <Activity size={11} strokeWidth={1.5} />,      color: stats.live > 0 ? '#1E7B3C' : undefined },
              { label: 'Flagged',         value: stats.frozen,     icon: <PauseCircle size={11} strokeWidth={1.5} />,   color: stats.frozen > 0 ? '#92680A' : undefined },
              { label: 'Blocked',         value: stats.blocked,    icon: <Ban size={11} strokeWidth={1.5} />,           color: stats.blocked > 0 ? '#9A3412' : undefined },
              { label: 'Submitted',       value: stats.submitted,  icon: <CheckCircle2 size={11} strokeWidth={1.5} /> },
              { label: 'Not started',     value: stats.notStarted, icon: <Clock size={11} strokeWidth={1.5} /> },
              ...(stats.conflicts > 0 ? [{ label: 'Conflicts',  value: stats.conflicts,  icon: <MonitorSmartphone size={11} strokeWidth={1.5} />, color: '#9B2828' }] : []),
              ...(stats.terminated > 0 ? [{ label: 'Terminated', value: stats.terminated, icon: <AlertTriangle size={11} strokeWidth={1.5} />,    color: '#9B2828' }] : []),
            ].map((stat) => (
              <div key={stat.label} className="flex items-center gap-1.5">
                <span style={{ color: stat.color ?? '#C4C3BD' }}>{stat.icon}</span>
                <span className="text-xs" style={{ color: stat.color ?? '#9A9891' }}>
                  <strong style={{ color: stat.color ?? '#0C0C0B' }}>{stat.value}</strong>{' '}{stat.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── View toggle: Roster | Reports ── */}
      <div style={{ background: '#FFFFFF', borderBottom: '1px solid #E3E1DB' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}
          className="flex items-center gap-2 px-4 py-2 sm:px-6">
          {(canReview ? (['roster', 'reports'] as const) : (['roster'] as const)).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className="text-xs px-3 py-1.5"
              style={{
                borderRadius: 2, cursor: 'pointer',
                background: view === v ? '#0C0C0B' : 'transparent',
                color: view === v ? '#FFFFFF' : '#9A9891',
                border: view === v ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
              }}>
              {v === 'roster' ? 'Roster' : 'Reports'}
            </button>
          ))}

          {/* ── Score view: Latest | Best ──────────────────────────
              Only rendered once somebody has actually sat more than once.
              On a first-run exam this would be a control that changes
              nothing, and the toolbar is busy enough. */}
          {view === 'roster' && anyRetakes && (
            <div className="flex items-center gap-1 ml-3 pl-3"
              style={{ borderLeft: '1px solid #E3E1DB' }}>
              <span className="text-xs mr-1" style={{ color: '#9A9891' }}>Show</span>
              {(['latest', 'best'] as const).map((sv) => (
                <button key={sv} onClick={() => setScoreView(sv)}
                  title={sv === 'latest'
                    ? 'Emphasise each student\u2019s most recent score'
                    : 'Emphasise each student\u2019s highest score (voided sittings excluded)'}
                  className="text-xs px-2.5 py-1"
                  style={{
                    borderRadius: 2, cursor: 'pointer',
                    background: scoreView === sv ? '#F0EFEA' : 'transparent',
                    color: scoreView === sv ? '#0C0C0B' : '#9A9891',
                    border: `1px solid ${scoreView === sv ? '#D8D6CF' : 'transparent'}`,
                  }}>
                  {sv === 'latest' ? 'Latest' : 'Best'}
                </button>
              ))}
            </div>
          )}
          {/* Export results — one implementation, all three staff roles. */}
          <button
            onClick={() => setShowExport(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 ml-auto transition-opacity hover:opacity-70"
            style={{
              borderRadius: 2, cursor: 'pointer',
              color: '#4A4A45', border: '1px solid #E3E1DB', background: 'transparent',
            }}
          >
            <Download size={11} strokeWidth={1.5} /> Export
          </button>
        </div>
      </div>

      {(view === 'reports' && canReview) ? (
        <div className="px-4 py-6 sm:p-6" style={{ maxWidth: 1100, margin: '0 auto', width: '100%' }}>
          <AssessmentReportsPanel
            assessmentId={assessmentId}
            reviewerId={invigId}
            reviewerRole={reviewerRole}
            instituteId={instituteId}
          />
        </div>
      ) : (
      <>
      {/* ── Toolbar ── */}
      <div style={{ background: '#FFFFFF', borderBottom: '1px solid #E3E1DB' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}
          className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-2.5 sm:px-6">
          <div className="flex items-center gap-2 px-3 py-2 w-full sm:w-[240px] sm:flex-shrink-0"
            style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}>
            <Search size={11} strokeWidth={1.5} style={{ color: '#C4C3BD', flexShrink: 0 }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search students…" className="text-xs outline-none bg-transparent flex-1 min-w-0"
              style={{ color: '#0C0C0B' }} />
          </div>
          <div className="flex items-center gap-1 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap">
            {filterTabs.map((tab) => (
              <button key={tab.value} onClick={() => setFilterStatus(tab.value)}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 flex-shrink-0 whitespace-nowrap"
                style={{
                  borderRadius: 2, cursor: 'pointer',
                  background: filterStatus === tab.value ? '#0C0C0B' : 'transparent',
                  color: filterStatus === tab.value ? '#FFFFFF' : '#9A9891',
                  border: filterStatus === tab.value ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
                }}>
                {tab.label}
                <span style={{
                  background: filterStatus === tab.value ? 'rgba(255,255,255,0.2)' : '#F0EFEB',
                  color: filterStatus === tab.value ? '#FFFFFF' : '#9A9891',
                  borderRadius: 2, padding: '0 4px', fontSize: 10,
                }}>{tab.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Roster table ── */}
      <div className="px-4 py-6 sm:p-6" style={{ maxWidth: 1100, margin: '0 auto', width: '100%' }}>
        <div className="hidden sm:flex items-center gap-4 px-5 pb-2 mb-1" style={{ borderBottom: '1px solid #E3E1DB' }}>
          <div style={{ width: 200, flexShrink: 0 }}><span className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>STUDENT</span></div>
          <div style={{ width: 130, flexShrink: 0 }}><span className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>STATUS</span></div>
          <div style={{ flex: 1 }}><span className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>PROGRESS / SCORE</span></div>
          <div style={{ width: 120, flexShrink: 0 }} />
          <div style={{ width: 86, flexShrink: 0 }}><span className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>ACTION</span></div>
          <div style={{ width: 13, flexShrink: 0 }} />
        </div>

        <div style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3, overflow: 'hidden' }}>
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <Users size={20} strokeWidth={1} style={{ color: '#C4C3BD' }} />
              <p className="text-xs" style={{ color: '#C4C3BD' }}>
                {search || filterStatus !== 'all' ? 'No students match your filters.' : 'No students allocated to this assessment.'}
              </p>
            </div>
          ) : (
            filtered.map((row) => (
              <RosterTableRow
                key={row.student.id}
                row={row}
                onSelect={() => setSelectedRow(row)}
                onRequestFreeze={handleRequestFreeze}
                onRequestUnfreeze={handleRequestUnfreeze}
                freezeLoadingId={freezeLoadingId}
                onRequestBlock={handleRequestBlock}
                onRequestUnblock={handleRequestUnblock}
                blockLoadingId={blockLoadingId}
                attemptOverrides={assessment.attemptOverrides}
                sections={assessment.sections ?? []}
                nowMs={breakTick}
                scoreView={scoreView}
              />
            ))
          )}
        </div>
      </div>

      </>
      )}

      {/* ── Detail drawer ── */}
      <AnimatePresence>
        {selectedRow && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-30" style={{ background: 'rgba(12,12,11,0.2)' }}
              onClick={() => setSelectedRow(null)} />
            <AttemptDrawer
              row={selectedRow}
              canSeeResults={canSeeResults}
              canReview={canReview}
              canManageAttempts={fullAccess}
              canDeleteAttempts={reviewerRole === 'web_owner'}
              onClose={() => setSelectedRow(null)}
              onRequestFreeze={handleRequestFreeze}
              onRequestUnfreeze={handleRequestUnfreeze}
              freezeLoading={freezeLoadingId === (selectedRow.attempt?.id ?? '')}
              onRequestBlock={handleRequestBlock}
              onRequestUnblock={handleRequestUnblock}
              blockLoading={blockLoadingId === selectedRow.student.id}
              onRequestDelete={handleRequestDelete}
              assessment={assessment}
              onOverrideSaved={refreshAssessment}
            />
          </>
        )}
      </AnimatePresence>

      {/* ── Freeze confirmation modal ── */}
      <AnimatePresence>
        {pendingFreeze && (
          <FreezeConfirmModal
            studentName={pendingFreeze.studentName}
            loading={freezeLoadingId === pendingFreeze.attemptId}
            onConfirm={(reason) => executeFreeze(pendingFreeze.attemptId, reason)}
            onCancel={() => setPendingFreeze(null)}
          />
        )}
      </AnimatePresence>

      {/* ── Unfreeze confirmation modal ── */}
      <AnimatePresence>
        {pendingUnfreeze && (
          <UnfreezeConfirmModal
            studentName={pendingUnfreeze.studentName}
            attempt={pendingUnfreeze.attempt}
            loading={freezeLoadingId === pendingUnfreeze.attempt.id}
            onConfirm={(grantedMs, note) =>
              executeUnfreeze(pendingUnfreeze.attempt, grantedMs, note)}
            onCancel={() => setPendingUnfreeze(null)}
          />
        )}
      </AnimatePresence>

      {/* ── Block confirmation modal ── */}
      <AnimatePresence>
        {pendingBlock && (
          <BlockConfirmModal
            studentName={pendingBlock.studentName}
            loading={blockLoadingId === pendingBlock.studentId}
            onConfirm={() => executeBlock(pendingBlock.studentId)}
            onCancel={() => setPendingBlock(null)}
          />
        )}
      </AnimatePresence>

      {/* ── Unblock confirmation modal ── */}
      <AnimatePresence>
        {pendingUnblock && (
          <UnblockConfirmModal
            studentName={pendingUnblock.studentName}
            loading={blockLoadingId === pendingUnblock.studentId}
            onConfirm={() => executeUnblock(pendingUnblock.studentId)}
            onCancel={() => setPendingUnblock(null)}
          />
        )}
      </AnimatePresence>

      {/* ── Soft-delete confirmation modal ── */}
      <AnimatePresence>
        {pendingDelete && (
          <SoftDeleteConfirmModal
            attemptNumber={pendingDelete.attemptNumber}
            loading={deleteLoading}
            onConfirm={() => executeSoftDelete(pendingDelete.attemptId)}
            onCancel={() => setPendingDelete(null)}
          />
        )}
        {showExport && assessment && (
          <ResultsExportModal
            assessment={assessment}
            students={students}
            attempts={attempts}
            blockedStudentIds={blockedSet}
            onClose={() => setShowExport(false)}
          />
        )}
      </AnimatePresence>

    </div>
  );
}