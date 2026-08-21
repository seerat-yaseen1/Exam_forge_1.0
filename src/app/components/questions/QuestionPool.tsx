/**
 * The question list, its filters, and the three dialogs that go with it.
 *
 * ── WHY IT IS ONE COMPONENT ───────────────────────────────────────
 * Three consoles show a pool of questions. The Web Owner's page already had
 * a shared core (QuestionBankCore); the institute's and the faculty's did
 * not, so between them they carried two copies of the same 800-line page:
 * the same type badge, the same difficulty chip, the same search-and-filter
 * bar with hand-painted button states, the same delete confirmation, the
 * same preview modal, the same slide-over editor. They had already drifted —
 * the faculty page's row is a hair taller and its empty state says something
 * different — and neither was usable on a phone, because both laid the row
 * out as a fixed row of flex children that simply ran off the side.
 *
 * What genuinely differs between the two is permission, not presentation:
 * who may edit which question, and whether a faculty member acts directly or
 * raises a request. That stays on the pages, as callbacks. Everything you
 * can see is here.
 *
 * ── THE ROW IS A TABLE ROW ────────────────────────────────────────
 * Which sounds obvious and was not what either page did. Making it a real
 * DataTable is what gives it the phone layout for free: the stem becomes the
 * card's heading and difficulty, date and actions become labelled lines
 * under it, instead of four columns fighting over 390px.
 */

import React, { useMemo, useState } from 'react';
import { AlertTriangle, Plus, Search, Trash2 } from 'lucide-react';
import {
  questionTypeBadge,
  difficultyColor,
  type Question,
  type Difficulty,
} from '../../../lib/questionBankService';
import { itemTypeIdForQuestion, liveQuestionItemTypes } from '../../../lib/itemTypes';
import { formatDate, truncate } from '../../../lib/dateFormat';
import { Button, EmptyState } from '../console/ui';
import {
  DataTable, FilterChips, RowMenu, SearchField, Sheet, TableSkeleton, Toolbar,
  type Column, type RowAction,
} from '../console/data';
import { QuestionPreview } from './QuestionPreview';

// ── Badges ────────────────────────────────────────────────────────

export function TypeBadge({ engine, variant }: Pick<Question, 'engine' | 'variant'>) {
  return (
    <span
      className="ef-chip ef-chip--sm"
      data-tone="solid"
      style={{ letterSpacing: '0.04em', flexShrink: 0 }}
    >
      {questionTypeBadge(engine, variant)}
    </span>
  );
}

export function DifficultyBadge({ difficulty }: { difficulty: Difficulty }) {
  const { bg, text, border } = difficultyColor(difficulty);
  return (
    <span
      className="ef-chip ef-chip--sm capitalize"
      style={{ background: bg, color: text, borderColor: border }}
    >
      {difficulty}
    </span>
  );
}

// ── Filters ───────────────────────────────────────────────────────

// Registry-derived; filters on the type ID, not on the badge text. See the
// same constant in QuestionBankCore for why the two were split apart.
const TYPE_FILTERS = [
  { value: '', label: 'All types' },
  ...liveQuestionItemTypes().map(({ def }) => ({ value: def.id as string, label: def.badge })),
];

const DIFF_FILTERS: Array<{ value: string; label: string; tone?: string }> = [
  { value: '', label: 'Any difficulty' },
  { value: 'easy', label: 'Easy', tone: 'success' },
  { value: 'medium', label: 'Medium', tone: 'warning' },
  { value: 'hard', label: 'Hard', tone: 'danger' },
];

export type PoolFilters = {
  search: string;
  type: string;
  difficulty: string;
};

export const NO_FILTERS: PoolFilters = { search: '', type: '', difficulty: '' };

export function filterQuestions(questions: Question[], f: PoolFilters): Question[] {
  const s = f.search.trim().toLowerCase();
  return questions.filter((q) => {
    if (f.type && itemTypeIdForQuestion(q.engine, q.variant) !== f.type) return false;
    if (f.difficulty && q.difficulty !== f.difficulty) return false;
    if (!s) return true;
    return (
      q.stem.toLowerCase().includes(s) ||
      q.subject.toLowerCase().includes(s) ||
      q.topic.toLowerCase().includes(s)
    );
  });
}

export function isFiltered(f: PoolFilters): boolean {
  return !!(f.search.trim() || f.type || f.difficulty);
}

// ── The list ──────────────────────────────────────────────────────

export type QuestionRowMeta = {
  /**
   * A short word for who wrote it — "Mine", or a colleague's name.
   * `null` where authorship carries no information (a pool of one author).
   */
  author?: string | null;
  /** Whether `author` is the viewer, which is the only one drawn in success. */
  mine?: boolean;
};

export function QuestionPool({
  questions,
  loading,
  filters,
  onFilters,
  meta,
  actions,
  onPreview,
  onAdd,
  addLabel = 'Add question',
  emptyBody,
  toolbarEnd,
}: {
  /** Already filtered. The caller owns the filtering so it can count both. */
  questions: Question[];
  total?: number;
  loading: boolean;
  filters: PoolFilters;
  onFilters: (next: PoolFilters) => void;
  /** Per-question authorship, for the badge on a shared pool. */
  meta?: (q: Question) => QuestionRowMeta;
  /** The overflow menu for one question. Empty array hides the menu. */
  actions?: (q: Question) => RowAction[];
  onPreview: (q: Question) => void;
  onAdd?: () => void;
  addLabel?: string;
  /** What to say when the pool is empty for reasons other than a filter. */
  emptyBody: string;
  /** Export, bulk upload — whatever this console offers. */
  toolbarEnd?: React.ReactNode;
}) {
  const columns: Column<Question>[] = useMemo(
    () => [
      {
        key: 'question',
        header: 'Question',
        primary: true,
        cell: (q) => {
          const m = meta?.(q) ?? {};
          return (
            <button
              type="button"
              className="ef-row-link text-left"
              onClick={() => onPreview(q)}
              title="Preview this question"
            >
              <span className="flex items-start gap-2">
                <TypeBadge engine={q.engine} variant={q.variant} />
                <span className="ef-t-sm ef-ink" style={{ lineHeight: 'var(--ef-leading-normal)' }}>
                  {truncate(q.stem, 130) || <em className="ef-muted">No stem</em>}
                </span>
              </span>
              <span className="flex items-center gap-1.5 flex-wrap" style={{ marginTop: 6 }}>
                {m.author && (
                  <span
                    className="ef-chip ef-chip--sm"
                    data-tone={m.mine ? 'success' : 'warning'}
                    title={m.mine ? 'You wrote this' : `Written by ${m.author}`}
                  >
                    {m.author}
                  </span>
                )}
                {q.subject && <span className="ef-t-xs ef-muted">{q.subject}</span>}
                {q.topic && <span className="ef-t-xs ef-muted">· {q.topic}</span>}
                {q.tags.slice(0, 3).map((tag) => (
                  <span key={tag} className="ef-chip ef-chip--sm">
                    #{tag}
                  </span>
                ))}
              </span>
            </button>
          );
        },
      },
      {
        key: 'difficulty',
        header: 'Difficulty',
        width: 120,
        cell: (q) => <DifficultyBadge difficulty={q.difficulty} />,
      },
      {
        key: 'added',
        header: 'Added',
        width: 132,
        cell: (q) => <span className="ef-t-xs ef-muted">{formatDate(q.createdAt)}</span>,
      },
      ...(actions
        ? [
            {
              key: 'actions',
              header: '',
              label: 'Actions',
              align: 'right' as const,
              width: 64,
              cell: (q: Question) => {
                const list = actions(q);
                if (list.length === 0) return null;
                return <RowMenu label="Question actions" actions={list} />;
              },
            },
          ]
        : []),
    ],
    [meta, actions, onPreview],
  );

  return (
    <>
      <Toolbar end={toolbarEnd}>
        <SearchField
          value={filters.search}
          onChange={(search) => onFilters({ ...filters, search })}
          label="Search questions"
          placeholder="Search a stem, subject or topic…"
        />
      </Toolbar>

      {/* Two rows rather than one with a divider between them. There are
          thirteen type chips: on any narrow screen the single row wraps, and
          a vertical rule that was between the groups ends up at the start of
          a line, separating nothing from nothing. */}
      <div className="flex flex-col" style={{ gap: 8, marginBottom: 'var(--ef-gap)' }}>
        <FilterChips
          label="Question type"
          value={filters.type}
          onChange={(type) => onFilters({ ...filters, type })}
          options={TYPE_FILTERS}
        />
        <FilterChips
          label="Difficulty"
          value={filters.difficulty}
          onChange={(difficulty) => onFilters({ ...filters, difficulty })}
          options={DIFF_FILTERS}
        />
      </div>

      {loading ? (
        <TableSkeleton rows={6} columns={4} />
      ) : (
        <DataTable
          columns={columns}
          rows={questions}
          rowKey={(q) => q.id}
          caption="Questions in this pool"
          empty={
            isFiltered(filters) ? (
              <EmptyState
                icon={<Search size={28} strokeWidth={1.1} />}
                title="Nothing matches"
                body="No question matches this search and these filters."
                action={<Button onClick={() => onFilters(NO_FILTERS)}>Clear filters</Button>}
              />
            ) : (
              <EmptyState
                icon={<Plus size={28} strokeWidth={1.1} />}
                title="No questions yet"
                body={emptyBody}
                action={
                  onAdd && (
                    <Button variant="primary" onClick={onAdd}>
                      <Plus size={13} strokeWidth={1.9} />
                      {addLabel}
                    </Button>
                  )
                }
              />
            )
          }
        />
      )}
    </>
  );
}

// ── The dialogs ───────────────────────────────────────────────────

export function PreviewSheet({ question, onClose }: { question: Question | null; onClose: () => void }) {
  return (
    <Sheet
      open={!!question}
      onClose={onClose}
      variant="centre"
      title="Question preview"
      description="Exactly what a candidate sees, plus the key."
    >
      {question && <QuestionPreview question={question} showAnswers showMeta showExplanation />}
    </Sheet>
  );
}

/**
 * The delete confirmation.
 *
 * `consequence` is a prop because the two consoles genuinely differ: an
 * institute admin's delete is immediate, a faculty member in request mode is
 * asking someone else to do it. Saying "permanently removed" to the second
 * one would be a lie.
 */
export function DeleteQuestionSheet({
  question,
  onConfirm,
  onCancel,
  busy,
  consequence,
  confirmLabel = 'Delete question',
}: {
  question: Question | null;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  consequence: string;
  confirmLabel?: string;
}) {
  return (
    <Sheet
      open={!!question}
      onClose={onCancel}
      variant="centre"
      title="Delete this question?"
      footer={
        <div className="flex items-center gap-2.5">
          <Button variant="danger" size="lg" onClick={onConfirm} loading={busy}>
            {!busy && <Trash2 size={13} strokeWidth={1.8} />}
            {busy ? 'Working…' : confirmLabel}
          </Button>
          <Button size="lg" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      }
    >
      {question && (
        <div className="flex flex-col" style={{ gap: 14 }}>
          <div
            className="flex items-start gap-2.5"
            style={{
              padding: '11px 13px',
              background: 'var(--ef-danger-bg)',
              border: '1px solid var(--ef-danger-border)',
              borderRadius: 'var(--ef-radius-sm)',
            }}
          >
            <AlertTriangle size={14} strokeWidth={1.7} style={{ color: 'var(--ef-danger)', flexShrink: 0, marginTop: 1 }} />
            <p className="ef-t-sm" style={{ color: 'var(--ef-danger)', lineHeight: 'var(--ef-leading-relaxed)' }}>
              {consequence}
            </p>
          </div>
          <div
            style={{
              padding: '12px 14px',
              background: 'var(--ef-canvas-raised)',
              border: '1px solid var(--ef-border)',
              borderRadius: 'var(--ef-radius-sm)',
            }}
          >
            <div className="flex items-center gap-2 mb-2">
              <TypeBadge engine={question.engine} variant={question.variant} />
              <DifficultyBadge difficulty={question.difficulty} />
            </div>
            <p className="ef-t-sm ef-ink" style={{ lineHeight: 'var(--ef-leading-relaxed)' }}>
              {truncate(question.stem, 160) || <em className="ef-muted">No stem</em>}
            </p>
          </div>
        </div>
      )}
    </Sheet>
  );
}

/** The slide-over the question editor lives in. */
export function EditorSheet({
  open,
  mode,
  onClose,
  children,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      flush
      title={mode === 'create' ? 'New question' : 'Edit question'}
      description={
        mode === 'create'
          ? 'Pick a type, write the stem, set the key.'
          : 'Changes apply everywhere this question is already used.'
      }
    >
      {children}
    </Sheet>
  );
}

/** Small hook so both pages hold the filter state the same way. */
export function usePoolFilters() {
  return useState<PoolFilters>(NO_FILTERS);
}
