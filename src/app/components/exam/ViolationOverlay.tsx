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
  ShieldOff, MonitorOff, Clipboard, MousePointer,
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
};

// ── Card shell ────────────────────────────────────────────────────

function OverlayCard({
  title,
  children,
  footer,
  accent = '#F2CECE',
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
        background: '#FFFFFF',
        border: '1px solid #E3E1DB',
        borderTop: `3px solid ${accent}`,
        borderRadius: 4,
        boxShadow: '0 16px 48px rgba(0,0,0,0.22)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-6 py-5">
        <p className="text-xs mb-4" style={{ color: '#6B6B66', letterSpacing: '0.1em' }}>
          {title}
        </p>
        {children}
      </div>
      {footer && (
        <div
          className="flex items-center justify-end gap-3 px-6 py-4"
          style={{ borderTop: '1px solid #F0EFEB' }}
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
        accent="#F5DFA0"
        footer={
          <button
            onClick={onDismiss}
            className="flex items-center gap-2 text-xs px-5 py-2.5"
            style={{
              background: '#0C0C0B', color: '#FFFFFF',
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
              background: '#FEF9EC', border: '1px solid #F5DFA0',
              color: '#92680A',
            }}
          >
            {VIOLATION_ICONS[violationType]}
          </div>
          <div>
            <p className="text-sm mb-1" style={{ color: '#0C0C0B' }}>
              {VIOLATION_LABELS[violationType]}
            </p>
            <p className="text-xs" style={{ color: '#6B6B66', lineHeight: 1.6 }}>
              Warning <strong>{warningNumber} of 3</strong>. You have{' '}
              <strong>{remaining} warning{remaining !== 1 ? 's' : ''}</strong> remaining before
              your exam is automatically terminated.
            </p>
          </div>
        </div>
        <div
          className="px-3 py-3"
          style={{ background: '#FEF9EC', border: '1px solid #F5DFA0', borderRadius: 2 }}
        >
          <p className="text-xs" style={{ color: '#92680A', lineHeight: 1.6 }}>
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
      <OverlayCard title="FINAL WARNING" accent="#F2CECE">
        <div className="flex items-start gap-4 mb-5">
          <div
            className="flex items-center justify-center flex-shrink-0"
            style={{
              width: 40, height: 40, borderRadius: 3,
              background: '#FDF5F5', border: '1px solid #F2CECE',
              color: '#9B2828',
            }}
          >
            <XOctagon size={18} strokeWidth={1.5} />
          </div>
          <div>
            <p className="text-sm mb-1" style={{ color: '#0C0C0B' }}>
              {VIOLATION_LABELS[violationType]}
            </p>
            <p className="text-xs" style={{ color: '#9B2828', lineHeight: 1.6 }}>
              This is your <strong>third and final warning</strong>. Your exam will be
              automatically terminated in <strong>{countdown} second{countdown !== 1 ? 's' : ''}</strong>.
            </p>
          </div>
        </div>

        {/* Countdown bar */}
        <div
          className="mb-4"
          style={{ background: '#F0EFEB', borderRadius: 2, height: 6, overflow: 'hidden' }}
        >
          <div
            style={{
              height: '100%',
              width: `${pct}%`,
              background: countdown > 15 ? '#92680A' : '#9B2828',
              transition: 'width 1s linear, background 0.3s',
              borderRadius: 2,
            }}
          />
        </div>

        <div
          className="px-3 py-3"
          style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}
        >
          <p className="text-xs" style={{ color: '#9B2828', lineHeight: 1.6 }}>
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
              background: '#0C0C0B', color: '#FFFFFF',
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
            <p className="text-sm mb-1" style={{ color: '#0C0C0B' }}>
              Fullscreen mode was exited
            </p>
            <p className="text-xs" style={{ color: '#6B6B66', lineHeight: 1.6 }}>
              This exam must be taken in fullscreen mode. This incident has been logged.
              Click the button below to return to fullscreen and continue your exam.
            </p>
          </div>
        </div>
        <div
          className="px-3 py-3"
          style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}
        >
          <p className="text-xs" style={{ color: '#6B6B66', lineHeight: 1.6 }}>
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
}

export function TerminatedOverlay({ reason, onExitView }: TerminatedProps) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: '#0C0C0B' }}
    >
      <div style={{ maxWidth: 440, width: '100%', padding: '0 24px' }}>
        <div className="flex items-center gap-3 mb-6">
          <XOctagon size={22} strokeWidth={1} style={{ color: '#9B2828' }} />
          <p className="text-xs" style={{ color: '#6B6B66', letterSpacing: '0.12em' }}>
            EXAM TERMINATED
          </p>
        </div>
        <p className="text-2xl mb-3" style={{ color: '#FFFFFF', fontWeight: 300, lineHeight: 1.3 }}>
          Your exam has been terminated.
        </p>
        <p className="text-sm mb-6" style={{ color: '#6B6B66', lineHeight: 1.7 }}>
          {reason}
        </p>
        <div
          className="px-4 py-4 mb-8"
          style={{ border: '1px solid #2C2C2A', borderRadius: 3 }}
        >
          <p className="text-xs" style={{ color: '#6B6B66', lineHeight: 1.7 }}>
            Your answers up to this point have been saved and submitted. Your examiner
            will be able to review your session including all integrity events logged
            during this exam.
          </p>
        </div>
        <button
          onClick={onExitView}
          className="flex items-center gap-2 text-xs px-5 py-2.5"
          style={{
            border: '1px solid #4A4A45', color: '#6B6B66',
            borderRadius: 2, background: 'transparent', cursor: 'pointer',
          }}
        >
          View submitted results
        </button>
      </div>
    </motion.div>
  );
}
