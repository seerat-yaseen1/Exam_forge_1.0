import React, {
  useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle,
} from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, X, Eye, Pencil, Trash2, Loader2, AlertTriangle, Search } from 'lucide-react';
import {
  getAllQuestions,
  createQuestion, updateQuestion, softDeleteQuestion,
  questionTypeBadge, difficultyColor,
  type Question, type Difficulty,
} from '../../../lib/questionBankService';
import { getAllSubjects, getAllTopics, type Subject, type Topic } from '../../../lib/subjectService';
import { QuestionTypeEngine, type QuestionDraft } from './QuestionTypeEngine';
import { QuestionPreview } from './QuestionPreview';

// ══════════════════════════════════════════════════════════════════
// QuestionBankCore — the shared Question Pool (list + create/edit/delete
// + preview + filters). Rendered by the web-owner Questions page AND by the
// Subjects → topic drill-in. When lockSubjectId/lockTopicId are passed it is
// scoped to that topic: the taxonomy dropdowns are hidden and new questions
// are pre-filled with that subject + topic.
// ══════════════════════════════════════════════════════════════════

export interface QuestionBankCoreHandle {
  openCreate: () => void;
}

export interface QuestionBankCoreProps {
  lockSubjectId?: string;
  lockTopicId?: string;
  showAddButton?: boolean;          // render an internal "Add Question" toolbar
  onChanged?: () => void;           // fired after create/edit/delete
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const truncate = (s: string, n = 100) => (s.length > n ? s.slice(0, n) + '…' : s);

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Badge chips ───────────────────────────────────────────────────────────────

function TypeBadgeChip({ engine, variant }: Pick<Question, 'engine' | 'variant'>) {
  const label = questionTypeBadge(engine, variant);
  return (
    <span
      className="text-xs px-1.5 py-0.5 select-none flex-shrink-0 inline-block"
      style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, letterSpacing: '0.04em', fontSize: 10 }}
    >
      {label}
    </span>
  );
}

function DiffChip({ difficulty }: { difficulty: Difficulty }) {
  const { bg, text, border } = difficultyColor(difficulty);
  return (
    <span
      className="text-xs px-2 py-0.5 capitalize select-none"
      style={{ background: bg, color: text, border: `1px solid ${border}`, borderRadius: 2 }}
    >
      {difficulty}
    </span>
  );
}

// ── Skeleton row ──────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-center gap-4 px-5 py-4" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
      <div className="h-4 w-10 rounded" style={{ background: '#EEECEA', animation: 'pulse 1.5s ease-in-out infinite' }} />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 rounded" style={{ width: '60%', background: '#EEECEA', animation: 'pulse 1.5s ease-in-out infinite' }} />
        <div className="h-2.5 rounded" style={{ width: '30%', background: '#F3F2EF', animation: 'pulse 1.5s ease-in-out infinite' }} />
      </div>
      <div className="h-4 w-16 rounded" style={{ background: '#F3F2EF', animation: 'pulse 1.5s ease-in-out infinite' }} />
      <div className="h-4 w-8 rounded" style={{ background: '#F3F2EF', animation: 'pulse 1.5s ease-in-out infinite' }} />
    </div>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────────────

const TYPE_FILTERS = [
  { label: 'All', value: '' }, { label: 'MCQ', value: 'MCQ' }, { label: 'Multi', value: 'Multi' },
  { label: 'T/F', value: 'T/F' }, { label: 'Fill', value: 'Fill' }, { label: 'Short', value: 'Short' },
  { label: 'Essay', value: 'Essay' }, { label: 'Match', value: 'Match' },
];

const DIFF_FILTERS = [
  { label: 'All', value: '' }, { label: 'Easy', value: 'easy' },
  { label: 'Medium', value: 'medium' }, { label: 'Hard', value: 'hard' },
];

interface FilterBarProps {
  search:      string; setSearch:      (v: string) => void;
  typeFilter:  string; setTypeFilter:  (v: string) => void;
  diffFilter:  string; setDiffFilter:  (v: string) => void;
  subjectId:   string; setSubjectId:   (v: string) => void;
  topicId:     string; setTopicId:     (v: string) => void;
  subjects:    Subject[];
  topics:      Topic[];
  hideTaxonomy?: boolean;   // hide subject/topic dropdowns when locked to a topic
}

function FilterBar({
  search, setSearch, typeFilter, setTypeFilter, diffFilter, setDiffFilter,
  subjectId, setSubjectId, topicId, setTopicId, subjects, topics, hideTaxonomy,
}: FilterBarProps) {
  const visibleTopics = subjectId
    ? topics.filter((t) => t.subjectId === subjectId).sort((a, b) => a.name.localeCompare(b.name))
    : [];

  const selectStyle: React.CSSProperties = {
    background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2,
    color: 'var(--ef-ink)', fontSize: 12, padding: '6px 8px', outline: 'none',
  };
  return (
    <div className="flex flex-col gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
      {/* Search */}
      <div className="flex items-center gap-2 px-3 py-2" style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
        <Search size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search stem, subject, topic…"
          className="flex-1 text-xs outline-none"
          style={{ background: 'transparent', color: 'var(--ef-ink)', fontSize: 13 }}
        />
        {search && (
          <button onClick={() => setSearch('')} className="hover:opacity-60 transition-opacity">
            <X size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          </button>
        )}
      </div>

      {/* Type + Diff chips */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
        <div className="flex items-center gap-1.5 flex-wrap">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setTypeFilter(f.value)}
              className="text-xs px-2.5 py-1 transition-all"
              style={{
                borderRadius: 2,
                border: typeFilter === f.value ? '1px solid var(--ef-ink)' : '1px solid var(--ef-border)',
                background: typeFilter === f.value ? 'var(--ef-ink)' : 'var(--ef-canvas-raised)',
                color: typeFilter === f.value ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="hidden md:block" style={{ width: 1, height: 20, background: 'var(--ef-border)', flexShrink: 0 }} />

        <div className="flex items-center gap-1.5 flex-wrap">
          {DIFF_FILTERS.map((f) => {
            const colors = f.value ? difficultyColor(f.value as Difficulty) : null;
            const isActive = diffFilter === f.value;
            return (
              <button
                key={f.value}
                onClick={() => setDiffFilter(f.value)}
                className="text-xs px-2.5 py-1 transition-all"
                style={{
                  borderRadius: 2,
                  border: isActive ? `1px solid ${colors?.border ?? 'var(--ef-ink)'}` : '1px solid var(--ef-border)',
                  background: isActive ? (colors?.bg ?? 'var(--ef-ink)') : 'var(--ef-canvas-raised)',
                  color: isActive ? (colors?.text ?? 'var(--ef-surface)') : 'var(--ef-text-muted)',
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Subject + Topic slug dropdowns (hidden when locked) */}
      {!hideTaxonomy && (
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>SUBJECT</span>
            <select value={subjectId} onChange={(e) => { setSubjectId(e.target.value); setTopicId(''); }} style={selectStyle}>
              <option value="">All subjects</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>{s.id} · {s.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>TOPIC</span>
            <select
              value={topicId}
              onChange={(e) => setTopicId(e.target.value)}
              disabled={!subjectId}
              style={{ ...selectStyle, opacity: subjectId ? 1 : 0.5, cursor: subjectId ? 'pointer' : 'not-allowed' }}
            >
              <option value="">{subjectId ? 'All topics' : 'Pick a subject first'}</option>
              {visibleTopics.map((t) => (
                <option key={t.id} value={t.id}>{t.id} · {t.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Question row ──────────────────────────────────────────────────────────────

function QuestionRow({
  question, onPreview, onEdit, onDelete,
}: {
  question: Question;
  onPreview: () => void;
  onEdit:    () => void;
  onDelete:  () => void;
}) {
  const [hovered, setHovered] = useState(false);

  const stemBlock = (
    <p className="text-xs" style={{ color: 'var(--ef-ink)', lineHeight: 1.5 }}>
      {truncate(question.stem, 110) || <em style={{ color: 'var(--ef-text-muted)' }}>No stem</em>}
    </p>
  );

  const stemBlockFull = (
    <p style={{ color: 'var(--ef-ink)', fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {question.stem || <em style={{ color: 'var(--ef-text-muted)' }}>No stem</em>}
    </p>
  );

  const metaBlock = (
    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
      {question.subject && <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{question.subject}</span>}
      {question.topic && <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>· {question.topic}</span>}
      {question.tags.slice(0, 3).map((tag) => (
        <span key={tag} className="text-xs px-1.5 py-0.5" style={{ background: 'var(--ef-border-subtle)', borderRadius: 2, color: 'var(--ef-text-muted)', fontSize: 10 }}>
          #{tag}
        </span>
      ))}
    </div>
  );

  const actions = (
    <div className="flex items-center gap-1 flex-shrink-0">
      <button onClick={onPreview} title="Preview" className="p-1.5 transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}>
        <Eye size={13} strokeWidth={1.5} />
      </button>
      <button onClick={onEdit} title="Edit" className="p-1.5 transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}>
        <Pencil size={13} strokeWidth={1.5} />
      </button>
      <button onClick={onDelete} title="Delete" className="p-1.5 transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}>
        <Trash2 size={13} strokeWidth={1.5} />
      </button>
    </div>
  );

  return (
    <div
      className="px-4 py-3.5 md:px-5 transition-colors"
      style={{ borderBottom: '1px solid var(--ef-border-subtle)', background: hovered ? 'var(--ef-canvas-raised)' : 'var(--ef-surface)' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Desktop: single row */}
      <div className="hidden md:flex items-center gap-4">
        <div className="flex-shrink-0"><TypeBadgeChip engine={question.engine} variant={question.variant} /></div>
        <div className="flex-1 min-w-0">{stemBlock}{metaBlock}</div>
        <div className="flex-shrink-0"><DiffChip difficulty={question.difficulty} /></div>
        <div className="flex-shrink-0 w-24 text-right">
          <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{formatDate(question.createdAt)}</span>
        </div>
        {actions}
      </div>

      {/* Phone: card */}
      <div className="md:hidden flex flex-col">
        <div className="mb-3">{stemBlockFull}</div>
        <div className="flex items-center gap-1.5 flex-wrap mb-2.5">
          <TypeBadgeChip engine={question.engine} variant={question.variant} />
          <DiffChip difficulty={question.difficulty} />
        </div>
        {(question.subject || question.topic) && (
          <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-xs mb-2.5">
            {question.subject && <span style={{ color: 'var(--ef-text-muted)' }}>{question.subject}</span>}
            {question.subject && question.topic && <span style={{ color: 'var(--ef-border-muted)' }}>·</span>}
            {question.topic && <span style={{ color: 'var(--ef-text-muted)' }}>{question.topic}</span>}
          </div>
        )}
        {question.tags.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mb-2.5">
            {question.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="px-1.5 py-0.5" style={{ background: 'var(--ef-border-subtle)', borderRadius: 2, color: 'var(--ef-text-muted)', fontSize: 10 }}>
                #{tag}
              </span>
            ))}
          </div>
        )}
        <div className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)' }}>Created {formatDate(question.createdAt)}</div>
        <div className="flex items-center gap-2 pt-3" style={{ borderTop: '1px solid var(--ef-border-subtle)' }}>
          <div className="flex-1" />
          <button onClick={onPreview} aria-label="Preview" className="flex items-center justify-center transition-opacity hover:opacity-60"
            style={{ width: 36, height: 36, color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
            <Eye size={14} strokeWidth={1.5} />
          </button>
          <button onClick={onEdit} aria-label="Edit" className="flex items-center justify-center transition-opacity hover:opacity-60"
            style={{ width: 36, height: 36, color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
            <Pencil size={14} strokeWidth={1.5} />
          </button>
          <button onClick={onDelete} aria-label="Delete" className="flex items-center justify-center transition-opacity hover:opacity-60"
            style={{ width: 36, height: 36, color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
            <Trash2 size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ filtered, onAdd }: { filtered: boolean; onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16" style={{ color: 'var(--ef-text-muted)' }}>
      <div style={{ width: 1, height: 32, background: 'linear-gradient(to bottom, transparent, var(--ef-border-muted))', marginBottom: 16 }} />
      <p className="text-xs" style={{ letterSpacing: '0.1em' }}>{filtered ? 'NO QUESTIONS MATCH' : 'NO QUESTIONS YET'}</p>
      {!filtered && (
        <button onClick={onAdd} className="mt-4 flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity hover:opacity-70"
          style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)', background: 'var(--ef-surface)' }}>
          <Plus size={12} strokeWidth={1.5} /> Add first question
        </button>
      )}
      <div style={{ width: 1, height: 32, background: 'linear-gradient(to top, transparent, var(--ef-border-muted))', marginTop: 16 }} />
    </div>
  );
}

// ── Delete confirm modal ──────────────────────────────────────────────────────

function DeleteModal({
  question, onConfirm, onCancel, deleting,
}: { question: Question; onConfirm: () => void; onCancel: () => void; deleting: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-60 flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.28)' }}
      onClick={onCancel}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-sm"
        style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3.5 md:px-5 md:py-4" style={{ borderBottom: '1px solid var(--ef-border)' }}>
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>DELETE QUESTION</p>
          <button onClick={onCancel} className="p-1 hover:opacity-60 transition-opacity" style={{ color: 'var(--ef-text-muted)' }}>
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        <div className="px-4 py-4 md:px-5 md:py-5">
          <div className="flex items-start gap-2.5 mb-4 px-3 py-3" style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
            <AlertTriangle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', flexShrink: 0, marginTop: 1 }} />
            <p className="text-xs" style={{ color: 'var(--ef-danger)', lineHeight: 1.6 }}>
              This question will be soft-deleted. Existing grants that reference it will not be
              automatically updated — institutes and faculty may still see it in their snapshots.
            </p>
          </div>
          <p className="text-xs" style={{ color: 'var(--ef-text-subtle)', lineHeight: 1.6 }}>Are you sure you want to delete:</p>
          <p className="text-xs mt-1.5 italic break-words" style={{ color: 'var(--ef-text-muted)' }}>"{truncate(question.stem, 80)}"</p>
        </div>
        <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3 px-4 py-3.5 md:px-5 md:py-4" style={{ borderTop: '1px solid var(--ef-border)' }}>
          <button
            onClick={onConfirm}
            disabled={deleting}
            className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
            style={{ background: deleting ? 'var(--ef-track)' : 'var(--ef-danger)', color: 'var(--ef-surface)', borderRadius: 2, cursor: deleting ? 'not-allowed' : 'pointer' }}
          >
            {deleting ? <><Loader2 size={11} className="animate-spin" /> Deleting…</> : <><Trash2 size={11} /> Delete</>}
          </button>
          <button onClick={onCancel} disabled={deleting} className="text-xs px-4 py-2.5" style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Preview modal ─────────────────────────────────────────────────────────────

function PreviewModal({ question, onClose }: { question: Question; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-60 flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.28)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="w-full"
        style={{ maxWidth: 560, background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3.5 md:px-5 md:py-4" style={{ borderBottom: '1px solid var(--ef-border)' }}>
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>QUESTION PREVIEW</p>
          <button onClick={onClose} className="p-1 hover:opacity-60 transition-opacity" style={{ color: 'var(--ef-text-muted)' }}>
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        <div className="px-4 py-4 md:px-5 md:py-5 max-h-[70vh] overflow-y-auto">
          <QuestionPreview question={question} showAnswers showMeta showExplanation />
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Slide-over panel (Create / Edit) ──────────────────────────────────────────

function QuestionPanel({
  mode, question, onSave, onClose,
}: {
  mode: 'create' | 'edit';
  question: Partial<Question> | null;   // create may carry a seed (locked subject/topic)
  onSave: (draft: QuestionDraft) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <>
      <motion.div
        key="panel-backdrop"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-50"
        style={{ background: 'rgba(12,12,11,0.18)' }}
        onClick={onClose}
      />
      <motion.div
        key="panel-body"
        initial={{ x: 48, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 48, opacity: 0 }}
        transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
        className="fixed right-0 top-0 bottom-0 z-50 flex flex-col w-full sm:w-[500px] sm:max-w-full"
        style={{ background: 'var(--ef-surface)', borderLeft: '1px solid var(--ef-border)' }}
      >
        <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 sm:py-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--ef-border)' }}>
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
            {mode === 'create' ? 'NEW QUESTION' : 'EDIT QUESTION'}
          </p>
          <button onClick={onClose} className="p-1 transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}>
            <X size={15} strokeWidth={1.5} />
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          <QuestionTypeEngine initialData={question ?? undefined} onSave={onSave} onCancel={onClose} />
        </div>
      </motion.div>
    </>
  );
}

// ── Core ──────────────────────────────────────────────────────────────────────

export const QuestionBankCore = forwardRef<QuestionBankCoreHandle, QuestionBankCoreProps>(
  function QuestionBankCore({ lockSubjectId, lockTopicId, showAddButton, onChanged }, ref) {
    const locked = !!(lockSubjectId && lockTopicId);

    // Data
    const [questions, setQuestions] = useState<Question[]>([]);
    const [subjects,  setSubjects]  = useState<Subject[]>([]);
    const [topics,    setTopics]    = useState<Topic[]>([]);
    const [loading,   setLoading]   = useState(true);

    // Panel / modal state
    const [panelOpen,    setPanelOpen]    = useState(false);
    const [panelMode,    setPanelMode]    = useState<'create' | 'edit'>('create');
    const [editTarget,   setEditTarget]   = useState<Question | null>(null);
    const [previewQ,     setPreviewQ]     = useState<Question | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<Question | null>(null);
    const [deleting,     setDeleting]     = useState(false);

    // Filters — taxonomy seeded from the lock when scoped to a topic
    const [search,     setSearch]     = useState('');
    const [typeFilter, setTypeFilter] = useState('');
    const [diffFilter, setDiffFilter] = useState('');
    const [subjectId,  setSubjectId]  = useState(lockSubjectId ?? '');
    const [topicId,    setTopicId]    = useState(lockTopicId ?? '');

    const fetchAll = useCallback(async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const [qs, subjs, tops] = await Promise.all([getAllQuestions(), getAllSubjects(), getAllTopics()]);
        setQuestions(qs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        setSubjects(subjs);
        setTopics(tops);
      } finally {
        if (!silent) setLoading(false);
      }
    }, []);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    // Keep filters in sync if the locked topic changes (drilling between topics)
    useEffect(() => {
      if (locked) { setSubjectId(lockSubjectId ?? ''); setTopicId(lockTopicId ?? ''); }
    }, [locked, lockSubjectId, lockTopicId]);

    const openCreate = useCallback(() => { setEditTarget(null); setPanelMode('create'); setPanelOpen(true); }, []);
    const openEdit   = (q: Question) => { setEditTarget(q); setPanelMode('edit'); setPanelOpen(true); };

    useImperativeHandle(ref, () => ({ openCreate }), [openCreate]);

    const handleSave = async (draft: QuestionDraft) => {
      if (panelMode === 'create') {
        const saved = await createQuestion(draft);
        setQuestions((prev) => [saved, ...prev]);
      } else if (editTarget) {
        await updateQuestion(editTarget.id, draft);
        const updated = { ...editTarget, ...draft, updatedAt: new Date().toISOString() } as Question;
        setQuestions((prev) => prev.map((q) => (q.id === editTarget.id ? updated : q)));
      }
      setPanelOpen(false);
      setEditTarget(null);
      onChanged?.();
    };

    const handleDelete = async () => {
      if (!deleteTarget) return;
      setDeleting(true);
      try {
        await softDeleteQuestion(deleteTarget.id);
        setQuestions((prev) => prev.filter((q) => q.id !== deleteTarget.id));
        setDeleteTarget(null);
        onChanged?.();
      } finally {
        setDeleting(false);
      }
    };

    // Name → slug fallback so legacy questions (no subjectId yet) still match.
    const subjectNameToId = useMemo(
      () => new Map(subjects.map((s) => [s.name.trim().toLowerCase(), s.id])), [subjects]);
    const topicNameToId = useMemo(
      () => new Map(topics.map((t) => [`${t.subjectId}::${t.name.trim().toLowerCase()}`, t.id])), [topics]);

    const filtered = questions.filter((q) => {
      if (typeFilter) { const b = questionTypeBadge(q.engine, q.variant); if (b !== typeFilter) return false; }
      if (diffFilter && q.difficulty !== diffFilter) return false;

      if (subjectId) {
        const qSubjectId = q.subjectId ?? subjectNameToId.get((q.subject ?? '').trim().toLowerCase());
        if (qSubjectId !== subjectId) return false;
      }
      if (topicId) {
        const qTopicId = q.topicId ?? topicNameToId.get(`${subjectId}::${(q.topic ?? '').trim().toLowerCase()}`);
        if (qTopicId !== topicId) return false;
      }

      if (search) {
        const s = search.toLowerCase();
        if (!q.stem.toLowerCase().includes(s) && !q.subject.toLowerCase().includes(s) && !q.topic.toLowerCase().includes(s)) return false;
      }
      return true;
    });

    // Non-locked filters that the "Clear" affordance should reset.
    const hasClearableFilters = !!(search || typeFilter || diffFilter || (!locked && (subjectId || topicId)));
    const clearFilters = () => {
      setSearch(''); setTypeFilter(''); setDiffFilter('');
      if (!locked) { setSubjectId(''); setTopicId(''); }
    };

    // Seed for new questions when locked to a topic.
    const createSeed: Partial<Question> | null = locked
      ? {
          subjectId: lockSubjectId,
          topicId:   lockTopicId,
          subject:   subjects.find((s) => s.id === lockSubjectId)?.name ?? '',
          topic:     topics.find((t) => t.id === lockTopicId)?.name ?? '',
        }
      : null;

    return (
      <>
        {showAddButton && (
          <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>QUESTIONS</span>
            <button
              onClick={openCreate}
              className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity hover:opacity-80"
              style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, letterSpacing: '0.03em', minHeight: 36 }}
            >
              <Plus size={12} strokeWidth={2} /> Add Question
            </button>
          </div>
        )}

        <FilterBar
          search={search}         setSearch={setSearch}
          typeFilter={typeFilter} setTypeFilter={setTypeFilter}
          diffFilter={diffFilter} setDiffFilter={setDiffFilter}
          subjectId={subjectId}   setSubjectId={setSubjectId}
          topicId={topicId}       setTopicId={setTopicId}
          subjects={subjects}     topics={topics}
          hideTaxonomy={locked}
        />

        {/* Column headers (desktop) */}
        {!loading && filtered.length > 0 && (
          <div className="hidden md:flex items-center gap-4 px-5 py-2" style={{ background: 'var(--ef-canvas-raised)', borderBottom: '1px solid var(--ef-border-subtle)' }}>
            <div className="flex-shrink-0 w-10"><span className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>TYPE</span></div>
            <div className="flex-1"><span className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>QUESTION</span></div>
            <div className="flex-shrink-0 w-16"><span className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>DIFF.</span></div>
            <div className="flex-shrink-0 w-24 text-right"><span className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>CREATED</span></div>
            <div className="flex-shrink-0 w-20" />
          </div>
        )}

        {loading && <><SkeletonRow /><SkeletonRow /><SkeletonRow /></>}

        {!loading && filtered.map((q) => (
          <QuestionRow
            key={q.id} question={q}
            onPreview={() => setPreviewQ(q)}
            onEdit={() => openEdit(q)}
            onDelete={() => setDeleteTarget(q)}
          />
        ))}

        {!loading && filtered.length === 0 && <EmptyState filtered={hasClearableFilters} onAdd={openCreate} />}

        {!loading && filtered.length > 0 && (
          <div className="px-5 py-3 flex items-center justify-between" style={{ borderTop: '1px solid var(--ef-border-subtle)' }}>
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
              {filtered.length} {filtered.length === 1 ? 'question' : 'questions'}
              {hasClearableFilters && ' matching filters'}
            </span>
            {hasClearableFilters && (
              <button onClick={clearFilters} className="text-xs transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}>
                Clear filters
              </button>
            )}
          </div>
        )}

        {/* Slide-over panel */}
        <AnimatePresence>
          {panelOpen && (
            <QuestionPanel
              mode={panelMode}
              question={panelMode === 'edit' ? editTarget : createSeed}
              onSave={handleSave}
              onClose={() => { setPanelOpen(false); setEditTarget(null); }}
            />
          )}
        </AnimatePresence>

        {/* Preview modal */}
        <AnimatePresence>
          {previewQ && <PreviewModal question={previewQ} onClose={() => setPreviewQ(null)} />}
        </AnimatePresence>

        {/* Delete confirm modal */}
        <AnimatePresence>
          {deleteTarget && (
            <DeleteModal question={deleteTarget} onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)} deleting={deleting} />
          )}
        </AnimatePresence>
      </>
    );
  }
);
