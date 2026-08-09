import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Search, Check, BookOpen, AlignLeft, Shuffle, ChevronDown, Code2 } from 'lucide-react';
import type { Question, QuestionEngine, Difficulty } from '../../../lib/questionBankService';
import type { AssessmentQuestion } from '../../../lib/assessmentService';

// ── helpers ───────────────────────────────────────────────────────

function truncateStem(s: string, n = 120) {
  const stripped = s.replace(/\$\$?[^$]*\$\$?/g, '[math]').replace(/<[^>]*>/g, '');
  return stripped.length > n ? stripped.slice(0, n) + '…' : stripped;
}

// ── Engine badge ──────────────────────────────────────────────────

const ENGINE_META: Record<QuestionEngine, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  mcq: {
    label: 'MCQ',
    color: '#2563A8',
    bg: '#EFF5FD',
    icon: <Check size={9} strokeWidth={2} />,
  },
  text: {
    label: 'TEXT',
    color: '#7C4D00',
    bg: '#FDF4E7',
    icon: <AlignLeft size={9} strokeWidth={2} />,
  },
  match: {
    label: 'MATCH',
    color: '#4A1D96',
    bg: '#F5F0FF',
    icon: <Shuffle size={9} strokeWidth={2} />,
  },
  code: {
    label: 'CODE',
    color: '#0F5132',
    bg: '#EAF6EF',
    icon: <Code2 size={9} strokeWidth={2} />,
  },
};

const DIFFICULTY_META: Record<Difficulty, { label: string; color: string }> = {
  easy: { label: 'Easy', color: 'var(--ef-success-strong)' },
  medium: { label: 'Medium', color: '#8B5A00' },
  hard: { label: 'Hard', color: 'var(--ef-danger)' },
};

function EngineBadge({ engine }: { engine: QuestionEngine }) {
  const m = ENGINE_META[engine];
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 select-none"
      style={{
        background: m.bg,
        color: m.color,
        border: `1px solid ${m.color}22`,
        borderRadius: 2,
        fontSize: 9,
        letterSpacing: '0.06em',
      }}
    >
      {m.icon}
      {m.label}
    </span>
  );
}

// ── Question row ──────────────────────────────────────────────────

function QuestionRow({
  question,
  selected,
  marks,
  onToggle,
  onMarksChange,
}: {
  question: Question;
  selected: boolean;
  marks: string;
  onToggle: () => void;
  onMarksChange: (v: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const diff = DIFFICULTY_META[question.difficulty];

  return (
    <div
      className="flex items-start gap-3 px-4 py-3 transition-colors"
      style={{
        borderBottom: '1px solid var(--ef-border-subtle)',
        background: selected ? 'var(--ef-canvas-raised)' : hovered ? '#FDFCFB' : 'var(--ef-surface)',
        cursor: 'pointer',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onToggle}
    >
      {/* Checkbox */}
      <div
        className="flex-shrink-0 flex items-center justify-center transition-all"
        style={{
          width: 16,
          height: 16,
          borderRadius: 2,
          marginTop: 1,
          background: selected ? 'var(--ef-ink)' : 'var(--ef-surface)',
          border: selected ? '1px solid var(--ef-ink)' : '1px solid var(--ef-text-muted)',
        }}
      >
        {selected && <Check size={9} strokeWidth={2.5} style={{ color: 'var(--ef-surface)' }} />}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-xs leading-relaxed" style={{ color: 'var(--ef-ink)' }}>
          {truncateStem(question.stem) || <em style={{ color: 'var(--ef-text-muted)' }}>No question text</em>}
        </p>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <EngineBadge engine={question.engine} />
          {question.variant && (
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>
              {question.variant}
            </span>
          )}
          <span className="text-xs" style={{ color: diff.color, fontSize: 10 }}>
            {diff.label}
          </span>
          {question.subject && (
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>
              {question.subject}
            </span>
          )}
          {question.topic && (
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>
              · {question.topic}
            </span>
          )}
        </div>
      </div>

      {/* Marks input (only when selected) */}
      <AnimatePresence>
        {selected && (
          <motion.div
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: 64 }}
            exit={{ opacity: 0, width: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="flex-shrink-0 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-end gap-0.5">
              <label style={{ color: 'var(--ef-text-muted)', fontSize: 9, letterSpacing: '0.06em' }}>MARKS</label>
              <input
                type="number"
                min="0.5"
                step="0.5"
                value={marks}
                onChange={(e) => onMarksChange(e.target.value)}
                className="text-xs px-2 py-1 outline-none text-center"
                style={{
                  width: 56,
                  border: '1px solid var(--ef-border)',
                  borderRadius: 2,
                  color: 'var(--ef-ink)',
                  background: 'var(--ef-surface)',
                }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Filter chip ───────────────────────────────────────────────────

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="text-xs px-2.5 py-1 transition-all"
      style={{
        borderRadius: 2,
        border: active ? '1px solid var(--ef-ink)' : '1px solid var(--ef-border)',
        background: active ? 'var(--ef-ink)' : 'var(--ef-canvas-raised)',
        color: active ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
      }}
    >
      {label}
    </button>
  );
}

// ── Main modal ────────────────────────────────────────────────────

interface QuestionPickerModalProps {
  questions: Question[];
  alreadySelected: string[];      // question IDs already in the assessment
  onConfirm: (picked: AssessmentQuestion[]) => void;
  onClose: () => void;
}

export function QuestionPickerModal({
  questions,
  alreadySelected,
  onConfirm,
  onClose,
}: QuestionPickerModalProps) {
  const [search, setSearch] = useState('');
  const [engineFilter, setEngineFilter] = useState<QuestionEngine | ''>('');
  const [diffFilter, setDiffFilter] = useState<Difficulty | ''>('');
  const [subjectFilter, setSubjectFilter] = useState('');
  const [showSubjectMenu, setShowSubjectMenu] = useState(false);

  // Selection state: { questionId → marks string }
  const [selected, setSelected] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    alreadySelected.forEach((id) => { init[id] = '1'; });
    return init;
  });

  // Collect unique subjects from questions
  const allSubjects = useMemo(() => {
    const s = new Set<string>();
    questions.forEach((q) => { if (q.subject) s.add(q.subject); });
    return Array.from(s).sort();
  }, [questions]);

  // Filtered list
  const filtered = useMemo(() => {
    return questions
      .filter((q) => !q.isDeleted)
      .filter((q) => !engineFilter || q.engine === engineFilter)
      .filter((q) => !diffFilter || q.difficulty === diffFilter)
      .filter((q) => !subjectFilter || q.subject === subjectFilter)
      .filter((q) => {
        if (!search.trim()) return true;
        const s = search.toLowerCase();
        return (
          q.stem.toLowerCase().includes(s) ||
          (q.subject || '').toLowerCase().includes(s) ||
          (q.topic || '').toLowerCase().includes(s) ||
          q.tags.some((t) => t.toLowerCase().includes(s))
        );
      });
  }, [questions, engineFilter, diffFilter, subjectFilter, search]);

  const selectedIds = Object.keys(selected);
  const newlySelectedCount = selectedIds.filter((id) => !alreadySelected.includes(id)).length;

  const handleToggle = (q: Question) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[q.id] !== undefined) {
        delete next[q.id];
      } else {
        next[q.id] = '1';
      }
      return next;
    });
  };

  const handleConfirm = () => {
    const picked: AssessmentQuestion[] = selectedIds
      .filter((id) => !alreadySelected.includes(id))
      .map((id, idx) => ({
        questionId: id,
        marks: parseFloat(selected[id]) || 1,
        order: alreadySelected.length + idx,
      }));
    onConfirm(picked);
  };

  const clearFilters = () => {
    setSearch('');
    setEngineFilter('');
    setDiffFilter('');
    setSubjectFilter('');
  };

  const hasFilters = !!(search || engineFilter || diffFilter || subjectFilter);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.35)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.97, opacity: 0, y: 8 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className="w-full flex flex-col"
        style={{
          maxWidth: 680,
          maxHeight: '82vh',
          background: 'var(--ef-surface)',
          border: '1px solid var(--ef-border)',
          borderRadius: 3,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div
          className="flex items-center justify-between px-4 sm:px-5 py-3.5 sm:py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--ef-border)' }}
        >
          <div className="flex items-center gap-3">
            <BookOpen size={14} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
            <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
              BROWSE QUESTION BANK
            </p>
          </div>
          <div className="flex items-center gap-3">
            {selectedIds.length > 0 && (
              <span
                className="text-xs px-2 py-0.5"
                style={{
                  background: 'var(--ef-success-bg)',
                  color: 'var(--ef-success-strong)',
                  border: '1px solid var(--ef-success-border)',
                  borderRadius: 2,
                }}
              >
                {selectedIds.length} selected
              </span>
            )}
            <button
              onClick={onClose}
              className="p-1 transition-opacity hover:opacity-60"
              style={{ color: 'var(--ef-text-muted)' }}
            >
              <X size={14} strokeWidth={1.5} />
            </button>
          </div>
        </div>

        {/* ── Filters ── */}
        <div
          className="px-5 py-3 flex-shrink-0 space-y-2.5"
          style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}
        >
          {/* Search */}
          <div
            className="flex items-center gap-2 px-3 py-2"
            style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2 }}
          >
            <Search size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by stem, subject, topic, or tag…"
              className="flex-1 text-xs outline-none"
              style={{ background: 'transparent', color: 'var(--ef-ink)', fontSize: 12 }}
            />
            {search && (
              <button onClick={() => setSearch('')} className="hover:opacity-60 transition-opacity">
                <X size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
              </button>
            )}
          </div>

          {/* Filter row */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)', fontSize: 10, letterSpacing: '0.05em' }}>
              TYPE:
            </span>
            <FilterChip label="All" active={!engineFilter} onClick={() => setEngineFilter('')} />
            <FilterChip label="MCQ" active={engineFilter === 'mcq'} onClick={() => setEngineFilter(engineFilter === 'mcq' ? '' : 'mcq')} />
            <FilterChip label="Text" active={engineFilter === 'text'} onClick={() => setEngineFilter(engineFilter === 'text' ? '' : 'text')} />
            <FilterChip label="Match" active={engineFilter === 'match'} onClick={() => setEngineFilter(engineFilter === 'match' ? '' : 'match')} />
            {/* The chips are a hand-written list beside a `QuestionEngine`
                union that has four members, so `code` was simply never added.
                Coding questions did appear under "All" and carried a CODE
                badge, but the one filter that would find them in a large bank
                did not offer them. */}
            <FilterChip label="Code" active={engineFilter === 'code'} onClick={() => setEngineFilter(engineFilter === 'code' ? '' : 'code')} />

            <span className="text-xs ml-2" style={{ color: 'var(--ef-text-muted)', fontSize: 10, letterSpacing: '0.05em' }}>
              DIFF:
            </span>
            <FilterChip label="Easy" active={diffFilter === 'easy'} onClick={() => setDiffFilter(diffFilter === 'easy' ? '' : 'easy')} />
            <FilterChip label="Medium" active={diffFilter === 'medium'} onClick={() => setDiffFilter(diffFilter === 'medium' ? '' : 'medium')} />
            <FilterChip label="Hard" active={diffFilter === 'hard'} onClick={() => setDiffFilter(diffFilter === 'hard' ? '' : 'hard')} />

            {/* Subject dropdown */}
            {allSubjects.length > 0 && (
              <div className="relative ml-2">
                <button
                  onClick={() => setShowSubjectMenu((v) => !v)}
                  className="flex items-center gap-1 text-xs px-2.5 py-1 transition-all"
                  style={{
                    borderRadius: 2,
                    border: subjectFilter ? '1px solid var(--ef-ink)' : '1px solid var(--ef-border)',
                    background: subjectFilter ? 'var(--ef-ink)' : 'var(--ef-canvas-raised)',
                    color: subjectFilter ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
                  }}
                >
                  {subjectFilter || 'Subject'}
                  <ChevronDown size={10} strokeWidth={1.5} />
                </button>
                <AnimatePresence>
                  {showSubjectMenu && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.14 }}
                      className="absolute top-full left-0 mt-1 z-10 py-1"
                      style={{
                        background: 'var(--ef-surface)',
                        border: '1px solid var(--ef-border)',
                        borderRadius: 2,
                        minWidth: 160,
                        maxHeight: 200,
                        overflowY: 'auto',
                        boxShadow: '0 4px 12px rgba(12,12,11,0.08)',
                      }}
                    >
                      <button
                        onClick={() => { setSubjectFilter(''); setShowSubjectMenu(false); }}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 transition-colors"
                        style={{ color: 'var(--ef-text-muted)' }}
                      >
                        All Subjects
                      </button>
                      {allSubjects.map((s) => (
                        <button
                          key={s}
                          onClick={() => { setSubjectFilter(s); setShowSubjectMenu(false); }}
                          className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 transition-colors"
                          style={{ color: subjectFilter === s ? 'var(--ef-ink)' : 'var(--ef-text-muted)' }}
                        >
                          {s}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {hasFilters && (
              <button
                onClick={clearFilters}
                className="ml-auto text-xs transition-opacity hover:opacity-60"
                style={{ color: 'var(--ef-text-muted)' }}
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* ── Question list ── */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12" style={{ color: 'var(--ef-text-muted)' }}>
              <div style={{ width: 1, height: 24, background: 'linear-gradient(to bottom, transparent, var(--ef-border-muted))', marginBottom: 12 }} />
              <p className="text-xs" style={{ letterSpacing: '0.1em' }}>
                {hasFilters ? 'NO QUESTIONS MATCH' : 'NO QUESTIONS IN BANK'}
              </p>
              <div style={{ width: 1, height: 24, background: 'linear-gradient(to top, transparent, var(--ef-border-muted))', marginTop: 12 }} />
            </div>
          ) : (
            <>
              <div
                className="sticky top-0 px-4 py-2 flex items-center justify-between"
                style={{ background: 'var(--ef-canvas-raised)', borderBottom: '1px solid var(--ef-border-subtle)', zIndex: 2 }}
              >
                <span className="text-xs" style={{ color: 'var(--ef-text-muted)', fontSize: 10, letterSpacing: '0.08em' }}>
                  {filtered.length} QUESTION{filtered.length !== 1 ? 'S' : ''}{hasFilters ? ' MATCHING' : ''}
                </span>
                <button
                  onClick={() => {
                    // Select all visible
                    const visibleIds = filtered.map((q) => q.id);
                    const allSelected = visibleIds.every((id) => selected[id] !== undefined);
                    if (allSelected) {
                      setSelected((prev) => {
                        const next = { ...prev };
                        visibleIds.forEach((id) => delete next[id]);
                        return next;
                      });
                    } else {
                      setSelected((prev) => {
                        const next = { ...prev };
                        visibleIds.forEach((id) => { if (!next[id]) next[id] = '1'; });
                        return next;
                      });
                    }
                  }}
                  className="text-xs transition-opacity hover:opacity-60"
                  style={{ color: 'var(--ef-text-muted)' }}
                >
                  {filtered.every((q) => selected[q.id] !== undefined) ? 'Deselect all' : 'Select all'}
                </button>
              </div>

              {filtered.map((q) => (
                <QuestionRow
                  key={q.id}
                  question={q}
                  selected={selected[q.id] !== undefined}
                  marks={selected[q.id] ?? '1'}
                  onToggle={() => handleToggle(q)}
                  onMarksChange={(v) =>
                    setSelected((prev) => ({ ...prev, [q.id]: v }))
                  }
                />
              ))}
            </>
          )}
        </div>

        {/* ── Footer ── */}
        <div
          className="flex items-center justify-between px-4 sm:px-5 py-3.5 sm:py-4 flex-shrink-0"
          style={{ borderTop: '1px solid var(--ef-border)' }}
        >
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
            {newlySelectedCount > 0
              ? `${newlySelectedCount} question${newlySelectedCount !== 1 ? 's' : ''} will be added`
              : selectedIds.length === 0
              ? 'Select questions to add'
              : 'No new questions selected'}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="text-xs px-4 py-2.5 transition-opacity hover:opacity-70"
              style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)' }}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={newlySelectedCount === 0}
              className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
              style={{
                background: newlySelectedCount === 0 ? 'var(--ef-track)' : 'var(--ef-ink)',
                color: 'var(--ef-surface)',
                borderRadius: 2,
                cursor: newlySelectedCount === 0 ? 'not-allowed' : 'pointer',
              }}
            >
              <Check size={11} strokeWidth={2} />
              Add {newlySelectedCount > 0 ? newlySelectedCount : ''} Question{newlySelectedCount !== 1 ? 's' : ''}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
