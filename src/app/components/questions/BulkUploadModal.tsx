import React, { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X, Download, Upload, FileSpreadsheet, CheckCircle2,
  AlertTriangle, AlertCircle, ChevronRight, Loader2,
  Info, FileDown,
} from 'lucide-react';
import {
  parseWorkbook, resolveSubjectsInRows, scoreDuplicatesInRows, downloadTemplate,
  computeSummary, getSaveableRows, getAllRows,
  type ParsedWorkbook, type ParsedRow, type UploadSummary,
} from './bulkUploadParser';
import { getAllSubjects, getAllTopics, ensureSubject, type Subject, type Topic } from '../../../lib/subjectService';
import {
  createQuestion, getAllQuestions,
  type QuestionOwnerType, type Question,
} from '../../../lib/questionBankService';
import { pct as fmtPct } from '../../../lib/duplicateDetection';
import { DuplicateCompareModal } from './DuplicateCompareModal';
import { type QuestionDraft } from './QuestionTypeEngine';

// ── Shared styles ─────────────────────────────────────────────────────────────

const S = {
  btn: (active: boolean): React.CSSProperties => ({
    background: active ? '#0C0C0B' : '#FAFAF8',
    color: active ? '#FFFFFF' : '#4A4A45',
    border: `1px solid ${active ? '#0C0C0B' : '#E3E1DB'}`,
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
    <div className="flex items-center gap-0" style={{ borderBottom: '1px solid #E3E1DB', padding: '0 24px' }}>
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
                  background: done ? '#2A6B3A' : active ? '#0C0C0B' : '#F0EFEB',
                  color: (done || active) ? '#FFFFFF' : '#B0AEA8',
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
                  color: done ? '#2A6B3A' : active ? '#0C0C0B' : '#B0AEA8',
                  letterSpacing: '0.05em',
                }}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div style={{ width: 28, height: 1, background: '#E3E1DB', margin: '0 6px', flexShrink: 0 }} />
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
      <p className="text-xs mb-1" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>STEP 1</p>
      <p className="text-sm mb-2" style={{ color: '#0C0C0B' }}>Download the template</p>
      <p className="text-xs mb-6" style={{ color: '#B0AEA8', lineHeight: 1.7 }}>
        The template contains three sheets — one per question engine. Each sheet includes column definitions and worked example rows. Fill from row 3 onwards; row 2 is an instruction row that the parser ignores.
      </p>

      <div className="grid grid-cols-3 gap-3 mb-6">
        {cards.map((c) => (
          <div key={c.badge} className="p-4" style={{ border: '1px solid #E3E1DB', borderRadius: 3 }}>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs px-1.5 py-0.5 select-none" style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.04em', fontSize: 10 }}>{c.badge}</span>
              <span className="text-xs" style={{ color: '#0C0C0B' }}>{c.title}</span>
            </div>
            <div className="space-y-1 mb-3">
              {c.cols.map((col) => (
                <p key={col} className="text-xs" style={{ color: '#9A9891', fontFamily: 'monospace', fontSize: 11 }}>{col}</p>
              ))}
            </div>
            <p className="text-xs" style={{ color: '#C4C3BD', lineHeight: 1.5 }}>{c.note}</p>
          </div>
        ))}
      </div>

      {/* Image URL note */}
      <div className="flex items-start gap-2.5 px-3 py-3 mb-6" style={{ background: '#FFFBF0', border: '1px solid #F0DFA0', borderRadius: 2 }}>
        <Info size={13} strokeWidth={1.5} style={{ color: '#8B5E1A', flexShrink: 0, marginTop: 1 }} />
        <p className="text-xs" style={{ color: '#8B5E1A', lineHeight: 1.7 }}>
          Images cannot be embedded in the spreadsheet. Use the <code style={{ fontFamily: 'monospace', background: 'rgba(0,0,0,0.05)', padding: '1px 4px', borderRadius: 2 }}>_image_url</code> columns to attach pre-hosted image links (must start with https://). Questions without images can have image URLs added later via the single-question editor.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={downloadTemplate}
          className="flex items-center gap-2 text-xs px-4 py-2.5 transition-opacity hover:opacity-80"
          style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.03em' }}
        >
          <FileDown size={12} strokeWidth={1.5} /> Download Template (MCQ + Text + Match)
        </button>
        <button
          type="button"
          onClick={onNext}
          className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity hover:opacity-70"
          style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}
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
      <p className="text-xs mb-1" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>STEP 2</p>
      <p className="text-sm mb-2" style={{ color: '#0C0C0B' }}>Upload your filled file</p>
      <p className="text-xs mb-6" style={{ color: '#B0AEA8' }}>
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
          border: `2px dashed ${dragOver ? '#0C0C0B' : '#D1CFCA'}`,
          borderRadius: 3,
          background: dragOver ? '#F7F6F3' : '#FAFAF8',
          outline: 'none',
        }}
      >
        <div
          className="flex items-center justify-center mb-4"
          style={{ width: 44, height: 44, borderRadius: 3, background: '#F0EFEB', border: '1px solid #E3E1DB' }}
        >
          <FileSpreadsheet size={20} strokeWidth={1.5} style={{ color: '#9A9891' }} />
        </div>
        <p className="text-xs mb-1" style={{ color: '#0C0C0B' }}>
          {dragOver ? 'Drop the file here' : 'Click to browse or drag & drop'}
        </p>
        <p className="text-xs" style={{ color: '#B0AEA8' }}>.xlsx / .xls — max 20 MB</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2.5 mb-4" style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
          <AlertCircle size={13} strokeWidth={1.5} style={{ color: '#9B2828', flexShrink: 0 }} />
          <p className="text-xs" style={{ color: '#9B2828' }}>{error}</p>
        </div>
      )}

      <input ref={inputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => { if (e.target.files?.[0]) process(e.target.files[0]); }} />

      <button type="button" onClick={onBack} className="text-xs" style={{ color: '#9A9891' }}>
        ← Back to template
      </button>
    </div>
  );
}

// ── Step 3 — Review ───────────────────────────────────────────────────────────

type ReviewTab = 'MCQ' | 'Text' | 'Match' | 'All';

function StatusDot({ status }: { status: ParsedRow['status'] }) {
  const colors = { valid: '#2A6B3A', warning: '#8B5E1A', error: '#9B2828' };
  return (
    <div className="flex-shrink-0 w-1.5 h-1.5 rounded-full" style={{ background: colors[status] }} />
  );
}

function RowCard({
  row,
  onViewMatch,
}: {
  row: ParsedRow;
  onViewMatch: (row: ParsedRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { status, draft, errors, warnings, subjectResolution, duplicateScore } = row;
  const hasDup = duplicateScore && duplicateScore.matchedReason !== 'none';

  const statusColor = status === 'valid' ? '#2A6B3A' : status === 'warning' ? '#8B5E1A' : '#9B2828';
  const statusBg    = status === 'valid' ? '#F0FBF4' : status === 'warning' ? '#FFFBF0' : '#FDF5F5';
  const statusBorder = status === 'valid' ? '#C3E8CE' : status === 'warning' ? '#F0DFA0' : '#F2CECE';

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
        <span className="text-xs flex-shrink-0" style={{ color: '#C4C3BD', fontSize: 10, minWidth: 60 }}>
          {row.sheet} #{row.rowIndex}
        </span>

        {/* Type badge */}
        {draft.engine && (
          <span className="text-xs px-1.5 py-0.5 select-none flex-shrink-0" style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, fontSize: 10 }}>
            {draft.variant ?? draft.engine}
          </span>
        )}

        {/* Stem preview */}
        <span className="flex-1 text-xs truncate" style={{ color: '#0C0C0B' }}>
          {draft.stem ? draft.stem.slice(0, 90) : <em style={{ color: '#B0AEA8' }}>No stem</em>}
        </span>

        {/* Subject pill */}
        {draft.subject && (
          <span className="text-xs px-2 py-0.5 flex-shrink-0" style={{ background: '#F0EFEB', borderRadius: 2, color: '#4A4A45', fontSize: 11 }}>
            {draft.subject}
            {subjectResolution?.kind === 'new' && (
              <span style={{ color: '#8B5E1A', marginLeft: 4, fontSize: 10 }}>NEW</span>
            )}
            {subjectResolution?.kind === 'alias' && (
              <span style={{ color: '#B0AEA8', marginLeft: 4, fontSize: 10 }}>→ alias</span>
            )}
          </span>
        )}

        {/* Duplicate score chips */}
        {hasDup && (
          <span
            className="flex items-center gap-1 text-xs flex-shrink-0 px-1.5 py-0.5"
            style={{
              background: status === 'error' ? '#FDF5F5' : '#FFFBF0',
              border: `1px solid ${status === 'error' ? '#F2CECE' : '#F0DFA0'}`,
              color: status === 'error' ? '#9B2828' : '#8B5E1A',
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
          <span className="flex items-center gap-1 text-xs flex-shrink-0" style={{ color: '#9B2828' }}>
            <AlertCircle size={11} strokeWidth={1.5} /> {errors.length}
          </span>
        )}
        {warnings.length > 0 && errors.length === 0 && (
          <span className="flex items-center gap-1 text-xs flex-shrink-0" style={{ color: '#8B5E1A' }}>
            <AlertTriangle size={11} strokeWidth={1.5} /> {warnings.length}
          </span>
        )}

        <span className="text-xs flex-shrink-0" style={{ color: '#C4C3BD', fontSize: 10 }}>
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-3 pt-1" style={{ borderTop: `1px solid ${statusBorder}` }}>
          {errors.map((e, i) => (
            <div key={i} className="flex items-start gap-2 mb-1.5">
              <AlertCircle size={11} strokeWidth={1.5} style={{ color: '#9B2828', flexShrink: 0, marginTop: 2 }} />
              <p className="text-xs" style={{ color: '#9B2828' }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{e.field}</span>: {e.message}
              </p>
            </div>
          ))}
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 mb-1.5">
              <AlertTriangle size={11} strokeWidth={1.5} style={{ color: '#8B5E1A', flexShrink: 0, marginTop: 2 }} />
              <p className="text-xs" style={{ color: '#8B5E1A' }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{w.field}</span>: {w.message}
              </p>
            </div>
          ))}
          {errors.length === 0 && warnings.length === 0 && (
            <p className="text-xs" style={{ color: '#2A6B3A' }}>✓ No issues found</p>
          )}

          {hasDup && duplicateScore?.matchedQuestionId && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onViewMatch(row); }}
              className="mt-2 text-xs px-2 py-1 transition-opacity hover:opacity-70"
              style={{ border: '1px solid #E3E1DB', background: '#FFFFFF', color: '#4A4A45', borderRadius: 2 }}
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
  onConfirm: () => void;
  onBack: () => void;
  onViewMatch: (row: ParsedRow) => void;
}) {
  const [activeTab, setActiveTab] = useState<ReviewTab>('All');
  const tabs: ReviewTab[] = ['All', 'MCQ', 'Text', 'Match'].filter((t) => {
    if (t === 'All') return true;
    if (t === 'MCQ')   return workbook.mcq.length > 0;
    if (t === 'Text')  return workbook.text.length > 0;
    if (t === 'Match') return workbook.match.length > 0;
    return false;
  }) as ReviewTab[];

  const rows =
    activeTab === 'All'   ? getAllRows(workbook) :
    activeTab === 'MCQ'   ? workbook.mcq :
    activeTab === 'Text'  ? workbook.text :
    workbook.match;

  return (
    <div className="px-6 py-6 flex flex-col" style={{ minHeight: 0 }}>
      <p className="text-xs mb-1" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>STEP 3</p>
      <p className="text-sm mb-3" style={{ color: '#0C0C0B' }}>Review & verify</p>

      {/* Summary bar */}
      <div
        className="flex items-center gap-4 px-4 py-3 mb-4 flex-wrap"
        style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}
      >
        <span className="text-xs" style={{ color: '#2A6B3A' }}>✓ {summary.valid} valid</span>
        {summary.warnings > 0 && <span className="text-xs" style={{ color: '#8B5E1A' }}>⚠ {summary.warnings} warnings</span>}
        {summary.errors   > 0 && <span className="text-xs" style={{ color: '#9B2828' }}>✗ {summary.errors} errors (will be skipped)</span>}
        <div style={{ flex: 1 }} />
        <span className="text-xs" style={{ color: '#0C0C0B' }}>
          <strong>{summary.willSave}</strong> will save · <strong>{summary.willSkip}</strong> skipped
        </span>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-3" style={{ borderBottom: '1px solid #E3E1DB' }}>
        {tabs.map((t) => {
          const count =
            t === 'All' ? getAllRows(workbook).length :
            t === 'MCQ' ? workbook.mcq.length :
            t === 'Text' ? workbook.text.length :
            workbook.match.length;
          return (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className="text-xs px-4 py-2 transition-all"
              style={{
                color: activeTab === t ? '#0C0C0B' : '#9A9891',
                borderBottom: activeTab === t ? '2px solid #0C0C0B' : '2px solid transparent',
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
          <p className="text-xs text-center py-8" style={{ color: '#B0AEA8' }}>No rows in this sheet.</p>
        ) : (
          rows.map((row) => (
            <RowCard
              key={`${row.sheet}-${row.rowIndex}`}
              row={row}
              onViewMatch={onViewMatch}
            />
          ))
        )}
      </div>

      {summary.willSave === 0 && (
        <div className="flex items-start gap-2.5 px-3 py-2.5 mb-4" style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
          <AlertCircle size={13} strokeWidth={1.5} style={{ color: '#9B2828', flexShrink: 0, marginTop: 1 }} />
          <p className="text-xs" style={{ color: '#9B2828' }}>No valid rows found. Fix the errors in your file and re-upload.</p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onConfirm}
          disabled={summary.willSave === 0}
          className="flex items-center gap-2 text-xs px-4 py-2.5 transition-opacity"
          style={{
            background: summary.willSave > 0 ? '#0C0C0B' : '#C8C7C2',
            color: '#FFFFFF', borderRadius: 2,
            cursor: summary.willSave > 0 ? 'pointer' : 'not-allowed',
          }}
        >
          Save {summary.willSave} questions <ChevronRight size={11} strokeWidth={1.5} />
        </button>
        <button type="button" onClick={onBack} className="text-xs" style={{ color: '#9A9891' }}>
          ← Re-upload
        </button>
      </div>
    </div>
  );
}

// ── Step 4 — Saving ───────────────────────────────────────────────────────────

function Step4({
  rows,
  subjects,
  ownerType,
  ownerId,
  onComplete,
}: {
  rows: ParsedRow[];
  subjects: Subject[];
  ownerType?: QuestionOwnerType;
  ownerId?: string;
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

      for (const row of rows) {
        try {
          // Ensure subject exists (creates if new)
          const { canonicalName } = await ensureSubject(row.draft.subject ?? '', subjectCache);
          const draft = { ...row.draft, subject: canonicalName } as QuestionDraft;
          await createQuestion({
            ...draft,
            ...(ownerType ? { ownerType, ownerId: ownerId ?? ownerType } : {}),
          });
          savedCount++;
        } catch (err: any) {
          console.warn(`[BulkUpload] skipped row ${row.rowIndex}:`, err?.message);
          skippedCount++;
        }
        setDone((d) => d + 1);
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
          <Loader2 size={24} className="animate-spin mb-5" style={{ color: '#9A9891' }} />
          <p className="text-sm mb-2" style={{ color: '#0C0C0B' }}>Saving questions…</p>
          <p className="text-xs mb-5" style={{ color: '#B0AEA8' }}>{done} / {total}</p>
          <div className="w-full" style={{ maxWidth: 280 }}>
            <div style={{ height: 4, background: '#E3E1DB', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: '#0C0C0B', borderRadius: 2, transition: 'width 0.3s ease' }} />
            </div>
            <p className="text-xs mt-2 text-center" style={{ color: '#C4C3BD' }}>{pct}%</p>
          </div>
        </>
      )}

      {phase === 'done' && (
        <>
          <div className="flex items-center justify-center mb-5" style={{ width: 48, height: 48, borderRadius: '50%', background: '#F0FBF4', border: '1px solid #C3E8CE' }}>
            <CheckCircle2 size={22} strokeWidth={1.5} style={{ color: '#2A6B3A' }} />
          </div>
          <p className="text-sm mb-2" style={{ color: '#0C0C0B' }}>Done!</p>
          <p className="text-xs" style={{ color: '#2A6B3A' }}>{saved} questions added to the pool.</p>
          {skipped > 0 && (
            <p className="text-xs mt-1" style={{ color: '#9B2828' }}>{skipped} questions could not be saved.</p>
          )}
        </>
      )}

      {phase === 'error' && (
        <>
          <div className="flex items-center justify-center mb-5" style={{ width: 48, height: 48, borderRadius: '50%', background: '#FDF5F5', border: '1px solid #F2CECE' }}>
            <AlertCircle size={22} strokeWidth={1.5} style={{ color: '#9B2828' }} />
          </div>
          <p className="text-sm mb-2" style={{ color: '#0C0C0B' }}>Something went wrong</p>
          <p className="text-xs" style={{ color: '#9B2828' }}>{errMsg}</p>
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
}

export function BulkUploadModal({ onClose, onComplete, ownerType, ownerId }: BulkUploadModalProps) {
  const [step,      setStep]      = useState<1 | 2 | 3 | 4>(1);
  const [workbook,  setWorkbook]  = useState<ParsedWorkbook | null>(null);
  const [summary,   setSummary]   = useState<UploadSummary | null>(null);
  const [saveRows,  setSaveRows]  = useState<ParsedRow[]>([]);
  const [subjects,  setSubjects]  = useState<Subject[]>([]);
  const [topics,    setTopics]    = useState<Topic[]>([]);
  const [pool,      setPool]      = useState<Question[]>([]);
  const [parseErr,  setParseErr]  = useState<string | null>(null);
  const [compareRow, setCompareRow] = useState<ParsedRow | null>(null);

  // Fetch subjects + topics + existing question pool once
  useEffect(() => {
    Promise.all([getAllSubjects(), getAllTopics(), getAllQuestions()]).then(([s, t, qs]) => {
      setSubjects(s);
      setTopics(t);
      setPool(qs);
    });
  }, []);

  const handleFile = useCallback((buffer: ArrayBuffer) => {
    setParseErr(null);
    try {
      const raw = parseWorkbook(buffer);
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
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(12,12,11,0.32)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0, y: 8 }}
        animate={{ scale: 1,    opacity: 1, y: 0 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className="w-full flex flex-col"
        style={{ maxWidth: 780, maxHeight: '90vh', background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 flex-shrink-0" style={{ borderBottom: '1px solid #E3E1DB' }}>
          <div>
            <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>QUESTION POOL</p>
            <p className="text-sm mt-0.5" style={{ color: '#0C0C0B' }}>Bulk Upload</p>
          </div>
          {step < 4 && (
            <button onClick={onClose} className="p-1 transition-opacity hover:opacity-60" style={{ color: '#9A9891' }}>
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
          <div className="mx-6 mt-4 flex items-start gap-2.5 px-3 py-2.5" style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
            <AlertCircle size={13} strokeWidth={1.5} style={{ color: '#9B2828', flexShrink: 0, marginTop: 1 }} />
            <p className="text-xs" style={{ color: '#9B2828' }}>{parseErr}</p>
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
                  onConfirm={() => setStep(4)}
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
              onClose={() => setCompareRow(null)}
            />
          )}
        </AnimatePresence>

        {/* Footer for step 4 */}
        {step === 4 && (
          <div className="flex-shrink-0 px-6 py-4 flex items-center gap-3" style={{ borderTop: '1px solid #E3E1DB' }}>
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-4 py-2.5"
              style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2 }}
            >
              Close & view pool
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}