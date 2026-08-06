import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Plus, X, Eye, Pencil, Trash2, Loader2, BookOpen,
  AlertTriangle, Search, Upload, Download,
} from 'lucide-react';
import {
  getQuestionsByOwner, getQuestionsByInstitute,
  createQuestionAsRole, editQuestionAsRole, deleteQuestionAsRole,
  questionTypeBadge, difficultyColor,
  type Question, type Difficulty,
} from '../../../lib/questionBankService';
import { getFacultyByInstitute } from '../../../lib/firebaseService';
import { getAllSubjects, type Subject } from '../../../lib/subjectService';
import { QuestionTypeEngine, type QuestionDraft } from '../../components/questions/QuestionTypeEngine';
import { QuestionPreview } from '../../components/questions/QuestionPreview';
import { SubjectManager } from '../../components/questions/SubjectManager';
import { BulkUploadModal } from '../../components/questions/BulkUploadModal';
import { ExportModal } from '../../components/questions/ExportModal';
import { useInstituteAuth } from '../../context/InstituteAuthContext';
import { Navigate } from 'react-router';

// ── Helpers ────────────────────────────────────────────────────────────────────

const truncate = (s: string, n = 100) => (s.length > n ? s.slice(0, n) + '…' : s);

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

// ── Badges ─────────────────────────────────────────────────────────────────────

function TypeBadgeChip({ engine, variant }: Pick<Question, 'engine' | 'variant'>) {
  const label = questionTypeBadge(engine, variant);
  return (
    <span
      className="text-xs px-1.5 py-0.5 select-none flex-shrink-0 inline-block"
      style={{
        background: 'var(--ef-ink)', color: 'var(--ef-surface)',
        borderRadius: 2, letterSpacing: '0.04em', fontSize: 10,
      }}
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

// ── Stat pill ──────────────────────────────────────────────────────────────────

function StatPill({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div
      className="flex items-center gap-3 px-5 py-4"
      style={{ border: '1px solid var(--ef-border)', borderRadius: 3, background: 'var(--ef-surface)' }}
    >
      <div
        className="flex items-center justify-center flex-shrink-0"
        style={{ width: 30, height: 30, borderRadius: 2, background: 'var(--ef-canvas)', border: '1px solid #EEECEA' }}
      >
        {icon}
      </div>
      <div>
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{label}</p>
        <p className="text-sm mt-0.5" style={{ color: 'var(--ef-ink)' }}>{value}</p>
      </div>
    </div>
  );
}

// ── Skeleton row ───────────────────────────────────────────────────────────────

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

// ── Tab bar ────────────────────────────────────────────────────────────────────

type Tab = 'pool' | 'subjects';

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'pool',     label: 'Question Pool' },
    { id: 'subjects', label: 'Subjects'      },
  ];
  return (
    <div className="flex gap-0" style={{ borderBottom: '1px solid var(--ef-border)' }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className="text-xs px-4 py-2.5 transition-all"
          style={{
            color: active === t.id ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
            borderBottom: active === t.id ? '2px solid var(--ef-ink)' : '2px solid transparent',
            letterSpacing: '0.02em',
            marginBottom: -1,
            background: 'transparent',
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Filter bar ─────────────────────────────────────────────────────────────────

const TYPE_FILTERS = [
  { label: 'All',   value: '' },
  { label: 'MCQ',   value: 'MCQ' },
  { label: 'Multi', value: 'Multi' },
  { label: 'T/F',   value: 'T/F' },
  { label: 'Fill',  value: 'Fill' },
  { label: 'Short', value: 'Short' },
  { label: 'Essay', value: 'Essay' },
  { label: 'Match', value: 'Match' },
];

const DIFF_FILTERS = [
  { label: 'All',    value: '' },
  { label: 'Easy',   value: 'easy' },
  { label: 'Medium', value: 'medium' },
  { label: 'Hard',   value: 'hard' },
];

interface FilterBarProps {
  search: string; setSearch: (v: string) => void;
  typeFilter: string; setTypeFilter: (v: string) => void;
  diffFilter: string; setDiffFilter: (v: string) => void;
}

function FilterBar({ search, setSearch, typeFilter, setTypeFilter, diffFilter, setDiffFilter }: FilterBarProps) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2 }}
      >
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

      <div className="flex items-center gap-4">
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

        <div style={{ width: 1, height: 20, background: 'var(--ef-border)', flexShrink: 0 }} />

        <div className="flex items-center gap-1.5">
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
    </div>
  );
}

// ── Question row ───────────────────────────────────────────────────────────────

function QuestionRow({
  question, authorLabel, canEdit, onPreview, onEdit, onDelete,
}: {
  question: Question;
  // 'Mine' for institute-authored, faculty name for faculty-authored
  // (institute-wide visibility). null suppresses the badge.
  authorLabel: string | null;
  // Whether the institute admin may edit/delete THIS question. Own questions:
  // yes. Faculty questions: not this phase (edit/delete are own-only; the
  // rules reject the write) — Phase 2 lights these up per granted rights.
  canEdit: boolean;
  onPreview: () => void;
  onEdit:    () => void;
  onDelete:  () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const mine = authorLabel === 'Mine';
  return (
    <div
      className="flex items-center gap-4 px-5 py-3.5 transition-colors"
      style={{ borderBottom: '1px solid var(--ef-border-subtle)', background: hovered ? 'var(--ef-canvas-raised)' : 'var(--ef-surface)' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex-shrink-0">
        <TypeBadgeChip engine={question.engine} variant={question.variant} />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-xs" style={{ color: 'var(--ef-ink)', lineHeight: 1.5 }}>
          {truncate(question.stem, 110) || <em style={{ color: 'var(--ef-text-muted)' }}>No stem</em>}
        </p>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {authorLabel && (
            <span
              className="text-xs px-1.5 py-0.5"
              style={{
                background: mine ? '#EEF2EE' : '#F3EFEA',
                color:      mine ? '#4A6B4A' : '#8A6D3B',
                borderRadius: 2, fontSize: 10, letterSpacing: '0.02em',
              }}
              title={mine ? 'Authored by you' : `Authored by ${authorLabel}`}
            >
              {mine ? 'Mine' : authorLabel}
            </span>
          )}
          {question.subject && (
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{question.subject}</span>
          )}
          {question.topic && (
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>· {question.topic}</span>
          )}
          {question.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="text-xs px-1.5 py-0.5"
              style={{ background: 'var(--ef-border-subtle)', borderRadius: 2, color: 'var(--ef-text-muted)', fontSize: 10 }}
            >
              #{tag}
            </span>
          ))}
        </div>
      </div>

      <div className="flex-shrink-0">
        <DiffChip difficulty={question.difficulty} />
      </div>

      <div className="flex-shrink-0 w-24 text-right">
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{formatDate(question.createdAt)}</span>
      </div>

      <div className="flex items-center gap-1 flex-shrink-0">
        <button onClick={onPreview} title="Preview" className="p-1.5 transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}>
          <Eye size={13} strokeWidth={1.5} />
        </button>
        {canEdit && (
          <>
            <button onClick={onEdit} title="Edit" className="p-1.5 transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}>
              <Pencil size={13} strokeWidth={1.5} />
            </button>
            <button onClick={onDelete} title="Delete" className="p-1.5 transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}>
              <Trash2 size={13} strokeWidth={1.5} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────────

function EmptyState({ filtered, onAdd }: { filtered: boolean; onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16" style={{ color: 'var(--ef-text-muted)' }}>
      <div style={{ width: 1, height: 32, background: 'linear-gradient(to bottom, transparent, var(--ef-border-muted))', marginBottom: 16 }} />
      <p className="text-xs" style={{ letterSpacing: '0.1em' }}>
        {filtered ? 'NO QUESTIONS MATCH' : 'NO QUESTIONS YET'}
      </p>
      {!filtered && (
        <button
          onClick={onAdd}
          className="mt-4 flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity hover:opacity-70"
          style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)', background: 'var(--ef-surface)' }}
        >
          <Plus size={12} strokeWidth={1.5} /> Add first question
        </button>
      )}
      <div style={{ width: 1, height: 32, background: 'linear-gradient(to top, transparent, var(--ef-border-muted))', marginTop: 16 }} />
    </div>
  );
}

// ── Delete confirm modal ───────────────────────────────────────────────────────

function DeleteModal({
  question, onConfirm, onCancel, deleting,
}: {
  question: Question; onConfirm: () => void; onCancel: () => void; deleting: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-60 flex items-center justify-center"
      style={{ background: 'rgba(12,12,11,0.28)' }}
      onClick={onCancel}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-sm"
        style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--ef-border)' }}>
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>DELETE QUESTION</p>
          <button onClick={onCancel} className="p-1 hover:opacity-60 transition-opacity" style={{ color: 'var(--ef-text-muted)' }}>
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        <div className="px-5 py-5">
          <div
            className="flex items-start gap-2.5 mb-4 px-3 py-3"
            style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}
          >
            <AlertTriangle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', flexShrink: 0, marginTop: 1 }} />
            <p className="text-xs" style={{ color: 'var(--ef-danger)', lineHeight: 1.6 }}>
              This question will be permanently removed from your question pool.
            </p>
          </div>
          <p className="text-xs" style={{ color: 'var(--ef-text-subtle)', lineHeight: 1.6 }}>Are you sure you want to delete:</p>
          <p className="text-xs mt-1.5 italic" style={{ color: 'var(--ef-text-muted)' }}>"{truncate(question.stem, 80)}"</p>
        </div>
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderTop: '1px solid var(--ef-border)' }}>
          <button
            onClick={onConfirm}
            disabled={deleting}
            className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
            style={{
              background: deleting ? 'var(--ef-track)' : 'var(--ef-danger)', color: 'var(--ef-surface)',
              borderRadius: 2, cursor: deleting ? 'not-allowed' : 'pointer',
            }}
          >
            {deleting
              ? <><Loader2 size={11} className="animate-spin" /> Deleting…</>
              : <><Trash2 size={11} /> Delete</>}
          </button>
          <button
            onClick={onCancel}
            disabled={deleting}
            className="text-xs px-4 py-2.5"
            style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}
          >
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Preview modal ──────────────────────────────────────────────────────────────

function PreviewModal({ question, onClose }: { question: Question; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-60 flex items-center justify-center"
      style={{ background: 'rgba(12,12,11,0.28)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="w-full"
        style={{ maxWidth: 560, background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--ef-border)' }}>
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>QUESTION PREVIEW</p>
          <button onClick={onClose} className="p-1 hover:opacity-60 transition-opacity" style={{ color: 'var(--ef-text-muted)' }}>
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        <div className="px-5 py-5 max-h-[70vh] overflow-y-auto">
          <QuestionPreview question={question} showAnswers showMeta showExplanation />
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Slide-over panel ───────────────────────────────────────────────────────────

function QuestionPanel({
  mode, question, instituteId, onSave, onClose,
}: {
  mode: 'create' | 'edit';
  question: Question | null;
  instituteId: string;
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
        className="fixed right-0 top-0 bottom-0 z-50 flex flex-col"
        style={{ width: 500, background: 'var(--ef-surface)', borderLeft: '1px solid var(--ef-border)' }}
      >
        <div
          className="flex items-center justify-between px-6 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--ef-border)' }}
        >
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
            {mode === 'create' ? 'NEW QUESTION' : 'EDIT QUESTION'}
          </p>
          <button onClick={onClose} className="p-1 transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}>
            <X size={15} strokeWidth={1.5} />
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          <QuestionTypeEngine
            initialData={question ?? undefined}
            ownerType="institute"
            ownerId={instituteId}
            instituteId={instituteId}
            onSave={onSave}
            onCancel={onClose}
          />
        </div>
      </motion.div>
    </>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export function InstituteQuestionsPage() {
  const { session } = useInstituteAuth();

  // Guard: redirect if permission was revoked mid-session
  if (!session) return <Navigate to="/institute/login" replace />;
  if (!session.canAdminCreateQuestions) return <Navigate to="/institute/dashboard" replace />;

  const instituteId = session.instituteId;

  // ── Data ──────────────────────────────────────────────────────────
  const [questions, setQuestions] = useState<Question[]>([]);
  const [subjects,  setSubjects]  = useState<Subject[]>([]);
  // facultyId → display name, for the author badge on faculty-authored
  // questions surfaced by institute-wide visibility.
  const [facultyNames, setFacultyNames] = useState<Record<string, string>>({});
  const [loading,   setLoading]   = useState(true);

  // ── UI state ───────���──────────────────────────────────────────────
  const [activeTab,      setActiveTab]      = useState<Tab>('pool');
  const [panelOpen,      setPanelOpen]      = useState(false);
  const [panelMode,      setPanelMode]      = useState<'create' | 'edit'>('create');
  const [editTarget,     setEditTarget]     = useState<Question | null>(null);
  const [previewQ,       setPreviewQ]       = useState<Question | null>(null);
  const [deleteTarget,   setDeleteTarget]   = useState<Question | null>(null);
  const [deleting,       setDeleting]       = useState(false);
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);
  const [exportOpen,     setExportOpen]     = useState(false);

  // ── Filters ───────────────────────────────────────────────────────
  const [search,     setSearch]     = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [diffFilter, setDiffFilter] = useState('');

  // ── Fetch ─────────────────────────────────────────────────────────
  const fetchAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [own, wide, subjs, faculty] = await Promise.all([
        // Own questions WITH answer keys (admin authors/edits these).
        getQuestionsByOwner('institute', instituteId),
        // Everything authored inside the institute — includes faculty
        // questions (public only; their keys stay owner-scoped). Phase-1
        // institute-wide visibility.
        getQuestionsByInstitute(instituteId),
        getAllSubjects(),
        getFacultyByInstitute(instituteId),
      ]);
      setFacultyNames(Object.fromEntries(faculty.map((f) => [f.id, f.name])));
      // Merge: own questions (keyed, editable) take precedence over their
      // public twin in the wide set; faculty questions come through as
      // public-only. De-dupe by id.
      const ownIds = new Set(own.map((q) => q.id));
      const merged = [...own, ...wide.filter((q) => !ownIds.has(q.id))];
      setQuestions(merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setSubjects(subjs);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [instituteId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── Save handler ──────────────────────────────────────────────────
  // Audit S-02. These three actions used to write straight to Firestore via
  // createQuestion / updateQuestion / softDeleteQuestion, which meant the
  // institute path skipped the question-rights ceiling entirely — an institute
  // whose ceiling says create is not allowed could still create. Phase 2A
  // moved the FACULTY page onto the *AsRole callables and this page was never
  // brought along, so the enforcement existed but only half the callers used
  // it. The callables apply the same ceiling check server-side and are now the
  // only write path, since the rules no longer accept these writes from
  // anyone but the webOwner.
  //
  // No request-mode branch here, unlike the faculty page: an institute admin
  // always resolves to direct mode (assertQuestionRight returns 'direct' for
  // admins and throws on requireMode 'request'), because request mode means
  // "ask the institute admin" and there is nobody above them to ask.
  const handleSave = async (draft: QuestionDraft) => {
    if (panelMode === 'create') {
      // Owner and tenant stamp are assigned SERVER-side from the caller's
      // verified claims; anything sent from here would be ignored.
      const { id } = await createQuestionAsRole(
        draft as Omit<Question, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'>,
      );
      const saved = {
        ...draft,
        id,
        ownerType: 'institute' as const,
        ownerId: instituteId,
        instituteId,
        isDeleted: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Question;
      setQuestions((prev) => [saved, ...prev]);
    } else if (editTarget) {
      await editQuestionAsRole(editTarget.id, draft as Partial<Question>, {
        prevSubjectId: editTarget.subjectId ?? null,
        prevTopicId:   editTarget.topicId ?? null,
      });
      const updated = { ...editTarget, ...draft, updatedAt: new Date().toISOString() } as Question;
      setQuestions((prev) => prev.map((q) => (q.id === editTarget.id ? updated : q)));
    }
    setPanelOpen(false);
    setEditTarget(null);
  };

  // ── Delete handler ────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteQuestionAsRole(deleteTarget.id, {
        subjectId: deleteTarget.subjectId ?? null,
        topicId:   deleteTarget.topicId ?? null,
      });
      setQuestions((prev) => prev.filter((q) => q.id !== deleteTarget.id));
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  // ── Open panel helpers ────────────────────────────────────────────
  const openCreate = () => { setEditTarget(null); setPanelMode('create'); setPanelOpen(true); };
  const openEdit   = (q: Question) => { setEditTarget(q); setPanelMode('edit'); setPanelOpen(true); };

  // ── Filter logic ──────────────────────────────────────────────────
  const filtered = questions.filter((q) => {
    if (typeFilter) { const b = questionTypeBadge(q.engine, q.variant); if (b !== typeFilter) return false; }
    if (diffFilter && q.difficulty !== diffFilter) return false;
    if (search) {
      const s = search.toLowerCase();
      if (
        !q.stem.toLowerCase().includes(s) &&
        !q.subject.toLowerCase().includes(s) &&
        !q.topic.toLowerCase().includes(s)
      ) return false;
    }
    return true;
  });

  const isFiltered = !!(search || typeFilter || diffFilter);

  // ── Render ────────────────────────────────────────────────────────
  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="px-8 py-10"
        style={{ maxWidth: 1120, margin: '0 auto' }}
      >
        {/* ── Page header ── */}
        <div
          className="flex items-start justify-between mb-8"
          style={{ borderBottom: '1px solid var(--ef-border)', paddingBottom: 20 }}
        >
          <div>
            <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>INSTITUTE ADMIN</p>
            <h1 className="text-base" style={{ color: 'var(--ef-ink)' }}>Questions</h1>
            <p className="text-xs mt-1" style={{ color: 'var(--ef-text-muted)' }}>
              Your institute's private question pool — visible only to {session.instituteName}.
            </p>
          </div>

          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={() => setExportOpen(true)}
              className="flex items-center gap-1.5 text-xs px-3 py-2.5 transition-opacity hover:opacity-80"
              style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-muted)', borderRadius: 2, background: 'var(--ef-surface)' }}
            >
              <Download size={12} strokeWidth={1.5} /> Export
            </button>

            <button
              onClick={() => setBulkUploadOpen(true)}
              className="flex items-center gap-1.5 text-xs px-3 py-2.5 transition-opacity hover:opacity-80"
              style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-muted)', borderRadius: 2, background: 'var(--ef-surface)' }}
            >
              <Upload size={12} strokeWidth={1.5} /> Bulk Upload
            </button>

            <button
              onClick={openCreate}
              className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity hover:opacity-80"
              style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, letterSpacing: '0.03em' }}
            >
              <Plus size={12} strokeWidth={2} /> Add Question
            </button>
          </div>
        </div>

        {/* ── Stat pills ── */}
        <div className="grid grid-cols-2 gap-3 mb-8" style={{ maxWidth: 480 }}>
          <StatPill
            icon={<BookOpen size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />}
            label="Total Questions"
            value={loading ? '…' : String(questions.length)}
          />
          <StatPill
            icon={<BookOpen size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />}
            label="Subjects"
            value={loading ? '…' : String(subjects.length)}
          />
        </div>

        {/* ── Tabs ── */}
        <TabBar active={activeTab} onChange={setActiveTab} />

        {/* ── Tab content ── */}
        <div style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderTop: 'none', borderRadius: '0 0 3px 3px' }}>

          {/* Pool tab */}
          {activeTab === 'pool' && (
            <>
              <FilterBar
                search={search} setSearch={setSearch}
                typeFilter={typeFilter} setTypeFilter={setTypeFilter}
                diffFilter={diffFilter} setDiffFilter={setDiffFilter}
              />

              {loading
                ? Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)
                : filtered.length === 0
                  ? <EmptyState filtered={isFiltered} onAdd={openCreate} />
                  : filtered.map((q) => {
                      const mine = q.ownerType === 'institute' && q.ownerId === instituteId;
                      const authorLabel = mine
                        ? 'Mine'
                        : (q.ownerType === 'faculty'
                            ? (facultyNames[q.ownerId ?? ''] ?? 'Faculty')
                            : null);
                      return (
                        <QuestionRow
                          key={q.id}
                          question={q}
                          authorLabel={authorLabel}
                          canEdit={mine}
                          onPreview={() => setPreviewQ(q)}
                          onEdit={() => openEdit(q)}
                          onDelete={() => setDeleteTarget(q)}
                        />
                      );
                    })
              }

              {/* Count footer */}
              {!loading && filtered.length > 0 && (
                <div
                  className="px-5 py-3 flex items-center justify-between"
                  style={{ borderTop: '1px solid var(--ef-border-subtle)' }}
                >
                  <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                    {isFiltered
                      ? `${filtered.length} of ${questions.length} question${questions.length !== 1 ? 's' : ''}`
                      : `${questions.length} question${questions.length !== 1 ? 's' : ''}`}
                  </p>
                </div>
              )}
            </>
          )}

          {/* Subjects tab */}
          {activeTab === 'subjects' && (
            <div className="px-6 py-6">
              <SubjectManager canMaintain={false} onSubjectsChange={(subjs) => setSubjects(subjs)} />
            </div>
          )}
        </div>
      </motion.div>

      {/* ── Modals & panels ── */}
      <AnimatePresence>
        {panelOpen && (
          <QuestionPanel
            mode={panelMode}
            question={editTarget}
            instituteId={instituteId}
            onSave={handleSave}
            onClose={() => { setPanelOpen(false); setEditTarget(null); }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {previewQ && <PreviewModal question={previewQ} onClose={() => setPreviewQ(null)} />}
      </AnimatePresence>

      <AnimatePresence>
        {deleteTarget && (
          <DeleteModal
            question={deleteTarget}
            onConfirm={handleDelete}
            onCancel={() => setDeleteTarget(null)}
            deleting={deleting}
          />
        )}
      </AnimatePresence>

      {bulkUploadOpen && (
        <BulkUploadModal
          onClose={() => setBulkUploadOpen(false)}
          onComplete={() => { setBulkUploadOpen(false); fetchAll(true); }}
          ownerType="institute"
          ownerId={instituteId}
          instituteId={instituteId}
        />
      )}

      {exportOpen && (
        <ExportModal
          questions={questions}
          subjects={subjects}
          onClose={() => setExportOpen(false)}
        />
      )}
    </>
  );
}