/**
 * list/AssessmentModals — Duplicate, Delete and Preview modals for the
 * assignments list. (Batch F1a: extracted verbatim from AssignmentsPage.tsx.)
 */
import { useState } from 'react';
import { motion } from 'motion/react';
import { X, Trash2, Loader2, AlertTriangle, CalendarClock, Timer, CheckSquare, Square, Copy } from 'lucide-react';
import { type Student } from '../../../../lib/firebaseService';
import { type DuplicateOptions, describeAssignment, type Assessment } from '../../../../lib/assessmentService';
import { type Subject } from '../../../../lib/subjectService';
import { Difficulty, DIFF_COLORS, formatDateTime, formatDateShort, truncate } from '../builder/shared';
import { StatusBadgeChip, MetaItem } from './ListChrome';

export function DuplicateModal({ assessment, onConfirm, onCancel, duplicating }: {
  assessment: Assessment;
  onConfirm: (opts: DuplicateOptions, title: string) => void;
  onCancel: () => void;
  duplicating: boolean;
}) {
  const [title, setTitle] = useState(`${assessment.title} (Copy)`);
  const [opts, setOpts] = useState<DuplicateOptions>({
    includeSections: true,
    includeQuestions: true,
    includeSettings: true,
    includeScheduling: false,   // a copy usually needs a NEW window
    includeSecurity: true,
    includeAllocations: false,  // and usually a NEW audience
  });

  const toggle = (k: keyof DuplicateOptions) =>
    setOpts((p) => {
      const next = { ...p, [k]: !p[k] };
      // Questions live inside sections — can't copy them without the structure.
      if (k === 'includeSections' && !next.includeSections) next.includeQuestions = false;
      if (k === 'includeQuestions' && next.includeQuestions) next.includeSections = true;
      return next;
    });

  const rows: Array<{ key: keyof DuplicateOptions; label: string; hint: string }> = [
    { key: 'includeSections',    label: 'Sections',        hint: 'Structure, marks, timers, breaks' },
    { key: 'includeQuestions',   label: 'Questions',       hint: 'The questions inside each section' },
    { key: 'includeSettings',    label: 'Settings',        hint: 'Timing, attempts, shuffle, review' },
    { key: 'includeSecurity',    label: 'Security',        hint: 'Tier, delivery mode, camera, extensions' },
    { key: 'includeScheduling',  label: 'Scheduling',      hint: 'Start and end dates' },
    { key: 'includeAllocations', label: 'Allocations',     hint: 'Who the exam is assigned to' },
  ];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-60 flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.28)' }} onClick={onCancel}>
      <motion.div initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md p-6"
        style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}>

        <div className="flex items-center gap-2 mb-1">
          <Copy size={14} strokeWidth={1.5} style={{ color: '#4A4A45' }} />
          <p className="text-sm" style={{ color: '#0C0C0B' }}>Duplicate assessment</p>
        </div>
        <p className="text-xs mb-4" style={{ color: '#9A9891', lineHeight: 1.6 }}>
          Creates a new <strong style={{ color: '#4A4A45' }}>draft</strong>. Student attempts,
          responses, results and reports are never copied.
        </p>

        <label className="text-xs block mb-1.5" style={{ color: '#6B6B66' }}>New title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full text-xs px-3 py-2 mb-4"
          style={{ border: '1px solid #E3E1DB', borderRadius: 2, color: '#0C0C0B' }}
        />

        <p className="text-xs mb-2" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>COPY OPTIONS</p>
        <div className="flex flex-col gap-1 mb-5">
          {rows.map((r) => {
            const checked = opts[r.key];
            const disabled = r.key === 'includeQuestions' && !opts.includeSections;
            return (
              <button
                key={r.key}
                type="button"
                onClick={() => !disabled && toggle(r.key)}
                className="flex items-start gap-2.5 px-3 py-2 text-left transition-colors"
                style={{
                  border: '1px solid #E3E1DB', borderRadius: 2,
                  background: checked ? '#FAFAF8' : '#FFFFFF',
                  opacity: disabled ? 0.45 : 1,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}>
                {checked
                  ? <CheckSquare size={13} strokeWidth={1.5} style={{ color: '#0C0C0B', marginTop: 1 }} />
                  : <Square size={13} strokeWidth={1.5} style={{ color: '#C4C3BD', marginTop: 1 }} />}
                <span className="flex flex-col">
                  <span className="text-xs" style={{ color: '#0C0C0B' }}>{r.label}</span>
                  <span className="text-xs" style={{ color: '#9A9891' }}>{r.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button onClick={onCancel} disabled={duplicating}
            className="text-xs px-4 py-2"
            style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={() => onConfirm(opts, title)} disabled={duplicating || !title.trim()}
            className="flex items-center gap-1.5 text-xs px-4 py-2"
            style={{
              background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2,
              opacity: duplicating || !title.trim() ? 0.5 : 1,
              cursor: duplicating ? 'default' : 'pointer',
            }}>
            {duplicating
              ? <><Loader2 size={11} className="animate-spin" /> Duplicating…</>
              : <><Copy size={11} strokeWidth={1.5} /> Duplicate</>}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

export function DeleteModal({ assessment, onConfirm, onCancel, deleting }: {
  assessment: Assessment; onConfirm: () => void; onCancel: () => void; deleting: boolean;
}) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-60 flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.28)' }} onClick={onCancel}>
      <motion.div initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-sm"
        style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3.5 md:px-5 md:py-4" style={{ borderBottom: '1px solid #E3E1DB' }}>
          <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>DELETE ASSESSMENT</p>
          <button onClick={onCancel} className="p-1 hover:opacity-60 transition-opacity" style={{ color: '#9A9891' }}><X size={14} strokeWidth={1.5} /></button>
        </div>
        <div className="px-4 py-4 md:px-5 md:py-5">
          <div className="flex items-start gap-2.5 mb-4 px-3 py-3"
            style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
            <AlertTriangle size={13} strokeWidth={1.5} style={{ color: '#9B2828', flexShrink: 0, marginTop: 1 }} />
            <p className="text-xs" style={{ color: '#9B2828', lineHeight: 1.6 }}>
              This assessment will be soft-deleted. Student submissions and results will be preserved.
            </p>
          </div>
          <p className="text-xs" style={{ color: '#4A4A45', lineHeight: 1.6 }}>Are you sure you want to delete:</p>
          <p className="text-xs mt-1.5 italic break-words" style={{ color: '#9A9891' }}>"{truncate(assessment.title, 80)}"</p>
        </div>
        <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3 px-4 py-3.5 md:px-5 md:py-4" style={{ borderTop: '1px solid #E3E1DB' }}>
          <button onClick={onConfirm} disabled={deleting}
            className="flex items-center justify-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
            style={{ background: deleting ? '#C8C7C2' : '#9B2828', color: '#FFFFFF', borderRadius: 2, cursor: deleting ? 'not-allowed' : 'pointer' }}>
            {deleting ? <><Loader2 size={11} className="animate-spin" /> Deleting…</> : <><Trash2 size={11} /> Delete</>}
          </button>
          <button onClick={onCancel} disabled={deleting} className="text-xs px-4 py-2.5"
            style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}>Cancel</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Preview modal ─────────────────────────────────────────────────

export function PreviewModal({ assessment, onClose }: { assessment: Assessment; onClose: () => void }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-60 flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.28)' }} onClick={onClose}>
      <motion.div initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="w-full" style={{ maxWidth: 620, background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3.5 md:px-5 md:py-4" style={{ borderBottom: '1px solid #E3E1DB' }}>
          <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>ASSESSMENT PREVIEW</p>
          <button onClick={onClose} className="p-1 hover:opacity-60 transition-opacity" style={{ color: '#9A9891' }}><X size={14} strokeWidth={1.5} /></button>
        </div>
        <div className="px-4 py-4 md:px-5 md:py-5 max-h-[76vh] overflow-y-auto space-y-5">
          <div>
            <p className="text-sm break-words" style={{ color: '#0C0C0B' }}>{assessment.title}</p>
            {assessment.description && <p className="text-xs mt-1.5" style={{ color: '#6B6B66', lineHeight: 1.6 }}>{assessment.description}</p>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4" style={{ background: '#FAFAF8', border: '1px solid #F0EFEB', borderRadius: 2 }}>
            <MetaItem label="Status"><StatusBadgeChip status={assessment.status} /></MetaItem>
            <MetaItem label="Subject"><span style={{ color: '#0C0C0B' }}>{assessment.subject || '—'}</span></MetaItem>
            <MetaItem label="Questions"><span style={{ color: '#0C0C0B' }}>{assessment.questions.length}</span></MetaItem>
            <MetaItem label="Total Marks"><span style={{ color: '#0C0C0B' }}>{assessment.totalMarks}</span></MetaItem>
            <MetaItem label="Assigned To"><span style={{ color: '#0C0C0B' }}>{describeAssignment(assessment)}</span></MetaItem>
            {assessment.passingScore !== undefined && (
              <MetaItem label="Passing Score"><span style={{ color: '#0C0C0B' }}>{assessment.passingScore}%</span></MetaItem>
            )}
          </div>
          {(assessment.startDate || assessment.endDate) && (
            <div style={{ background: '#FAFAF8', border: '1px solid #F0EFEB', borderRadius: 2 }}>
              <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderBottom: '1px solid #F0EFEB' }}>
                <CalendarClock size={12} strokeWidth={1.5} style={{ color: '#9A9891' }} />
                <span className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>SCHEDULE</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4">
                <MetaItem label="Start"><span style={{ color: '#0C0C0B' }}>{formatDateTime(assessment.startDate)}</span></MetaItem>
                <MetaItem label="End"><span style={{ color: '#0C0C0B' }}>{formatDateTime(assessment.endDate)}</span></MetaItem>
              </div>
            </div>
          )}
          {assessment.sections && assessment.sections.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>SECTIONS ({assessment.sections.length})</p>
                {assessment.sectionStartOrder && assessment.sectionStartOrder !== 'sequential' && (
                  <span
                    className="text-xs px-2 py-0.5"
                    style={{ background: '#F0EFEB', color: '#6B6B66', border: '1px solid #E3E1DB', borderRadius: 2 }}
                  >
                    {assessment.sectionStartOrder === 'random' ? 'Random order' : "Student's choice"}
                  </span>
                )}
              </div>
              {assessment.sections.map((sec, si) => {
                const secMarks = sec.questions.reduce((s, q) => s + q.marks, 0);
                return (
                  <div key={sec.id} style={{ border: '1px solid #E3E1DB', borderRadius: 2, overflow: 'hidden' }}>
                    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5" style={{ background: '#FAFAF8', borderBottom: '1px solid #F0EFEB' }}>
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="flex items-center justify-center flex-shrink-0"
                          style={{ width: 18, height: 18, borderRadius: 2, background: '#F0EFEB', border: '1px solid #E3E1DB', fontSize: 9, color: '#9A9891' }}>
                          {si + 1}
                        </div>
                        <span className="text-xs truncate" style={{ color: '#0C0C0B' }}>{sec.name}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: '#9A9891' }}>
                        {sec.timeLimit && <span className="flex items-center gap-1"><Timer size={10} strokeWidth={1.5} />{sec.timeLimit} min</span>}
                        {sec.breakAfter && sec.breakAfter.durationMinutes > 0 && (
                          <span
                            className="flex items-center gap-1 px-1.5"
                            title={sec.breakAfter.mandatory ? 'Mandatory break' : 'Skippable break'}
                            style={{ background: '#FAFAF8', border: '1px dashed #E3E1DB', borderRadius: 2, color: '#9A9891', padding: '1px 6px' }}
                          >
                            Break: {sec.breakAfter.durationMinutes} min
                          </span>
                        )}
                        <span>{sec.questions.length} Q · {secMarks} mk</span>
                      </div>
                    </div>
                    {sec.rules.length > 0 && (
                      <div className="px-3 py-2.5 space-y-1">
                        {sec.rules.filter(r => r.count > 0).map((r, ri) => {
                          const dc = DIFF_COLORS[r.difficulty as Difficulty];
                          return (
                            <div key={ri} className="flex items-center justify-between text-xs py-0.5">
                              <div className="flex items-center gap-2">
                                <span className="px-1.5 py-0.5 capitalize"
                                  style={{ background: dc.bg, color: dc.text, border: `1px solid ${dc.border}`, borderRadius: 2, fontSize: 10 }}>
                                  {r.difficulty}
                                </span>
                                <span style={{ color: '#6B6B66' }}>{r.subject}</span>
                                <span style={{ color: '#C4C3BD', fontSize: 10 }}>›</span>
                                <span style={{ color: '#9A9891', fontSize: 11 }}>{r.topic}</span>
                              </div>
                              <span style={{ color: '#9A9891' }}>{r.count} × {r.marksPerQuestion} mk</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Shared form primitives ────────────────────────────────────────