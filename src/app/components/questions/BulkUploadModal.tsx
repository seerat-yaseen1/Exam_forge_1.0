import React, { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X, Download, Upload, FileSpreadsheet, CheckCircle2,
  AlertTriangle, AlertCircle, ChevronRight, Loader2,
  Info, FileDown,
} from 'lucide-react';
import {
  parseWorkbook, resolveSubjectsInRows, scoreDuplicatesInRows, downloadTemplate,
  computeSummary, getSaveableRows, getAllRows, isDupReviewRow, rowKey,
  type ParsedWorkbook, type ParsedRow, type UploadSummary,
} from './bulkUploadParser';
import { getAllSubjects, getAllTopics, ensureSubject, bumpTaxonomyCounts, type Subject, type Topic } from '../../../lib/subjectService';
import {
  createQuestion, createQuestionsBulkAsRole, getDuplicateCheckPool,
  type QuestionOwnerType, type Question,
} from '../../../lib/questionBankService';
import { pct as fmtPct } from '../../../lib/duplicateDetection';
import { DuplicateCompareModal } from './DuplicateCompareModal';
import { type QuestionDraft } from './QuestionTypeEngine';

// ── Shared styles ─────────────────────────────────────────────────────────────

const S = {
  btn: (active: boolean): React.CSSProperties => ({
    background: active ? 'var(--ef-ink)' : 'var(--ef-canvas-raised)',
    color: active ? 'var(--ef-surface)' : 'var(--ef-text-subtle)',
    border: `1px solid ${active ? 'var(--ef-ink)' : 'var(--ef-border)'}`,
    borderRadius: 2,
    cursor: 'pointer',
    transition: 'all 0.15s',
  }),
};

// ── Step indicator ────────────────────────────────────────────────────────────

const STEPS = [
  { n: 1, label: 'Template' },
  { n: 2, label: 'Upload'   },
  { n: 3, label: 'Review'   },
  { n: 4, label: 'Save'     },
];

function StepStrip({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-0" style={{ borderBottom: '1px solid var(--ef-border)', padding: '0 24px' }}>
      {STEPS.map((s, i) => {
        const done   = s.n < current;
        const active = s.n === current;
        return (
          <React.Fragment key={s.n}>
            <div className="flex items-center gap-2 py-3.5">
              <div
                className="flex items-center justify-center flex-shrink-0"
                style={{
                  width: 18, height: 18, borderRadius: '50%',
                  background: done ? 'var(--ef-success)' : active ? 'var(--ef-ink)' : 'var(--ef-border-subtle)',
                  color: (done || active) ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
                  fontSize: 9,
                  letterSpacing: '0.03em',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {done ? <CheckCircle2 size={10} strokeWidth={2.5} /> : s.n}
              </div>
              <span
                className="text-xs"
                style={{
                  color: done ? 'var(--ef-success)' : active ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
                  letterSpacing: '0.05em',
                }}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div style={{ width: 28, height: 1, background: 'var(--ef-border)', margin: '0 6px', flexShrink: 0 }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Step 1 — Download Template ────────────────────────────────────────────────

function Step1({ onNext }: { onNext: () => void }) {
  const cards = [
    {
      badge: 'MCQ',
      title: 'Multiple Choice',
      cols: ['type', 'stem', 'option_a … option_e', 'correct', 'subject', 'topic', 'tags', 'difficulty', 'explanation', 'stem_image_url', 'option_a_image_url … option_e_image_url'],
      note: 'correct = A (single), A,C (multi), True/False',
    },
    {
      badge: 'Text',
      title: 'Short / Long Answer',
      cols: ['type', 'stem', 'model_answer', 'subject', 'topic', 'tags', 'difficulty', 'explanation', 'stem_image_url'],
      note: 'type = short or long',
    },
    {
      badge: 'Match',
      title: 'Match the Columns',
      cols: ['stem', 'pair1_a', 'pair1_b', '… up to pair8_a', 'pair8_b', 'subject', 'topic', 'tags', 'difficulty', 'explanation', 'stem_image_url'],
      note: 'Min 2 pairs required',
    },
  ];

  return (
    <div className="px-6 py-6">
      <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>STEP 1</p>
      <p className="text-sm mb-2" style={{ color: 'var(--ef-ink)' }}>Download the template</p>
      <p className="text-xs mb-6" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.7 }}>
        The template contains three sheets — one per question engine. Each sheet includes column definitions and worked example rows. Fill from row 3 onwards; row 2 is an instruction row that the parser ignores.
      </p>

      <div className="grid grid-cols-3 gap-3 mb-6">
        {cards.map((c) => (
          <div key={c.badge} className="p-4" style={{ border: '1px solid var(--ef-border)', borderRadius: 3 }}>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs px-1.5 py-0.5 select-none" style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, letterSpacing: '0.04em', fontSize: 10 }}>{c.badge}</span>
              <span className="text-xs" style={{ color: 'var(--ef-ink)' }}>{c.title}</span>
            </div>
            <div className="space-y-1 mb-3">
              {c.cols.map((col) => (
                <p key={col} className="text-xs" style={{ color: 'var(--ef-text-muted)', fontFamily: 'monospace', fontSize: 11 }}>{col}</p>
              ))}
            </div>
            <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>{c.note}</p>
          </div>
        ))}
      </div>

      {/* Image URL note */}
      <div className="flex items-start gap-2.5 px-3 py-3 mb-6" style={{ background: 'var(--ef-warning-bg)', border: '1px solid var(--ef-warning-border)', borderRadius: 2 }}>
        <Info size={13} strokeWidth={1.5} style={{ color: 'var(--ef-warning-strong)', flexShrink: 0, marginTop: 1 }} />
        <p className="text-xs" style={{ color: 'var(--ef-warning-strong)', lineHeight: 1.7 }}>
          Images cannot be embedded in the spreadsheet. Use the <code style={{ fontFamily: 'monospace', background: 'rgba(0,0,0,0.05)', padding: '1px 4px', borderRadius: 2 }}>_image_url</code> columns to attach pre-hosted image links (must start with https://). Questions without images can have image URLs added later via the single-question editor.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={downloadTemplate}
          className="flex items-center gap-2 text-xs px-4 py-2.5 transition-opacity hover:opacity-80"
          style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, letterSpacing: '0.03em' }}
        >
          <FileDown size={12} strokeWidth={1.5} /> Download Template (MCQ + Text + Match)
        </button>
        <button
          type="button"
          onClick={onNext}
          className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity hover:opacity-70"
          style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}
        >
          I have a file ready <ChevronRight size={11} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}

// ── Step 2 — Upload ───────────────────────────────────────────────────────────

function Step2({
  onFile,
  onBack,
}: {
  onFile: (buffer: ArrayBuffer, fileName: string) => void;
  onBack: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const process = useCallback((file: File) => {
    setError(null);
    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
      setError('Only .xlsx and .xls files are accepted.');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError('File must be under 20 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      if (e.target?.result instanceof ArrayBuffer) {
        onFile(e.target.result, file.name);
      }
    };
    reader.readAsArrayBuffer(file);
  }, [onFile]);

  return (
    <div className="px-6 py-6">
      <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>STEP 2</p>
      <p className="text-sm mb-2" style={{ color: 'var(--ef-ink)' }}>Upload your filled file</p>
      <p className="text-xs mb-6" style={{ color: 'var(--ef-text-muted)' }}>
        Upload the filled XLSX template. All three sheets (MCQ, Text, Match) can be present — any sheets you left blank are simply ignored.
      </p>

      {/* Drop zone */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) process(e.dataTransfer.files[0]); }}
        className="flex flex-col items-center justify-center py-14 cursor-pointer transition-all mb-4"
        style={{
          border: `2px dashed ${dragOver ? 'var(--ef-ink)' : 'var(--ef-border-muted)'}`,
          borderRadius: 3,
          background: dragOver ? 'var(--ef-canvas)' : 'var(--ef-canvas-raised)',
          outline: 'none',
        }}
      >
        <div
          className="flex items-center justify-center mb-4"
          style={{ width: 44, height: 44, borderRadius: 3, background: 'var(--ef-border-subtle)', border: '1px solid var(--ef-border)' }}
        >
          <FileSpreadsheet size={20} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
        </div>
        <p className="text-xs mb-1" style={{ color: 'var(--ef-ink)' }}>
          {dragOver ? 'Drop the file here' : 'Click to browse or drag & drop'}
        </p>
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>.xlsx / .xls — max 20 MB</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2.5 mb-4" style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
          <AlertCircle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', flexShrink: 0 }} />
          <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{error}</p>
        </div>
      )}

      <input ref={inputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => { if (e.target.files?.[0]) process(e.target.files[0]); }} />

      <button type="button" onClick={onBack} className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
        ← Back to template
      </button>
    </div>
  );
}

// ── Step 3 — Review ───────────────────────────────────────────────────────────

type ReviewTab = 'MCQ' | 'Text' | 'Match' | 'All';

function StatusDot({ status }: { status: ParsedRow['status'] }) {
  const colors = { valid: 'var(--ef-success)', warning: 'var(--ef-warning-strong)', error: 'var(--ef-danger)' };
  return (
    <div className="flex-shrink-0 w-1.5 h-1.5 rounded-full" style={{ background: colors[status] }} />
  );
}

function RowCard({
  row,
  onViewMatch,
  isDupReview,
  isIncluded,
  onToggleInclude,
}: {
  row: ParsedRow;
  onViewMatch: (row: ParsedRow) => void;
  isDupReview?: boolean;
  isIncluded?: boolean;
  onToggleInclude?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { status, draft, errors, warnings, subjectResolution, duplicateScore } = row;
  const hasDup = duplicateScore && duplicateScore.matchedReason !== 'none';

  const statusColor = status === 'valid' ? 'var(--ef-success)' : status === 'warning' ? 'var(--ef-warning-strong)' : 'var(--ef-danger)';
  const statusBg    = status === 'valid' ? 'var(--ef-success-bg)' : status === 'warning' ? 'var(--ef-warning-bg)' : 'var(--ef-danger-bg)';
  const statusBorder = status === 'valid' ? 'var(--ef-success-border)' : status === 'warning' ? 'var(--ef-warning-border)' : 'var(--ef-danger-border)';

  return (
    <div style={{ border: `1px solid ${statusBorder}`, borderRadius: 2, background: statusBg, marginBottom: 6 }}>
      {/* Row header */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
      >
        <StatusDot status={status} />

        {/* Sheet + row */}
        <span className="text-xs flex-shrink-0" style={{ color: 'var(--ef-text-muted)', fontSize: 10, minWidth: 60 }}>
          {row.sheet} #{row.rowIndex}
        </span>

        {/* Type badge */}
        {draft.engine && (
          <span className="text-xs px-1.5 py-0.5 select-none flex-shrink-0" style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, fontSize: 10 }}>
            {draft.variant ?? draft.engine}
          </span>
        )}

        {/* Stem preview */}
        <span className="flex-1 text-xs truncate" style={{ color: 'var(--ef-ink)' }}>
          {draft.stem ? draft.stem.slice(0, 90) : <em style={{ color: 'var(--ef-text-muted)' }}>No stem</em>}
        </span>

        {/* Subject pill */}
        {draft.subject && (
          <span className="text-xs px-2 py-0.5 flex-shrink-0" style={{ background: 'var(--ef-border-subtle)', borderRadius: 2, color: 'var(--ef-text-subtle)', fontSize: 11 }}>
            {draft.subject}
            {subjectResolution?.kind === 'new' && (
              <span style={{ color: 'var(--ef-warning-strong)', marginLeft: 4, fontSize: 10 }}>NEW</span>
            )}
            {subjectResolution?.kind === 'alias' && (
              <span style={{ color: 'var(--ef-text-muted)', marginLeft: 4, fontSize: 10 }}>→ alias</span>
            )}
          </span>
        )}

        {/* Duplicate score chips */}
        {hasDup && (
          <span
            className="flex items-center gap-1 text-xs flex-shrink-0 px-1.5 py-0.5"
            style={{
              background: status === 'error' ? 'var(--ef-danger-bg)' : 'var(--ef-warning-bg)',
              border: `1px solid ${status === 'error' ? 'var(--ef-danger-border)' : 'var(--ef-warning-border)'}`,
              color: status === 'error' ? 'var(--ef-danger)' : 'var(--ef-warning-strong)',
              borderRadius: 2, fontSize: 10, letterSpacing: '0.04em',
            }}
            title={`stem ${fmtPct(duplicateScore!.stemSim)} · options ${fmtPct(duplicateScore!.optionsSim)} · answer ${duplicateScore!.answerMatch ? '✓' : '✗'}`}
          >
            DUP
            <span style={{ opacity: 0.7 }}>
              S{fmtPct(duplicateScore!.stemSim)} · O{fmtPct(duplicateScore!.optionsSim)} · A{duplicateScore!.answerMatch ? '✓' : '✗'}
            </span>
          </span>
        )}

        {/* Error / warning counts */}
        {errors.length > 0 && (
          <span className="flex items-center gap-1 text-xs flex-shrink-0" style={{ color: 'var(--ef-danger)' }}>
            <AlertCircle size={11} strokeWidth={1.5} /> {errors.length}
          </span>
        )}
        {warnings.length > 0 && errors.length === 0 && (
          <span className="flex items-center gap-1 text-xs flex-shrink-0" style={{ color: 'var(--ef-warning-strong)' }}>
            <AlertTriangle size={11} strokeWidth={1.5} /> {warnings.length}
          </span>
        )}

        <span className="text-xs flex-shrink-0" style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>
          {expanded ? '▲' : '▼'}
        </span>
      </button>
      {/* Possible-duplicate decision strip */}
      {isDupReview && (
        <div className="flex items-center gap-2 px-3 pb-2">
          <span className="text-xs" style={{ color: 'var(--ef-warning-strong)' }}>
            Possible duplicate — {isIncluded ? 'will be saved' : 'skipped unless included'}
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onViewMatch(row); }}
            className="text-xs px-2 py-1 transition-opacity hover:opacity-70"
            style={{ border: '1px solid var(--ef-border)', background: 'var(--ef-surface)', color: 'var(--ef-text-subtle)', borderRadius: 2 }}
          >
            Compare
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleInclude?.(); }}
            className="text-xs px-2 py-1 transition-opacity hover:opacity-70"
            style={{
              border: `1px solid ${isIncluded ? 'var(--ef-success)' : 'var(--ef-border)'}`,
              background: isIncluded ? 'var(--ef-success-bg)' : 'var(--ef-surface)',
              color: isIncluded ? 'var(--ef-success)' : 'var(--ef-text-subtle)',
              borderRadius: 2,
            }}
          >
            {isIncluded ? '✓ Included' : 'Include'}
          </button>
        </div>
      )}

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-3 pt-1" style={{ borderTop: `1px solid ${statusBorder}` }}>
          {errors.map((e, i) => (
            <div key={i} className="flex items-start gap-2 mb-1.5">
              <AlertCircle size={11} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', flexShrink: 0, marginTop: 2 }} />
              <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{e.field}</span>: {e.message}
              </p>
            </div>
          ))}
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 mb-1.5">
              <AlertTriangle size={11} strokeWidth={1.5} style={{ color: 'var(--ef-warning-strong)', flexShrink: 0, marginTop: 2 }} />
              <p className="text-xs" style={{ color: 'var(--ef-warning-strong)' }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{w.field}</span>: {w.message}
              </p>
            </div>
          ))}
          {errors.length === 0 && warnings.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--ef-success)' }}>✓ No issues found</p>
          )}

          {hasDup && duplicateScore?.matchedQuestionId && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onViewMatch(row); }}
              className="mt-2 text-xs px-2 py-1 transition-opacity hover:opacity-70"
              style={{ border: '1px solid var(--ef-border)', background: 'var(--ef-surface)', color: 'var(--ef-text-subtle)', borderRadius: 2 }}
            >
              View matched question →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Step3({
  workbook,
  subjects,
  summary,
  onConfirm,
  onBack,
  onViewMatch,
}: {
  workbook: ParsedWorkbook;
  subjects: Subject[];
  summary: UploadSummary;
  onConfirm: (rowsToSave: ParsedRow[]) => void;
  onBack: () => void;
  onViewMatch: (row: ParsedRow) => void;
}) {
  const [activeTab, setActiveTab] = useState<ReviewTab>('All');
  // Possible-duplicate rows the user has explicitly chosen to include.
  const [included, setIncluded] = useState<Set<string>>(new Set());

  const toggleInclude = (row: ParsedRow) => {
    setIncluded((prev) => {
      const next = new Set(prev);
      const k = rowKey(row);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  const allRows = getAllRows(workbook);
  // A row saves if: not an error, and (not a possible duplicate OR explicitly included).
  const rowsToSave = allRows.filter(
    (r) => r.status !== 'error' && (!isDupReviewRow(r) || included.has(rowKey(r))),
  );
  const includedCount = allRows.filter(
    (r) => isDupReviewRow(r) && included.has(rowKey(r)),
  ).length;

  const tabs: ReviewTab[] = ['All', 'MCQ', 'Text', 'Match'].filter((t) => {
    if (t === 'All') return true;
    if (t === 'MCQ')   return workbook.mcq.length > 0;
    if (t === 'Text')  return workbook.text.length > 0;
    if (t === 'Match') return workbook.match.length > 0;
    return false;
  }) as ReviewTab[];

  const rows =
    activeTab === 'All'   ? allRows :
    activeTab === 'MCQ'   ? workbook.mcq :
    activeTab === 'Text'  ? workbook.text :
    workbook.match;

  return (
    <div className="px-6 py-6 flex flex-col" style={{ minHeight: 0 }}>
      <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>STEP 3</p>
      <p className="text-sm mb-3" style={{ color: 'var(--ef-ink)' }}>Review & verify</p>

      {/* Summary bar */}
      <div
        className="flex items-center gap-4 px-4 py-3 mb-4 flex-wrap"
        style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2 }}
      >
        <span className="text-xs" style={{ color: 'var(--ef-success)' }}>✓ {summary.valid} valid</span>
        {summary.warnings > 0 && <span className="text-xs" style={{ color: 'var(--ef-warning-strong)' }}>⚠ {summary.warnings} warnings</span>}
        {summary.dupSkipped > 0 && <span className="text-xs" style={{ color: 'var(--ef-danger)' }}>⊘ {summary.dupSkipped} exact duplicates (auto-skipped)</span>}
        {summary.dupReview > 0 && (
          <span className="text-xs" style={{ color: 'var(--ef-warning-strong)' }}>
            ? {summary.dupReview} possible duplicates — {includedCount} included
          </span>
        )}
        {summary.errors - summary.dupSkipped > 0 && (
          <span className="text-xs" style={{ color: 'var(--ef-danger)' }}>✗ {summary.errors - summary.dupSkipped} errors (will be skipped)</span>
        )}
        <div style={{ flex: 1 }} />
        <span className="text-xs" style={{ color: 'var(--ef-ink)' }}>
          <strong>{rowsToSave.length}</strong> will save · <strong>{allRows.length - rowsToSave.length}</strong> skipped
        </span>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-3" style={{ borderBottom: '1px solid var(--ef-border)' }}>
        {tabs.map((t) => {
          const count =
            t === 'All' ? allRows.length :
            t === 'MCQ' ? workbook.mcq.length :
            t === 'Text' ? workbook.text.length :
            workbook.match.length;
          return (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className="text-xs px-4 py-2 transition-all"
              style={{
                color: activeTab === t ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
                borderBottom: activeTab === t ? '2px solid var(--ef-ink)' : '2px solid transparent',
                marginBottom: -1,
              }}
            >
              {t} ({count})
            </button>
          );
        })}
      </div>

      {/* Row list */}
      <div className="overflow-y-auto flex-1 mb-4" style={{ maxHeight: 340 }}>
        {rows.length === 0 ? (
          <p className="text-xs text-center py-8" style={{ color: 'var(--ef-text-muted)' }}>No rows in this sheet.</p>
        ) : (
          rows.map((row) => (
            <RowCard
              key={rowKey(row)}
              row={row}
              onViewMatch={onViewMatch}
              isDupReview={isDupReviewRow(row)}
              isIncluded={included.has(rowKey(row))}
              onToggleInclude={() => toggleInclude(row)}
            />
          ))
        )}
      </div>

      {rowsToSave.length === 0 && (
        <div className="flex items-start gap-2.5 px-3 py-2.5 mb-4" style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
          <AlertCircle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', flexShrink: 0, marginTop: 1 }} />
          <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>No rows will be saved. Fix errors, or include reviewed duplicates you want to keep.</p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onConfirm(rowsToSave)}
          disabled={rowsToSave.length === 0}
          className="flex items-center gap-2 text-xs px-4 py-2.5 transition-opacity"
          style={{
            background: rowsToSave.length > 0 ? 'var(--ef-ink)' : 'var(--ef-track)',
            color: 'var(--ef-surface)', borderRadius: 2,
            cursor: rowsToSave.length > 0 ? 'pointer' : 'not-allowed',
          }}
        >
          Save {rowsToSave.length} questions <ChevronRight size={11} strokeWidth={1.5} />
        </button>
        <button type="button" onClick={onBack} className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
          ← Re-upload
        </button>
      </div>
    </div>
  );
}

// ── Step 4 — Saving ───────────────────────────────────────────────────────────

const MAX_UPLOAD_ROWS = 500;

function Step4({
  rows,
  subjects,
  ownerType,
  ownerId,
  instituteId,
  onComplete,
}: {
  rows: ParsedRow[];
  subjects: Subject[];
  ownerType?: QuestionOwnerType;
  ownerId?: string;
  instituteId?: string;
  onComplete: (saved: number, skipped: number) => void;
}) {
  const [done,    setDone]    = useState(0);
  const [total]              = useState(rows.length);
  const [phase,   setPhase]   = useState<'saving' | 'done' | 'error'>('saving');
  const [errMsg,  setErrMsg]  = useState<string | null>(null);
  const [saved,   setSaved]   = useState(0);
  const [skipped, setSkipped] = useState(0);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    (async () => {
      const subjectCache = [...subjects];
      let savedCount  = 0;
      let skippedCount = 0;

      // ── Phase 1: resolve subjects, build payloads ────────────────
      // Stays client-side and per-row. ensureSubject only touches the network
      // for a subject it has not seen, so a file with a handful of distinct
      // subjects resolves in a handful of calls regardless of row count.
      const payloads: QuestionDraft[] = [];
      for (const row of rows) {
        try {
          const { canonicalName } = await ensureSubject(row.draft.subject ?? '', subjectCache);
          const draft = { ...row.draft, subject: canonicalName } as QuestionDraft;
          payloads.push({
            ...draft,
            ...(ownerType ? { ownerType, ownerId: ownerId ?? ownerType } : {}),
            // Tenant stamp: institute/faculty-authored questions carry the
            // author's institute (rules validate it); webOwner content never
            // carries one.
            ...(ownerType && ownerType !== 'webOwner' && instituteId ? { instituteId } : {}),
          } as QuestionDraft);
        } catch (err: any) {
          console.warn(`[BulkUpload] subject resolution failed for row ${row.rowIndex}:`, err?.message);
          skippedCount++;
          setDone((d) => d + 1);
        }
      }

      // ── Phase 2: write ───────────────────────────────────────────
      // Audit S-02. This used to be one direct createQuestion per row for
      // EVERY role, which meant bulk upload bypassed the question-rights model
      // outright: a faculty member with no create grant could not add one
      // question through the UI but could import a thousand here. Institute
      // and faculty now go through createQuestionsBulkAsRole, which applies
      // the same ceiling and grant check as single-create — once per chunk
      // rather than once per row, so the fix costs nothing in speed.
      //
      // webOwner keeps the direct path. assertQuestionRight resolves an
      // institute-or-faculty owner and has no webOwner branch by design — the
      // ceiling exists to constrain tenants, and the platform owner is who
      // sets it. This mirrors Phase 2A, where single-create made the same
      // split for the same reason.
      const useRightsGatedPath = !!ownerType && ownerType !== 'webOwner';

      if (useRightsGatedPath) {
        const res = await createQuestionsBulkAsRole(
          payloads.map((q) => ({
            question: q as any,
            subjectId: (q as any).subjectId ?? null,
            topicId:   (q as any).topicId   ?? null,
          })),
          (doneCount) => setDone(skippedCount + doneCount),
        );
        savedCount   = res.ids.length;
        skippedCount += res.skipped;
        // Taxonomy counters are aggregated and bumped server-side by the
        // callable — deliberately NOT also bumped here, or every count would
        // be double-applied.
      } else {
        const subjectDeltas = new Map<string, number>();
        const topicDeltas   = new Map<string, number>();

        for (const q of payloads) {
          try {
            const created = await createQuestion(q as any, { skipCounterBump: true });
            if (created.subjectId) subjectDeltas.set(created.subjectId, (subjectDeltas.get(created.subjectId) ?? 0) + 1);
            if (created.topicId)   topicDeltas.set(created.topicId, (topicDeltas.get(created.topicId) ?? 0) + 1);
            savedCount++;
          } catch (err: any) {
            console.warn('[BulkUpload] skipped a row:', err?.message);
            skippedCount++;
          }
          setDone((d) => d + 1);
        }

        // One counter write per subject/topic instead of one per question.
        for (const [subjectId, delta] of subjectDeltas) {
          await bumpTaxonomyCounts({ subjectId }, delta);
        }
        for (const [topicId, delta] of topicDeltas) {
          await bumpTaxonomyCounts({ topicId }, delta);
        }
      }

      setSaved(savedCount);
      setSkipped(skippedCount);
      setPhase('done');
      onComplete(savedCount, skippedCount);
    })().catch((err) => {
      setErrMsg(err?.message ?? 'Unknown error');
      setPhase('error');
    });
  }, []);

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="px-6 py-10 flex flex-col items-center justify-center" style={{ minHeight: 320 }}>
      {phase === 'saving' && (
        <>
          <Loader2 size={24} className="animate-spin mb-5" style={{ color: 'var(--ef-text-muted)' }} />
          <p className="text-sm mb-2" style={{ color: 'var(--ef-ink)' }}>Saving questions…</p>
          <p className="text-xs mb-5" style={{ color: 'var(--ef-text-muted)' }}>{done} / {total}</p>
          <div className="w-full" style={{ maxWidth: 280 }}>
            <div style={{ height: 4, background: 'var(--ef-border)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: 'var(--ef-ink)', borderRadius: 2, transition: 'width 0.3s ease' }} />
            </div>
            <p className="text-xs mt-2 text-center" style={{ color: 'var(--ef-text-muted)' }}>{pct}%</p>
          </div>
        </>
      )}

      {phase === 'done' && (
        <>
          <div className="flex items-center justify-center mb-5" style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--ef-success-bg)', border: '1px solid var(--ef-success-border)' }}>
            <CheckCircle2 size={22} strokeWidth={1.5} style={{ color: 'var(--ef-success)' }} />
          </div>
          <p className="text-sm mb-2" style={{ color: 'var(--ef-ink)' }}>Done!</p>
          <p className="text-xs" style={{ color: 'var(--ef-success)' }}>{saved} questions added to the pool.</p>
          {skipped > 0 && (
            <p className="text-xs mt-1" style={{ color: 'var(--ef-danger)' }}>{skipped} questions could not be saved.</p>
          )}
        </>
      )}

      {phase === 'error' && (
        <>
          <div className="flex items-center justify-center mb-5" style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)' }}>
            <AlertCircle size={22} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />
          </div>
          <p className="text-sm mb-2" style={{ color: 'var(--ef-ink)' }}>Something went wrong</p>
          <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{errMsg}</p>
        </>
      )}
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

export interface BulkUploadModalProps {
  onClose:    () => void;
  onComplete: (savedCount: number) => void;
  /** Optional — scopes newly created questions to an institute or faculty owner. */
  ownerType?: QuestionOwnerType;
  ownerId?:   string;
  instituteId?: string;
}

export function BulkUploadModal({ onClose, onComplete, ownerType, ownerId, instituteId }: BulkUploadModalProps) {
  const [step,      setStep]      = useState<1 | 2 | 3 | 4>(1);
  const [workbook,  setWorkbook]  = useState<ParsedWorkbook | null>(null);
  const [summary,   setSummary]   = useState<UploadSummary | null>(null);
  const [saveRows,  setSaveRows]  = useState<ParsedRow[]>([]);
  const [subjects,  setSubjects]  = useState<Subject[]>([]);
  const [topics,    setTopics]    = useState<Topic[]>([]);
  const [pool,      setPool]      = useState<Question[]>([]);
  const [parseErr,  setParseErr]  = useState<string | null>(null);
  const [compareRow, setCompareRow] = useState<ParsedRow | null>(null);

  // Fetch subjects + topics + the caller-scoped duplicate-check pool once
  useEffect(() => {
    Promise.all([
      getAllSubjects(),
      getAllTopics(),
      getDuplicateCheckPool(ownerType, ownerId, instituteId),
    ]).then(([s, t, qs]) => {
      setSubjects(s);
      setTopics(t);
      setPool(qs);
    });
  }, []);

  const handleFile = useCallback(async (buffer: ArrayBuffer) => {
    setParseErr(null);
    try {
      // parseWorkbook is async since Batch E (lazy xlsx) — see bulkUploadParser.
      const raw = await parseWorkbook(buffer);
      if (raw.sheetsFound.length === 0) {
        setParseErr('No recognised sheets found (expected MCQ, Text, or Match). Check your template.');
        return;
      }
      // Pass 1: resolve subjects against registry
      const withSubjects: ParsedWorkbook = {
        ...raw,
        mcq:   resolveSubjectsInRows(raw.mcq,   subjects, topics),
        text:  resolveSubjectsInRows(raw.text,  subjects, topics),
        match: resolveSubjectsInRows(raw.match, subjects, topics),
      };
      // Pass 2: score duplicates (must run after subjects so subjectId+topicId are set).
      // Scoring runs across all three sheets together — but the candidate filter scopes
      // each row to its own subject+topic, so cross-sheet matches still work correctly.
      const resolved: ParsedWorkbook = {
        ...withSubjects,
        mcq:   scoreDuplicatesInRows(withSubjects.mcq,   pool),
        text:  scoreDuplicatesInRows(withSubjects.text,  pool),
        match: scoreDuplicatesInRows(withSubjects.match, pool),
      };
      const allRows = getAllRows(resolved);
      // Row cap (audit S-02). There was no limit at all before this — a file of
      // any size was accepted and written one question at a time. 500 is the
      // largest import that still behaves like a single action: three chunked
      // calls, and a failure you can still reason about. Enforced again
      // server-side per chunk, since a client-side limit is a courtesy rather
      // than a control.
      if (allRows.length > MAX_UPLOAD_ROWS) {
        setParseErr(
          `This file has ${allRows.length} questions. The limit is ${MAX_UPLOAD_ROWS} per upload — `
          + `please split it into smaller files.`,
        );
        return;
      }
      const sum = computeSummary(allRows);
      setWorkbook(resolved);
      setSummary(sum);
      setSaveRows(getSaveableRows(allRows));
      setStep(3);
    } catch (err: any) {
      setParseErr(`Failed to parse file: ${err?.message ?? 'Unknown error'}. Make sure you are using the STRATUM template.`);
    }
  }, [subjects, topics, pool]);

  const handleComplete = (saved: number, skipped: number) => {
    onComplete(saved);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.32)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0, y: 8 }}
        animate={{ scale: 1,    opacity: 1, y: 0 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className="w-full flex flex-col"
        style={{ maxWidth: 780, maxHeight: '90vh', background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 sm:py-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--ef-border)' }}>
          <div>
            <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>QUESTION POOL</p>
            <p className="text-sm mt-0.5" style={{ color: 'var(--ef-ink)' }}>Bulk Upload</p>
          </div>
          {step < 4 && (
            <button onClick={onClose} className="p-1 transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}>
              <X size={15} strokeWidth={1.5} />
            </button>
          )}
        </div>

        {/* Step strip */}
        <div className="flex-shrink-0">
          <StepStrip current={step} />
        </div>

        {/* Parse error */}
        {parseErr && (
          <div className="mx-6 mt-4 flex items-start gap-2.5 px-3 py-2.5" style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
            <AlertCircle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', flexShrink: 0, marginTop: 1 }} />
            <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{parseErr}</p>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div key="s1" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.18 }}>
                <Step1 onNext={() => setStep(2)} />
              </motion.div>
            )}
            {step === 2 && (
              <motion.div key="s2" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.18 }}>
                <Step2 onFile={handleFile} onBack={() => setStep(1)} />
              </motion.div>
            )}
            {step === 3 && workbook && summary && (
              <motion.div key="s3" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.18 }}>
                <Step3
                  workbook={workbook}
                  subjects={subjects}
                  summary={summary}
                 onConfirm={(rowsToSave) => { setSaveRows(rowsToSave); setStep(4); }}
                  onBack={() => setStep(2)}
                  onViewMatch={setCompareRow}
                />
              </motion.div>
            )}
            {step === 4 && (
              <motion.div key="s4" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.18 }}>
                <Step4
                  rows={saveRows}
                  subjects={subjects}
                  ownerType={ownerType}
                  ownerId={ownerId}
                  instituteId={instituteId}
                  onComplete={handleComplete}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Duplicate compare modal */}
        <AnimatePresence>
          {compareRow && (
            <DuplicateCompareModal
              row={compareRow}
              pool={pool}
              allRows={workbook ? getAllRows(workbook) : []}
              onClose={() => setCompareRow(null)}
            />
          )}
        </AnimatePresence>

        {/* Footer for step 4 */}
        {step === 4 && (
          <div className="flex-shrink-0 px-6 py-4 flex items-center gap-3" style={{ borderTop: '1px solid var(--ef-border)' }}>
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-4 py-2.5"
              style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2 }}
            >
              Close & view pool
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}