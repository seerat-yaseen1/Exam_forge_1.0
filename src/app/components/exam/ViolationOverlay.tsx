/**
 * ViolationOverlay
 *
 * Four distinct overlay states:
 *   'warning'             – dismissible toast; shows warning n of 3
 *   'final_warning'       – non-dismissible; 30-second countdown then terminate
 *   'fullscreen_required' – blocks all input until student re-enters fullscreen
 *   'terminated'          – terminal; exam ended, no way out
 */

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  AlertTriangle, Maximize, XOctagon, Eye,
  ShieldOff, MonitorOff, Clipboard, MousePointer, PanelRight,
} from 'lucide-react';
import type { ViolationType } from '../../../lib/submissionService';

// ── Shared overlay backdrop ────────────────────────────────────────

function Backdrop({ dim = true, children }: { dim?: boolean; children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: dim ? 'rgba(12,12,11,0.72)' : 'rgba(12,12,11,0.92)' }}
    >
      {children}
    </motion.div>
  );
}

// ── Violation label map ────────────────────────────────────────────

const VIOLATION_LABELS: Record<ViolationType, string> = {
  tab_switch:      'Tab switch detected',
  focus_loss:      'Window focus lost',
  fullscreen_exit: 'Fullscreen exited',
  copy_attempt:    'Copy attempt blocked',
  paste_attempt:   'Paste attempt blocked',
  right_click:     'Right-click blocked',
  multi_person:    'Multiple persons detected',
  face_absent:     'Face not detected',
  devtools_open:   'DevTools detected',
  reload_attempt:  'Reload attempt blocked',
  keyboard_block:  'Blocked key combination',
  // Audit L4 (2026-08-04). Both maps are typed Record<ViolationType, …>, and
  // this member was missing from each — so the maps did not actually cover the
  // union they claimed to. Safe only by accident today: 'extension_detected'
  // is not in ExamShell's WARNING_VIOLATION_TYPES, so handleViolation returns
  // before this overlay is ever asked to render it. Adding it makes the maps
  // total, so promoting it to a warning type later cannot ship a blank overlay.
  extension_detected: 'Browser extension detected',
  viewport_narrowed:  'Exam window was narrowed',
};

const VIOLATION_ICONS: Record<ViolationType, React.ReactNode> = {
  tab_switch:      <Eye size={18} strokeWidth={1.5} />,
  focus_loss:      <Eye size={18} strokeWidth={1.5} />,
  fullscreen_exit: <MonitorOff size={18} strokeWidth={1.5} />,
  copy_attempt:    <Clipboard size={18} strokeWidth={1.5} />,
  paste_attempt:   <Clipboard size={18} strokeWidth={1.5} />,
  right_click:     <MousePointer size={18} strokeWidth={1.5} />,
  multi_person:    <ShieldOff size={18} strokeWidth={1.5} />,
  face_absent:     <Eye size={18} strokeWidth={1.5} />,
  devtools_open:   <ShieldOff size={18} strokeWidth={1.5} />,
  reload_attempt:  <AlertTriangle size={18} strokeWidth={1.5} />,
  keyboard_block:  <AlertTriangle size={18} strokeWidth={1.5} />,
  extension_detected: <ShieldOff size={18} strokeWidth={1.5} />,
  viewport_narrowed:  <PanelRight size={18} strokeWidth={1.5} />,
};

// ── Card shell ────────────────────────────────────────────────────

function OverlayCard({
  title,
  children,
  footer,
  accent = 'var(--ef-danger-border)',
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  accent?: string;
}) {
  return (
    <motion.div
      initial={{ scale: 0.95, opacity: 0, y: 12 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.95, opacity: 0, y: 12 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      style={{
        width: 420,
        background: 'var(--ef-surface)',
        border: '1px solid var(--ef-border)',
        borderTop: `3px solid ${accent}`,
        borderRadius: 4,
        boxShadow: '0 16px 48px rgba(0,0,0,0.22)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-6 py-5">
        <p className="text-xs mb-4" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
          {title}
        </p>
        {children}
      </div>
      {footer && (
        <div
          className="flex items-center justify-end gap-3 px-6 py-4"
          style={{ borderTop: '1px solid var(--ef-border-subtle)' }}
        >
          {footer}
        </div>
      )}
    </motion.div>
  );
}

// ──────────────────────────────────────────────────────────────────
// WARNING overlay  (1 / 2 of 3)
// ──────────────────────────────────────────────────────────────────

interface WarningProps {
  violationType: ViolationType;
  warningNumber: 1 | 2;
  onDismiss: () => void;
}

export function WarningOverlay({ violationType, warningNumber, onDismiss }: WarningProps) {
  const remaining = 3 - warningNumber;
  return (
    <Backdrop>
      <OverlayCard
        title="INTEGRITY VIOLATION"
        accent="var(--ef-warning-border)"
        footer={
          <button
            onClick={onDismiss}
            className="flex items-center gap-2 text-xs px-5 py-2.5"
            style={{
              background: 'var(--ef-ink)', color: 'var(--ef-surface)',
              borderRadius: 2, cursor: 'pointer',
            }}
          >
            I understand — continue exam
          </button>
        }
      >
        <div className="flex items-start gap-4 mb-5">
          <div
            className="flex items-center justify-center flex-shrink-0"
            style={{
              width: 40, height: 40, borderRadius: 3,
              background: '#FEF9EC', border: '1px solid var(--ef-warning-border)',
              color: 'var(--ef-warning)',
            }}
          >
            {VIOLATION_ICONS[violationType]}
          </div>
          <div>
            <p className="text-sm mb-1" style={{ color: 'var(--ef-ink)' }}>
              {VIOLATION_LABELS[violationType]}
            </p>
            <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
              Warning <strong>{warningNumber} of 3</strong>. You have{' '}
              <strong>{remaining} warning{remaining !== 1 ? 's' : ''}</strong> remaining before
              your exam is automatically terminated.
            </p>
          </div>
        </div>
        <div
          className="px-3 py-3"
          style={{ background: '#FEF9EC', border: '1px solid var(--ef-warning-border)', borderRadius: 2 }}
        >
          <p className="text-xs" style={{ color: 'var(--ef-warning)', lineHeight: 1.6 }}>
            This incident has been recorded and will be visible to your examiner. Please
            stay focused on the exam window.
          </p>
        </div>
      </OverlayCard>
    </Backdrop>
  );
}

// ──────────────────────────────────────────────────────────────────
// FINAL WARNING overlay  (warning 3 — 30-second countdown)
// ──────────────────────────────────────────────────────────────────

interface FinalWarningProps {
  violationType: ViolationType;
  onCountdownEnd: () => void;
}

export function FinalWarningOverlay({ violationType, onCountdownEnd }: FinalWarningProps) {
  const [countdown, setCountdown] = useState(30);

  useEffect(() => {
    if (countdown <= 0) { onCountdownEnd(); return; }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown, onCountdownEnd]);

  const pct = (countdown / 30) * 100;

  return (
    <Backdrop dim={false}>
      <OverlayCard title="FINAL WARNING" accent="var(--ef-danger-border)">
        <div className="flex items-start gap-4 mb-5">
          <div
            className="flex items-center justify-center flex-shrink-0"
            style={{
              width: 40, height: 40, borderRadius: 3,
              background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)',
              color: 'var(--ef-danger)',
            }}
          >
            <XOctagon size={18} strokeWidth={1.5} />
          </div>
          <div>
            <p className="text-sm mb-1" style={{ color: 'var(--ef-ink)' }}>
              {VIOLATION_LABELS[violationType]}
            </p>
            <p className="text-xs" style={{ color: 'var(--ef-danger)', lineHeight: 1.6 }}>
              This is your <strong>third and final warning</strong>. Your exam will be
              automatically terminated in <strong>{countdown} second{countdown !== 1 ? 's' : ''}</strong>.
            </p>
          </div>
        </div>

        {/* Countdown bar */}
        <div
          className="mb-4"
          style={{ background: 'var(--ef-border-subtle)', borderRadius: 2, height: 6, overflow: 'hidden' }}
        >
          <div
            style={{
              height: '100%',
              width: `${pct}%`,
              background: countdown > 15 ? 'var(--ef-warning)' : 'var(--ef-danger)',
              transition: 'width 1s linear, background 0.3s',
              borderRadius: 2,
            }}
          />
        </div>

        <div
          className="px-3 py-3"
          style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}
        >
          <p className="text-xs" style={{ color: 'var(--ef-danger)', lineHeight: 1.6 }}>
            You cannot dismiss this dialog. Return to the exam window immediately to
            stop the countdown. If you are the only person in the room, ensure your
            face is visible to the camera.
          </p>
        </div>
      </OverlayCard>
    </Backdrop>
  );
}

// ──────────────────────────────────────────────────────────────────
// FULLSCREEN REQUIRED overlay
// ──────────────────────────────────────────────────────────────────

interface FullscreenProps {
  onReturnFullscreen: () => void;
}

export function FullscreenRequiredOverlay({ onReturnFullscreen }: FullscreenProps) {
  return (
    <Backdrop dim={false}>
      <OverlayCard
        title="FULLSCREEN REQUIRED"
        accent="#C8D8F0"
        footer={
          <button
            onClick={onReturnFullscreen}
            className="flex items-center gap-2 text-xs px-5 py-2.5"
            style={{
              background: 'var(--ef-ink)', color: 'var(--ef-surface)',
              borderRadius: 2, cursor: 'pointer',
            }}
          >
            <Maximize size={12} strokeWidth={1.5} />
            Return to fullscreen
          </button>
        }
      >
        <div className="flex items-start gap-4 mb-5">
          <div
            className="flex items-center justify-center flex-shrink-0"
            style={{
              width: 40, height: 40, borderRadius: 3,
              background: '#EEF3FB', border: '1px solid #C8D8F0',
              color: '#4A6FA5',
            }}
          >
            <Maximize size={18} strokeWidth={1.5} />
          </div>
          <div>
            <p className="text-sm mb-1" style={{ color: 'var(--ef-ink)' }}>
              Fullscreen mode was exited
            </p>
            <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
              This exam must be taken in fullscreen mode. This incident has been logged.
              Click the button below to return to fullscreen and continue your exam.
            </p>
          </div>
        </div>
        <div
          className="px-3 py-3"
          style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2 }}
        >
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
            All interactions are blocked until you return to fullscreen. If you repeatedly
            exit fullscreen, your exam may be terminated.
          </p>
        </div>
      </OverlayCard>
    </Backdrop>
  );
}

// ──────────────────────────────────────────────────────────────────
// TERMINATED overlay
// ──────────────────────────────────────────────────────────────────

interface TerminatedProps {
  reason: string;
  onExitView: () => void;
  /**
   * H2 (audit 2026-08-06): the final flush before grading rejected, so some
   * answers the student typed may never have reached the server. Swaps the
   * reassurance below for the truth — see the note on the panel.
   */
  answersMayBeUnsaved?: boolean;
}

export function TerminatedOverlay({ reason, onExitView, answersMayBeUnsaved }: TerminatedProps) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: 'var(--ef-ink)' }}
    >
      <div style={{ maxWidth: 440, width: '100%', padding: '0 24px' }}>
        <div className="flex items-center gap-3 mb-6">
          <XOctagon size={22} strokeWidth={1} style={{ color: 'var(--ef-danger)' }} />
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.12em' }}>
            EXAM TERMINATED
          </p>
        </div>
        <p className="text-2xl mb-3" style={{ color: 'var(--ef-surface)', fontWeight: 300, lineHeight: 1.3 }}>
          Your exam has been terminated.
        </p>
        <p className="text-sm mb-6" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.7 }}>
          {reason}
        </p>
        {/* H2 (audit 2026-08-06): this panel used to promise "your answers
            have been saved and submitted" UNCONDITIONALLY, including on the
            path where the final flush had just failed. That is the worst
            possible moment to be reassuring: termination is the one outcome a
            student is least placed to dispute, and telling them their work was
            saved removes the very reason they would raise it. When the flush
            rejects, say so, and tell them what to do about it. */}
        <div
          className="px-4 py-4 mb-8"
          style={{
            border: `1px solid ${answersMayBeUnsaved ? 'var(--ef-danger)' : '#2C2C2A'}`,
            borderRadius: 3,
          }}
        >
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.7 }}>
            {answersMayBeUnsaved ? (
              <>
                <span style={{ color: '#C86B6B' }}>
                  Your last answers may not have been saved.
                </span>{' '}
                The final save failed as your exam was terminated, so answers you
                entered shortly beforehand may be missing from your submission.
                Report this to your examiner or invigilator now — your session,
                including this failure and all integrity events logged during the
                exam, is available for them to review.
              </>
            ) : (
              <>
                Your answers up to this point have been saved and submitted. Your
                examiner will be able to review your session including all integrity
                events logged during this exam.
              </>
            )}
          </p>
        </div>
        <button
          onClick={onExitView}
          className="flex items-center gap-2 text-xs px-5 py-2.5"
          style={{
            border: '1px solid var(--ef-text-subtle)', color: 'var(--ef-text-muted)',
            borderRadius: 2, background: 'transparent', cursor: 'pointer',
          }}
        >
          View submitted results
        </button>
      </div>
    </motion.div>
  );
}
