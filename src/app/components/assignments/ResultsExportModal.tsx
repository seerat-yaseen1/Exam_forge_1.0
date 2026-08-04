/**
 * ResultsExportModal — export options for the assessment roster.
 *
 * Rendered by AssessmentRosterCore (shared by all three staff roles), inside
 * its AnimatePresence, following the same overlay pattern as the freeze /
 * block confirm modals. All data arrives via props from the roster's live
 * state — this component fetches nothing.
 *
 * The actual workbook building + download lives in lib/resultsExport.ts.
 */

import { useState } from 'react';
import { motion } from 'motion/react';
import { Download, Loader2, X, FileSpreadsheet, FileText } from 'lucide-react';
import type { Assessment } from '../../../lib/assessmentService';
import type { Student } from '../../../lib/firebaseService';
import type { Attempt } from '../../../lib/submissionService';
import {
  downloadResultsExport,
  type ExportAttemptScope,
  type ExportFormat,
} from '../../../lib/resultsExport';

const SCOPE_OPTIONS: Array<{ value: ExportAttemptScope; label: string; hint: string }> = [
  {
    value: 'best',
    label: 'Best score per student',
    hint: 'Highest finalized score each; terminated attempts only count when nothing cleaner exists.',
  },
  {
    value: 'latest',
    label: 'Latest attempt per student',
    hint: 'Most recently started attempt, whatever its status.',
  },
  {
    value: 'all',
    label: 'All attempts',
    hint: 'One row per attempt, with a "Counted" marker on the score that best-mode keeps.',
  },
];

const FORMAT_OPTIONS: Array<{ value: ExportFormat; label: string; hint: string; icon: 'xlsx' | 'csv' }> = [
  {
    value: 'xlsx',
    label: 'Excel (.xlsx)',
    hint: 'One workbook — Summary, Sections and Integrity sheets.',
    icon: 'xlsx',
  },
  {
    value: 'csv',
    label: 'CSV (3 files)',
    hint: 'Separate summary / sections / integrity files.',
    icon: 'csv',
  },
];

export function ResultsExportModal({
  assessment,
  students,
  attempts,
  blockedStudentIds,
  onClose,
}: {
  assessment: Assessment;
  students: Student[];
  attempts: Attempt[];
  blockedStudentIds: Set<string>;
  onClose: () => void;
}) {
  const [scope, setScope]   = useState<ExportAttemptScope>('best');
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState<string | null>(null);

  const handleExport = async () => {
    setBusy(true);
    setError(null);
    try {
      await downloadResultsExport({
        assessment,
        students,
        attempts,
        blockedStudentIds,
        options: { scope, format },
      });
      onClose();
    } catch (e) {
      console.error('[ResultsExport] failed', e);
      setError('Export failed — please try again.');
      setBusy(false);
    }
  };

  const optionCard = (
    active: boolean,
    onClick: () => void,
    label: string,
    hint: string,
    icon?: React.ReactNode,
  ) => (
    <button
      key={label}
      onClick={onClick}
      className="w-full text-left px-3 py-2.5 transition-colors"
      style={{
        border: `1px solid ${active ? '#0C0C0B' : '#E3E1DB'}`,
        background: active ? '#FAFAF8' : '#FFFFFF',
        borderRadius: 2, cursor: 'pointer',
      }}
    >
      <div className="flex items-center gap-2">
        <span
          style={{
            width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
            border: `1px solid ${active ? '#0C0C0B' : '#6B6B66'}`,
            background: active ? '#0C0C0B' : 'transparent',
            boxShadow: active ? 'inset 0 0 0 2.5px #FFFFFF' : 'none',
          }}
        />
        {icon}
        <span className="text-xs" style={{ color: '#0C0C0B' }}>{label}</span>
      </div>
      <p className="text-xs mt-1" style={{ color: '#6B6B66', lineHeight: 1.5, paddingLeft: 20 }}>
        {hint}
      </p>
    </button>
  );

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.36)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="w-full"
        style={{ maxWidth: 440, background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid #E3E1DB' }}>
          <div className="flex items-center gap-2">
            <Download size={13} strokeWidth={1.5} style={{ color: '#0C0C0B' }} />
            <p className="text-xs" style={{ color: '#0C0C0B', letterSpacing: '0.06em' }}>EXPORT RESULTS</p>
          </div>
          <button onClick={onClose} className="p-1 hover:opacity-60 transition-opacity" style={{ color: '#6B6B66' }}>
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-5">
          <div>
            <p className="text-xs mb-2" style={{ color: '#6B6B66' }}>Attempts to include</p>
            <div className="space-y-2">
              {SCOPE_OPTIONS.map((o) =>
                optionCard(scope === o.value, () => setScope(o.value), o.label, o.hint)
              )}
            </div>
          </div>

          <div>
            <p className="text-xs mb-2" style={{ color: '#6B6B66' }}>Format</p>
            <div className="space-y-2">
              {FORMAT_OPTIONS.map((o) =>
                optionCard(
                  format === o.value, () => setFormat(o.value), o.label, o.hint,
                  o.icon === 'xlsx'
                    ? <FileSpreadsheet size={12} strokeWidth={1.5} style={{ color: '#1E7B3C', flexShrink: 0 }} />
                    : <FileText size={12} strokeWidth={1.5} style={{ color: '#6B6B66', flexShrink: 0 }} />
                )
              )}
            </div>
          </div>

          <p className="text-xs" style={{ color: '#6B6B66', lineHeight: 1.6 }}>
            Covers all <strong style={{ color: '#4A4A45' }}>{students.length}</strong>{' '}
            allocated student{students.length === 1 ? '' : 's'} — those who never attempted
            appear as “Not attempted”. Deleted attempts are excluded, matching the live
            roster.
          </p>

          {error && (
            <p className="text-xs" style={{ color: '#9B2828' }}>{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderTop: '1px solid #E3E1DB' }}>
          <button
            onClick={handleExport}
            disabled={busy}
            className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
            style={{
              background: busy ? '#4A4A45' : '#0C0C0B',
              color: '#FFFFFF', borderRadius: 2,
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy
              ? <><Loader2 size={10} className="animate-spin" /> Exporting…</>
              : <><Download size={10} strokeWidth={1.5} /> Export</>}
          </button>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-xs px-4 py-2.5 transition-opacity hover:opacity-70"
            style={{ color: '#6B6B66', border: '1px solid #E3E1DB', borderRadius: 2 }}
          >
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}