import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import {
  Plus, X, Eye, Pencil, Trash2, Loader2, ClipboardList,
  Target, Clock, Calendar, AlertTriangle, Search, CheckCircle2,
  FileText, CalendarClock, ArrowRight, Timer, Award,
  ChevronRight, Layers, CheckSquare, Square, AlertCircle,
  Shuffle, BarChart2, BookOpen, Lock, Users, Building2, Zap, Infinity as InfinityIcon,
} from 'lucide-react';
import {
  getAllInstitutes,
  getAllStudents,
  type Institute,
  type Student,
} from '../../lib/firebaseService';
import {
  getAllAssessments,
  createAssessment,
  updateAssessment,
  softDeleteAssessment,
  statusColor,
  formatAssignmentTarget,
  resolveQuestionsForSections,
  validateSelectionRules,
  type Assessment,
  type AssessmentDraft,
  type AssessmentStatus,
  type AssignmentTarget,
  type AssessmentSection,
} from '../../lib/assessmentService';
import { getAllQuestions, type Question } from '../../lib/questionBankService';
import { getAllSubjects, type Subject } from '../../lib/subjectService';
import { EditMenu } from '../components/assignments/edit/EditMenu';

// ── Local draft types ─────────────────────────────────────────────

type Difficulty = 'easy' | 'medium' | 'hard';

type RuleDraft = {
  subject: string;
  topic: string;           // specific topic within subject
  difficulty: Difficulty;
  count: string;           // string for <input> binding
  marksPerQuestion: string;
};

type SectionDraft = {
  id: string;
  name: string;
  timeLimit: string;
  rules: RuleDraft[];
  assignedTopics: string[]; // "subject::topic" keys pre-assigned in Step 1
  breakAfterMinutes: string;  // empty = no break
  breakMandatory: boolean;
};

function makeSectionId() {
  return `sec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

const SECTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function defaultSectionName(idx: number) {
  return `Section ${SECTION_LETTERS[idx] ?? idx + 1}`;
}

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

const DIFF_LABEL: Record<Difficulty, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

const DIFF_COLORS: Record<Difficulty, { bg: string; text: string; border: string }> = {
  easy:   { bg: '#F0F9F4', text: '#1E7B3C', border: '#B8E6C8' },
  medium: { bg: '#FEF9EC', text: '#92680A', border: '#F5DFA0' },
  hard:   { bg: '#FDF5F5', text: '#9B2828', border: '#F2CECE' },
};

// ── Date/time helpers ─────────────────────────────────────────────

function toDateTimeLocal(iso?: string): string {
  if (!iso) return '';
  return iso.slice(0, 16);
}

function fromDateTimeLocal(val: string): string {
  if (!val) return '';
  return new Date(val).toISOString();
}

// Local-time formatter for the datetime-local input (avoids the UTC drift
// caused by .toISOString().slice(0,16) on non-UTC timezones).
function dateToInputLocal(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateTime(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function formatDateShort(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

const truncate = (s: string, n = 100) => (s.length > n ? s.slice(0, n) + '…' : s);

// ── Status badge ──────────────────────────────────────────────────

function StatusBadgeChip({ status }: { status: AssessmentStatus }) {
  const { bg, text, border } = statusColor(status);
  return (
    <span
      className="text-xs px-2 py-0.5 capitalize select-none"
      style={{ background: bg, color: text, border: `1px solid ${border}`, borderRadius: 2 }}
    >
      {status}
    </span>
  );
}

// ── Stat pill ─────────────────────────────────────────────────────

function StatPill({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 px-5 py-4"
      style={{ border: '1px solid #E3E1DB', borderRadius: 3, background: '#FFFFFF' }}>
      <div className="flex items-center justify-center flex-shrink-0"
        style={{ width: 30, height: 30, borderRadius: 2, background: '#F7F6F3', border: '1px solid #EEECEA' }}>
        {icon}
      </div>
      <div>
        <p className="text-xs" style={{ color: '#9A9891' }}>{label}</p>
        <p className="text-sm mt-0.5" style={{ color: '#0C0C0B' }}>{value}</p>
      </div>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-4 px-5 py-4" style={{ borderBottom: '1px solid #F0EFEB' }}>
      <div className="h-4 w-10 rounded" style={{ background: '#EEECEA' }} />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 rounded" style={{ width: '60%', background: '#EEECEA' }} />
        <div className="h-2.5 rounded" style={{ width: '30%', background: '#F3F2EF' }} />
      </div>
      <div className="h-4 w-28 rounded" style={{ background: '#F3F2EF' }} />
    </div>
  );
}

// ── Filter bar ────────────────────────────────────────────────────

const STATUS_FILTERS = [
  { label: 'All', value: '' },
  { label: 'Draft', value: 'draft' },
  { label: 'Active', value: 'active' },
  { label: 'Closed', value: 'closed' },
];

function FilterBar({ search, setSearch, statusFilter, setStatusFilter }: {
  search: string; setSearch: (v: string) => void;
  statusFilter: string; setStatusFilter: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4" style={{ borderBottom: '1px solid #F0EFEB' }}>
      <div className="flex items-center gap-2 px-3 py-2"
        style={{ background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2 }}>
        <Search size={13} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, subject, description…"
          className="flex-1 text-xs outline-none"
          style={{ background: 'transparent', color: '#0C0C0B', fontSize: 13 }} />
        {search && (
          <button onClick={() => setSearch('')} className="hover:opacity-60 transition-opacity">
            <X size={12} strokeWidth={1.5} style={{ color: '#9A9891' }} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {STATUS_FILTERS.map((f) => {
          const colors = f.value ? statusColor(f.value as AssessmentStatus) : null;
          const isActive = statusFilter === f.value;
          return (
            <button key={f.value} onClick={() => setStatusFilter(f.value)}
              className="text-xs px-2.5 py-1 transition-all"
              style={{
                borderRadius: 2,
                border: isActive ? `1px solid ${colors?.border ?? '#0C0C0B'}` : '1px solid #E3E1DB',
                background: isActive ? (colors?.bg ?? '#0C0C0B') : '#FAFAF8',
                color: isActive ? (colors?.text ?? '#FFFFFF') : '#6B6B66',
              }}>
              {f.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Assessment row ────────────────────────────────────────────────

function AssessmentRow({ assessment, onPreview, onPatched, onOpenLegacyEditor, onDelete, onRoster }: {
  assessment: Assessment;
  onPreview: () => void;
  onPatched: (patch: Partial<Assessment>) => void;
  onOpenLegacyEditor: () => void;
  onDelete: () => void;
  onRoster: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const sectionCount = assessment.sections?.length;

  return (
    <div
      className="flex items-center gap-4 px-5 py-3.5 transition-colors"
      style={{ borderBottom: '1px solid #F0EFEB', background: hovered ? '#FAFAF8' : '#FFFFFF' }}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    >
      <div className="flex-shrink-0"><StatusBadgeChip status={assessment.status} /></div>
      <div className="flex-1 min-w-0">
        <p className="text-xs" style={{ color: '#0C0C0B', lineHeight: 1.5 }}>
          {truncate(assessment.title, 80) || <em style={{ color: '#B0AEA8' }}>Untitled Assessment</em>}
        </p>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {assessment.subject && <span className="text-xs" style={{ color: '#9A9891' }}>{assessment.subject}</span>}
          <span className="text-xs" style={{ color: '#C4C3BD' }}>
            · {assessment.questions.length} Q · {assessment.totalMarks} marks
          </span>
          {sectionCount && (
            <span className="text-xs" style={{ color: '#C4C3BD' }}>
              · {sectionCount} section{sectionCount !== 1 ? 's' : ''}
            </span>
          )}
          <span className="text-xs" style={{ color: '#C4C3BD' }}>· {formatAssignmentTarget(assessment.assignedTo)}</span>
        </div>
      </div>
      <div className="flex-shrink-0 text-right" style={{ minWidth: 148 }}>
        {assessment.startDate || assessment.endDate ? (
          <div className="flex items-center gap-1.5 justify-end">
            <span className="text-xs" style={{ color: '#9A9891' }}>{formatDateShort(assessment.startDate)}</span>
            {assessment.endDate && (
              <><ArrowRight size={10} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
              <span className="text-xs" style={{ color: '#9A9891' }}>{formatDateShort(assessment.endDate)}</span></>
            )}
          </div>
        ) : <span className="text-xs" style={{ color: '#C4C3BD' }}>No date set</span>}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {assessment.status !== 'draft' && (
          <button onClick={onRoster} title="Live Roster"
            className="flex items-center gap-1 text-xs px-2 py-1.5 transition-all"
            style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, background: '#FAFAF8' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#0C0C0B'; (e.currentTarget as HTMLElement).style.color = '#0C0C0B'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB'; (e.currentTarget as HTMLElement).style.color = '#4A4A45'; }}>
            <Users size={11} strokeWidth={1.5} /> Roster
          </button>
        )}
        <button onClick={onPreview} title="Preview" className="p-1.5 transition-opacity hover:opacity-60" style={{ color: '#9A9891' }}><Eye size={13} strokeWidth={1.5} /></button>
        <EditMenu assessment={assessment} onPatched={onPatched} onOpenLegacyEditor={onOpenLegacyEditor} />
        <button onClick={onDelete} title="Delete" className="p-1.5 transition-opacity hover:opacity-60" style={{ color: '#C4C3BD' }}><Trash2 size={13} strokeWidth={1.5} /></button>
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────

function EmptyState({ filtered, onAdd }: { filtered: boolean; onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16" style={{ color: '#C4C3BD' }}>
      <div style={{ width: 1, height: 32, background: 'linear-gradient(to bottom, transparent, #DDDBD5)', marginBottom: 16 }} />
      <p className="text-xs" style={{ letterSpacing: '0.1em' }}>{filtered ? 'NO ASSESSMENTS MATCH' : 'NO ASSESSMENTS YET'}</p>
      {!filtered && (
        <button onClick={onAdd} className="mt-4 flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity hover:opacity-70"
          style={{ border: '1px solid #E3E1DB', borderRadius: 2, color: '#9A9891', background: '#FFFFFF' }}>
          <Plus size={12} strokeWidth={1.5} /> Create first assessment
        </button>
      )}
      <div style={{ width: 1, height: 32, background: 'linear-gradient(to top, transparent, #DDDBD5)', marginTop: 16 }} />
    </div>
  );
}

// ── Delete modal ──────────────────────────────────────────────────

function DeleteModal({ assessment, onConfirm, onCancel, deleting }: {
  assessment: Assessment; onConfirm: () => void; onCancel: () => void; deleting: boolean;
}) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-60 flex items-center justify-center"
      style={{ background: 'rgba(12,12,11,0.28)' }} onClick={onCancel}>
      <motion.div initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-sm"
        style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid #E3E1DB' }}>
          <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>DELETE ASSESSMENT</p>
          <button onClick={onCancel} className="p-1 hover:opacity-60 transition-opacity" style={{ color: '#9A9891' }}><X size={14} strokeWidth={1.5} /></button>
        </div>
        <div className="px-5 py-5">
          <div className="flex items-start gap-2.5 mb-4 px-3 py-3"
            style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
            <AlertTriangle size={13} strokeWidth={1.5} style={{ color: '#9B2828', flexShrink: 0, marginTop: 1 }} />
            <p className="text-xs" style={{ color: '#9B2828', lineHeight: 1.6 }}>
              This assessment will be soft-deleted. Student submissions and results will be preserved.
            </p>
          </div>
          <p className="text-xs" style={{ color: '#4A4A45', lineHeight: 1.6 }}>Are you sure you want to delete:</p>
          <p className="text-xs mt-1.5 italic" style={{ color: '#9A9891' }}>"{truncate(assessment.title, 80)}"</p>
        </div>
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderTop: '1px solid #E3E1DB' }}>
          <button onClick={onConfirm} disabled={deleting}
            className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
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

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs mb-0.5" style={{ color: '#9A9891' }}>{label}</p>
      <div className="text-xs">{children}</div>
    </div>
  );
}

function PreviewModal({ assessment, onClose }: { assessment: Assessment; onClose: () => void }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-60 flex items-center justify-center"
      style={{ background: 'rgba(12,12,11,0.28)' }} onClick={onClose}>
      <motion.div initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="w-full" style={{ maxWidth: 620, background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid #E3E1DB' }}>
          <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>ASSESSMENT PREVIEW</p>
          <button onClick={onClose} className="p-1 hover:opacity-60 transition-opacity" style={{ color: '#9A9891' }}><X size={14} strokeWidth={1.5} /></button>
        </div>
        <div className="px-5 py-5 max-h-[76vh] overflow-y-auto space-y-5">
          <div>
            <p className="text-sm" style={{ color: '#0C0C0B' }}>{assessment.title}</p>
            {assessment.description && <p className="text-xs mt-1.5" style={{ color: '#6B6B66', lineHeight: 1.6 }}>{assessment.description}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3 p-4" style={{ background: '#FAFAF8', border: '1px solid #F0EFEB', borderRadius: 2 }}>
            <MetaItem label="Status"><StatusBadgeChip status={assessment.status} /></MetaItem>
            <MetaItem label="Subject"><span style={{ color: '#0C0C0B' }}>{assessment.subject || '—'}</span></MetaItem>
            <MetaItem label="Questions"><span style={{ color: '#0C0C0B' }}>{assessment.questions.length}</span></MetaItem>
            <MetaItem label="Total Marks"><span style={{ color: '#0C0C0B' }}>{assessment.totalMarks}</span></MetaItem>
            <MetaItem label="Assigned To"><span style={{ color: '#0C0C0B' }}>{formatAssignmentTarget(assessment.assignedTo)}</span></MetaItem>
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
              <div className="grid grid-cols-2 gap-3 p-4">
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
                    <div className="flex items-center justify-between px-3 py-2.5" style={{ background: '#FAFAF8', borderBottom: '1px solid #F0EFEB' }}>
                      <div className="flex items-center gap-2">
                        <div className="flex items-center justify-center"
                          style={{ width: 18, height: 18, borderRadius: 2, background: '#F0EFEB', border: '1px solid #E3E1DB', fontSize: 9, color: '#9A9891' }}>
                          {si + 1}
                        </div>
                        <span className="text-xs" style={{ color: '#0C0C0B' }}>{sec.name}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs" style={{ color: '#9A9891' }}>
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

function Field({ label, hint, required, children }: {
  label: string; hint?: string; required?: boolean; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-1.5 mb-1.5">
        <label className="text-xs" style={{ color: '#6B6B66' }}>
          {label}{required && <span style={{ color: '#9B2828' }}> *</span>}
        </label>
        {hint && <span style={{ color: '#C4C3BD', fontSize: 10 }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <div style={{ flex: 1, height: 1, background: '#F0EFEB' }} />
      <span style={{ color: '#C4C3BD', letterSpacing: '0.1em', fontSize: 10, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: '#F0EFEB' }} />
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  border: '1px solid #E3E1DB', borderRadius: 2,
  color: '#0C0C0B', background: '#FFFFFF',
  width: '100%', fontSize: 12, padding: '7px 10px', outline: 'none',
};

const selectStyle: React.CSSProperties = { ...inputStyle, appearance: 'auto' };

function DurationIndicator({ startDate, endDate, totalSectionTime = 0 }: {
  startDate: string; endDate: string; totalSectionTime?: number;
}) {
  const s = new Date(startDate), e = new Date(endDate);
  if (isNaN(s.getTime()) || isNaN(e.getTime()) || e <= s) return null;
  const diffMins = Math.floor((e.getTime() - s.getTime()) / 60000);
  const h = Math.floor(diffMins / 60), m = diffMins % 60;
  const label = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`;

  const required = totalSectionTime + 1; // window must be at least 1 min more than total section time
  const tooShort = totalSectionTime > 0 && diffMins < required;

  if (tooShort) {
    const shortBy = required - diffMins;
    const shortLabel = shortBy >= 60
      ? `${Math.floor(shortBy / 60)}h${shortBy % 60 > 0 ? ` ${shortBy % 60}m` : ''}`
      : `${shortBy}m`;
    return (
      <div className="flex items-center gap-2 px-3 py-2"
        style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
        <AlertTriangle size={11} strokeWidth={1.5} style={{ color: '#9B2828', flexShrink: 0 }} />
        <span className="text-xs" style={{ color: '#9B2828' }}>
          Window <strong>{label}</strong> is too short — extend by at least <strong>{shortLabel}</strong> to cover all section time limits ({totalSectionTime}m total) plus a 1m buffer.
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2"
      style={{ background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2 }}>
      <Clock size={11} strokeWidth={1.5} style={{ color: '#1E7B3C', flexShrink: 0 }} />
      <span className="text-xs" style={{ color: '#1E7B3C' }}>Window duration: <strong>{label}</strong></span>
    </div>
  );
}

// ── Field mutability ──────────────────────────────────────────────

type FieldMutability = {
  targetType: boolean;
  startDate: boolean;
  endDate: boolean | 'extend-only';
  shuffleQuestions: boolean;
  sections: boolean;
};

function mutabilityFor(status?: AssessmentStatus): FieldMutability {
  if (!status || status === 'draft') {
    return { targetType: true, startDate: true, endDate: true, shuffleQuestions: true, sections: true };
  }
  if (status === 'active') {
    return { targetType: false, startDate: false, endDate: 'extend-only', shuffleQuestions: false, sections: false };
  }
  // closed
  return { targetType: false, startDate: false, endDate: false, shuffleQuestions: false, sections: false };
}

// ── Friendly schedule controls ────────────────────────────────────

function PresetChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2.5 py-1 transition-all"
      style={{
        background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 999,
        fontSize: 11, color: '#4A4A45', letterSpacing: '0.01em',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = '#0C0C0B';
        (e.currentTarget as HTMLElement).style.color = '#FFFFFF';
        (e.currentTarget as HTMLElement).style.borderColor = '#0C0C0B';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = '#FFFFFF';
        (e.currentTarget as HTMLElement).style.color = '#4A4A45';
        (e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB';
      }}
    >
      {label}
    </button>
  );
}

function SegmentedToggle({
  leftLabel, rightLabel, leftIcon, rightIcon, isLeft, onLeft, onRight,
}: {
  leftLabel: string; rightLabel: string;
  leftIcon: React.ReactNode; rightIcon: React.ReactNode;
  isLeft: boolean; onLeft: () => void; onRight: () => void;
}) {
  const btn = (active: boolean): React.CSSProperties => ({
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: 6, padding: '7px 10px', fontSize: 11, letterSpacing: '0.02em',
    background: active ? '#0C0C0B' : 'transparent',
    color: active ? '#FFFFFF' : '#6B6B66',
    transition: 'all 0.15s',
    cursor: active ? 'default' : 'pointer',
  });
  return (
    <div className="flex" style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', overflow: 'hidden' }}>
      <button type="button" onClick={onLeft} style={btn(isLeft)}>{leftIcon}{leftLabel}</button>
      <button type="button" onClick={onRight} style={btn(!isLeft)}>{rightIcon}{rightLabel}</button>
    </div>
  );
}

function StartScheduleControl({
  startDate, setStartDate,
}: { startDate: string; setStartDate: (v: string) => void }) {
  const isImmediate = !startDate;

  const setRelative = (mins: number) => {
    const d = new Date(Date.now() + mins * 60000);
    setStartDate(dateToInputLocal(d));
  };
  const setTomorrow9 = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    setStartDate(dateToInputLocal(d));
  };
  const switchToScheduled = () => {
    if (!startDate) setRelative(60);
  };

  return (
    <Field label="Start">
      <div className="space-y-2">
        <SegmentedToggle
          leftLabel="Start immediately"
          rightLabel="Schedule for later"
          leftIcon={<Zap size={11} strokeWidth={1.5} />}
          rightIcon={<Calendar size={11} strokeWidth={1.5} />}
          isLeft={isImmediate}
          onLeft={() => setStartDate('')}
          onRight={switchToScheduled}
        />

        {isImmediate ? (
          <p className="text-xs flex items-start gap-1.5 px-1" style={{ color: '#9A9891', lineHeight: 1.5 }}>
            <Zap size={10} strokeWidth={1.5} style={{ flexShrink: 0, marginTop: 2 }} />
            Students can begin as soon as the assessment is published.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 py-2"
              style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
              <Calendar size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
              <input type="datetime-local" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                className="flex-1 outline-none"
                style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <PresetChip label="In 15 min" onClick={() => setRelative(15)} />
              <PresetChip label="In 1 hr" onClick={() => setRelative(60)} />
              <PresetChip label="Tomorrow 9 AM" onClick={setTomorrow9} />
            </div>
          </>
        )}
      </div>
    </Field>
  );
}

function EndScheduleControl({
  endDate, setEndDate, startDate,
}: { endDate: string; setEndDate: (v: string) => void; startDate: string }) {
  const hasDeadline = !!endDate;

  const baseDate = (): Date => {
    if (startDate) {
      const d = new Date(startDate);
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  };

  const setRelative = (mins: number) => {
    const d = new Date(baseDate().getTime() + mins * 60000);
    setEndDate(dateToInputLocal(d));
  };
  const switchToDeadline = () => {
    if (!endDate) setRelative(60);
  };

  return (
    <Field label="End">
      <div className="space-y-2">
        <SegmentedToggle
          leftLabel="No deadline"
          rightLabel="Set deadline"
          leftIcon={<InfinityIcon size={11} strokeWidth={1.5} />}
          rightIcon={<Calendar size={11} strokeWidth={1.5} />}
          isLeft={!hasDeadline}
          onLeft={() => setEndDate('')}
          onRight={switchToDeadline}
        />

        {!hasDeadline ? (
          <p className="text-xs flex items-start gap-1.5 px-1" style={{ color: '#9A9891', lineHeight: 1.5 }}>
            <InfinityIcon size={10} strokeWidth={1.5} style={{ flexShrink: 0, marginTop: 2 }} />
            The assessment stays open until you close it manually.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 py-2"
              style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
              <Calendar size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
              <input type="datetime-local" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                className="flex-1 outline-none"
                style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }}
                min={startDate || undefined} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <PresetChip label="+30 min" onClick={() => setRelative(30)} />
              <PresetChip label="+1 hr" onClick={() => setRelative(60)} />
              <PresetChip label="+2 hr" onClick={() => setRelative(120)} />
              <PresetChip label="+1 day" onClick={() => setRelative(60 * 24)} />
            </div>
            <p className="text-xs px-1" style={{ color: '#C4C3BD', lineHeight: 1.5 }}>
              Presets are relative to {startDate ? 'the start time' : 'now'}.
            </p>
          </>
        )}
      </div>
    </Field>
  );
}

// ── Locked field wrapper ──────────────────────────────────────────

function LockedFieldWrapper({ label, reason, children }: {
  label: string; reason: string; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-xs" style={{ color: '#B0AEA8' }}>{label}</span>
        <div className="flex items-center gap-1">
          <Lock size={9} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
          <span style={{ color: '#C4C3BD', fontSize: 10 }}>{reason}</span>
        </div>
      </div>
      <div style={{ opacity: 0.4, pointerEvents: 'none', userSelect: 'none' }}>
        {children}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// RULE BUILDER — right-panel component for step 2
// Three-level hierarchy: Subject → Topic → Difficulty
// ══════════════════════════════════════════════════════════════════

function DifficultyRow({
  diff, available, bankTotal, rule,
  onCountChange, onMarksChange,
}: {
  diff: Difficulty;
  available: number;
  bankTotal: number;
  rule: RuleDraft | undefined;
  onCountChange: (v: string) => void;
  onMarksChange: (v: string) => void;
}) {
  const count = parseInt(rule?.count ?? '', 10) || 0;
  const isEmpty = bankTotal === 0;
  const isOver = count > available;
  const hasValue = count > 0;
  const dc = DIFF_COLORS[diff];

  return (
    <div
      className="flex items-center gap-2.5 py-1.5 px-3 mx-2 my-0.5"
      style={{
        borderRadius: 2,
        border: hasValue ? `1px solid ${isOver ? '#F2CECE' : '#E3E1DB'}` : '1px solid transparent',
        background: hasValue ? (isOver ? '#FDF5F5' : '#FFFFFF') : 'transparent',
        opacity: isEmpty ? 0.4 : 1,
      }}
    >
      {/* Difficulty badge */}
      <span
        className="flex-shrink-0 capitalize"
        style={{
          background: dc.bg, color: dc.text, border: `1px solid ${dc.border}`,
          borderRadius: 2, fontSize: 10, padding: '2px 7px', minWidth: 48, textAlign: 'center',
        }}
      >
        {DIFF_LABEL[diff]}
      </span>

      {/* Available count */}
      <span className="flex-shrink-0 text-xs" style={{ color: available === 0 ? '#C4C3BD' : '#9A9891', minWidth: 62 }}>
        {isEmpty ? 'none in bank' : `${available} avail.`}
      </span>

      {/* Pick count */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <span style={{ color: '#C4C3BD', fontSize: 11 }}>pick</span>
        <input
          type="number"
          disabled={isEmpty}
          value={rule?.count ?? ''}
          onChange={(e) => onCountChange(e.target.value)}
          placeholder="0"
          min="0"
          max={available}
          className="outline-none text-center"
          style={{
            width: 38, padding: '3px 4px', fontSize: 12, borderRadius: 2,
            border: `1px solid ${isOver ? '#F2CECE' : '#E3E1DB'}`,
            background: isOver ? '#FDF5F5' : '#FFFFFF',
            color: isOver ? '#9B2828' : '#0C0C0B',
            cursor: isEmpty ? 'not-allowed' : 'text',
          }}
        />
      </div>

      {/* Marks per Q */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <input
          type="number"
          disabled={isEmpty}
          value={rule?.marksPerQuestion ?? ''}
          onChange={(e) => onMarksChange(e.target.value)}
          placeholder="1"
          min="0.5"
          step="0.5"
          className="outline-none text-center"
          style={{
            width: 38, padding: '3px 4px', fontSize: 12, borderRadius: 2,
            border: '1px solid #E3E1DB', background: '#FFFFFF', color: '#0C0C0B',
            cursor: isEmpty ? 'not-allowed' : 'text',
          }}
        />
        <span style={{ color: '#C4C3BD', fontSize: 10 }}>mk/Q</span>
      </div>

      {/* Subtotal + status */}
      <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
        {hasValue && !isOver && (
          <span style={{ color: '#B0AEA8', fontSize: 10 }}>
            {count * (parseFloat(rule?.marksPerQuestion ?? '') || 1)} mk
          </span>
        )}
        {hasValue && (
          isOver
            ? <div className="flex items-center gap-0.5">
                <AlertCircle size={11} strokeWidth={1.5} style={{ color: '#9B2828' }} />
                <span style={{ color: '#9B2828', fontSize: 10 }}>only {available}</span>
              </div>
            : <CheckCircle2 size={12} strokeWidth={1.5} style={{ color: '#1E7B3C' }} />
        )}
      </div>
    </div>
  );
}

function RuleBuilderPanel({
  sections,
  activeSectionIdx,
  setActiveSectionIdx,
  setSections,
  allQuestions,
  locked,
  subjectPoolNames,
  topicPool,
}: {
  sections: SectionDraft[];
  activeSectionIdx: number;
  setActiveSectionIdx: (i: number) => void;
  setSections: React.Dispatch<React.SetStateAction<SectionDraft[]>>;
  allQuestions: Question[];
  locked?: boolean;
  subjectPoolNames?: string[];
  topicPool?: string[];
}) {
  const activeSection = sections[activeSectionIdx];

  // ── Derived bank structure ──────────────────────────────────────
  // subjectTopics: subject → sorted list of topics
  // bankCount: subject::topic::difficulty → count
  const { subjectTopics, bankCount } = useMemo(() => {
    const topicsMap: Record<string, Set<string>> = {};
    const countMap: Record<string, number> = {};
    allQuestions.forEach((q) => {
      if (q.isDeleted || !q.subject || !q.topic) return;
      if (!topicsMap[q.subject]) topicsMap[q.subject] = new Set();
      topicsMap[q.subject].add(q.topic);
      const k = `${q.subject}::${q.topic}::${q.difficulty}`;
      countMap[k] = (countMap[k] ?? 0) + 1;
    });
    const sorted: Record<string, string[]> = {};
    for (const subj in topicsMap) {
      sorted[subj] = [...topicsMap[subj]].sort();
    }
    return { subjectTopics: sorted, bankCount: countMap };
  }, [allQuestions]);

  // ── Filter by this section's assigned topics ────────────────────
  // If assignedTopics is non-empty, only show those subject/topic pairs.
  // If empty (no pre-assignment), fall back to showing the full bank.
  const filteredSubjectTopics = useMemo(() => {
    // Layer 1: start from full bank
    let base: Record<string, string[]> = subjectTopics;

    // Layer 2: narrow by global subjectPool / topicPool from Step 1
    const subjSet = subjectPoolNames && subjectPoolNames.length > 0 ? new Set(subjectPoolNames) : null;
    const topicSet = topicPool && topicPool.length > 0 ? new Set(topicPool) : null;
    if (subjSet || topicSet) {
      const narrowed: Record<string, string[]> = {};
      for (const subj in base) {
        if (subjSet && !subjSet.has(subj)) continue;
        const topics = base[subj].filter((t) => !topicSet || topicSet.has(`${subj}::${t}`));
        if (topics.length > 0) narrowed[subj] = topics;
      }
      base = narrowed;
    }

    // Layer 3: narrow further by per-section assignedTopics
    const assigned = activeSection?.assignedTopics ?? [];
    if (assigned.length === 0) return base;
    const result: Record<string, string[]> = {};
    assigned.forEach((key) => {
      const idx = key.indexOf('::');
      if (idx === -1) return;
      const subj = key.slice(0, idx);
      const topic = key.slice(idx + 2);
      if (!base[subj] || !base[subj].includes(topic)) return;
      if (!result[subj]) result[subj] = [];
      if (!result[subj].includes(topic)) result[subj].push(topic);
    });
    for (const subj in result) result[subj].sort();
    return result;
  }, [activeSection?.assignedTopics, subjectTopics, subjectPoolNames, topicPool]);

  const allSubjects = useMemo(() => Object.keys(filteredSubjectTopics).sort(), [filteredSubjectTopics]);

  const isTopicFiltered = (activeSection?.assignedTopics?.length ?? 0) > 0;

  // ── Cross-section topic map ─────────────────────────────────────
  // For each "subject::topic" key, which OTHER sections also have it assigned?
  const topicOtherSectionsMap = useMemo(() => {
    const map: Record<string, number[]> = {};
    sections.forEach((sec, si) => {
      if (si === activeSectionIdx) return;
      (sec.assignedTopics ?? []).forEach((key) => {
        if (!map[key]) map[key] = [];
        map[key].push(si);
      });
    });
    return map;
  }, [sections, activeSectionIdx]);

  // ── Prior-section committed counts ─────────────────────────────
  // key: subject::topic::difficulty
  const priorCommitted = useMemo(() => {
    const map: Record<string, number> = {};
    sections.forEach((sec, si) => {
      if (si >= activeSectionIdx) return;
      sec.rules.forEach((r) => {
        const count = parseInt(r.count, 10) || 0;
        if (!count) return;
        const k = `${r.subject}::${r.topic}::${r.difficulty}`;
        map[k] = (map[k] ?? 0) + count;
      });
    });
    return map;
  }, [sections, activeSectionIdx]);

  const getAvailable = (subject: string, topic: string, diff: Difficulty) => {
    const total = bankCount[`${subject}::${topic}::${diff}`] ?? 0;
    const used = priorCommitted[`${subject}::${topic}::${diff}`] ?? 0;
    return Math.max(0, total - used);
  };

  // ── Expand/select state ─────────────────────────────────────────
  // expandedSubjects: which subject accordions are open
  // selectedTopics: which topics are checked (key = subject::topic)

  // Helper: derive expanded subjects from both rules and pre-assigned topics
  function deriveExpandedSubjects(sec: SectionDraft | undefined): Set<string> {
    const set = new Set<string>();
    sec?.rules.forEach((r) => { if (r.subject) set.add(r.subject); });
    // Also auto-expand subjects of pre-assigned topics so faculty sees them immediately
    (sec?.assignedTopics ?? []).forEach((key) => {
      const subj = key.split('::')[0];
      if (subj) set.add(subj);
    });
    return set;
  }

  const [expandedSubjects, setExpandedSubjects] = useState<Set<string>>(() =>
    deriveExpandedSubjects(sections[activeSectionIdx])
  );

  const [selectedTopics, setSelectedTopics] = useState<Set<string>>(() => {
    const set = new Set<string>();
    sections[activeSectionIdx]?.rules.forEach((r) => {
      if (r.subject && r.topic) set.add(`${r.subject}::${r.topic}`);
    });
    return set;
  });

  // Re-sync when active section tab changes
  useEffect(() => {
    const newTopics = new Set<string>();
    sections[activeSectionIdx]?.rules.forEach((r) => {
      if (r.subject && r.topic) newTopics.add(`${r.subject}::${r.topic}`);
    });
    setExpandedSubjects(deriveExpandedSubjects(sections[activeSectionIdx]));
    setSelectedTopics(newTopics);
  }, [activeSectionIdx]); // eslint-disable-line

  const toggleSubject = (subject: string) => {
    setExpandedSubjects((prev) => {
      const next = new Set(prev);
      next.has(subject) ? next.delete(subject) : next.add(subject);
      return next;
    });
  };

  const toggleTopic = (subject: string, topic: string) => {
    const tk = `${subject}::${topic}`;
    setSelectedTopics((prev) => {
      const next = new Set(prev);
      if (next.has(tk)) {
        next.delete(tk);
        // Clear all rules for this topic in the active section
        setSections((secs) => secs.map((sec, i) =>
          i !== activeSectionIdx ? sec : {
            ...sec,
            rules: sec.rules.filter((r) => !(r.subject === subject && r.topic === topic)),
          }
        ));
      } else {
        next.add(tk);
        // Ensure subject is expanded
        setExpandedSubjects((es) => { const ns = new Set(es); ns.add(subject); return ns; });
      }
      return next;
    });
  };

  const updateRule = (
    subject: string, topic: string, diff: Difficulty,
    field: 'count' | 'marksPerQuestion', value: string
  ) => {
    setSections((secs) => secs.map((sec, i) => {
      if (i !== activeSectionIdx) return sec;
      const existing = sec.rules.find(
        (r) => r.subject === subject && r.topic === topic && r.difficulty === diff
      );
      if (existing) {
        return {
          ...sec,
          rules: sec.rules.map((r) =>
            r.subject === subject && r.topic === topic && r.difficulty === diff
              ? { ...r, [field]: value }
              : r
          ),
        };
      } else {
        const newRule: RuleDraft = { subject, topic, difficulty: diff, count: '', marksPerQuestion: '1', [field]: value };
        return { ...sec, rules: [...sec.rules, newRule] };
      }
    }));
  };

  const getRule = (subject: string, topic: string, diff: Difficulty) =>
    activeSection?.rules.find((r) => r.subject === subject && r.topic === topic && r.difficulty === diff);

  // ── Totals ──────────────────────────────────────────────────────
  const sectionTotalQ = activeSection?.rules.reduce((s, r) => s + (parseInt(r.count, 10) || 0), 0) ?? 0;
  const sectionTotalMarks = activeSection?.rules.reduce((s, r) =>
    s + (parseInt(r.count, 10) || 0) * (parseFloat(r.marksPerQuestion) || 0), 0) ?? 0;

  const grandTotalQ = sections.reduce((s, sec) =>
    s + sec.rules.reduce((ss, r) => ss + (parseInt(r.count, 10) || 0), 0), 0);
  const grandTotalMarks = sections.reduce((s, sec) =>
    sec.rules.reduce((ss, r) =>
      ss + (parseInt(r.count, 10) || 0) * (parseFloat(r.marksPerQuestion) || 0), s), 0);

  if (!activeSection) return null;

  return (
    <div className="flex" style={{ background: '#FFFFFF', minHeight: 560, alignItems: 'stretch' }}>

      {/* ── LEFT: Vertical section rail (sticky while page scrolls) ── */}
      <div className="flex-shrink-0 flex flex-col"
        style={{
          width: 172,
          borderRight: '1px solid #E3E1DB',
          background: '#FAFAF8',
          position: 'sticky',
          top: 0,
          alignSelf: 'flex-start',
        }}>

        <div className="flex-shrink-0 px-4 pt-4 pb-2">
          <p style={{ color: '#C4C3BD', fontSize: 10, letterSpacing: '0.09em' }}>SECTIONS</p>
        </div>

        <div className="flex-1">
          {sections.map((sec, idx) => {
            const isActive = idx === activeSectionIdx;
            const secQ = sec.rules.reduce((s, r) => s + (parseInt(r.count, 10) || 0), 0);
            const secMarks = sec.rules.reduce((s, r) => s + (parseInt(r.count, 10) || 0) * (parseFloat(r.marksPerQuestion) || 0), 0);
            return (
              <button
                key={sec.id}
                onClick={() => setActiveSectionIdx(idx)}
                className="w-full flex flex-col items-start px-4 py-3 transition-colors text-left"
                style={{
                  background: isActive ? '#FFFFFF' : 'transparent',
                  borderLeft: `2px solid ${isActive ? '#0C0C0B' : 'transparent'}`,
                  borderBottom: '1px solid #E3E1DB',
                }}
              >
                <span className="text-xs" style={{ color: isActive ? '#0C0C0B' : '#6B6B66', lineHeight: 1.4, wordBreak: 'break-word' }}>
                  {sec.name}
                </span>
                <span style={{ color: '#C4C3BD', fontSize: 10, marginTop: 2 }}>
                  {secQ > 0 ? `${secQ} Q · ${secMarks} mk` : 'no rules yet'}
                </span>
                {sec.timeLimit && (
                  <span className="flex items-center gap-1 mt-1" style={{ color: '#B0AEA8', fontSize: 10 }}>
                    <Timer size={9} strokeWidth={1.5} />{sec.timeLimit} min
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Grand total at rail bottom */}
        <div className="flex-shrink-0 px-4 py-3" style={{ borderTop: '1px solid #E3E1DB', background: '#F7F6F3' }}>
          <p style={{ color: '#9A9891', fontSize: 10 }}>{grandTotalQ} Q · {grandTotalMarks} marks</p>
          <p style={{ color: '#C4C3BD', fontSize: 10, marginTop: 1 }}>
            {sections.length} section{sections.length !== 1 ? 's' : ''} total
          </p>
        </div>
      </div>

      {/* ── RIGHT: Rule content (grows with content; outer page handles scroll) ── */}
      <div className="flex-1 flex flex-col" style={{ minWidth: 0 }}>

      {/* ── Instruction or lock banner ── */}
      {locked ? (
        <div className="px-5 py-2.5 flex-shrink-0 flex items-center gap-2"
          style={{ background: '#FEF9EC', borderBottom: '1px solid #F5DFA0' }}>
          <Lock size={11} strokeWidth={1.5} style={{ color: '#92680A', flexShrink: 0 }} />
          <p style={{ color: '#92680A', fontSize: 11, lineHeight: 1.5 }}>
            Question rules are locked — the question set was resolved when this test went live and cannot be changed.
          </p>
        </div>
      ) : isTopicFiltered ? (
        <div className="px-5 py-2.5 flex-shrink-0 flex items-center gap-2"
          style={{ background: '#F0F9F4', borderBottom: '1px solid #B8E6C8' }}>
          <BookOpen size={11} strokeWidth={1.5} style={{ color: '#1E7B3C', flexShrink: 0 }} />
          <p style={{ color: '#1E7B3C', fontSize: 11, lineHeight: 1.5 }}>
            Showing <strong>{activeSection?.assignedTopics.length}</strong> pre-assigned topic{(activeSection?.assignedTopics.length ?? 0) !== 1 ? 's' : ''} for this section.
            Set pick count &amp; marks per difficulty row.
          </p>
        </div>
      ) : (
        <div className="px-5 py-2.5 flex-shrink-0 flex items-center gap-2"
          style={{ background: '#FAFAF8', borderBottom: '1px solid #F0EFEB' }}>
          <Layers size={11} strokeWidth={1.5} style={{ color: '#C4C3BD', flexShrink: 0 }} />
          <p style={{ color: '#9A9891', fontSize: 11, lineHeight: 1.5 }}>
            No topics pre-assigned — showing full bank. Assign topics in Setup (Step 1) for a focused view.
          </p>
        </div>
      )}

      {/* ── Subject / topic / difficulty tree ── */}
      <div className="flex-1" style={locked ? { pointerEvents: 'none', opacity: 0.5 } : {}}>
        {allSubjects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16" style={{ color: '#C4C3BD' }}>
            {isTopicFiltered ? (
              <>
                <p className="text-xs">No topics assigned to this section</p>
                <p style={{ fontSize: 11, color: '#DDDBD5', marginTop: 4 }}>Go back to Setup to assign topics</p>
              </>
            ) : (
              <>
                <p className="text-xs">No subjects found in question bank</p>
                <p style={{ fontSize: 11, color: '#DDDBD5', marginTop: 4 }}>Add questions to the bank first</p>
              </>
            )}
          </div>
        ) : (
          allSubjects.map((subject) => {
            const isSubjectOpen = expandedSubjects.has(subject);
            const topics = filteredSubjectTopics[subject] ?? [];
            const totalInBank = topics.reduce(
              (s, t) => s + DIFFICULTIES.reduce((ss, d) => ss + (bankCount[`${subject}::${t}::${d}`] ?? 0), 0), 0
            );
            const subjectSelectedQ = activeSection.rules
              .filter((r) => r.subject === subject)
              .reduce((s, r) => s + (parseInt(r.count, 10) || 0), 0);
            const subjectSelectedTopics = topics.filter((t) => selectedTopics.has(`${subject}::${t}`)).length;

            return (
              <div key={subject} style={{ borderBottom: '1px solid #F0EFEB' }}>

                {/* Subject accordion header */}
                <button
                  className="w-full flex items-center gap-2.5 px-5 py-3 text-left transition-colors"
                  style={{ background: isSubjectOpen ? '#FAFAF8' : '#FFFFFF' }}
                  onClick={() => toggleSubject(subject)}
                >
                  {/* Chevron */}
                  <ChevronRight size={13} strokeWidth={1.5}
                    style={{ color: '#9A9891', flexShrink: 0, transition: 'transform 0.15s', transform: isSubjectOpen ? 'rotate(90deg)' : 'rotate(0deg)' }} />

                  <span className="flex-1 text-xs" style={{ color: '#0C0C0B' }}>{subject}</span>

                  {/* Badge: selected topics count */}
                  {subjectSelectedTopics > 0 && (
                    <span className="text-xs px-1.5 py-0.5 flex-shrink-0"
                      style={{ background: '#F7F6F3', color: '#6B6B66', border: '1px solid #E3E1DB', borderRadius: 2, fontSize: 10 }}>
                      {subjectSelectedTopics}/{topics.length} topic{topics.length !== 1 ? 's' : ''}
                    </span>
                  )}

                  {/* Badge: Q selected */}
                  {subjectSelectedQ > 0 && (
                    <span className="text-xs px-1.5 py-0.5 flex-shrink-0"
                      style={{ background: '#F0F9F4', color: '#1E7B3C', border: '1px solid #B8E6C8', borderRadius: 2 }}>
                      {subjectSelectedQ} Q
                    </span>
                  )}

                  <span style={{ color: '#C4C3BD', fontSize: 11, flexShrink: 0 }}>{totalInBank} in bank</span>
                </button>

                {/* Topics list */}
                <AnimatePresence initial={false}>
                  {isSubjectOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
                      animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
                      exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
                      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                      style={{ borderTop: '1px solid #F0EFEB' }}
                    >
                      <div className="py-1.5" style={{ background: '#FAFAF8' }}>
                        {topics.map((topic) => {
                          const tk = `${subject}::${topic}`;
                          const isTopicSelected = selectedTopics.has(tk);
                          const topicTotalInBank = DIFFICULTIES.reduce(
                            (s, d) => s + (bankCount[`${subject}::${topic}::${d}`] ?? 0), 0
                          );
                          const topicQ = activeSection.rules
                            .filter((r) => r.subject === subject && r.topic === topic)
                            .reduce((s, r) => s + (parseInt(r.count, 10) || 0), 0);
                          const topicMarks = activeSection.rules
                            .filter((r) => r.subject === subject && r.topic === topic)
                            .reduce((s, r) => s + (parseInt(r.count, 10) || 0) * (parseFloat(r.marksPerQuestion) || 0), 0);

                          // Cross-section sharing: which other sections also have this topic?
                          const otherSectionIdxs = topicOtherSectionsMap[tk] ?? [];

                          return (
                            <div key={topic} style={{ borderBottom: '1px solid #F0EFEB' }}>
                              {/* Topic row with checkbox */}
                              <button
                                className="w-full flex items-center gap-2.5 px-5 py-2.5 text-left transition-colors"
                                style={{ background: isTopicSelected ? '#FFFFFF' : 'transparent' }}
                                onClick={() => toggleTopic(subject, topic)}
                              >
                                {/* Checkbox */}
                                <span style={{ flexShrink: 0 }}>
                                  {isTopicSelected
                                    ? <CheckSquare size={13} strokeWidth={1.5} style={{ color: '#0C0C0B' }} />
                                    : <Square size={13} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />}
                                </span>

                                {/* Topic name */}
                                <span className="flex-1 text-xs" style={{ color: isTopicSelected ? '#0C0C0B' : '#6B6B66' }}>
                                  {topic}
                                </span>

                                {/* Cross-section "also in Sec X" badge */}
                                {otherSectionIdxs.length > 0 && (
                                  <span style={{ fontSize: 10, color: '#92680A', background: '#FEF9EC', border: '1px solid #F5DFA0', borderRadius: 2, padding: '1px 6px', flexShrink: 0 }}>
                                    also in {otherSectionIdxs.map((si) => sections[si]?.name ?? `Sec ${si + 1}`).join(', ')}
                                  </span>
                                )}

                                {/* Marks subtotal for this topic */}
                                {topicMarks > 0 && (
                                  <span style={{ color: '#9A9891', fontSize: 11, flexShrink: 0 }}>
                                    {topicMarks} mk
                                  </span>
                                )}

                                {/* Q count badge */}
                                {topicQ > 0 && (
                                  <span className="text-xs px-1.5 py-0.5 flex-shrink-0"
                                    style={{ background: '#F0F9F4', color: '#1E7B3C', border: '1px solid #B8E6C8', borderRadius: 2, fontSize: 10 }}>
                                    {topicQ} Q
                                  </span>
                                )}

                                <span style={{ color: '#C4C3BD', fontSize: 10, flexShrink: 0 }}>
                                  {topicTotalInBank} in bank
                                </span>
                              </button>

                              {/* Difficulty rows (only when topic is checked) */}
                              <AnimatePresence initial={false}>
                                {isTopicSelected && (
                                  <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                                    style={{ overflow: 'hidden', borderTop: '1px solid #F0EFEB', background: '#FFFFFF', paddingTop: 4, paddingBottom: 6 }}
                                  >
                                    {DIFFICULTIES.map((diff) => (
                                      <DifficultyRow
                                        key={diff}
                                        diff={diff}
                                        available={getAvailable(subject, topic, diff)}
                                        bankTotal={bankCount[`${subject}::${topic}::${diff}`] ?? 0}
                                        rule={getRule(subject, topic, diff)}
                                        onCountChange={(v) => updateRule(subject, topic, diff, 'count', v)}
                                        onMarksChange={(v) => updateRule(subject, topic, diff, 'marksPerQuestion', v)}
                                      />
                                    ))}
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>
                          );
                        })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })
        )}
      </div>

      {/* ── Footer: per-section total ── */}
      {sectionTotalQ > 0 && (
        <div className="flex-shrink-0 flex items-center justify-between px-5 py-2.5"
          style={{ borderTop: '1px solid #E3E1DB', background: '#FAFAF8' }}>
          <span className="text-xs" style={{ color: '#9A9891' }}>
            {activeSection.name} · {sectionTotalQ} question{sectionTotalQ !== 1 ? 's' : ''}
          </span>
          <span className="text-xs" style={{ color: '#0C0C0B' }}>{sectionTotalMarks} marks</span>
        </div>
      )}
      </div>{/* end right column */}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SECTION TOPIC PICKER — inline topic assignment for Step 1 section cards
// ══════════════════════════════════════════════════════════════════

function SectionTopicPicker({
  sectionIdx,
  sections,
  assignedTopics,
  onToggleTopic,
  subjectTopics,
}: {
  sectionIdx: number;
  sections: SectionDraft[];
  assignedTopics: string[];
  onToggleTopic: (key: string) => void;
  subjectTopics: Record<string, string[]>;
}) {
  const allSubjects = useMemo(() => Object.keys(subjectTopics).sort(), [subjectTopics]);

  const [expandedSubjects, setExpandedSubjects] = useState<Set<string>>(() => {
    const set = new Set<string>();
    assignedTopics.forEach((key) => {
      const subj = key.split('::')[0];
      if (subj) set.add(subj);
    });
    return set;
  });

  // Topics in other sections (excluding this one)
  const topicOtherSections = useMemo(() => {
    const map: Record<string, number[]> = {};
    sections.forEach((sec, si) => {
      if (si === sectionIdx) return;
      (sec.assignedTopics ?? []).forEach((key) => {
        if (!map[key]) map[key] = [];
        map[key].push(si);
      });
    });
    return map;
  }, [sections, sectionIdx]);

  const toggleSubject = (subj: string) => {
    setExpandedSubjects((prev) => {
      const next = new Set(prev);
      next.has(subj) ? next.delete(subj) : next.add(subj);
      return next;
    });
  };

  if (allSubjects.length === 0) {
    return (
      <div className="py-5 text-center" style={{ borderTop: '1px solid #E3E1DB' }}>
        <p style={{ color: '#C4C3BD', fontSize: 11 }}>No subjects in question bank</p>
        <p style={{ color: '#DDDBD5', fontSize: 10, marginTop: 3 }}>Add questions first to assign topics</p>
      </div>
    );
  }

  return (
    <div style={{ borderTop: '1px solid #E3E1DB' }}>
      {allSubjects.map((subject) => {
        const topics = subjectTopics[subject] ?? [];
        const isOpen = expandedSubjects.has(subject);
        const assignedCount = topics.filter((t) => assignedTopics.includes(`${subject}::${t}`)).length;

        return (
          <div key={subject} style={{ borderBottom: '1px solid #F0EFEB' }}>
            {/* Subject header */}
            <button
              type="button"
              className="w-full flex items-center gap-2 px-4 py-2 text-left transition-colors"
              style={{ background: isOpen ? '#F7F6F3' : '#FAFAF8' }}
              onClick={() => toggleSubject(subject)}
            >
              <ChevronRight
                size={11} strokeWidth={1.5}
                style={{ color: '#9A9891', flexShrink: 0, transition: 'transform 0.15s', transform: isOpen ? 'rotate(90deg)' : 'none' }}
              />
              <span className="flex-1 text-xs" style={{ color: '#0C0C0B' }}>{subject}</span>
              {assignedCount > 0 && (
                <span style={{ fontSize: 10, color: '#1E7B3C', background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2, padding: '1px 6px', flexShrink: 0 }}>
                  {assignedCount}/{topics.length}
                </span>
              )}
            </button>

            {/* Topics list */}
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
                  animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
                  exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
                  transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                >
                  {topics.map((topic) => {
                    const key = `${subject}::${topic}`;
                    const isChecked = assignedTopics.includes(key);
                    const otherSecs = topicOtherSections[key] ?? [];

                    return (
                      <button
                        key={topic}
                        type="button"
                        className="w-full flex items-center gap-2.5 px-5 py-2 text-left transition-colors"
                        style={{ background: isChecked ? '#FAFAF8' : '#FFFFFF', borderTop: '1px solid #F7F6F3' }}
                        onClick={() => onToggleTopic(key)}
                      >
                        <span style={{ flexShrink: 0 }}>
                          {isChecked
                            ? <CheckSquare size={12} strokeWidth={1.5} style={{ color: '#0C0C0B' }} />
                            : <Square size={12} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />}
                        </span>
                        <span className="flex-1 text-xs" style={{ color: isChecked ? '#0C0C0B' : '#6B6B66' }}>
                          {topic}
                        </span>
                        {otherSecs.length > 0 && (
                          <span style={{ fontSize: 10, color: '#92680A', background: '#FEF9EC', border: '1px solid #F5DFA0', borderRadius: 2, padding: '1px 6px', flexShrink: 0 }}>
                            also in {otherSecs.map((si) => sections[si]?.name ?? `Sec ${si + 1}`).join(', ')}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SUBJECT PICKER PHASE — Phase 1 of the right column in Step 1
// Grid of subject cards; each shows name · topic count · Q count.
// ══════════════════════════════════════════════════════════════════

function SubjectPickerPhase({
  subjects,
  allQuestions,
  selectedIds,
  onToggle,
  onNext,
  loading,
}: {
  subjects: Subject[];
  allQuestions: Question[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onNext: () => void;
  loading: boolean;
}) {
  // Derive unique topic count per subject name from live question bank
  const topicCountBySubject = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    allQuestions.forEach((q) => {
      if (q.isDeleted || !q.subject || !q.topic) return;
      if (!map[q.subject]) map[q.subject] = new Set();
      map[q.subject].add(q.topic);
    });
    const out: Record<string, number> = {};
    for (const subj in map) out[subj] = map[subj].size;
    return out;
  }, [allQuestions]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-14">
        <Loader2 size={18} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
      </div>
    );
  }

  if (subjects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-14" style={{ color: '#C4C3BD' }}>
        <BookOpen size={22} strokeWidth={1} style={{ marginBottom: 10 }} />
        <p className="text-xs">No subjects in question bank</p>
        <p style={{ fontSize: 11, color: '#DDDBD5', marginTop: 4 }}>Add questions with subject metadata first</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs mb-4" style={{ color: '#9A9891', lineHeight: 1.6 }}>
        Select the subjects this assessment will draw from. Topics are chosen in the next step.
      </p>

      <div className="space-y-2">
        {subjects.map((subj) => {
          const isSelected = selectedIds.includes(subj.id);
          const topicCount = topicCountBySubject[subj.name] ?? 0;
          const qCount = subj.questionCount;

          return (
            <button
              key={subj.id}
              type="button"
              onClick={() => onToggle(subj.id)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left transition-all"
              style={{
                border: isSelected ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
                borderRadius: 3,
                background: isSelected ? '#FFFFFF' : '#FAFAF8',
              }}
            >
              {/* Checkbox */}
              <div style={{
                width: 16, height: 16, borderRadius: 2, flexShrink: 0,
                border: `1px solid ${isSelected ? '#0C0C0B' : '#DDDBD5'}`,
                background: isSelected ? '#0C0C0B' : '#FFFFFF',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {isSelected && <CheckCircle2 size={9} strokeWidth={2.5} style={{ color: '#FFFFFF' }} />}
              </div>

              {/* Name + meta */}
              <div className="flex-1 min-w-0">
                <p className="text-xs" style={{ color: isSelected ? '#0C0C0B' : '#4A4A45' }}>{subj.name}</p>
                <p style={{ fontSize: 10, color: '#B0AEA8', marginTop: 2 }}>
                  {topicCount} topic{topicCount !== 1 ? 's' : ''}{qCount > 0 ? ` · ${qCount} Q` : ''}
                </p>
              </div>

              {/* Selected tick */}
              {isSelected && (
                <CheckCircle2 size={13} strokeWidth={1.5} style={{ color: '#0C0C0B', flexShrink: 0 }} />
              )}
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between mt-5">
        <span className="text-xs" style={{ color: '#B0AEA8' }}>
          {selectedIds.length === 0
            ? 'Select at least one subject to continue'
            : `${selectedIds.length} subject${selectedIds.length !== 1 ? 's' : ''} selected`}
        </span>
        <button
          type="button"
          onClick={onNext}
          disabled={selectedIds.length === 0}
          className="flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity"
          style={{
            background: selectedIds.length > 0 ? '#0C0C0B' : '#C8C7C2',
            color: '#FFFFFF', borderRadius: 2,
            cursor: selectedIds.length > 0 ? 'pointer' : 'not-allowed',
          }}
        >
          Topics <ChevronRight size={11} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// TOPIC PICKER PHASE — Phase 2 of the right column in Step 1
// Accordion grouped by selected subjects; topics with Q counts.
// "Select All" per subject; orphaned topics (0 Q) are grayed out.
// ══════════════════════════════════════════════════════════════════

function TopicPickerPhase({
  allSubjects,
  allQuestions,
  selectedSubjectIds,
  selectedTopics,
  onToggleTopic,
  onBack,
  onNext,
}: {
  allSubjects: Subject[];
  allQuestions: Question[];
  selectedSubjectIds: string[];
  selectedTopics: string[];
  onToggleTopic: (key: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  // Resolve subject names from selected IDs
  const selectedSubjectNames = useMemo(
    () => allSubjects.filter((s) => selectedSubjectIds.includes(s.id)).map((s) => s.name),
    [allSubjects, selectedSubjectIds]
  );

  // Build topic lists + per-topic Q counts, scoped to selected subjects
  const subjectData = useMemo(() => {
    const map: Record<string, { topics: string[]; counts: Record<string, number> }> = {};
    selectedSubjectNames.forEach((name) => {
      map[name] = { topics: [], counts: {} };
    });
    const topicSets: Record<string, Set<string>> = {};
    allQuestions.forEach((q) => {
      if (q.isDeleted || !q.subject || !q.topic) return;
      if (!map[q.subject]) return;
      if (!topicSets[q.subject]) topicSets[q.subject] = new Set();
      topicSets[q.subject].add(q.topic);
      map[q.subject].counts[q.topic] = (map[q.subject].counts[q.topic] ?? 0) + 1;
    });
    for (const subj in topicSets) {
      map[subj].topics = [...topicSets[subj]].sort();
    }
    return map;
  }, [allQuestions, selectedSubjectNames]);

  const [expandedSubjects, setExpandedSubjects] = useState<Set<string>>(
    () => new Set(selectedSubjectNames)
  );

  // Re-sync expanded set when going back and changing subjects
  useEffect(() => {
    setExpandedSubjects(new Set(selectedSubjectNames));
  }, [selectedSubjectNames.join(',')]); // eslint-disable-line

  const toggleSubjectAccordion = (name: string) => {
    setExpandedSubjects((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const selectAllForSubject = (subjName: string) => {
    const topics = subjectData[subjName]?.topics ?? [];
    topics.forEach((topic) => {
      const key = `${subjName}::${topic}`;
      const hasQ = (subjectData[subjName]?.counts[topic] ?? 0) > 0;
      if (hasQ && !selectedTopics.includes(key)) onToggleTopic(key);
    });
  };

  const clearAllForSubject = (subjName: string) => {
    const topics = subjectData[subjName]?.topics ?? [];
    topics.forEach((topic) => {
      const key = `${subjName}::${topic}`;
      if (selectedTopics.includes(key)) onToggleTopic(key);
    });
  };

  const totalAvailableTopics = Object.values(subjectData).reduce(
    (s, d) => s + d.topics.filter((t) => (d.counts[t] ?? 0) > 0).length, 0
  );

  if (selectedSubjectIds.length === 0) {
    return (
      <div className="py-10 text-center" style={{ color: '#C4C3BD' }}>
        <p className="text-xs">No subjects selected</p>
        <button type="button" onClick={onBack} className="mt-3 text-xs transition-opacity hover:opacity-70" style={{ color: '#9A9891' }}>
          ← Back to subjects
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs mb-3" style={{ color: '#9A9891', lineHeight: 1.6 }}>
        Choose which topics to include. Grayed-out topics have no questions yet.
      </p>

      <div style={{ border: '1px solid #E3E1DB', borderRadius: 3, overflow: 'hidden' }}>
        {selectedSubjectNames.map((subjName, si) => {
          const data = subjectData[subjName] ?? { topics: [], counts: {} };
          const topics = data.topics;
          const isOpen = expandedSubjects.has(subjName);
          const assignedCount = topics.filter((t) => selectedTopics.includes(`${subjName}::${t}`)).length;
          const availableCount = topics.filter((t) => (data.counts[t] ?? 0) > 0).length;
          const allAvailableSelected = availableCount > 0 && assignedCount >= availableCount;

          return (
            <div key={subjName} style={{ borderBottom: si < selectedSubjectNames.length - 1 ? '1px solid #E3E1DB' : 'none' }}>
              {/* Subject header row */}
              <div className="flex items-stretch">
                <button
                  type="button"
                  className="flex-1 flex items-center gap-2 px-3 py-2.5 text-left transition-colors min-w-0"
                  style={{ background: isOpen ? '#F7F6F3' : '#FAFAF8' }}
                  onClick={() => toggleSubjectAccordion(subjName)}
                >
                  <ChevronRight
                    size={11} strokeWidth={1.5}
                    style={{ color: '#9A9891', flexShrink: 0, transition: 'transform 0.15s', transform: isOpen ? 'rotate(90deg)' : 'none' }}
                  />
                  <span className="flex-1 text-xs truncate" style={{ color: '#0C0C0B' }}>{subjName}</span>
                  {assignedCount > 0 && (
                    <span style={{ fontSize: 10, color: '#1E7B3C', background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2, padding: '1px 6px', flexShrink: 0 }}>
                      {assignedCount}/{availableCount}
                    </span>
                  )}
                </button>
                {/* "Select all" / "Clear" toggle */}
                <button
                  type="button"
                  className="flex-shrink-0 px-3 text-xs transition-opacity hover:opacity-70"
                  style={{
                    color: '#6B6B66',
                    borderLeft: '1px solid #E3E1DB',
                    background: isOpen ? '#F7F6F3' : '#FAFAF8',
                    cursor: availableCount === 0 ? 'not-allowed' : 'pointer',
                    opacity: availableCount === 0 ? 0.4 : 1,
                  }}
                  disabled={availableCount === 0}
                  onClick={() => allAvailableSelected ? clearAllForSubject(subjName) : selectAllForSubject(subjName)}
                >
                  {allAvailableSelected ? 'Clear' : 'All'}
                </button>
              </div>

              {/* Topics list */}
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
                    animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
                    exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
                    transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                  >
                    {topics.length === 0 ? (
                      <div className="px-5 py-3" style={{ background: '#FFFFFF', borderTop: '1px solid #F0EFEB' }}>
                        <p style={{ color: '#C4C3BD', fontSize: 11 }}>No topics found for this subject</p>
                      </div>
                    ) : (
                      topics.map((topic) => {
                        const key = `${subjName}::${topic}`;
                        const isChecked = selectedTopics.includes(key);
                        const qCount = data.counts[topic] ?? 0;
                        const hasQ = qCount > 0;

                        return (
                          <button
                            key={topic}
                            type="button"
                            disabled={!hasQ}
                            onClick={() => hasQ && onToggleTopic(key)}
                            className="w-full flex items-center gap-2.5 px-5 py-2 text-left transition-colors"
                            style={{
                              background: isChecked ? '#FAFAF8' : '#FFFFFF',
                              borderTop: '1px solid #F7F6F3',
                              opacity: hasQ ? 1 : 0.4,
                              cursor: hasQ ? 'pointer' : 'not-allowed',
                            }}
                          >
                            <span style={{ flexShrink: 0 }}>
                              {isChecked
                                ? <CheckSquare size={12} strokeWidth={1.5} style={{ color: '#0C0C0B' }} />
                                : <Square size={12} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />}
                            </span>
                            <span className="flex-1 text-xs" style={{ color: isChecked ? '#0C0C0B' : '#6B6B66' }}>
                              {topic}
                            </span>
                            <span style={{ fontSize: 10, color: hasQ ? '#B0AEA8' : '#C4C3BD', flexShrink: 0 }}>
                              {hasQ ? `${qCount} Q` : 'No questions'}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between mt-5">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs px-3 py-2 transition-opacity hover:opacity-70"
          style={{ color: '#6B6B66', border: '1px solid #E3E1DB', borderRadius: 2 }}
        >
          ← Subjects
        </button>
        <div className="flex items-center gap-3">
          <span className="text-xs" style={{ color: '#B0AEA8' }}>
            {selectedTopics.length === 0
              ? `${totalAvailableTopics} available`
              : `${selectedTopics.length} of ${totalAvailableTopics} selected`}
          </span>
          <button
            type="button"
            onClick={onNext}
            disabled={selectedTopics.length === 0}
            className="flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity"
            style={{
              background: selectedTopics.length > 0 ? '#0C0C0B' : '#C8C7C2',
              color: '#FFFFFF', borderRadius: 2,
              cursor: selectedTopics.length > 0 ? 'pointer' : 'not-allowed',
            }}
          >
            Sections <ChevronRight size={11} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// STEP 1 — Setup (Basics + Sections, two-column)
// ══════════════════════════════════════════════════════════════════

function SetupStep({
  title, setTitle, description, setDescription,
  subject, setSubject, status, setStatus,
  targetType, setTargetType,
  selectedInstituteIds, setSelectedInstituteIds,
  selectedStudentIds, setSelectedStudentIds,
  sections, setSections,
  onContinue, originalStatus,
  allQuestions,
  subjectPool, setSubjectPool,
  topicPool, setTopicPool,
}: {
  title: string; setTitle: (v: string) => void;
  description: string; setDescription: (v: string) => void;
  subject: string; setSubject: (v: string) => void;
  status: AssessmentStatus; setStatus: (v: AssessmentStatus) => void;
  targetType: 'all' | 'institutes' | 'students';
  setTargetType: (v: 'all' | 'institutes' | 'students') => void;
  selectedInstituteIds: string[]; setSelectedInstituteIds: (ids: string[]) => void;
  selectedStudentIds: string[]; setSelectedStudentIds: (ids: string[]) => void;
  sections: SectionDraft[];
  setSections: React.Dispatch<React.SetStateAction<SectionDraft[]>>;
  onContinue: () => void;
  originalStatus?: AssessmentStatus;
  allQuestions: Question[];
  subjectPool: string[];
  setSubjectPool: React.Dispatch<React.SetStateAction<string[]>>;
  topicPool: string[];
  setTopicPool: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const [titleError, setTitleError] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const mut = mutabilityFor(originalStatus);
  const lockReason = originalStatus === 'active' ? 'test is live' : 'test is closed';

  // ── Subject docs (Phase 1) ────────────────────────────────────
  const [allSubjectDocs, setAllSubjectDocs] = useState<Subject[]>([]);
  const [loadingSubjects, setLoadingSubjects] = useState(true);

  useEffect(() => {
    getAllSubjects()
      .then(setAllSubjectDocs)
      .finally(() => setLoadingSubjects(false));
  }, []);

  // ── Right-column phase: 1=Subjects, 2=Topics, 3=Sections ─────
  // Restore the furthest-completed phase when returning from Step 2.
  const [rightPhase, setRightPhase] = useState<1 | 2 | 3>(() => {
    if (topicPool.length > 0) return 3;
    if (subjectPool.length > 0) return 2;
    return 1;
  });

  // ── Toggle subject in pool — cascades prune to topicPool + sections ─
  const toggleSubjectInPool = useCallback((id: string) => {
    const isRemoving = subjectPool.includes(id);
    if (isRemoving) {
      const subj = allSubjectDocs.find((s) => s.id === id);
      if (subj) {
        const subjName = subj.name;
        setTopicPool((tp) => tp.filter((k) => !k.startsWith(`${subjName}::`)));
        setSections((secs) => secs.map((sec) => ({
          ...sec,
          assignedTopics: sec.assignedTopics.filter((k) => !k.startsWith(`${subjName}::`)),
          rules: sec.rules.filter((r) => r.subject !== subjName),
        })));
      }
      setSubjectPool((prev) => prev.filter((x) => x !== id));
    } else {
      setSubjectPool((prev) => [...prev, id]);
    }
  }, [subjectPool, allSubjectDocs, setSubjectPool, setTopicPool, setSections]);

  // ── Toggle topic in pool ──────────────────────────────────────
  const toggleTopicInPool = useCallback((key: string) => {
    setTopicPool((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
    // If removing, also clear from any section's assignedTopics + rules
    if (topicPool.includes(key)) {
      const [subj, topic] = key.split('::');
      setSections((secs) => secs.map((sec) => ({
        ...sec,
        assignedTopics: sec.assignedTopics.filter((k) => k !== key),
        rules: sec.rules.filter((r) => !(r.subject === subj && r.topic === topic)),
      })));
    }
  }, [topicPool, setTopicPool, setSections]);

  // ── Full bank subject→topics map ──────────────────────────────
  // Build subject→topics map from the question bank
  const subjectTopics = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    allQuestions.forEach((q) => {
      if (q.isDeleted || !q.subject || !q.topic) return;
      if (!map[q.subject]) map[q.subject] = new Set();
      map[q.subject].add(q.topic);
    });
    const sorted: Record<string, string[]> = {};
    for (const subj in map) sorted[subj] = [...map[subj]].sort();
    return sorted;
  }, [allQuestions]);

  // ── Scoped subjectTopics for Phase 3 section builder ─────────
  // When a topicPool is set, scope the section picker to only those topics.
  const scopedSubjectTopics = useMemo(() => {
    if (topicPool.length === 0) return subjectTopics;
    const result: Record<string, string[]> = {};
    topicPool.forEach((key) => {
      const idx = key.indexOf('::');
      if (idx === -1) return;
      const subj = key.slice(0, idx);
      const topic = key.slice(idx + 2);
      if (!result[subj]) result[subj] = [];
      if (!result[subj].includes(topic)) result[subj].push(topic);
    });
    for (const subj in result) result[subj].sort();
    return result;
  }, [topicPool, subjectTopics]);

  const toggleSectionExpanded = (id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAssignedTopic = (sectionIdx: number, key: string) => {
    setSections((prev) => prev.map((s, i) => {
      if (i !== sectionIdx) return s;
      const hasKey = s.assignedTopics.includes(key);
      return {
        ...s,
        assignedTopics: hasKey
          ? s.assignedTopics.filter((k) => k !== key)
          : [...s.assignedTopics, key],
        // If removing a topic, also clear its rules
        rules: hasKey
          ? s.rules.filter((r) => `${r.subject}::${r.topic}` !== key)
          : s.rules,
      };
    }));
  };

  const addSection = () => {
    setSections((prev) => [
      ...prev,
      { id: makeSectionId(), name: defaultSectionName(prev.length), timeLimit: '', rules: [], assignedTopics: [], breakAfterMinutes: '', breakMandatory: false },
    ]);
  };

  const removeSection = (idx: number) => {
    if (sections.length <= 1) return;
    setSections((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateSection = (idx: number, field: 'name' | 'timeLimit', value: string) => {
    if (field === 'timeLimit') {
      if (value !== '' && (parseInt(value, 10) || 0) < 1) return;
    }
    setSections((prev) => prev.map((s, i) => (i === idx ? { ...s, [field]: value } : s)));
  };

  const totalSectionTime = sections.reduce((sum, s) => sum + (parseInt(s.timeLimit, 10) || 0), 0);

  const sectionsValid = sections.length > 0 && sections.every((s) => s.name.trim() && parseInt(s.timeLimit, 10) >= 1);
  const canContinue = title.trim() !== '' && sectionsValid;

  const handleContinue = () => {
    if (!title.trim()) { setTitleError(true); return; }
    onContinue();
  };

  return (
    <motion.div
      key="step1"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="flex-1 overflow-y-auto"
      style={{ padding: '48px 48px 80px' }}
    >
      <div style={{ width: '100%', maxWidth: 1080, margin: '0 auto' }}>

        {/* Heading */}
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex items-center justify-center"
              style={{ width: 28, height: 28, borderRadius: 2, background: '#F7F6F3', border: '1px solid #EEECEA' }}>
              <Layers size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />
            </div>
            <p className="text-xs" style={{ color: '#C4C3BD', letterSpacing: '0.1em' }}>STEP 1 OF 2</p>
          </div>
          <h2 className="text-base mb-1" style={{ color: '#0C0C0B' }}>Assessment Setup</h2>
          <p className="text-xs" style={{ color: '#B0AEA8', lineHeight: 1.6 }}>
            Define the basics and configure sections. Question rules are set in the next step.
          </p>
          {originalStatus && originalStatus !== 'draft' && (
            <div className="flex items-start gap-2.5 mt-4 px-3 py-3"
              style={{ background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2 }}>
              <Lock size={11} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0, marginTop: 1 }} />
              <p className="text-xs" style={{ color: '#6B6B66', lineHeight: 1.6 }}>
                {originalStatus === 'active'
                  ? <>Some fields are locked because this test is <strong>live</strong>.</>
                  : <>Some fields are locked because this test is <strong>closed</strong>.</>}
              </p>
            </div>
          )}
        </div>

        {/* Two-column grid */}
        <div className="grid gap-12" style={{ gridTemplateColumns: '1fr 1fr' }}>

          {/* ── LEFT: Basics ── */}
          <div className="space-y-5">
            <SectionLabel label="BASICS" />

            <Field label="Title" required>
              <input
                type="text" value={title}
                onChange={(e) => { setTitle(e.target.value); if (e.target.value.trim()) setTitleError(false); }}
                style={{ ...inputStyle, fontSize: 13, padding: '9px 12px', borderColor: titleError ? '#F2CECE' : '#E3E1DB', background: titleError ? '#FDF5F5' : '#FFFFFF' }}
                placeholder="e.g., Midterm Exam — Mathematics" autoFocus
              />
              {titleError && <p className="text-xs mt-1" style={{ color: '#9B2828' }}>Title is required</p>}
            </Field>

            <Field label="Description" hint="(optional)">
              <textarea value={description} onChange={(e) => setDescription(e.target.value)}
                style={{ ...inputStyle, minHeight: 80, resize: 'none', fontSize: 13, padding: '9px 12px' }}
                placeholder="Instructions or notes visible to students" />
            </Field>

            <Field label="Subject" hint="(optional)">
              <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
                style={{ ...inputStyle, fontSize: 13, padding: '9px 12px' }} placeholder="e.g., Mathematics" />
            </Field>

            {mut.targetType ? (
              <Field label="Assign To">
                <select
                  value={targetType}
                  onChange={(e) => setTargetType(e.target.value as 'all' | 'institutes' | 'students')}
                  style={{ ...selectStyle, fontSize: 13, padding: '9px 12px' }}
                >
                  <option value="all">All Students</option>
                  <option value="institutes">Specific Institutes</option>
                  <option value="students">Specific Students</option>
                </select>
                {targetType === 'institutes' && (
                  <InstitutePicker selectedIds={selectedInstituteIds} onChange={setSelectedInstituteIds} locked={false} />
                )}
                {targetType === 'students' && (
                  <StudentPicker selectedIds={selectedStudentIds} onChange={setSelectedStudentIds} locked={false} />
                )}
              </Field>
            ) : (
              <LockedFieldWrapper label="Assign To" reason={lockReason}>
                <div>
                  <select value={targetType} readOnly style={{ ...selectStyle, fontSize: 13, padding: '9px 12px' }}>
                    <option value="all">All Students</option>
                    <option value="institutes">Specific Institutes</option>
                    <option value="students">Specific Students</option>
                  </select>
                  {targetType === 'institutes' && (
                    <InstitutePicker selectedIds={selectedInstituteIds} onChange={setSelectedInstituteIds} locked={true} />
                  )}
                  {targetType === 'students' && (
                    <StudentPicker selectedIds={selectedStudentIds} onChange={setSelectedStudentIds} locked={true} />
                  )}
                </div>
              </LockedFieldWrapper>
            )}
          </div>

          {/* ── RIGHT: Phase stepper (Subjects → Topics → Sections) ── */}
          <div>

            {/* Phase indicator strip */}
            <div className="flex items-center mb-6">
              {[
                { n: 1 as const, label: 'Subjects' },
                { n: 2 as const, label: 'Topics' },
                { n: 3 as const, label: 'Sections' },
              ].map(({ n, label }, i) => {
                const isActive = rightPhase === n;
                const isDone = rightPhase > n;
                const canGoBack = rightPhase > n;
                return (
                  <React.Fragment key={n}>
                    {i > 0 && (
                      <div style={{
                        flex: 1, height: 1, margin: '0 8px',
                        background: isDone ? '#0C0C0B' : '#E3E1DB',
                        transition: 'background 0.2s',
                      }} />
                    )}
                    <button
                      type="button"
                      disabled={!canGoBack}
                      onClick={() => canGoBack && setRightPhase(n)}
                      className="flex items-center gap-1.5 flex-shrink-0 transition-opacity"
                      style={{ cursor: canGoBack ? 'pointer' : 'default', opacity: 1 }}
                    >
                      <div style={{
                        width: 18, height: 18, borderRadius: 9, fontSize: 9,
                        background: isActive ? '#0C0C0B' : isDone ? '#0C0C0B' : '#E3E1DB',
                        color: (isActive || isDone) ? '#FFFFFF' : '#9A9891',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                      }}>
                        {isDone
                          ? <CheckCircle2 size={10} strokeWidth={2.5} style={{ color: '#FFFFFF' }} />
                          : n}
                      </div>
                      <span style={{
                        fontSize: 11,
                        color: isActive ? '#0C0C0B' : isDone ? '#6B6B66' : '#C4C3BD',
                      }}>
                        {label}
                      </span>
                    </button>
                  </React.Fragment>
                );
              })}
            </div>

            {/* ── Phase 1: Subject Picker ── */}
            {rightPhase === 1 && (
              <SubjectPickerPhase
                subjects={allSubjectDocs}
                allQuestions={allQuestions}
                selectedIds={subjectPool}
                onToggle={toggleSubjectInPool}
                onNext={() => setRightPhase(2)}
                loading={loadingSubjects}
              />
            )}

            {/* ── Phase 2: Topic Picker ── */}
            {rightPhase === 2 && (
              <TopicPickerPhase
                allSubjects={allSubjectDocs}
                allQuestions={allQuestions}
                selectedSubjectIds={subjectPool}
                selectedTopics={topicPool}
                onToggleTopic={toggleTopicInPool}
                onBack={() => setRightPhase(1)}
                onNext={() => setRightPhase(3)}
              />
            )}

            {/* ── Phase 3: Section Builder ── */}
            {rightPhase === 3 && (
              <div>
                {/* Pool reminder strip */}
                {topicPool.length > 0 && (
                  <div className="flex items-center gap-2 px-3 py-2 mb-4"
                    style={{ background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2 }}>
                    <BookOpen size={10} strokeWidth={1.5} style={{ color: '#1E7B3C', flexShrink: 0 }} />
                    <span style={{ fontSize: 11, color: '#1E7B3C', flex: 1 }}>
                      Topic pool: {topicPool.length} topic{topicPool.length !== 1 ? 's' : ''} across {subjectPool.length} subject{subjectPool.length !== 1 ? 's' : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => setRightPhase(2)}
                      className="text-xs transition-opacity hover:opacity-70"
                      style={{ color: '#1E7B3C', flexShrink: 0 }}
                    >
                      Edit ↗
                    </button>
                  </div>
                )}

                {/* Section cards */}
                <div className="space-y-3">
                  <AnimatePresence initial={false}>
                    {sections.map((sec, idx) => {
                      const isPickerOpen = expandedSections.has(sec.id);
                      const hasAssigned = sec.assignedTopics.length > 0;
                      return (
                        <motion.div
                          key={sec.id}
                          initial={{ opacity: 0, y: -8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                          style={{
                            border: '1px solid #E3E1DB',
                            borderRadius: 3,
                            overflow: 'hidden',
                            opacity: !mut.sections ? 0.5 : 1,
                            pointerEvents: !mut.sections ? 'none' : 'auto',
                          }}
                        >
                          {/* Top row: index + name + time + topics toggle + remove */}
                          <div className="flex items-center" style={{ gap: 8, padding: '8px 10px', background: '#FFFFFF' }}>
                            <div className="flex-shrink-0 flex items-center justify-center"
                              style={{ width: 26, height: 26, borderRadius: 2, background: '#F7F6F3', border: '1px solid #EEECEA', fontSize: 10, color: '#9A9891' }}>
                              {(idx + 1).toString().padStart(2, '0')}
                            </div>
                            <input
                              type="text" value={sec.name}
                              onChange={(e) => updateSection(idx, 'name', e.target.value)}
                              placeholder={`Section ${SECTION_LETTERS[idx] ?? idx + 1}`}
                              className="flex-1 outline-none text-xs"
                              style={{ border: '1px solid #E3E1DB', borderRadius: 2, color: '#0C0C0B', background: '#FFFFFF', padding: '7px 10px', minWidth: 0 }}
                            />
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <input
                                type="number" value={sec.timeLimit}
                                onChange={(e) => updateSection(idx, 'timeLimit', e.target.value)}
                                placeholder="—" min="1"
                                className="flex-shrink-0 outline-none text-center text-xs"
                                style={{ width: 52, padding: '7px 6px', border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B', MozAppearance: 'textfield' } as React.CSSProperties}
                                onWheel={(e) => (e.target as HTMLInputElement).blur()}
                                onKeyDown={(e) => { if (['-', 'e', '+', '.'].includes(e.key)) e.preventDefault(); }}
                              />
                              <span className="text-xs flex-shrink-0" style={{ color: '#9A9891' }}>min</span>
                            </div>
                            {/* Topics toggle button */}
                            <button
                              type="button"
                              onClick={() => toggleSectionExpanded(sec.id)}
                              className="flex-shrink-0 flex items-center gap-1 text-xs px-2 py-1.5 transition-all"
                              style={{
                                borderRadius: 2,
                                border: isPickerOpen ? '1px solid #0C0C0B' : (hasAssigned ? '1px solid #B8E6C8' : '1px solid #E3E1DB'),
                                background: isPickerOpen ? '#0C0C0B' : (hasAssigned ? '#F0F9F4' : '#FAFAF8'),
                                color: isPickerOpen ? '#FFFFFF' : (hasAssigned ? '#1E7B3C' : '#9A9891'),
                              }}
                              title={isPickerOpen ? 'Close topic picker' : 'Assign topics to this section'}
                            >
                              <BookOpen size={10} strokeWidth={1.5} />
                              <span>Topics{hasAssigned ? ` · ${sec.assignedTopics.length}` : ''}</span>
                              <ChevronRight size={9} strokeWidth={2} style={{ transform: isPickerOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                            </button>
                            <button
                              onClick={() => removeSection(idx)}
                              disabled={sections.length <= 1}
                              className="flex-shrink-0 flex items-center justify-center transition-opacity hover:opacity-60"
                              style={{ width: 22, height: 22, borderRadius: 2, color: sections.length <= 1 ? '#E3E1DB' : '#C4C3BD', cursor: sections.length <= 1 ? 'not-allowed' : 'pointer' }}
                            >
                              <X size={12} strokeWidth={1.5} />
                            </button>
                          </div>

                          {/* Break-after-section row (hidden on last section) */}
                          {idx < sections.length - 1 && (
                            <div
                              className="flex items-center"
                              style={{
                                gap: 8,
                                padding: '6px 10px 8px 44px',
                                background: '#FFFFFF',
                                borderTop: '1px dashed #F0EFEB',
                              }}
                            >
                              <span className="text-xs flex-shrink-0" style={{ color: '#9A9891' }}>
                                Break after
                              </span>
                              <input
                                type="number"
                                value={sec.breakAfterMinutes}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  if (v !== '' && (parseInt(v, 10) || 0) < 1) return;
                                  setSections((prev) => prev.map((s, i) => (i === idx ? { ...s, breakAfterMinutes: v } : s)));
                                }}
                                placeholder="—"
                                min="1"
                                className="flex-shrink-0 outline-none text-center text-xs"
                                style={{ width: 52, padding: '5px 6px', border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B', MozAppearance: 'textfield' } as React.CSSProperties}
                                onWheel={(e) => (e.target as HTMLInputElement).blur()}
                                onKeyDown={(e) => { if (['-', 'e', '+', '.'].includes(e.key)) e.preventDefault(); }}
                              />
                              <span className="text-xs flex-shrink-0" style={{ color: '#9A9891' }}>min</span>
                              <label
                                className="flex items-center gap-1.5 text-xs ml-2"
                                style={{
                                  color: sec.breakAfterMinutes ? '#4A4A45' : '#C4C3BD',
                                  cursor: sec.breakAfterMinutes ? 'pointer' : 'not-allowed',
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={sec.breakMandatory}
                                  disabled={!sec.breakAfterMinutes}
                                  onChange={(e) =>
                                    setSections((prev) => prev.map((s, i) => (i === idx ? { ...s, breakMandatory: e.target.checked } : s)))
                                  }
                                />
                                Mandatory wait
                              </label>
                              <span className="text-xs ml-auto" style={{ color: '#C4C3BD' }}>
                                {sec.breakAfterMinutes
                                  ? sec.breakMandatory
                                    ? 'Student must wait the full duration'
                                    : 'Student may skip and continue'
                                  : 'No break — next section starts immediately'}
                              </span>
                            </div>
                          )}

                          {/* Assigned topic tags (collapsed view) */}
                          {hasAssigned && !isPickerOpen && (
                            <div className="flex flex-wrap gap-1.5 px-10 pb-2.5 pt-0" style={{ background: '#FFFFFF' }}>
                              {sec.assignedTopics.map((key) => {
                                const parts = key.split('::');
                                const subj = parts[0] ?? '';
                                const topic = parts[1] ?? key;
                                return (
                                  <span
                                    key={key}
                                    className="inline-flex items-center gap-1 px-2 py-0.5"
                                    style={{ background: '#F0F9F4', color: '#1E7B3C', border: '1px solid #B8E6C8', borderRadius: 2, fontSize: 10 }}
                                  >
                                    <span style={{ color: '#9A9891', fontSize: 9 }}>{subj}</span>
                                    <span style={{ color: '#C4C3BD', fontSize: 9 }}>›</span>
                                    <span>{topic}</span>
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); toggleAssignedTopic(idx, key); }}
                                      className="hover:opacity-60 transition-opacity"
                                      style={{ color: '#1E7B3C', lineHeight: 1, marginLeft: 1 }}
                                    >
                                      <X size={8} strokeWidth={2.5} />
                                    </button>
                                  </span>
                                );
                              })}
                            </div>
                          )}

                          {/* Expandable topic picker — scoped to topicPool */}
                          <AnimatePresence initial={false}>
                            {isPickerOpen && (
                              <motion.div
                                initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
                                animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
                                exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
                                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                              >
                                <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                                  <SectionTopicPicker
                                    sectionIdx={idx}
                                    sections={sections}
                                    assignedTopics={sec.assignedTopics}
                                    onToggleTopic={(key) => toggleAssignedTopic(idx, key)}
                                    subjectTopics={scopedSubjectTopics}
                                  />
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>

                {/* Add section */}
                <button
                  onClick={addSection}
                  disabled={sections.length >= 26 || !mut.sections}
                  className="w-full mt-3 flex items-center justify-center gap-1.5 py-2.5 text-xs transition-all hover:opacity-80"
                  style={{ border: '1px dashed #DDDBD5', borderRadius: 3, color: '#9A9891', background: 'transparent', cursor: sections.length >= 26 || !mut.sections ? 'not-allowed' : 'pointer', opacity: !mut.sections ? 0.4 : 1 }}
                >
                  <Plus size={12} strokeWidth={1.5} /> Add Section
                </button>

                {/* Summary */}
                {(sections.length > 1 || totalSectionTime > 0) && (() => {
                  const totalAssigned = sections.reduce((s, sec) => s + sec.assignedTopics.length, 0);
                  return (
                    <div className="flex items-center gap-4 mt-4 px-4 py-3"
                      style={{ background: '#F7F6F3', border: '1px solid #EEECEA', borderRadius: 2 }}>
                      <span className="text-xs" style={{ color: '#9A9891' }}>
                        {sections.length} section{sections.length !== 1 ? 's' : ''}
                      </span>
                      {totalAssigned > 0 && (
                        <span className="text-xs flex items-center gap-1" style={{ color: '#1E7B3C' }}>
                          <BookOpen size={9} strokeWidth={1.5} />
                          {totalAssigned} topic{totalAssigned !== 1 ? 's' : ''} assigned
                        </span>
                      )}
                      {totalSectionTime > 0 && (
                        <span className="text-xs flex items-center gap-1.5 ml-auto" style={{ color: '#6B6B66' }}>
                          <Timer size={10} strokeWidth={1.5} />
                          {totalSectionTime} min total
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>

        {/* Continue */}
        <div className="mt-10 flex items-center justify-end">
          <button onClick={handleContinue} disabled={!canContinue}
            className="flex items-center gap-2 text-xs px-5 py-2.5 transition-opacity"
            style={{
              background: canContinue ? '#0C0C0B' : '#C8C7C2',
              color: '#FFFFFF', borderRadius: 2,
              cursor: canContinue ? 'pointer' : 'not-allowed',
              letterSpacing: '0.03em',
            }}>
            Continue to Rules <ChevronRight size={12} strokeWidth={2} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ── Settings toggle row ───────────────────────────────────────────

function SettingsToggle({ icon, label, hint, value, onChange, locked, lockReason }: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
  locked?: boolean;
  lockReason?: string;
}) {
  return (
    <button
      type="button"
      onClick={locked ? undefined : () => onChange(!value)}
      className="w-full flex items-center gap-4 px-4 py-3 text-left transition-colors"
      style={{
        border: '1px solid #E3E1DB',
        borderRadius: 2,
        background: value ? '#FAFAF8' : '#FFFFFF',
        opacity: locked ? 0.45 : 1,
        cursor: locked ? 'default' : 'pointer',
        pointerEvents: locked ? 'none' : 'auto',
      }}
    >
      {/* Icon */}
      <div className="flex items-center justify-center flex-shrink-0"
        style={{ width: 28, height: 28, borderRadius: 2, background: '#F7F6F3', border: '1px solid #EEECEA' }}>
        {icon}
      </div>

      {/* Label + hint */}
      <div className="flex-1 min-w-0">
        <p className="text-xs" style={{ color: '#0C0C0B' }}>{label}</p>
        <p className="text-xs mt-0.5" style={{ color: '#B0AEA8', lineHeight: 1.5 }}>{hint}</p>
      </div>

      {/* Lock indicator or toggle track */}
      {locked ? (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Lock size={10} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
          {lockReason && <span style={{ color: '#C4C3BD', fontSize: 10 }}>{lockReason}</span>}
        </div>
      ) : (
        <div
          className="flex-shrink-0 transition-colors"
          style={{
            width: 34,
            height: 18,
            borderRadius: 9,
            background: value ? '#0C0C0B' : '#D9D8D3',
            position: 'relative',
          }}
        >
          <div
            className="transition-transform"
            style={{
              position: 'absolute',
              top: 3,
              left: value ? 18 : 3,
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: '#FFFFFF',
            }}
          />
        </div>
      )}
    </button>
  );
}

// ══════════════════════════════════════════════════════════════════
// INSTITUTE PICKER — inline checkbox list for "Specific Institutes"
// ══════════════════════════════════════════════════════════════════

function InstitutePicker({
  selectedIds,
  onChange,
  locked,
}: {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  locked: boolean;
}) {
  const [institutes, setInstitutes] = useState<Institute[]>([]);
  const [loadingInst, setLoadingInst] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    getAllInstitutes()
      .then((list) =>
        setInstitutes(
          list
            .filter((i) => i.status !== 'disabled')
            .sort((a, b) => a.name.localeCompare(b.name))
        )
      )
      .finally(() => setLoadingInst(false));
  }, []);

  const filtered = institutes.filter(
    (i) =>
      !search ||
      i.name.toLowerCase().includes(search.toLowerCase()) ||
      i.code.toLowerCase().includes(search.toLowerCase())
  );

  const toggle = (id: string) => {
    if (locked) return;
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id]
    );
  };

  return (
    <div
      style={{
        border: '1px solid #E3E1DB',
        borderRadius: 2,
        background: '#FFFFFF',
        marginTop: 6,
        opacity: locked ? 0.5 : 1,
        pointerEvents: locked ? 'none' : 'auto',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: '1px solid #F0EFEB', background: '#FAFAF8' }}
      >
        <div className="flex items-center gap-1.5">
          <Building2 size={11} strokeWidth={1.5} style={{ color: '#9A9891' }} />
          <span className="text-xs" style={{ color: '#6B6B66' }}>
            {selectedIds.length === 0
              ? 'No institutes selected'
              : `${selectedIds.length} institute${selectedIds.length !== 1 ? 's' : ''} selected`}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {filtered.length > 0 && filtered.some((i) => !selectedIds.includes(i.id)) && (
            <button
              onClick={() => onChange([...new Set([...selectedIds, ...filtered.map((i) => i.id)])])}
              className="text-xs transition-opacity hover:opacity-60"
              style={{ color: '#9A9891' }}
            >
              Select all ({filtered.length})
            </button>
          )}
          {selectedIds.length > 0 && (
            <button
              onClick={() => onChange([])}
              className="text-xs transition-opacity hover:opacity-60"
              style={{ color: '#9A9891' }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Search */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: '1px solid #F0EFEB' }}
      >
        <Search size={11} strokeWidth={1.5} style={{ color: '#C4C3BD', flexShrink: 0 }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search institutes…"
          className="flex-1 text-xs outline-none bg-transparent"
          style={{ color: '#0C0C0B' }}
        />
        {search && (
          <button onClick={() => setSearch('')}>
            <X size={10} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
          </button>
        )}
      </div>

      {/* List */}
      <div style={{ maxHeight: 200, overflowY: 'auto' }}>
        {loadingInst ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={14} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-6 text-center">
            <span className="text-xs" style={{ color: '#C4C3BD' }}>No institutes found</span>
          </div>
        ) : (
          filtered.map((inst) => {
            const isSelected = selectedIds.includes(inst.id);
            return (
              <button
                key={inst.id}
                onClick={() => toggle(inst.id)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors"
                style={{
                  background: isSelected ? '#FAFAF8' : '#FFFFFF',
                  borderBottom: '1px solid #F7F6F3',
                }}
              >
                {/* Checkbox */}
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 2,
                    border: `1px solid ${isSelected ? '#0C0C0B' : '#DDDBD5'}`,
                    background: isSelected ? '#0C0C0B' : '#FFFFFF',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {isSelected && (
                    <CheckCircle2 size={9} strokeWidth={2.5} style={{ color: '#FFFFFF' }} />
                  )}
                </div>

                <span className="flex-1 text-xs" style={{ color: '#0C0C0B' }}>
                  {inst.name}
                </span>

                <span
                  className="text-xs px-1.5 py-0.5 flex-shrink-0"
                  style={{
                    background: '#F0EFEB', color: '#9A9891',
                    borderRadius: 2, fontSize: 10,
                  }}
                >
                  {inst.code}
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Empty selection warning */}
      {selectedIds.length === 0 && !loadingInst && institutes.length > 0 && (
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{ borderTop: '1px solid #F0EFEB', background: '#FEF9EC' }}
        >
          <AlertTriangle size={10} strokeWidth={1.5} style={{ color: '#92680A', flexShrink: 0 }} />
          <span style={{ color: '#92680A', fontSize: 10 }}>
            No institutes selected — no students will receive this assessment.
          </span>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// STUDENT PICKER — institute-filtered checkbox list for "Specific Students"
// ══════════════════════════════════════════════════════════════════

function StudentPicker({
  selectedIds,
  onChange,
  locked,
}: {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  locked: boolean;
}) {
  const [students, setStudents] = useState<Student[]>([]);
  const [institutes, setInstitutes] = useState<Institute[]>([]);
  const [loadingStudents, setLoadingStudents] = useState(true);
  const [search, setSearch] = useState('');
  const [filterInstId, setFilterInstId] = useState<string>('all');

  useEffect(() => {
    Promise.all([getAllStudents(), getAllInstitutes()]).then(([studs, insts]) => {
      setStudents(studs.filter((s) => s.status !== 'disabled'));
      setInstitutes(insts);
      setLoadingStudents(false);
    });
  }, []);

  const instMap = useMemo(() => {
    const m: Record<string, string> = {};
    institutes.forEach((i) => { m[i.id] = i.name; });
    return m;
  }, [institutes]);

  // Only show institutes that actually have students
  const instTabs = useMemo(
    () =>
      institutes
        .filter((i) => students.some((s) => s.instituteId === i.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [institutes, students]
  );

  const filtered = students.filter((s) => {
    const matchInst = filterInstId === 'all' || s.instituteId === filterInstId;
    const matchSearch =
      !search ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.email.toLowerCase().includes(search.toLowerCase());
    return matchInst && matchSearch;
  });

  const toggle = (id: string) => {
    if (locked) return;
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id]
    );
  };

  const selectAllVisible = () => {
    if (locked) return;
    onChange([...new Set([...selectedIds, ...filtered.map((s) => s.id)])]);
  };

  return (
    <div
      style={{
        border: '1px solid #E3E1DB',
        borderRadius: 2,
        background: '#FFFFFF',
        marginTop: 6,
        opacity: locked ? 0.5 : 1,
        pointerEvents: locked ? 'none' : 'auto',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: '1px solid #F0EFEB', background: '#FAFAF8' }}
      >
        <div className="flex items-center gap-1.5">
          <Users size={11} strokeWidth={1.5} style={{ color: '#9A9891' }} />
          <span className="text-xs" style={{ color: '#6B6B66' }}>
            {selectedIds.length === 0
              ? 'No students selected'
              : `${selectedIds.length} student${selectedIds.length !== 1 ? 's' : ''} selected`}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {filtered.length > 0 && filtered.some((s) => !selectedIds.includes(s.id)) && (
            <button
              onClick={selectAllVisible}
              className="text-xs transition-opacity hover:opacity-60"
              style={{ color: '#9A9891' }}
            >
              Select {filterInstId === 'all' ? 'all' : 'all in institute'} ({filtered.length})
            </button>
          )}
          {selectedIds.length > 0 && (
            <button
              onClick={() => onChange([])}
              className="text-xs transition-opacity hover:opacity-60"
              style={{ color: '#9A9891' }}
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Institute filter pills */}
      {!loadingStudents && instTabs.length > 1 && (
        <div
          className="flex items-center gap-1.5 px-3 py-2 overflow-x-auto"
          style={{ borderBottom: '1px solid #F0EFEB' }}
        >
          <button
            onClick={() => setFilterInstId('all')}
            className="text-xs px-2.5 py-1 flex-shrink-0 transition-colors"
            style={{
              borderRadius: 2,
              background: filterInstId === 'all' ? '#0C0C0B' : '#F0EFEB',
              color: filterInstId === 'all' ? '#FFFFFF' : '#6B6B66',
              border: filterInstId === 'all' ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
            }}
          >
            All institutes
          </button>
          {instTabs.map((inst) => {
            const isActive = filterInstId === inst.id;
            const countInInst = selectedIds.filter((id) =>
              students.find((s) => s.id === id && s.instituteId === inst.id)
            ).length;
            return (
              <button
                key={inst.id}
                onClick={() => setFilterInstId(inst.id)}
                className="text-xs px-2.5 py-1 flex-shrink-0 transition-colors flex items-center gap-1"
                style={{
                  borderRadius: 2,
                  background: isActive ? '#0C0C0B' : '#F0EFEB',
                  color: isActive ? '#FFFFFF' : '#6B6B66',
                  border: isActive ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
                }}
              >
                {inst.name}
                {countInInst > 0 && (
                  <span
                    style={{
                      background: isActive ? 'rgba(255,255,255,0.25)' : '#0C0C0B',
                      color: '#FFFFFF',
                      borderRadius: 9,
                      fontSize: 9,
                      padding: '1px 5px',
                    }}
                  >
                    {countInInst}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Search */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: '1px solid #F0EFEB' }}
      >
        <Search size={11} strokeWidth={1.5} style={{ color: '#C4C3BD', flexShrink: 0 }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or email…"
          className="flex-1 text-xs outline-none bg-transparent"
          style={{ color: '#0C0C0B' }}
        />
        {search && (
          <button onClick={() => setSearch('')}>
            <X size={10} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
          </button>
        )}
      </div>

      {/* Student list */}
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        {loadingStudents ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={14} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-6 text-center">
            <span className="text-xs" style={{ color: '#C4C3BD' }}>
              {search ? 'No students match your search' : 'No students found'}
            </span>
          </div>
        ) : (
          filtered.map((student) => {
            const isSelected = selectedIds.includes(student.id);
            const instName = instMap[student.instituteId] ?? '—';
            return (
              <button
                key={student.id}
                onClick={() => toggle(student.id)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors"
                style={{
                  background: isSelected ? '#FAFAF8' : '#FFFFFF',
                  borderBottom: '1px solid #F7F6F3',
                }}
              >
                {/* Checkbox */}
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 2,
                    border: `1px solid ${isSelected ? '#0C0C0B' : '#DDDBD5'}`,
                    background: isSelected ? '#0C0C0B' : '#FFFFFF',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {isSelected && (
                    <CheckCircle2 size={9} strokeWidth={2.5} style={{ color: '#FFFFFF' }} />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-xs" style={{ color: '#0C0C0B' }}>{student.name}</p>
                  <p className="text-xs" style={{ color: '#B0AEA8', marginTop: 1 }}>{student.email}</p>
                </div>

                <span
                  className="text-xs px-1.5 py-0.5 flex-shrink-0"
                  style={{
                    background: '#F0EFEB', color: '#9A9891',
                    borderRadius: 2, fontSize: 10,
                    maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                  title={instName}
                >
                  {instName}
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Empty selection warning */}
      {selectedIds.length === 0 && !loadingStudents && students.length > 0 && (
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{ borderTop: '1px solid #F0EFEB', background: '#FEF9EC' }}
        >
          <AlertTriangle size={10} strokeWidth={1.5} style={{ color: '#92680A', flexShrink: 0 }} />
          <span style={{ color: '#92680A', fontSize: 10 }}>
            No students selected — this assessment will not be visible to anyone.
          </span>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// STEP 2 — Rules + Settings (top strip + full-width rule builder)
// ══════════════════════════════════════════════════════════════════

function DetailsStep({
  mode, assessment, originalStatus, allQuestions, sections, setSections, onBack, onSave,
  title, description, subject, status,
  targetType, selectedInstituteIds, selectedStudentIds,
  subjectPool, topicPool,
}: {
  mode: 'create' | 'edit';
  assessment: Assessment | null;
  originalStatus?: AssessmentStatus;
  allQuestions: Question[];
  sections: SectionDraft[];
  setSections: React.Dispatch<React.SetStateAction<SectionDraft[]>>;
  onBack: () => void;
  onSave: (draft: AssessmentDraft) => Promise<void>;
  title: string;
  description: string;
  subject: string;
  status: AssessmentStatus;
  targetType: 'all' | 'institutes' | 'students';
  selectedInstituteIds: string[];
  selectedStudentIds: string[];
  subjectPool: string[];
  topicPool: string[];
}) {
  const [startDate, setStartDate] = useState(toDateTimeLocal(assessment?.startDate));
  const [endDate, setEndDate] = useState(toDateTimeLocal(assessment?.endDate));
  const [passingScore, setPassingScore] = useState(assessment?.passingScore?.toString() ?? '');
  const [maxAttempts, setMaxAttempts] = useState(assessment?.maxAttempts?.toString() ?? '1');
  const [shuffleQuestions, setShuffleQuestions] = useState(assessment?.shuffleQuestions ?? false);
  const [sectionStartOrder, setSectionStartOrder] = useState<'sequential' | 'random' | 'student_choice'>(
    assessment?.sectionStartOrder ?? 'sequential'
  );
  const [showResults, setShowResults] = useState(assessment?.showResults ?? false);
  const [allowReview, setAllowReview] = useState(assessment?.allowReview ?? false);
  const [saving, setSaving] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [activeSectionIdx, setActiveSectionIdx] = useState(0);

  // Resolve subjectPool IDs → names so RuleBuilderPanel can filter against q.subject (a name)
  const [subjectDocs, setSubjectDocs] = useState<Subject[]>([]);
  useEffect(() => {
    getAllSubjects().then(setSubjectDocs).catch(() => setSubjectDocs([]));
  }, []);
  const subjectPoolNames = useMemo(
    () => subjectDocs.filter((s) => subjectPool.includes(s.id)).map((s) => s.name),
    [subjectDocs, subjectPool]
  );

  const mut = mutabilityFor(originalStatus);
  const lockReason = originalStatus === 'active' ? 'test is live' : 'test is closed';

  const buildSections = (sectionDrafts: SectionDraft[]): AssessmentSection[] =>
    sectionDrafts.map((sec, idx) => {
      const breakMins = parseInt(sec.breakAfterMinutes, 10);
      const out: AssessmentSection = {
        id: sec.id,
        name: sec.name,
        assignedTopics: sec.assignedTopics,
        rules: sec.rules
          .filter((r) => (parseInt(r.count, 10) || 0) > 0)
          .map((r) => ({
            subject: r.subject,
            topic: r.topic,
            difficulty: r.difficulty,
            count: parseInt(r.count, 10),
            marksPerQuestion: parseFloat(r.marksPerQuestion) || 1,
          })),
        questions: [],
      };
      const tl = parseInt(sec.timeLimit, 10);
      if (tl > 0) out.timeLimit = tl;
      if (idx < sectionDrafts.length - 1 && breakMins > 0) {
        out.breakAfter = { durationMinutes: breakMins, mandatory: sec.breakMandatory };
      }
      return out;
    });

  const [pendingPublish, setPendingPublish] = useState<{ warnings: string[] } | null>(null);

  const handleSave = async (overrideStatus?: AssessmentStatus, bypassSoftWarnings = false) => {
    setValidationErrors([]);
    const targetStatus: AssessmentStatus = overrideStatus ?? status;

    // ── HARD checks (apply to publish only; drafts skip all time checks) ──
    if (targetStatus === 'active') {
      const errors: string[] = [];
      const now = Date.now();
      const startMs = startDate ? new Date(fromDateTimeLocal(startDate)).getTime() : null;
      const endMs = endDate ? new Date(fromDateTimeLocal(endDate)).getTime() : null;

      if (startMs !== null && startMs < now) {
        errors.push('Start time is in the past — choose "Start immediately" or pick a future time.');
      }
      if (endMs !== null && endMs <= now) {
        errors.push('End time must be in the future.');
      }
      if (startMs !== null && endMs !== null && endMs <= startMs) {
        errors.push('End time must be after the start time.');
      }
      if (errors.length > 0) {
        setValidationErrors(errors);
        return;
      }
    }

    if (mut.endDate === 'extend-only' && assessment?.endDate && endDate) {
      const originalEnd = new Date(assessment.endDate).getTime();
      const newEnd = new Date(fromDateTimeLocal(endDate)).getTime();
      if (newEnd < originalEnd) {
        setValidationErrors([`The deadline cannot be moved earlier while the test is active — you may only extend it (current end: ${formatDateTime(assessment.endDate)}).`]);
        return;
      }
    }

    const builtSections = buildSections(sections);

    // ── HARD section/rule checks (publish only) — must run BEFORE soft warnings ──
    if (targetStatus === 'active') {
      const errors: string[] = [];

      // Each section must request at least 1 question.
      sections.forEach((s) => {
        const total = s.rules.reduce((sum, r) => sum + (parseInt(r.count, 10) || 0), 0);
        if (total < 1) {
          errors.push(`${s.name || 'Untitled section'} must have at least 1 question.`);
        }
      });

      const { valid, results } = validateSelectionRules(builtSections, allQuestions);
      if (!valid) {
        results
          .filter((r) => !r.ok)
          .forEach((r) => errors.push(`${r.sectionName}: ${r.subject} › ${r.topic} (${r.difficulty}) — requested ${r.requested}, only ${r.available} available`));
      }

      if (errors.length > 0) {
        setValidationErrors(errors);
        return;
      }
    }

    // ── SOFT warnings (publish only, can be bypassed) — run LAST so hard errors surface first ──
    if (targetStatus === 'active' && !bypassSoftWarnings) {
      const warnings: string[] = [];
      if (!startDate) {
        warnings.push('You\'re publishing with "Start immediately" — students will be able to begin as soon as the assessment is saved.');
      }
      if (!endDate) {
        warnings.push('You\'re publishing with "No deadline" — the assessment will stay open until you close it manually.');
      }
      // Window-vs-required time warning. Use now as the start when "immediate".
      const startMs = startDate ? new Date(fromDateTimeLocal(startDate)).getTime() : Date.now();
      const endMs = endDate ? new Date(fromDateTimeLocal(endDate)).getTime() : null;
      if (endMs !== null) {
        const windowMins = Math.floor((endMs - startMs) / 60000);
        const totalSectionTime = sections.reduce((sum, s) => sum + (parseInt(s.timeLimit, 10) || 0), 0);
        const totalBreakTime = sections.slice(0, -1).reduce((sum, s) => sum + (parseInt(s.breakAfterMinutes, 10) || 0), 0);
        const required = totalSectionTime + totalBreakTime;
        if (required > 0 && windowMins < required + 1) {
          warnings.push(`The scheduled window (${windowMins}m) is shorter than the total section time + breaks (${required}m). Some students may run out of clock time.`);
        }
      }
      if (warnings.length > 0) {
        setPendingPublish({ warnings });
        return;
      }
    }

    setSaving(true);
    try {
      const assignedTo: AssignmentTarget =
        targetType === 'all' ? { type: 'all' }
          : targetType === 'institutes' ? { type: 'institutes', instituteIds: selectedInstituteIds }
          : { type: 'students', studentIds: selectedStudentIds };

      let finalSections = builtSections;
      let flatQuestions = builtSections.flatMap((s) => s.questions);

      if (targetStatus === 'active') {
        const resolved = resolveQuestionsForSections(builtSections, allQuestions);
        finalSections = resolved.sections;
        flatQuestions = resolved.flatQuestions;
      }

      const draft: AssessmentDraft = {
        ownerType: 'webOwner',
        ownerId: 'webOwner',
        title: title.trim(),
        description,
        subject,
        tags: [],
        questions: flatQuestions,
        sections: finalSections,
        subjectPool: subjectPool.length > 0 ? subjectPool : undefined,
        topicPool: topicPool.length > 0 ? topicPool : undefined,
        assignedTo,
        startDate: startDate ? fromDateTimeLocal(startDate) : undefined,
        endDate: endDate ? fromDateTimeLocal(endDate) : undefined,
        timeLimit: undefined,
        passingScore: passingScore ? parseInt(passingScore, 10) : undefined,
        maxAttempts: maxAttempts ? parseInt(maxAttempts, 10) : undefined,
        shuffleQuestions,
        sectionStartOrder,
        showResults,
        allowReview,
        status: targetStatus,
      };

      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  const totalSectionTime = sections.reduce((sum, s) => sum + (parseInt(s.timeLimit, 10) || 0), 0);

  return (
    <div className="flex flex-col">

      {/* ── TOP: Schedule + Grading + Section Limits | Settings (fixed natural height) ── */}
      <div className="flex-shrink-0" style={{ borderBottom: '1px solid #E3E1DB', background: '#FAFAF8' }}>
        <div style={{ padding: '20px 48px 24px' }}>

          {/* Back link */}
          <div className="flex items-center gap-2 mb-4">
            <button onClick={onBack}
              className="flex items-center gap-1 text-xs transition-opacity hover:opacity-60"
              style={{ color: '#B0AEA8' }}>
              <X size={11} strokeWidth={1.5} /> Back to Setup
            </button>
            <span style={{ color: '#DDDBD5', fontSize: 10 }}>·</span>
            <p className="text-xs" style={{ color: '#C4C3BD', letterSpacing: '0.1em' }}>STEP 2 OF 2 — RULES &amp; SETTINGS</p>
          </div>

          {/* Two-column layout: left stacks Schedule/Grading/Section Limits, right holds Settings.
              Collapses to a single column on screens under ~860px. */}
          <div
            className="gap-8"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              alignItems: 'start',
            }}
          >

            {/* LEFT COLUMN: Schedule + Grading + Section Limits */}
            <div className="space-y-6" style={{ minWidth: 0 }}>

            {/* SCHEDULE */}
            <div className="space-y-3">
              <SectionLabel label="SCHEDULE" />
              {mut.startDate ? (
                <StartScheduleControl startDate={startDate} setStartDate={setStartDate} />
              ) : (
                <LockedFieldWrapper label="Start Date & Time" reason={lockReason}>
                  <div className="flex items-center gap-2 px-3 py-2"
                    style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
                    <Calendar size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
                    <input type="datetime-local" value={startDate} readOnly className="flex-1 outline-none"
                      style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }} />
                  </div>
                </LockedFieldWrapper>
              )}

              {mut.endDate === true && (
                <EndScheduleControl endDate={endDate} setEndDate={setEndDate} startDate={startDate} />
              )}
              {mut.endDate === 'extend-only' && (
                <div>
                  <Field label="End Date & Time">
                    <div className="flex items-center gap-2 px-3 py-2"
                      style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
                      <Calendar size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
                      <input type="datetime-local" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                        className="flex-1 outline-none"
                        style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }}
                        min={toDateTimeLocal(assessment?.endDate) || startDate || undefined} />
                    </div>
                  </Field>
                  <p className="text-xs mt-1.5 flex items-center gap-1" style={{ color: '#9A9891' }}>
                    <Clock size={9} strokeWidth={1.5} style={{ flexShrink: 0 }} />
                    You may only extend the deadline, not shorten it.
                  </p>
                </div>
              )}
              {mut.endDate === false && (
                <LockedFieldWrapper label="End Date & Time" reason={lockReason}>
                  <div className="flex items-center gap-2 px-3 py-2"
                    style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
                    <Calendar size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
                    <input type="datetime-local" value={endDate} readOnly className="flex-1 outline-none"
                      style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }} />
                  </div>
                </LockedFieldWrapper>
              )}

              {startDate && endDate && (
                <DurationIndicator startDate={startDate} endDate={endDate} totalSectionTime={totalSectionTime} />
              )}
            </div>

            {/* GRADING */}
            <div className="space-y-3">
              <SectionLabel label="GRADING" />
              <Field label="Passing Score" hint="(%, optional)">
                <div className="flex items-center gap-2 px-3 py-2"
                  style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
                  <Award size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
                  <input type="number" value={passingScore} onChange={(e) => setPassingScore(e.target.value)}
                    placeholder="e.g., 50" min="0" max="100" className="flex-1 outline-none"
                    style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }} />
                  {passingScore && <span style={{ color: '#C4C3BD', fontSize: 10 }}>%</span>}
                </div>
              </Field>

              <Field label="Max Attempts" hint="(per student, default 1)">
                <div className="flex items-center gap-2 px-3 py-2"
                  style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
                  <ClipboardList size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
                  <input type="number" value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)}
                    placeholder="e.g., 2" min="1" className="flex-1 outline-none"
                    style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }} />
                  {maxAttempts && <span style={{ color: '#C4C3BD', fontSize: 10 }}>attempts</span>}
                </div>
              </Field>

              {status === 'active' && (
                <div className="flex items-start gap-2 px-3 py-3"
                  style={{ background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2 }}>
                  <CheckCircle2 size={12} strokeWidth={1.5} style={{ color: '#1E7B3C', flexShrink: 0, marginTop: 1 }} />
                  <p className="text-xs" style={{ color: '#1E7B3C', lineHeight: 1.6 }}>
                    Setting status to <strong>Active</strong> will validate and randomly resolve a unique question set per student at save time.
                  </p>
                </div>
              )}
            </div>

            {/* SECTION LIMITS */}
            {(sections.some((s) => s.timeLimit) || sections.slice(0, -1).some((s) => parseInt(s.breakAfterMinutes, 10) > 0)) && (
              <div className="space-y-3">
                <SectionLabel label="SECTION LIMITS" />
                <div className="space-y-1">
                  {sections.map((sec, sIdx) => {
                    const showSection = !!sec.timeLimit;
                    const breakMins = sIdx < sections.length - 1 ? parseInt(sec.breakAfterMinutes, 10) || 0 : 0;
                    if (!showSection && !breakMins) return null;
                    return (
                      <div key={sec.id} className="space-y-1">
                        {showSection && (
                          <div className="flex items-center justify-between px-3 py-1.5"
                            style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                            <span className="text-xs" style={{ color: '#6B6B66' }}>{sec.name}</span>
                            <span className="text-xs flex items-center gap-1" style={{ color: '#9A9891' }}>
                              <Timer size={10} strokeWidth={1.5} />{sec.timeLimit} min
                            </span>
                          </div>
                        )}
                        {breakMins > 0 && (
                          <div className="flex items-center justify-between px-3 py-1"
                            style={{ background: '#FAFAF8', border: '1px dashed #E3E1DB', borderRadius: 2 }}>
                            <span className="text-xs" style={{ color: '#9A9891' }}>
                              Break {sec.breakMandatory ? '(mandatory)' : '(skippable)'}
                            </span>
                            <span className="text-xs" style={{ color: '#9A9891' }}>{breakMins} min</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            </div>{/* /LEFT COLUMN */}

            {/* RIGHT COLUMN: SETTINGS */}
            <div className="space-y-3" style={{ minWidth: 0 }}>
              <SectionLabel label="SETTINGS" />

              {/* Section start order */}
              <div className="space-y-1.5">
                <p className="text-xs" style={{ color: '#6B6B66' }}>
                  Section order
                </p>
                <div className="flex" style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', overflow: 'hidden' }}>
                  {([
                    { key: 'sequential' as const, label: 'In order' },
                    { key: 'random' as const,     label: 'Random' },
                    { key: 'student_choice' as const, label: "Student's choice" },
                  ]).map((opt, i) => {
                    const active = sectionStartOrder === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => setSectionStartOrder(opt.key)}
                        className="flex-1 text-xs px-2 py-1.5 transition-colors"
                        style={{
                          background: active ? '#0C0C0B' : 'transparent',
                          color: active ? '#FFFFFF' : '#4A4A45',
                          borderLeft: i === 0 ? 'none' : '1px solid #E3E1DB',
                          cursor: 'pointer',
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs" style={{ color: '#9A9891' }}>
                  {sectionStartOrder === 'random'
                    ? 'Each student gets sections in a different order.'
                    : sectionStartOrder === 'student_choice'
                      ? 'Students choose which section to take first.'
                      : 'Sections are taken in the order shown below.'}
                </p>
              </div>

              <div className="space-y-2">
                <SettingsToggle
                  icon={<Shuffle size={12} strokeWidth={1.5} style={{ color: '#9A9891' }} />}
                  label="Shuffle Questions"
                  hint="Randomise question order for each student"
                  value={shuffleQuestions}
                  onChange={setShuffleQuestions}
                  locked={!mut.shuffleQuestions}
                  lockReason={mut.shuffleQuestions ? undefined : lockReason}
                />
                <SettingsToggle
                  icon={<BarChart2 size={12} strokeWidth={1.5} style={{ color: '#9A9891' }} />}
                  label="Show Results"
                  hint="Display score and outcomes to students after submission"
                  value={showResults}
                  onChange={setShowResults}
                />
                <SettingsToggle
                  icon={<BookOpen size={12} strokeWidth={1.5} style={{ color: '#9A9891' }} />}
                  label="Allow Review"
                  hint="Let students revisit their answers after submission"
                  value={allowReview}
                  onChange={setAllowReview}
                />
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* ── BOTTOM: Rule Builder (full width) ── */}
      <RuleBuilderPanel
        sections={sections}
        activeSectionIdx={activeSectionIdx}
        setActiveSectionIdx={setActiveSectionIdx}
        setSections={setSections}
        allQuestions={allQuestions}
        locked={!mut.sections}
        subjectPoolNames={subjectPoolNames}
        topicPool={topicPool}
      />

      {/* Bottom save bar */}
      <div className="flex items-center justify-end gap-3 px-12 py-5 mt-8"
        style={{ borderTop: '1px solid #E3E1DB', background: '#FAFAF8' }}>
        {(() => {
          // Edit mode on a live or closed assessment: status is locked, single Save Changes.
          const lockedStatus = mode === 'edit' && (originalStatus === 'active' || originalStatus === 'closed');
          if (lockedStatus) {
            return (
              <button onClick={() => handleSave()} disabled={saving}
                className="flex items-center gap-1.5 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
                style={{ background: saving ? '#C8C7C2' : '#0C0C0B', color: '#FFFFFF', borderRadius: 2, cursor: saving ? 'not-allowed' : 'pointer' }}>
                {saving
                  ? <><Loader2 size={11} className="animate-spin" /> Saving…</>
                  : <><CheckCircle2 size={11} /> Save Changes</>}
              </button>
            );
          }
          // Create mode, or edit on a draft: offer Save as Draft + Publish.
          const draftLabel = mode === 'create' ? 'Save as Draft' : 'Save Draft';
          const publishLabel = mode === 'create' ? 'Create & Publish' : 'Save & Publish';
          return (
            <>
              <button onClick={() => handleSave('draft')} disabled={saving}
                className="flex items-center gap-1.5 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
                style={{ background: '#FFFFFF', color: '#0C0C0B', border: '1px solid #0C0C0B', borderRadius: 2, cursor: saving ? 'not-allowed' : 'pointer' }}>
                {saving ? <><Loader2 size={11} className="animate-spin" /> Saving…</> : <>{draftLabel}</>}
              </button>
              <button onClick={() => handleSave('active')} disabled={saving}
                className="flex items-center gap-1.5 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
                style={{ background: saving ? '#C8C7C2' : '#0C0C0B', color: '#FFFFFF', borderRadius: 2, cursor: saving ? 'not-allowed' : 'pointer' }}>
                {saving ? <><Loader2 size={11} className="animate-spin" /> Publishing…</> : <><CheckCircle2 size={11} /> {publishLabel}</>}
              </button>
            </>
          );
        })()}
      </div>

      {/* Validation-error modal (hard-block) */}
      {validationErrors.length > 0 && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center px-6"
          style={{ background: 'rgba(12,12,11,0.45)' }}
          onClick={() => setValidationErrors([])}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3, maxWidth: 520, width: '100%' }}>
            <div className="px-6 py-5" style={{ borderBottom: '1px solid #E3E1DB' }}>
              <div className="flex items-center gap-2">
                <AlertCircle size={14} strokeWidth={1.5} style={{ color: '#9B2828' }} />
                <span className="text-xs" style={{ color: '#0C0C0B', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Fix the following before saving
                </span>
              </div>
            </div>
            <ul className="px-6 py-4 space-y-2.5">
              {validationErrors.map((err, i) => (
                <li key={i} className="flex items-start gap-2 text-xs" style={{ color: '#0C0C0B', lineHeight: 1.55 }}>
                  <span style={{ color: '#9B2828', flexShrink: 0, marginTop: 1 }}>•</span>
                  <span>{err}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end gap-2 px-6 py-4"
              style={{ borderTop: '1px solid #E3E1DB', background: '#FAFAF8' }}>
              <button onClick={() => setValidationErrors([])}
                className="text-xs px-4 py-2 transition-opacity hover:opacity-80"
                style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, cursor: 'pointer' }}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Soft-warning confirmation modal (publish only) */}
      {pendingPublish && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center px-6"
          style={{ background: 'rgba(12,12,11,0.45)' }}
          onClick={() => setPendingPublish(null)}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3, maxWidth: 520, width: '100%' }}>
            <div className="px-6 py-5" style={{ borderBottom: '1px solid #E3E1DB' }}>
              <div className="flex items-center gap-2">
                <AlertTriangle size={14} strokeWidth={1.5} style={{ color: '#B5651D' }} />
                <span className="text-xs" style={{ color: '#0C0C0B', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Confirm publish
                </span>
              </div>
              <p className="text-xs mt-2" style={{ color: '#6B6B66', lineHeight: 1.6 }}>
                Before publishing, please review the following:
              </p>
            </div>
            <ul className="px-6 py-4 space-y-2.5">
              {pendingPublish.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2 text-xs" style={{ color: '#0C0C0B', lineHeight: 1.55 }}>
                  <span style={{ color: '#B5651D', flexShrink: 0, marginTop: 1 }}>•</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end gap-2 px-6 py-4"
              style={{ borderTop: '1px solid #E3E1DB', background: '#FAFAF8' }}>
              <button onClick={() => setPendingPublish(null)}
                className="text-xs px-4 py-2 transition-opacity hover:opacity-80"
                style={{ background: '#FFFFFF', color: '#0C0C0B', border: '1px solid #C8C7C2', borderRadius: 2, cursor: 'pointer' }}>
                Go back
              </button>
              <button onClick={() => { setPendingPublish(null); handleSave('active', true); }} disabled={saving}
                className="flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity hover:opacity-80"
                style={{ background: saving ? '#C8C7C2' : '#0C0C0B', color: '#FFFFFF', borderRadius: 2, cursor: saving ? 'not-allowed' : 'pointer' }}>
                {saving ? <><Loader2 size={11} className="animate-spin" /> Publishing…</> : <><CheckCircle2 size={11} /> Publish anyway</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// ASSESSMENT PANEL — full-page orchestrator
// ══════════════════════════════════════════════════════════════════

function AssessmentPanel({ mode, assessment, allQuestions, onSave, onClose }: {
  mode: 'create' | 'edit';
  assessment: Assessment | null;
  allQuestions: Question[];
  onSave: (draft: AssessmentDraft) => Promise<void>;
  onClose: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);

  // Lock body scroll while the panel is open so the page underneath doesn't
  // contribute its own scrollbar alongside the panel's scrollbar.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // ── Lifted basics state ──────────────────────────────────────────
  const [title, setTitle] = useState(assessment?.title ?? '');
  const [description, setDescription] = useState(assessment?.description ?? '');
  const [subject, setSubject] = useState(assessment?.subject ?? '');
  const [status, setStatus] = useState<AssessmentStatus>(assessment?.status ?? 'draft');
  const [targetType, setTargetType] = useState<'all' | 'institutes' | 'students'>(
    assessment?.assignedTo.type ?? 'all'
  );
  const [selectedInstituteIds, setSelectedInstituteIds] = useState<string[]>(
    assessment?.assignedTo.type === 'institutes' ? assessment.assignedTo.instituteIds : []
  );
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>(
    assessment?.assignedTo.type === 'students' ? assessment.assignedTo.studentIds : []
  );

  // ── Subject / topic pool (Step 1 Phases 1 & 2) ──────────────────
  const [subjectPool, setSubjectPool] = useState<string[]>(assessment?.subjectPool ?? []);
  const [topicPool, setTopicPool] = useState<string[]>(assessment?.topicPool ?? []);

  const [sections, setSections] = useState<SectionDraft[]>(() => {
    if (assessment?.sections && assessment.sections.length > 0) {
      return assessment.sections.map((sec) => ({
        id: sec.id,
        name: sec.name,
        timeLimit: sec.timeLimit?.toString() ?? '',
        // Restore assigned topics; fall back to inferring from existing rules for old assessments
        assignedTopics: sec.assignedTopics ?? [...new Set(sec.rules.map((r) => `${r.subject}::${r.topic}`))],
        rules: sec.rules.map((r) => ({
          subject: r.subject,
          topic: r.topic,
          difficulty: r.difficulty,
          count: r.count.toString(),
          marksPerQuestion: r.marksPerQuestion.toString(),
        })),
        breakAfterMinutes: sec.breakAfter?.durationMinutes?.toString() ?? '',
        breakMandatory: sec.breakAfter?.mandatory ?? false,
      }));
    }
    return [{
      id: makeSectionId(),
      name: 'Section A',
      timeLimit: '',
      rules: [],
      assignedTopics: [],
      breakAfterMinutes: '',
      breakMandatory: false,
    }];
  });

  const grandTotalQ = sections.reduce((s, sec) => s + sec.rules.reduce((ss, r) => ss + (parseInt(r.count, 10) || 0), 0), 0);
  const grandTotalMarks = sections.reduce((s, sec) => sec.rules.reduce((ss, r) => ss + (parseInt(r.count, 10) || 0) * (parseFloat(r.marksPerQuestion) || 0), s), 0);

  return (
    <motion.div
      key="fullpage-panel"
      initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: '#F7F6F3' }}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-8 flex-shrink-0"
        style={{ height: 56, borderBottom: '1px solid #E3E1DB', background: '#FFFFFF' }}>
        {/* Left */}
        <div className="flex items-center gap-4">
          <button onClick={onClose}
            className="flex items-center gap-1.5 text-xs transition-opacity hover:opacity-60"
            style={{ color: '#9A9891' }}>
            <X size={13} strokeWidth={1.5} />
            <span style={{ letterSpacing: '0.04em' }}>Cancel</span>
          </button>
          <div style={{ width: 1, height: 14, background: '#E3E1DB' }} />
          <p className="text-xs" style={{ color: '#B0AEA8', letterSpacing: '0.1em' }}>
            {mode === 'create' ? 'NEW ASSESSMENT' : 'EDIT ASSESSMENT'}
          </p>
          {/* Step indicator */}
          <div className="flex items-center gap-1.5">
            {[1, 2].map((n, i) => (
              <React.Fragment key={n}>
                {i > 0 && <div style={{ width: 16, height: 1, background: step >= n ? '#0C0C0B' : '#E3E1DB' }} />}
                <div className="flex items-center justify-center"
                  style={{ width: 18, height: 18, borderRadius: 9, background: step >= n ? '#0C0C0B' : '#E3E1DB', fontSize: 9, color: step >= n ? '#FFFFFF' : '#9A9891' }}>
                  {n}
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* Center */}
        {step === 2 && grandTotalQ > 0 && (
          <span className="text-xs px-2.5 py-1"
            style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2, color: '#6B6B66' }}>
            {sections.length} section{sections.length !== 1 ? 's' : ''} · {grandTotalQ} Q · {grandTotalMarks} marks
          </span>
        )}

        {/* Right */}
        {step === 1 ? (
          <button
            onClick={() => setStep(2)}
            disabled={!title.trim() || !sections.every((s) => s.name.trim() && parseInt(s.timeLimit, 10) >= 1)}
            className="flex items-center gap-1.5 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
            style={{
              background: title.trim() && sections.every((s) => s.name.trim() && parseInt(s.timeLimit, 10) >= 1) ? '#0C0C0B' : '#C8C7C2',
              color: '#FFFFFF', borderRadius: 2,
              cursor: title.trim() && sections.every((s) => s.name.trim() && parseInt(s.timeLimit, 10) >= 1) ? 'pointer' : 'not-allowed',
            }}>
            Continue to Rules <ChevronRight size={12} strokeWidth={2} />
          </button>
        ) : null}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <AnimatePresence mode="wait">
          {step === 1 ? (
            <SetupStep
              key="step1"
              title={title} setTitle={setTitle}
              description={description} setDescription={setDescription}
              subject={subject} setSubject={setSubject}
              status={status} setStatus={setStatus}
              targetType={targetType} setTargetType={setTargetType}
              selectedInstituteIds={selectedInstituteIds} setSelectedInstituteIds={setSelectedInstituteIds}
              selectedStudentIds={selectedStudentIds} setSelectedStudentIds={setSelectedStudentIds}
              sections={sections} setSections={setSections}
              onContinue={() => setStep(2)}
              originalStatus={assessment?.status}
              allQuestions={allQuestions}
              subjectPool={subjectPool} setSubjectPool={setSubjectPool}
              topicPool={topicPool} setTopicPool={setTopicPool}
            />
          ) : (
            <motion.div key="step2" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }} className="flex-1 overflow-y-auto flex flex-col">
              <DetailsStep
                mode={mode} assessment={assessment} originalStatus={assessment?.status}
                allQuestions={allQuestions}
                sections={sections} setSections={setSections}
                onBack={() => setStep(1)} onSave={onSave}
                title={title} description={description} subject={subject} status={status}
                targetType={targetType}
                selectedInstituteIds={selectedInstituteIds}
                selectedStudentIds={selectedStudentIds}
                subjectPool={subjectPool}
                topicPool={topicPool}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════

export function AssignmentsPage() {
  const navigate = useNavigate();
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [allQuestions, setAllQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<'create' | 'edit'>('create');
  const [editTarget, setEditTarget] = useState<Assessment | null>(null);
  const [previewAssessment, setPreviewAssessment] = useState<Assessment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Assessment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const fetchAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [assessData, questionsData] = await Promise.all([getAllAssessments(), getAllQuestions()]);
      setAssessments(assessData.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setAllQuestions(questionsData);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleSave = async (draft: AssessmentDraft) => {
    if (panelMode === 'create') {
      const saved = await createAssessment(draft);
      setAssessments((prev) => [saved, ...prev]);
    } else if (editTarget) {
      await updateAssessment(editTarget.id, draft);
      const totalMarks = draft.questions.reduce((s, q) => s + q.marks, 0);
      const updated = { ...editTarget, ...draft, totalMarks, updatedAt: new Date().toISOString() } as Assessment;
      setAssessments((prev) => prev.map((a) => (a.id === editTarget.id ? updated : a)));
    }
    setPanelOpen(false);
    setEditTarget(null);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await softDeleteAssessment(deleteTarget.id);
      setAssessments((prev) => prev.filter((a) => a.id !== deleteTarget.id));
      setDeleteTarget(null);
    } finally { setDeleting(false); }
  };

  const openCreate = () => { setEditTarget(null); setPanelMode('create'); setPanelOpen(true); };
  const openEdit = (a: Assessment) => { setEditTarget(a); setPanelMode('edit'); setPanelOpen(true); };

  const filtered = assessments.filter((a) => {
    if (statusFilter && a.status !== statusFilter) return false;
    if (search) {
      const s = search.toLowerCase();
      if (!a.title.toLowerCase().includes(s) && !a.subject.toLowerCase().includes(s) && !a.description.toLowerCase().includes(s)) return false;
    }
    return true;
  });

  const draftCount = assessments.filter((a) => a.status === 'draft').length;
  const activeCount = assessments.filter((a) => a.status === 'active').length;
  const closedCount = assessments.filter((a) => a.status === 'closed').length;

  return (
    <>
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="px-8 py-10" style={{ maxWidth: 1120, margin: '0 auto' }}>

        {/* Header */}
        <div className="flex items-start justify-between mb-8"
          style={{ borderBottom: '1px solid #E3E1DB', paddingBottom: 20 }}>
          <div>
            <p className="text-xs mb-1" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>WEB OWNER</p>
            <h1 className="text-base" style={{ color: '#0C0C0B' }}>Assignments</h1>
            <p className="text-xs mt-1" style={{ color: '#B0AEA8' }}>
              Create and manage test assignments for institutes and students.
            </p>
          </div>
          <button onClick={openCreate}
            className="flex items-center gap-1.5 text-xs px-4 py-2.5 mt-1 transition-opacity hover:opacity-80"
            style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.03em' }}>
            <Plus size={12} strokeWidth={2} /> Create Assessment
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-3 mb-8">
          <StatPill icon={<ClipboardList size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />} label="Total Assessments" value={loading ? '…' : String(assessments.length)} />
          <StatPill icon={<FileText size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />} label="Drafts" value={loading ? '…' : String(draftCount)} />
          <StatPill icon={<Target size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />} label="Active" value={loading ? '…' : String(activeCount)} />
          <StatPill icon={<Clock size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />} label="Closed" value={loading ? '…' : String(closedCount)} />
        </div>

        {/* List */}
        <div style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}>
          <FilterBar search={search} setSearch={setSearch} statusFilter={statusFilter} setStatusFilter={setStatusFilter} />
          {!loading && filtered.length > 0 && (
            <div className="flex items-center gap-4 px-5 py-2" style={{ background: '#FAFAF8', borderBottom: '1px solid #F0EFEB' }}>
              <div className="flex-shrink-0 w-16"><span className="text-xs" style={{ color: '#C4C3BD', letterSpacing: '0.08em' }}>STATUS</span></div>
              <div className="flex-1"><span className="text-xs" style={{ color: '#C4C3BD', letterSpacing: '0.08em' }}>ASSESSMENT</span></div>
              <div className="flex-shrink-0 text-right" style={{ minWidth: 148 }}><span className="text-xs" style={{ color: '#C4C3BD', letterSpacing: '0.08em' }}>DATE RANGE</span></div>
              <div className="flex-shrink-0 w-20" />
            </div>
          )}
          {loading && <><SkeletonRow /><SkeletonRow /><SkeletonRow /></>}
          {!loading && filtered.map((a) => (
            <AssessmentRow key={a.id} assessment={a}
              onPreview={() => setPreviewAssessment(a)}
              onPatched={(patch) => setAssessments((prev) => prev.map((x) => (x.id === a.id ? { ...x, ...patch, updatedAt: new Date().toISOString() } as Assessment : x)))}
              onOpenLegacyEditor={() => openEdit(a)}
              onDelete={() => setDeleteTarget(a)}
              onRoster={() => navigate(`/dashboard/assignments/${a.id}/roster`)} />
          ))}
          {!loading && filtered.length === 0 && <EmptyState filtered={!!(search || statusFilter)} onAdd={openCreate} />}
          {!loading && filtered.length > 0 && (
            <div className="px-5 py-3 flex items-center justify-between" style={{ borderTop: '1px solid #F0EFEB' }}>
              <span className="text-xs" style={{ color: '#C4C3BD' }}>
                {filtered.length} {filtered.length === 1 ? 'assessment' : 'assessments'}
                {(search || statusFilter) && ' matching filters'}
              </span>
              {(search || statusFilter) && (
                <button onClick={() => { setSearch(''); setStatusFilter(''); }}
                  className="text-xs transition-opacity hover:opacity-60" style={{ color: '#9A9891' }}>
                  Clear filters
                </button>
              )}
            </div>
          )}
        </div>
      </motion.div>

      {/* Full-page panel */}
      <AnimatePresence>
        {panelOpen && (
          <AssessmentPanel mode={panelMode} assessment={editTarget} allQuestions={allQuestions}
            onSave={handleSave} onClose={() => { setPanelOpen(false); setEditTarget(null); }} />
        )}
      </AnimatePresence>

      {/* Preview */}
      <AnimatePresence>
        {previewAssessment && <PreviewModal assessment={previewAssessment} onClose={() => setPreviewAssessment(null)} />}
      </AnimatePresence>

      {/* Delete */}
      <AnimatePresence>
        {deleteTarget && <DeleteModal assessment={deleteTarget} onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)} deleting={deleting} />}
      </AnimatePresence>
    </>
  );
}
