import React, { useState, useMemo } from 'react';
import { motion } from 'motion/react';
import {
  X, Download, FileDown, FileJson, Filter,
  CheckCircle2, Loader2,
} from 'lucide-react';
import { type Question, type Difficulty, difficultyColor, questionTypeBadge } from '../../../lib/questionBankService';
import { type Subject } from '../../../lib/subjectService';

// ── Types ─────────────────────────────────────────────────────────────────────

type ExportFormat = 'xlsx' | 'json';

interface ExportFilters {
  subjects:    string[];   // canonical subject names; [] = all
  difficulties: Difficulty[]; // [] = all
  engines:     string[];   // 'mcq' | 'text' | 'match'; [] = all
  tags:        string[];   // any-match; [] = all
  dateFrom:    string;     // ISO or ''
  dateTo:      string;     // ISO or ''
}

// ── Pill toggle button ────────────────────────────────────────────────────────

function PillToggle({
  label, active, onClick, color,
}: {
  label: string; active: boolean; onClick: () => void;
  color?: { bg: string; text: string; border: string };
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs px-2.5 py-1 transition-all"
      style={{
        borderRadius: 2,
        border: active
          ? `1px solid ${color?.border ?? '#0C0C0B'}`
          : '1px solid #E3E1DB',
        background: active ? (color?.bg ?? '#0C0C0B') : '#FAFAF8',
        color: active ? (color?.text ?? '#FFFFFF') : '#6B6B66',
      }}
    >
      {label}
    </button>
  );
}

// ── Subject multi-select ──────────────────────────────────────────────────────

function SubjectMultiSelect({
  subjects, selected, onChange,
}: {
  subjects: Subject[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const toggle = (name: string) =>
    onChange(selected.includes(name) ? selected.filter((s) => s !== name) : [...selected, name]);

  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        type="button"
        onClick={() => onChange([])}
        className="text-xs px-2.5 py-1 transition-all"
        style={{
          borderRadius: 2,
          border: selected.length === 0 ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
          background: selected.length === 0 ? '#0C0C0B' : '#FAFAF8',
          color: selected.length === 0 ? '#FFFFFF' : '#6B6B66',
        }}
      >
        All
      </button>
      {subjects.map((s) => {
        const isActive = selected.includes(s.name);
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => toggle(s.name)}
            className="text-xs px-2.5 py-1 transition-all flex items-center gap-1.5"
            style={{
              borderRadius: 2,
              border: isActive ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
              background: isActive ? '#0C0C0B' : '#FAFAF8',
              color: isActive ? '#FFFFFF' : '#6B6B66',
            }}
          >
            {s.name}
            {s.questionCount > 0 && (
              <span style={{ opacity: 0.6, fontSize: 10 }}>{s.questionCount}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Tag input filter ──────────────────────────────────────────────────────────

function TagFilterInput({
  tags, onChange,
}: { tags: string[]; onChange: (t: string[]) => void }) {
  const [input, setInput] = useState('');

  const commit = (raw: string) => {
    const t = raw.trim().toLowerCase();
    if (!t || tags.includes(t)) { setInput(''); return; }
    onChange([...tags, t]);
    setInput('');
  };

  return (
    <div
      className="flex flex-wrap gap-1.5 items-center p-2 min-h-9"
      style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FAFAF8' }}
    >
      {tags.map((tag) => (
        <span key={tag} className="flex items-center gap-1 px-2 py-0.5 text-xs select-none" style={{ background: '#F0EFEB', borderRadius: 2, color: '#4A4A45' }}>
          #{tag}
          <button type="button" onClick={() => onChange(tags.filter((t) => t !== tag))} className="hover:opacity-60 transition-opacity">
            <X size={9} strokeWidth={2} />
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(input); } }}
        onBlur={() => { if (input.trim()) commit(input); }}
        placeholder={tags.length === 0 ? 'Filter by tags (Enter to add)…' : ''}
        className="flex-1 text-xs outline-none min-w-20"
        style={{ background: 'transparent', color: '#0C0C0B', fontSize: 13 }}
      />
    </div>
  );
}

// ── XLSX export ───────────────────────────────────────────────────────────────

// Lazy xlsx (Remediation plan Batch E / ext #19): the ~142 KB gzip sheet
// library loads on first actual use (template download / file parse /
// export), not with the page chunk that happens to render this component.
type XlsxModule = typeof import('xlsx');
let xlsxPromise: Promise<XlsxModule> | null = null;
const loadXlsx = () => (xlsxPromise ??= import('xlsx'));

async function questionsToXLSX(questions: Question[]): Promise<void> {
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();

  const mcq   = questions.filter((q) => q.engine === 'mcq');
  const text  = questions.filter((q) => q.engine === 'text');
  const match = questions.filter((q) => q.engine === 'match');

  // ── MCQ sheet ──────────────────────────────────────────────────
  if (mcq.length > 0) {
    const rows = mcq.map((q) => {
      const letters = 'abcde'.split('');
      const optMap: Record<string, string> = {};
      const imgMap: Record<string, string> = {};
      q.options.forEach((o, i) => {
        if (i < 5) {
          optMap[`option_${letters[i]}`] = o.text;
          if (o.image) imgMap[`option_${letters[i]}_image_url`] = o.image;
        }
      });

      const correctLetters = q.correctIds.map((cid) => {
        const idx = q.options.findIndex((o) => o.id === cid);
        return idx >= 0 ? letters[idx].toUpperCase() : '';
      }).filter(Boolean).join(',');

      return {
        type: q.variant,
        stem: q.stem,
        ...optMap,
        correct: correctLetters,
        subject: q.subject,
        topic: q.topic,
        tags: q.tags.join(', '),
        difficulty: q.difficulty,
        explanation: q.explanation,
        stem_image_url: q.stemImage ?? '',
        ...imgMap,
      };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'MCQ');
  }

  // ── Text sheet ─────────────────────────────────────────────────
  if (text.length > 0) {
    const rows = text.map((q) => ({
      type: q.variant,
      stem: q.stem,
      model_answer: q.modelAnswer,
      subject: q.subject,
      topic: q.topic,
      tags: q.tags.join(', '),
      difficulty: q.difficulty,
      explanation: q.explanation,
      stem_image_url: q.stemImage ?? '',
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Text');
  }

  // ── Match sheet ────────────────────────────────────────────────
  if (match.length > 0) {
    const rows = match.map((q) => {
      const pairCols: Record<string, string> = {};
      q.pairs.forEach((p, i) => {
        pairCols[`pair${i + 1}_a`] = p.leftText;
        pairCols[`pair${i + 1}_b`] = p.rightText;
      });
      return {
        stem: q.stem,
        ...pairCols,
        subject: q.subject,
        topic: q.topic,
        tags: q.tags.join(', '),
        difficulty: q.difficulty,
        explanation: q.explanation,
        stem_image_url: q.stemImage ?? '',
      };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Match');
  }

  const ts = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `STRATUM_Questions_${ts}.xlsx`);
}

// ── JSON export ───────────────────────────────────────────────────────────────

function questionsToJSON(questions: Question[], filters: ExportFilters): void {
  const payload = {
    exportedAt: new Date().toISOString(),
    filters,
    count: questions.length,
    questions,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `STRATUM_Questions_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface ExportModalProps {
  questions: Question[];
  subjects:  Subject[];
  onClose:   () => void;
}

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];
const ENGINES = [
  { value: 'mcq',   label: 'MCQ'   },
  { value: 'text',  label: 'Text'  },
  { value: 'match', label: 'Match' },
];

export function ExportModal({ questions, subjects, onClose }: ExportModalProps) {
  const [format,   setFormat]   = useState<ExportFormat>('xlsx');
  const [exporting, setExporting] = useState(false);
  const [done,     setDone]     = useState(false);

  const [filters, setFilters] = useState<ExportFilters>({
    subjects:     [],
    difficulties: [],
    engines:      [],
    tags:         [],
    dateFrom:     '',
    dateTo:       '',
  });

  const inp: React.CSSProperties = {
    background: '#FAFAF8', border: '1px solid #E3E1DB', color: '#0C0C0B',
    borderRadius: 2, outline: 'none', fontSize: 12, padding: '7px 10px', width: '100%',
  };

  // Live-filtered count
  const filtered = useMemo(() => {
    return questions.filter((q) => {
      if (filters.subjects.length > 0 && !filters.subjects.includes(q.subject)) return false;
      if (filters.difficulties.length > 0 && !filters.difficulties.includes(q.difficulty)) return false;
      if (filters.engines.length > 0 && !filters.engines.includes(q.engine)) return false;
      if (filters.tags.length > 0) {
        const has = filters.tags.some((t) => q.tags.includes(t));
        if (!has) return false;
      }
      if (filters.dateFrom) {
        if (q.createdAt < filters.dateFrom) return false;
      }
      if (filters.dateTo) {
        if (q.createdAt > filters.dateTo + 'T23:59:59Z') return false;
      }
      return true;
    });
  }, [questions, filters]);

  const toggleDiff = (d: Difficulty) =>
    setFilters((f) => ({
      ...f,
      difficulties: f.difficulties.includes(d) ? f.difficulties.filter((x) => x !== d) : [...f.difficulties, d],
    }));

  const toggleEngine = (e: string) =>
    setFilters((f) => ({
      ...f,
      engines: f.engines.includes(e) ? f.engines.filter((x) => x !== e) : [...f.engines, e],
    }));

  const handleExport = async () => {
    setExporting(true);
    try {
      await new Promise((r) => setTimeout(r, 100)); // let UI update
      if (format === 'xlsx') questionsToXLSX(filtered);
      else questionsToJSON(filtered, filters);
      setDone(true);
      setTimeout(onClose, 1800);
    } finally {
      setExporting(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.28)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="w-full flex flex-col"
        style={{ maxWidth: 560, maxHeight: '90vh', background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 sm:py-4 flex-shrink-0" style={{ borderBottom: '1px solid #E3E1DB' }}>
          <div>
            <p className="text-xs" style={{ color: '#6B6B66', letterSpacing: '0.1em' }}>QUESTION POOL</p>
            <p className="text-sm mt-0.5" style={{ color: '#0C0C0B' }}>Export Questions</p>
          </div>
          <button onClick={onClose} className="p-1 hover:opacity-60 transition-opacity" style={{ color: '#6B6B66' }}>
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>

        {/* Filters */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {done ? (
            <div className="flex flex-col items-center py-12">
              <div className="flex items-center justify-center mb-4" style={{ width: 44, height: 44, borderRadius: '50%', background: '#F0FBF4', border: '1px solid #C3E8CE' }}>
                <CheckCircle2 size={20} strokeWidth={1.5} style={{ color: '#2A6B3A' }} />
              </div>
              <p className="text-sm mb-1" style={{ color: '#0C0C0B' }}>Export ready</p>
              <p className="text-xs" style={{ color: '#2A6B3A' }}>{filtered.length} questions exported.</p>
            </div>
          ) : (
            <>
              {/* Subject */}
              <div className="mb-5">
                <label className="block text-xs mb-2" style={{ color: '#4A4A45' }}>
                  Subject <span style={{ color: '#6B6B66' }}>(all if none selected)</span>
                </label>
                <SubjectMultiSelect
                  subjects={subjects}
                  selected={filters.subjects}
                  onChange={(v) => setFilters((f) => ({ ...f, subjects: v }))}
                />
              </div>

              {/* Difficulty */}
              <div className="mb-5">
                <label className="block text-xs mb-2" style={{ color: '#4A4A45' }}>
                  Difficulty <span style={{ color: '#6B6B66' }}>(all if none selected)</span>
                </label>
                <div className="flex gap-2">
                  {DIFFICULTIES.map((d) => (
                    <PillToggle
                      key={d} label={d.charAt(0).toUpperCase() + d.slice(1)}
                      active={filters.difficulties.includes(d)}
                      onClick={() => toggleDiff(d)}
                      color={difficultyColor(d)}
                    />
                  ))}
                </div>
              </div>

              {/* Engine */}
              <div className="mb-5">
                <label className="block text-xs mb-2" style={{ color: '#4A4A45' }}>
                  Question type <span style={{ color: '#6B6B66' }}>(all if none selected)</span>
                </label>
                <div className="flex gap-2">
                  {ENGINES.map((e) => (
                    <PillToggle
                      key={e.value} label={e.label}
                      active={filters.engines.includes(e.value)}
                      onClick={() => toggleEngine(e.value)}
                    />
                  ))}
                </div>
              </div>

              {/* Tags */}
              <div className="mb-5">
                <label className="block text-xs mb-2" style={{ color: '#4A4A45' }}>
                  Tags <span style={{ color: '#6B6B66' }}>(any match — blank = all)</span>
                </label>
                <TagFilterInput
                  tags={filters.tags}
                  onChange={(v) => setFilters((f) => ({ ...f, tags: v }))}
                />
              </div>

              {/* Date range */}
              <div className="mb-5">
                <label className="block text-xs mb-2" style={{ color: '#4A4A45' }}>Date created</label>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs mb-1" style={{ color: '#6B6B66' }}>From</p>
                    <input
                      type="date"
                      value={filters.dateFrom}
                      onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
                      style={inp}
                    />
                  </div>
                  <div>
                    <p className="text-xs mb-1" style={{ color: '#6B6B66' }}>To</p>
                    <input
                      type="date"
                      value={filters.dateTo}
                      onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
                      style={inp}
                    />
                  </div>
                </div>
              </div>

              {/* Format */}
              <div className="mb-5">
                <label className="block text-xs mb-2" style={{ color: '#4A4A45' }}>Export format</label>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { v: 'xlsx' as ExportFormat, label: 'XLSX Spreadsheet', sub: 'Re-importable — 3 sheets (MCQ, Text, Match)', icon: <FileDown size={14} strokeWidth={1.5} /> },
                    { v: 'json' as ExportFormat, label: 'JSON',             sub: 'Full question objects — for developers',       icon: <FileJson size={14} strokeWidth={1.5} /> },
                  ].map((f) => (
                    <button
                      key={f.v}
                      type="button"
                      onClick={() => setFormat(f.v)}
                      className="flex items-start gap-3 p-3 text-left transition-all"
                      style={{
                        border: format === f.v ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
                        borderRadius: 2,
                        background: format === f.v ? '#F7F6F3' : '#FFFFFF',
                      }}
                    >
                      <span style={{ color: format === f.v ? '#0C0C0B' : '#6B6B66', marginTop: 1, flexShrink: 0 }}>{f.icon}</span>
                      <div>
                        <p className="text-xs" style={{ color: '#0C0C0B' }}>{f.label}</p>
                        <p className="text-xs mt-0.5" style={{ color: '#6B6B66', lineHeight: 1.5 }}>{f.sub}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        {!done && (
          <div className="flex-shrink-0 px-5 py-4 flex items-center gap-3" style={{ borderTop: '1px solid #E3E1DB' }}>
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting || filtered.length === 0}
              className="flex items-center gap-2 text-xs px-4 py-2.5 transition-opacity"
              style={{
                background: filtered.length > 0 ? '#0C0C0B' : '#C8C7C2',
                color: '#FFFFFF', borderRadius: 2,
                cursor: filtered.length > 0 ? 'pointer' : 'not-allowed',
              }}
            >
              {exporting
                ? <><Loader2 size={11} className="animate-spin" /> Exporting…</>
                : <><Download size={11} strokeWidth={1.5} /> Export {filtered.length} question{filtered.length !== 1 ? 's' : ''}</>
              }
            </button>
            <p className="text-xs" style={{ color: '#6B6B66' }}>
              {filtered.length} of {questions.length} questions match
            </p>
            <button type="button" onClick={onClose} className="ml-auto text-xs" style={{ color: '#6B6B66' }}>
              Cancel
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}