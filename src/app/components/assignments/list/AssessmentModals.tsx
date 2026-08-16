/**
 * list/AssessmentModals — Duplicate, Delete and Preview modals for the
 * assignments list. (Batch F1a: extracted verbatim from AssignmentsPage.tsx.)
 */
import { useState } from 'react';
import { motion } from 'motion/react';
import { X, Trash2, Loader2, AlertTriangle, CalendarClock, Timer, CheckSquare, Square, Copy } from 'lucide-react';
import { type Student } from '../../../../lib/firebaseService';
import { type DuplicateOptions, describeAssignment, isGroupRule, ruleQuestionCount, type Assessment } from '../../../../lib/assessmentService';
import { GROUP_KIND_LABEL } from '../../../../lib/questionBankService';
import { type Subject } from '../../../../lib/subjectService';
import { Difficulty, DIFF_COLORS, formatDateTime, formatDateShort, truncate } from '../builder/shared';
import { StatusBadgeChip, MetaItem } from './ListChrome';

/**
 * "Start from existing" — pick the exam to copy.
 *
 * Duplicating was already the fastest route to a new assessment: structure,
 * selection rules, grading policy and security tier all come across, and the
 * options in DuplicateModal decide what does not. It was reachable only from an
 * unlabelled icon at the end of a row, so it was found by accident or not at
 * all — and most exams are a variant of one that already exists.
 *
 * This is a chooser, nothing more. It hands the picked assessment straight to
 * DuplicateModal, so there is one duplication path rather than two.
 */
export function SourcePickerModal({ assessments, onPick, onCancel }: {
  assessments: Assessment[];
  onPick: (a: Assessment) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  // Most recent first — the exam an author wants to copy is nearly always one
  // of the last few they touched.
  const shown = assessments
    .filter((a) => !q || a.title.toLowerCase().includes(q) || (a.subject ?? '').toLowerCase().includes(q))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, 50);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.45)' }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="w-full flex flex-col"
        style={{ maxWidth: 560, maxHeight: '80vh', background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}>
        <div className="px-6 py-5 flex-shrink-0" style={{ borderBottom: '1px solid var(--ef-border)' }}>
          <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>START FROM EXISTING</p>
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
            Pick an assessment to copy. You choose what comes across next.
          </p>
          <input
            type="text" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title or subject…" autoFocus
            className="w-full outline-none mt-3"
            style={{
              border: '1px solid var(--ef-border)', borderRadius: 2,
              padding: '8px 10px', fontSize: 13, color: 'var(--ef-ink)',
              background: 'var(--ef-canvas-raised)',
            }}
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {shown.length === 0 ? (
            <p className="text-xs px-6 py-8 text-center" style={{ color: 'var(--ef-text-muted)' }}>
              Nothing matches “{query}”.
            </p>
          ) : shown.map((a) => {
            const qCount = a.sections?.reduce((n, sec) => n + sec.questions.length, 0) ?? 0;
            return (
              <button key={a.id} onClick={() => onPick(a)}
                className="w-full flex items-center gap-3 px-6 py-3 text-left transition-colors"
                style={{ borderBottom: '1px solid var(--ef-border-subtle)', cursor: 'pointer' }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas-raised)')}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs truncate" style={{ color: 'var(--ef-ink)' }}>{a.title}</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>
                    {[a.subject, `${a.sections?.length ?? 0} section${(a.sections?.length ?? 0) === 1 ? '' : 's'}`,
                      qCount > 0 ? `${qCount} questions` : null].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <StatusBadgeChip status={a.status} />
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-end px-6 py-4 flex-shrink-0"
          style={{ borderTop: '1px solid var(--ef-border)', background: 'var(--ef-canvas-raised)' }}>
          <button onClick={onCancel} className="text-xs px-4 py-2 transition-opacity hover:opacity-70"
            style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2, cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

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
        style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}>

        <div className="flex items-center gap-2 mb-1">
          <Copy size={14} strokeWidth={1.5} style={{ color: 'var(--ef-text-subtle)' }} />
          <p className="text-sm" style={{ color: 'var(--ef-ink)' }}>Duplicate assessment</p>
        </div>
        <p className="text-xs mb-4" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
          Creates a new <strong style={{ color: 'var(--ef-text-subtle)' }}>draft</strong>. Student attempts,
          responses, results and reports are never copied.
        </p>

        <label className="text-xs block mb-1.5" style={{ color: 'var(--ef-text-muted)' }}>New title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full text-xs px-3 py-2 mb-4"
          style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-ink)' }}
        />

        <p className="text-xs mb-2" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>COPY OPTIONS</p>
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
                  border: '1px solid var(--ef-border)', borderRadius: 2,
                  background: checked ? 'var(--ef-canvas-raised)' : 'var(--ef-surface)',
                  opacity: disabled ? 0.45 : 1,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}>
                {checked
                  ? <CheckSquare size={13} strokeWidth={1.5} style={{ color: 'var(--ef-ink)', marginTop: 1 }} />
                  : <Square size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', marginTop: 1 }} />}
                <span className="flex flex-col">
                  <span className="text-xs" style={{ color: 'var(--ef-ink)' }}>{r.label}</span>
                  <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{r.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button onClick={onCancel} disabled={duplicating}
            className="text-xs px-4 py-2"
            style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={() => onConfirm(opts, title)} disabled={duplicating || !title.trim()}
            className="flex items-center gap-1.5 text-xs px-4 py-2"
            style={{
              background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2,
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
        style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3.5 md:px-5 md:py-4" style={{ borderBottom: '1px solid var(--ef-border)' }}>
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>DELETE ASSESSMENT</p>
          <button onClick={onCancel} className="p-1 hover:opacity-60 transition-opacity" style={{ color: 'var(--ef-text-muted)' }}><X size={14} strokeWidth={1.5} /></button>
        </div>
        <div className="px-4 py-4 md:px-5 md:py-5">
          <div className="flex items-start gap-2.5 mb-4 px-3 py-3"
            style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
            <AlertTriangle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', flexShrink: 0, marginTop: 1 }} />
            <p className="text-xs" style={{ color: 'var(--ef-danger)', lineHeight: 1.6 }}>
              This assessment will be soft-deleted. Student submissions and results will be preserved.
            </p>
          </div>
          <p className="text-xs" style={{ color: 'var(--ef-text-subtle)', lineHeight: 1.6 }}>Are you sure you want to delete:</p>
          <p className="text-xs mt-1.5 italic break-words" style={{ color: 'var(--ef-text-muted)' }}>"{truncate(assessment.title, 80)}"</p>
        </div>
        <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3 px-4 py-3.5 md:px-5 md:py-4" style={{ borderTop: '1px solid var(--ef-border)' }}>
          <button onClick={onConfirm} disabled={deleting}
            className="flex items-center justify-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
            style={{ background: deleting ? 'var(--ef-track)' : 'var(--ef-danger)', color: 'var(--ef-surface)', borderRadius: 2, cursor: deleting ? 'not-allowed' : 'pointer' }}>
            {deleting ? <><Loader2 size={11} className="animate-spin" /> Deleting…</> : <><Trash2 size={11} /> Delete</>}
          </button>
          <button onClick={onCancel} disabled={deleting} className="text-xs px-4 py-2.5"
            style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>Cancel</button>
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
        className="w-full" style={{ maxWidth: 620, background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3.5 md:px-5 md:py-4" style={{ borderBottom: '1px solid var(--ef-border)' }}>
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>ASSESSMENT PREVIEW</p>
          <button onClick={onClose} className="p-1 hover:opacity-60 transition-opacity" style={{ color: 'var(--ef-text-muted)' }}><X size={14} strokeWidth={1.5} /></button>
        </div>
        <div className="px-4 py-4 md:px-5 md:py-5 max-h-[76vh] overflow-y-auto space-y-5">
          <div>
            <p className="text-sm break-words" style={{ color: 'var(--ef-ink)' }}>{assessment.title}</p>
            {assessment.description && <p className="text-xs mt-1.5" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>{assessment.description}</p>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4" style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border-subtle)', borderRadius: 2 }}>
            <MetaItem label="Status"><StatusBadgeChip status={assessment.status} /></MetaItem>
            <MetaItem label="Subject"><span style={{ color: 'var(--ef-ink)' }}>{assessment.subject || '—'}</span></MetaItem>
            <MetaItem label="Questions"><span style={{ color: 'var(--ef-ink)' }}>{assessment.questions.length}</span></MetaItem>
            <MetaItem label="Total Marks"><span style={{ color: 'var(--ef-ink)' }}>{assessment.totalMarks}</span></MetaItem>
            <MetaItem label="Assigned To"><span style={{ color: 'var(--ef-ink)' }}>{describeAssignment(assessment)}</span></MetaItem>
            {assessment.passingScore !== undefined && (
              <MetaItem label="Passing Score"><span style={{ color: 'var(--ef-ink)' }}>{assessment.passingScore}%</span></MetaItem>
            )}
          </div>
          {(assessment.startDate || assessment.endDate) && (
            <div style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border-subtle)', borderRadius: 2 }}>
              <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
                <CalendarClock size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
                <span className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>SCHEDULE</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4">
                <MetaItem label="Start"><span style={{ color: 'var(--ef-ink)' }}>{formatDateTime(assessment.startDate)}</span></MetaItem>
                <MetaItem label="End"><span style={{ color: 'var(--ef-ink)' }}>{formatDateTime(assessment.endDate)}</span></MetaItem>
              </div>
            </div>
          )}
          {assessment.sections && assessment.sections.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>SECTIONS ({assessment.sections.length})</p>
                {assessment.sectionStartOrder && assessment.sectionStartOrder !== 'sequential' && (
                  <span
                    className="text-xs px-2 py-0.5"
                    style={{ background: 'var(--ef-border-subtle)', color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}
                  >
                    {assessment.sectionStartOrder === 'random' ? 'Random order' : "Student's choice"}
                  </span>
                )}
              </div>
              {assessment.sections.map((sec, si) => {
                const secMarks = sec.questions.reduce((s, q) => s + q.marks, 0);
                return (
                  <div key={sec.id} style={{ border: '1px solid var(--ef-border)', borderRadius: 2, overflow: 'hidden' }}>
                    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5" style={{ background: 'var(--ef-canvas-raised)', borderBottom: '1px solid var(--ef-border-subtle)' }}>
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="flex items-center justify-center flex-shrink-0"
                          style={{ width: 18, height: 18, borderRadius: 2, background: 'var(--ef-border-subtle)', border: '1px solid var(--ef-border)', fontSize: 9, color: 'var(--ef-text-muted)' }}>
                          {si + 1}
                        </div>
                        <span className="text-xs truncate" style={{ color: 'var(--ef-ink)' }}>{sec.name}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                        {sec.timeLimit && <span className="flex items-center gap-1"><Timer size={10} strokeWidth={1.5} />{sec.timeLimit} min</span>}
                        {sec.breakAfter && sec.breakAfter.durationMinutes > 0 && (
                          <span
                            className="flex items-center gap-1 px-1.5"
                            title={sec.breakAfter.mandatory ? 'Mandatory break' : 'Skippable break'}
                            style={{ background: 'var(--ef-canvas-raised)', border: '1px dashed var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)', padding: '1px 6px' }}
                          >
                            Break: {sec.breakAfter.durationMinutes} min
                          </span>
                        )}
                        <span>{sec.questions.length} Q · {secMarks} mk</span>
                      </div>
                    </div>
                    {sec.rules.length > 0 && (
                      <div className="px-3 py-2.5 space-y-1">
                        {sec.rules.filter(r => (ruleQuestionCount(r) ?? 1) > 0).map((r, ri) => {
                          const dc = DIFF_COLORS[r.difficulty as Difficulty];
                          return (
                            <div key={ri} className="flex items-center justify-between text-xs py-0.5">
                              <div className="flex items-center gap-2">
                                <span className="px-1.5 py-0.5 capitalize"
                                  style={{ background: dc.bg, color: dc.text, border: `1px solid ${dc.border}`, borderRadius: 2, fontSize: 10 }}>
                                  {r.difficulty}
                                </span>
                                {isGroupRule(r) && (
                                  <span
                                    title="Grouped set — shared passage, chart or scenario"
                                    style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)', fontSize: 10, padding: '1px 5px' }}>
                                    {r.groupKind ? GROUP_KIND_LABEL[r.groupKind] : 'Grouped Set'}
                                  </span>
                                )}
                                <span style={{ color: 'var(--ef-text-muted)' }}>{r.subject}</span>
                                <span style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>›</span>
                                <span style={{ color: 'var(--ef-text-muted)', fontSize: 11 }}>{r.topic}</span>
                              </div>
                              <span style={{ color: 'var(--ef-text-muted)' }}>
                                {isGroupRule(r)
                                  ? `${r.groupCount} × ${r.questionsPerGroup === 'all' ? 'all' : r.questionsPerGroup} Q × ${r.marksPerQuestion} mk`
                                  : `${ruleQuestionCount(r) ?? 0} × ${r.marksPerQuestion} mk`}
                              </span>
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