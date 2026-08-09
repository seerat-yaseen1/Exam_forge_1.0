/**
 * QuestionGroupEditor — author a grouped question set.
 *
 * A group is a shared STIMULUS plus its dependent child questions: a DI table,
 * a reading passage, a caselet, a puzzle, a seating arrangement. All five are
 * one model — they differ only in what the stimulus contains — so this one
 * editor covers them and `kind` picks the flavour.
 *
 * TWO PHASES on create: stimulus first, then children. Children are BUFFERED
 * in local state and written only when the whole group is saved, because
 * creation is atomic server-side: a group whose children failed to write is a
 * passage with no questions, and children whose group failed to write are
 * unanswerable orphans that ordinary topic rules can still draw.
 *
 * ON EDIT the stimulus and metadata are editable here; children are ordinary
 * question documents and are edited through the normal question bank, which
 * already has the full per-engine editor, duplicate detection and rights
 * plumbing. Rebuilding that inside this component would be a second copy of
 * the most safety-critical form in the app.
 */

import { useState } from 'react';
import { motion } from 'motion/react';
import { Plus, Trash2, Pencil, ChevronLeft, Loader2, GripVertical, AlertTriangle } from 'lucide-react';
import { SubjectTopicSelect } from './SubjectTopicSelect';
import { ImageUploader } from './ImageUploader';
import { QuestionTypeEngine, type QuestionDraft } from './QuestionTypeEngine';
import { RichText } from './RichText';
import {
  GROUP_KINDS, GROUP_KIND_LABEL, buildEmptyGroup,
  type Difficulty, type GroupChildDraft, type GroupKind, type GroupStimulus,
  type QuestionEngine, type QuestionGroup, type QuestionOwnerType,
} from '../../../lib/questionBankService';

/** Exhaustive over QuestionEngine — a new engine will not compile until named. */
const ENGINE_LABEL: Record<QuestionEngine, string> = {
  mcq: 'MCQ', text: 'Text', match: 'Match', code: 'Code',
};

// ── Shared styles, matching QuestionTypeEngine ────────────────────

const inp: React.CSSProperties = {
  background: 'var(--ef-canvas-raised)',
  border: '1px solid var(--ef-border)',
  color: 'var(--ef-ink)',
  borderRadius: 2,
  fontSize: 13,
  padding: '8px 10px',
  width: '100%',
  outline: 'none',
};

function Field({ label, error, hint, children }: {
  label: string; error?: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <label className="block text-xs mb-1.5" style={{ color: 'var(--ef-text-subtle)' }}>{label}</label>
      {children}
      {hint  && <p className="text-xs mt-1.5" style={{ color: 'var(--ef-text-muted)' }}>{hint}</p>}
      {error && <p className="text-xs mt-1.5" style={{ color: 'var(--ef-danger)' }}>{error}</p>}
    </div>
  );
}

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

const FORMATS: Array<{ value: GroupStimulus['format']; label: string; hint: string }> = [
  { value: 'richtext', label: 'Passage / text', hint: 'Comprehension, caselets, puzzles, seating scenarios' },
  { value: 'table',    label: 'Data table',     hint: 'Structural rows and columns — reflows, and is readable aloud' },
  { value: 'image',    label: 'Figure',         hint: 'Charts and diagrams that genuinely are pictures' },
  { value: 'mixed',    label: 'Mixed',          hint: 'Text plus a table and/or figures' },
];

// ══════════════════════════════════════════════════════════════════
// TABLE EDITOR
// ══════════════════════════════════════════════════════════════════

/**
 * Structural DI table editor.
 *
 * Authors could paste a screenshot instead, and `format: 'image'` still lets
 * them. But an image of a table cannot reflow on a phone, cannot be zoomed
 * without losing the row a candidate was on, and cannot be read by a screen
 * reader — and this platform runs exams on mobile at the 'normal' tier. So
 * the structural path is the default and this is what makes it usable.
 */
function TableEditor({
  table, onChange,
}: {
  table: NonNullable<GroupStimulus['table']>;
  onChange: (t: NonNullable<GroupStimulus['table']>) => void;
}) {
  const cols = table.headers.length;

  const setHeader = (i: number, v: string) => {
    const headers = [...table.headers];
    headers[i] = v;
    onChange({ ...table, headers });
  };

  const setCell = (r: number, c: number, v: string) => {
    const rows = table.rows.map((row, ri) =>
      ri === r ? { cells: row.cells.map((cell, ci) => (ci === c ? v : cell)) } : row);
    onChange({ ...table, rows });
  };

  const addColumn = () => onChange({
    ...table,
    headers: [...table.headers, ''],
    rows: table.rows.map((row) => ({ cells: [...row.cells, ''] })),
  });

  const removeColumn = (i: number) => {
    if (cols <= 1) return;
    onChange({
      ...table,
      headers: table.headers.filter((_, hi) => hi !== i),
      rows: table.rows.map((row) => ({ cells: row.cells.filter((_, ci) => ci !== i) })),
    });
  };

  // New rows are padded to the current column count so a ragged table can
  // never be stored — the renderer would silently drop the missing cells.
  const addRow = () => onChange({
    ...table,
    rows: [...table.rows, { cells: Array.from({ length: cols }, () => '') }],
  });

  const removeRow = (i: number) => {
    if (table.rows.length <= 1) return;
    onChange({ ...table, rows: table.rows.filter((_, ri) => ri !== i) });
  };

  return (
    <div>
      <input
        value={table.caption ?? ''}
        onChange={(e) => onChange({ ...table, caption: e.target.value })}
        placeholder="Table caption (optional) — e.g. Regional sales, 2024"
        style={{ ...inp, marginBottom: 10 }}
      />

      <div style={{ overflowX: 'auto', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ width: 28 }} />
              {table.headers.map((h, ci) => (
                <th key={ci} style={{ padding: 4, minWidth: 110, background: 'var(--ef-canvas)' }}>
                  <div className="flex items-center gap-1">
                    <input
                      value={h}
                      onChange={(e) => setHeader(ci, e.target.value)}
                      placeholder={`Column ${ci + 1}`}
                      style={{ ...inp, fontWeight: 600, padding: '6px 8px' }}
                    />
                    <button
                      type="button"
                      onClick={() => removeColumn(ci)}
                      disabled={cols <= 1}
                      title="Remove column"
                      className="flex-shrink-0 transition-opacity hover:opacity-60 disabled:opacity-25"
                      style={{ color: 'var(--ef-text-muted)' }}
                    >
                      <Trash2 size={12} strokeWidth={1.5} />
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, ri) => (
              <tr key={ri}>
                <td style={{ padding: 4, textAlign: 'center' }}>
                  <button
                    type="button"
                    onClick={() => removeRow(ri)}
                    disabled={table.rows.length <= 1}
                    title="Remove row"
                    className="transition-opacity hover:opacity-60 disabled:opacity-25"
                    style={{ color: 'var(--ef-text-muted)' }}
                  >
                    <Trash2 size={12} strokeWidth={1.5} />
                  </button>
                </td>
                {row.cells.map((cell, ci) => (
                  <td key={ci} style={{ padding: 4 }}>
                    <input
                      value={cell}
                      onChange={(e) => setCell(ri, ci, e.target.value)}
                      style={{ ...inp, padding: '6px 8px' }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 mt-2">
        <button type="button" onClick={addRow}
          className="flex items-center gap-1 text-xs px-2 py-1 transition-opacity hover:opacity-70"
          style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-subtle)' }}>
          <Plus size={11} strokeWidth={1.5} /> Row
        </button>
        <button type="button" onClick={addColumn}
          className="flex items-center gap-1 text-xs px-2 py-1 transition-opacity hover:opacity-70"
          style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-subtle)' }}>
          <Plus size={11} strokeWidth={1.5} /> Column
        </button>
        <span className="text-xs ml-auto" style={{ color: 'var(--ef-text-muted)' }}>
          Cells accept $math$ like any other field.
        </span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// GROUP EDITOR
// ══════════════════════════════════════════════════════════════════

export type GroupEditorSave = {
  group: Omit<QuestionGroup, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt' | 'childIds'>;
  children: GroupChildDraft[];
};

interface Props {
  /** Editing an existing group: stimulus + metadata only, children untouched. */
  initialGroup?: QuestionGroup | null;
  /** How many children the group already has — display only, on edit. */
  existingChildCount?: number;
  ownerType?: QuestionOwnerType;
  ownerId?: string;
  instituteId?: string;
  onSave: (payload: GroupEditorSave) => Promise<void>;
  onCancel: () => void;
}

export function QuestionGroupEditor({
  initialGroup, existingChildCount, ownerType, ownerId, instituteId, onSave, onCancel,
}: Props) {
  const isEdit = !!initialGroup;
  const seed = initialGroup ?? buildEmptyGroup('di');

  const [phase, setPhase] = useState<'stimulus' | 'children'>('stimulus');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // ── Group fields ──────────────────────────────────────────────────
  const [kind,       setKind]       = useState<GroupKind>(seed.kind);
  const [title,      setTitle]      = useState(seed.title);
  const [stimulus,   setStimulus]   = useState<GroupStimulus>(seed.stimulus);
  const [subjectId,  setSubjectId]  = useState<string | null>(seed.subjectId ?? null);
  const [topicId,    setTopicId]    = useState<string | null>(seed.topicId ?? null);
  const [subject,    setSubject]    = useState(seed.subject);
  const [topic,      setTopic]      = useState(seed.topic);
  const [difficulty, setDifficulty] = useState<Difficulty>(seed.difficulty);
  const [tagsText,   setTagsText]   = useState((seed.tags ?? []).join(', '));

  // ── Buffered children (create only) ───────────────────────────────
  const [children, setChildren] = useState<GroupChildDraft[]>([]);
  const [childEditor, setChildEditor] = useState<{ index: number | null } | null>(null);

  const setFormat = (format: GroupStimulus['format']) => {
    // Switching format never destroys the other fields — an author who tries
    // 'table', types a passage, then switches back should find it intact.
    setStimulus((s) => ({
      ...s,
      format,
      ...(format === 'table' || format === 'mixed'
        ? { table: s.table ?? { headers: [''], rows: [{ cells: [''] }] } }
        : {}),
    }));
  };

  // ── Validation ────────────────────────────────────────────────────
  const validateStimulus = (): boolean => {
    const errs: Record<string, string> = {};
    if (!title.trim()) errs.title = 'A title is required — it is how you find this set later.';
    if (!subjectId) errs.subject = 'Subject is required.';
    if (!topicId)   errs.topic   = 'Topic is required.';

    const hasBody   = !!stimulus.body?.trim();
    const hasTable  = !!stimulus.table && stimulus.table.rows.some((r) => r.cells.some((c) => c.trim()));
    const hasImages = (stimulus.images ?? []).length > 0;

    if (stimulus.format === 'richtext' && !hasBody) {
      errs.stimulus = 'The passage or scenario text is required.';
    } else if (stimulus.format === 'table' && !hasTable) {
      errs.stimulus = 'The table needs at least one filled cell.';
    } else if (stimulus.format === 'image' && !hasImages) {
      errs.stimulus = 'Attach at least one figure.';
    } else if (stimulus.format === 'mixed' && !hasBody && !hasTable && !hasImages) {
      errs.stimulus = 'A mixed stimulus needs text, a table or a figure.';
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const buildGroup = (): GroupEditorSave['group'] => ({
    kind,
    title: title.trim(),
    stimulus,
    subject, topic,
    subjectId: subjectId ?? undefined,
    topicId:   topicId ?? undefined,
    tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean),
    difficulty,
    ownerType, ownerId, instituteId,
  });

  const handleContinue = () => {
    if (!validateStimulus()) return;
    // On edit there are no buffered children to collect — children live in the
    // bank already and are edited there.
    if (isEdit) { void commit(); return; }
    setPhase('children');
  };

  const commit = async () => {
    if (!isEdit && children.length === 0) {
      setErrors({ children: 'A set needs at least one question — the stimulus alone is not a question.' });
      return;
    }
    setSaving(true);
    try {
      await onSave({ group: buildGroup(), children });
    } finally {
      setSaving(false);
    }
  };

  // ── Child editor overlay ──────────────────────────────────────────
  if (childEditor) {
    const editing = childEditor.index !== null ? children[childEditor.index] : undefined;
    return (
      <div className="h-full flex flex-col">
        <div
          className="flex-shrink-0 px-6 py-3 flex items-center gap-2"
          style={{ borderBottom: '1px solid var(--ef-border)', background: 'var(--ef-canvas-raised)' }}
        >
          <button
            type="button"
            onClick={() => setChildEditor(null)}
            className="flex items-center gap-1 text-xs transition-opacity hover:opacity-60"
            style={{ color: 'var(--ef-text-muted)' }}
          >
            <ChevronLeft size={12} strokeWidth={1.5} /> Back to the set
          </button>
          <span className="text-xs ml-auto" style={{ color: 'var(--ef-text-muted)' }}>
            {childEditor.index === null
              ? `Question ${children.length + 1} of this set`
              : `Editing question ${childEditor.index + 1}`}
          </span>
        </div>
        <div className="flex-1 min-h-0">
          <QuestionTypeEngine
            /* The child inherits the SET's subject, topic and tags: a question
               filed under a different topic than its own stimulus would be
               unreachable by the rule that drew the set. Difficulty is NOT
               inherited — sets routinely ramp, and the rule matches on the
               group's difficulty, not the child's. */
            initialData={editing ? {
              ...editing,
              subject, topic,
              subjectId: subjectId ?? undefined,
              topicId: topicId ?? undefined,
            } as QuestionDraft : undefined}
            ownerType={ownerType}
            ownerId={ownerId}
            instituteId={instituteId}
            onSave={async (draft) => {
              const child: GroupChildDraft = {
                ...draft,
                subject, topic,
                subjectId: subjectId ?? undefined,
                topicId:   topicId ?? undefined,
              };
              setChildren((prev) => childEditor.index === null
                ? [...prev, child]
                : prev.map((c, i) => (i === childEditor.index ? child : c)));
              setChildEditor(null);
              setErrors((e) => ({ ...e, children: '' }));
            }}
            onCancel={() => setChildEditor(null)}
          />
        </div>
      </div>
    );
  }

  // ── Children phase ────────────────────────────────────────────────
  if (phase === 'children') {
    return (
      <div className="h-full flex flex-col">
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="flex items-center gap-2 mb-5">
            <button
              type="button"
              onClick={() => setPhase('stimulus')}
              className="flex items-center gap-1 text-xs transition-opacity hover:opacity-60"
              style={{ color: 'var(--ef-text-muted)' }}
            >
              <ChevronLeft size={11} strokeWidth={1.5} /> Stimulus
            </button>
            <span className="text-xs ml-auto" style={{ color: 'var(--ef-text-muted)' }}>
              {GROUP_KIND_LABEL[kind]} · {subject} › {topic}
            </span>
          </div>

          <p className="text-xs mb-4" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
            QUESTIONS IN THIS SET
          </p>

          {children.length === 0 && (
            <div
              className="px-4 py-8 text-center mb-4"
              style={{ border: '1px dashed var(--ef-border)', borderRadius: 2 }}
            >
              <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                No questions yet. A set needs at least one.
              </p>
            </div>
          )}

          <div className="space-y-2 mb-4">
            {children.map((c, i) => (
              <div
                key={i}
                className="flex items-start gap-3 px-3 py-2.5"
                style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-canvas-raised)' }}
              >
                <GripVertical size={13} strokeWidth={1.5} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--ef-text-muted)' }} />
                <span className="text-xs flex-shrink-0 mt-0.5" style={{ color: 'var(--ef-text-muted)', minWidth: 18 }}>
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <RichText
                    text={c.stem}
                    style={{ fontSize: 12.5, color: 'var(--ef-ink)', lineHeight: '1.5',
                      display: '-webkit-box', WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}
                  />
                  <p className="text-xs mt-1" style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>
                    {/* Was a three-arm ternary ending in 'Match', so a coding
                        child was labelled "Match". ENGINE_LABEL is exhaustive
                        over QuestionEngine, so a fifth engine fails the build
                        rather than silently borrowing the last arm. */}
                    {ENGINE_LABEL[c.engine]} · {c.difficulty}
                  </p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button type="button" title="Edit" onClick={() => setChildEditor({ index: i })}
                    className="p-1 transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}>
                    <Pencil size={12} strokeWidth={1.5} />
                  </button>
                  <button type="button" title="Remove" onClick={() => setChildren((p) => p.filter((_, j) => j !== i))}
                    className="p-1 transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}>
                    <Trash2 size={12} strokeWidth={1.5} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setChildEditor({ index: null })}
            className="flex items-center gap-1.5 text-xs px-3 py-2 transition-opacity hover:opacity-70"
            style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-subtle)' }}
          >
            <Plus size={12} strokeWidth={1.5} /> Add a question to this set
          </button>

          {errors.children && (
            <p className="text-xs mt-3" style={{ color: 'var(--ef-danger)' }}>{errors.children}</p>
          )}
        </div>

        <div className="flex-shrink-0 px-6 py-4 flex items-center gap-3" style={{ borderTop: '1px solid var(--ef-border)' }}>
          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={commit}
            disabled={saving || children.length === 0}
            className="flex items-center gap-2 text-xs px-4 py-2 disabled:opacity-40"
            style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2 }}
          >
            {saving && <Loader2 size={12} className="animate-spin" />}
            Save set{children.length > 0 ? ` (${children.length} question${children.length === 1 ? '' : 's'})` : ''}
          </motion.button>
          <button onClick={onCancel} className="text-xs px-4 py-2"
            style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2 }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Stimulus phase ────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto px-6 py-6">

        <Field label="Set type *" hint="Changes the label candidates see; the model is identical for all five.">
          <div className="flex flex-wrap gap-1.5">
            {GROUP_KINDS.map((k) => {
              const active = kind === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className="text-xs px-2.5 py-1.5 transition-all"
                  style={{
                    border: active ? '1.5px solid var(--ef-ink)' : '1px solid var(--ef-border)',
                    background: active ? 'var(--ef-canvas)' : 'var(--ef-surface)',
                    color: active ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
                    borderRadius: 2,
                  }}
                >
                  {GROUP_KIND_LABEL[k]}
                </button>
              );
            })}
          </div>
        </Field>

        <Field
          label="Title *"
          error={errors.title}
          hint="Internal only — candidates never see it. Use something you can search for."
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. DI — Regional sales 2024 (hard)"
            style={inp}
          />
        </Field>

        <Field label="Stimulus format *">
          <div className="space-y-1.5">
            {FORMATS.map((f) => {
              const active = stimulus.format === f.value;
              return (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFormat(f.value)}
                  className="w-full text-left px-3 py-2 transition-all"
                  style={{
                    border: active ? '1.5px solid var(--ef-ink)' : '1px solid var(--ef-border)',
                    background: active ? 'var(--ef-canvas)' : 'var(--ef-surface)',
                    borderRadius: 2,
                  }}
                >
                  <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>{f.label}</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>{f.hint}</p>
                </button>
              );
            })}
          </div>
        </Field>

        {(stimulus.format === 'richtext' || stimulus.format === 'mixed') && (
          <Field
            label={stimulus.format === 'mixed' ? 'Text' : 'Passage / scenario *'}
            error={stimulus.format === 'richtext' ? errors.stimulus : undefined}
            hint="Supports $inline$ and $$block$$ math."
          >
            <textarea
              value={stimulus.body ?? ''}
              onChange={(e) => setStimulus((s) => ({ ...s, body: e.target.value }))}
              rows={10}
              placeholder="Paste the passage, caselet or scenario here…"
              style={{ ...inp, resize: 'vertical', lineHeight: 1.7, minHeight: 180 }}
            />
          </Field>
        )}

        {(stimulus.format === 'table' || stimulus.format === 'mixed') && (
          <Field
            label={stimulus.format === 'mixed' ? 'Data table' : 'Data table *'}
            error={stimulus.format === 'table' ? errors.stimulus : undefined}
          >
            <TableEditor
              table={stimulus.table ?? { headers: [''], rows: [{ cells: [''] }] }}
              onChange={(t) => setStimulus((s) => ({ ...s, table: t }))}
            />
          </Field>
        )}

        {(stimulus.format === 'image' || stimulus.format === 'mixed') && (
          <Field
            label={stimulus.format === 'mixed' ? 'Figure' : 'Figure *'}
            error={stimulus.format === 'image' ? errors.stimulus : undefined}
            hint="Charts and diagrams. Prefer a data table when the content is tabular — a table image is unreadable on a phone."
          >
            <ImageUploader
              value={(stimulus.images ?? [])[0]}
              onChange={(url) => setStimulus((s) => ({ ...s, images: url ? [url] : [] }))}
              label="Attach figure"
            />
          </Field>
        )}

        {errors.stimulus && stimulus.format === 'mixed' && (
          <p className="text-xs mb-4" style={{ color: 'var(--ef-danger)' }}>{errors.stimulus}</p>
        )}

        <div style={{ borderTop: '1px solid var(--ef-border-subtle)', margin: '0 0 20px' }} />
        <p className="text-xs mb-4" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>METADATA</p>

        <SubjectTopicSelect
          subjectId={subjectId}
          topicId={topicId}
          onChange={(v) => {
            setSubjectId(v.subjectId); setSubject(v.subjectName);
            setTopicId(v.topicId);     setTopic(v.topicName);
          }}
          subjectError={errors.subject}
          topicError={errors.topic}
        />

        <Field
          label="Set difficulty *"
          hint="Selection rules match on THIS, not on the individual questions — sets routinely ramp inside themselves."
        >
          <div className="flex gap-1.5">
            {DIFFICULTIES.map((d) => {
              const active = difficulty === d;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDifficulty(d)}
                  className="text-xs px-3 py-1.5 capitalize transition-all"
                  style={{
                    border: active ? '1.5px solid var(--ef-ink)' : '1px solid var(--ef-border)',
                    background: active ? 'var(--ef-canvas)' : 'var(--ef-surface)',
                    color: active ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
                    borderRadius: 2,
                  }}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Tags" hint="Comma-separated.">
          <input
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="e.g. bar-chart, percentages"
            style={inp}
          />
        </Field>

        {isEdit && (
          <div
            className="flex items-start gap-2 px-3 py-2.5"
            style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-canvas-raised)' }}
          >
            <AlertTriangle size={13} strokeWidth={1.5} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--ef-text-muted)' }} />
            <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
              Editing the stimulus only.{typeof existingChildCount === 'number'
                ? ` This set's ${existingChildCount} question${existingChildCount === 1 ? '' : 's'} are`
                : ' The questions in this set are'} edited individually in the question bank.
              Papers already published keep the questions they froze at publish time.
            </p>
          </div>
        )}
      </div>

      <div className="flex-shrink-0 px-6 py-4 flex items-center gap-3" style={{ borderTop: '1px solid var(--ef-border)' }}>
        <motion.button
          whileTap={{ scale: 0.98 }}
          onClick={handleContinue}
          disabled={saving}
          className="flex items-center gap-2 text-xs px-4 py-2 disabled:opacity-40"
          style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2 }}
        >
          {saving && <Loader2 size={12} className="animate-spin" />}
          {isEdit ? 'Save changes' : 'Continue to questions'}
        </motion.button>
        <button onClick={onCancel} className="text-xs px-4 py-2"
          style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
