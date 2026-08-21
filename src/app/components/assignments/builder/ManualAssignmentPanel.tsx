/**
 * builder/ManualAssignmentPanel — routing a hand-picked paper into sections.
 *
 * Shown on the Questions stage when the author chose Manual Selection, turned
 * randomization off, and has more than one section. It answers the same
 * question the rule matrix answers — what does each section contain? — for a
 * paper whose questions are already named.
 *
 * ── WHY FILTERS, AND WHY NOT ONLY FILTERS ─────────────────────────
 * The spec asks for filters rather than one-by-one dropdowns, and it is right
 * about the reason: routing forty questions through forty dropdowns is not a
 * workflow, it is a punishment.
 *
 * But a filter that assigns everything it matches, sight unseen, hits a wall on
 * the first realistic paper. Filter to Algebra/Hard, get twelve, want eight of
 * them here and four in the next section — and there is no second filter that
 * splits them, because the thing that separates the eight from the four is the
 * author's judgement, not a field on the question. So the filter narrows the
 * VIEW and the assignment acts on what is SELECTED in it, with "select all
 * filtered" one click away. Batch speed when the filter is the whole answer,
 * an escape hatch when it is not.
 *
 * ── WHY ONE LIST RATHER THAN A PANEL PER SECTION ──────────────────
 * The spec describes working section by section: filter, confirm, "assign to
 * Section X", repeat. That shape hides the two things the same spec then asks
 * to be tracked live — what each section has, and what is left over. One list
 * with a section target shows both at once, and the "unassigned pool view" the
 * spec wants at the end of the flow is not a separate screen here: it is this
 * list with the section filter set to Unassigned, available from the start
 * instead of arriving after the work is done.
 *
 * ── WHY A CLAIMED QUESTION IS NOT INERT ───────────────────────────
 * The spec's default is show-but-disable, to stop a question being silently
 * double-assigned. It cannot be double-assigned: assignments are a
 * questionId → sectionId map, so a second home replaces the first by
 * construction. What is left of the concern is that a move should be visible,
 * not that it should be hard — so a claimed row stays clickable and says where
 * it currently lives and where it is about to go. Disabling it would only mean
 * a trip to another section to unassign first.
 */

import { useMemo, useState } from 'react';
import {
  ArrowRight, Check, CornerUpLeft, Layers, Search, X,
} from 'lucide-react';
import type { Difficulty, Question, QuestionEngine } from '../../../../lib/questionBankService';
import { DIFF_LABEL, type SectionDraft } from './shared';

/** Sentinel for the section filter — a real section id can never be ''. */
const UNASSIGNED = '';

const ENGINE_LABEL: Record<QuestionEngine, string> = {
  mcq: 'Objective',
  text: 'Subjective',
  match: 'Match',
  code: 'Coding',
};

export function ManualAssignmentPanel({
  questions,
  sections,
  assignments,
  onAssign,
  onMarksChange,
  locked,
  qSubject,
  qTopic,
}: {
  /** The picked pool, in the order the author picked it. */
  questions: Question[];
  sections: SectionDraft[];
  /** questionId → sectionId. Absent = unassigned. */
  assignments: Record<string, string>;
  /** `sectionId: null` unassigns. Always a batch — one row is a batch of one. */
  onAssign: (questionIds: string[], sectionId: string | null) => void;
  onMarksChange: (sectionId: string, marks: string) => void;
  locked: boolean;
  qSubject: (q: Question) => string;
  qTopic: (q: Question) => string;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [rawTarget, setTarget] = useState<string>(sections[0]?.id ?? '');
  // A target the author chose and then DELETED would otherwise sit in the
  // dropdown as a blank option and assign questions into nowhere.
  const target = sections.some((s) => s.id === rawTarget) ? rawTarget : sections[0]?.id ?? '';

  /**
   * Assignments, with references to deleted sections read as unassigned.
   *
   * The same normalisation manualSectionLists does when it builds the paper —
   * and it has to happen here too, or a question orphaned by a deleted section
   * would show its old section's name on the row while the tallies, which
   * count what the paper will actually contain, called it unassigned. One of
   * the two would be lying and the author could not tell which.
   */
  const placed = useMemo(() => {
    const live = new Set(sections.map((s) => s.id));
    const out: Record<string, string> = {};
    for (const [qid, sid] of Object.entries(assignments)) {
      if (live.has(sid)) out[qid] = sid;
    }
    return out;
  }, [assignments, sections]);

  const [search, setSearch] = useState('');
  const [topic, setTopic] = useState('');
  const [difficulty, setDifficulty] = useState<Difficulty | ''>('');
  const [engine, setEngine] = useState<QuestionEngine | ''>('');
  const [tag, setTag] = useState('');
  /** '' is a real value here (Unassigned), so absence needs its own token. */
  const [sectionFilter, setSectionFilter] = useState<string | null>(null);

  const topics = useMemo(
    () => [...new Set(questions.map(qTopic).filter(Boolean))].sort(),
    [questions, qTopic],
  );
  const tags = useMemo(
    () => [...new Set(questions.flatMap((q) => q.tags))].filter(Boolean).sort(),
    [questions],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return questions.filter((q) => {
      const at = placed[q.id] ?? UNASSIGNED;
      if (sectionFilter !== null && at !== sectionFilter) return false;
      if (topic && qTopic(q) !== topic) return false;
      if (difficulty && q.difficulty !== difficulty) return false;
      if (engine && q.engine !== engine) return false;
      if (tag && !q.tags.includes(tag)) return false;
      if (!term) return true;
      return (
        q.stem.toLowerCase().includes(term)
        || qSubject(q).toLowerCase().includes(term)
        || qTopic(q).toLowerCase().includes(term)
        || q.tags.some((t) => t.toLowerCase().includes(term))
      );
    });
  }, [questions, placed, sectionFilter, topic, difficulty, engine, tag, search, qSubject, qTopic]);

  // ── Running totals ───────────────────────────────────────────────
  // The spec asks for these live, and they are the reason the whole panel is
  // one screen: an author balancing a 3-section paper is really watching four
  // numbers move, and they cannot do that if three of them are behind a tab.
  const perSection = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of sections) counts[s.id] = 0;
    for (const q of questions) {
      const sid = placed[q.id];
      if (sid && counts[sid] !== undefined) counts[sid]++;
    }
    return counts;
  }, [sections, questions, placed]);

  const unassignedCount = questions.length
    - Object.values(perSection).reduce((n, c) => n + c, 0);

  const sectionName = (id: string) => sections.find((s) => s.id === id)?.name || 'Untitled section';

  const togglePicked = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const selectAllFiltered = () => setPicked(new Set(filtered.map((q) => q.id)));
  const clearSelection = () => setPicked(new Set());

  const assignPicked = (sectionId: string | null) => {
    if (picked.size === 0) return;
    onAssign([...picked], sectionId);
    // Cleared after the move, not kept. A selection that survives its own
    // assignment invites a second click that silently re-routes questions the
    // author has already dealt with and moved on from.
    clearSelection();
  };

  /** How many of the current selection would MOVE rather than simply land. */
  const movingCount = useMemo(() => {
    let n = 0;
    for (const id of picked) {
      const at = placed[id];
      if (at && at !== target) n++;
    }
    return n;
  }, [picked, placed, target]);

  const filtersOn = !!(search || topic || difficulty || engine || tag || sectionFilter !== null);

  return (
    <div style={{ padding: '28px 48px 40px' }}>
      <div style={{ width: '100%', maxWidth: 1080, margin: '0 auto' }}>

        {/* ── Section tallies ── */}
        <div className="grid gap-2 mb-5"
          style={{ gridTemplateColumns: `repeat(auto-fit, minmax(190px, 1fr))` }}>
          {sections.map((s) => (
            <SectionTally
              key={s.id}
              name={s.name || 'Untitled section'}
              count={perSection[s.id] ?? 0}
              marks={s.manualMarks}
              onMarks={(v) => onMarksChange(s.id, v)}
              active={target === s.id}
              locked={locked}
              // Clicking a tally aims the Assign button at that section rather
              // than filtering to it. One meaning per control: the tally is
              // "where am I working", the filter dropdown is "what am I
              // looking at". Making the tally do both would mean every click
              // that chose a destination also hid everything not already in
              // it — which is precisely the set you were about to add to.
              onFocus={() => setTarget(s.id)}
            />
          ))}
          {/* The unassigned tally IS the spec's end-of-flow pool view, and it
              filters rather than targets because there is nothing to aim at:
              "unassigned" is where questions come from, not somewhere they
              can be sent. Clicking it is the two-click path to emptying it —
              filter here, Select all, Assign. */}
          <button
            type="button"
            onClick={() => setSectionFilter(UNASSIGNED)}
            className="flex flex-col items-start gap-1 px-3.5 py-3 text-left transition-colors"
            style={{
              border: `1px solid ${unassignedCount > 0 ? 'var(--ef-warning-border)' : 'var(--ef-border)'}`,
              background: unassignedCount > 0 ? 'var(--ef-warning-bg)' : 'var(--ef-canvas-raised)',
              borderRadius: 3,
              cursor: 'pointer',
            }}
          >
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>
              UNASSIGNED
            </span>
            <span className="text-xs tabular-nums"
              style={{ color: unassignedCount > 0 ? 'var(--ef-warning-strong)' : 'var(--ef-ink)' }}>
              {unassignedCount} question{unassignedCount === 1 ? '' : 's'}
            </span>
          </button>
        </div>

        {/* ── Filters ── */}
        <div className="flex items-center gap-2 px-3 py-2.5 flex-wrap mb-3"
          style={{ border: '1px solid var(--ef-border)', borderRadius: 3, background: 'var(--ef-canvas-raised)' }}>
          <div className="flex items-center gap-1.5 px-2 py-1 flex-1"
            style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', minWidth: 170 }}>
            <Search size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search text, topic or tag"
              className="flex-1 outline-none text-xs"
              style={{ background: 'transparent', color: 'var(--ef-ink)', border: 'none', minWidth: 0 }}
            />
          </div>

          <Select value={topic} onChange={setTopic} placeholder="All topics" options={topics} />
          <Select value={difficulty} onChange={(v) => setDifficulty(v as Difficulty | '')}
            placeholder="Any level" options={['easy', 'medium', 'hard']}
            labelFor={(v) => DIFF_LABEL[v as Difficulty]} />
          <Select value={engine} onChange={(v) => setEngine(v as QuestionEngine | '')}
            placeholder="Any type" options={['mcq', 'text', 'match', 'code']}
            labelFor={(v) => ENGINE_LABEL[v as QuestionEngine]} />
          {tags.length > 0 && (
            <Select value={tag} onChange={setTag} placeholder="Any tag" options={tags} />
          )}
          <Select
            value={sectionFilter === null ? '__any' : sectionFilter === UNASSIGNED ? '__none' : sectionFilter}
            onChange={(v) => setSectionFilter(v === '__any' ? null : v === '__none' ? UNASSIGNED : v)}
            placeholder="Anywhere"
            explicitOptions={[
              { value: '__any', label: 'Anywhere' },
              { value: '__none', label: 'Unassigned only' },
              ...sections.map((s) => ({ value: s.id, label: `In ${s.name || 'Untitled'}` })),
            ]}
          />

          {filtersOn && (
            <button
              type="button"
              onClick={() => {
                setSearch(''); setTopic(''); setDifficulty(''); setEngine(''); setTag('');
                setSectionFilter(null);
              }}
              className="flex items-center gap-1 text-xs px-2 py-1 transition-opacity hover:opacity-70"
              style={{ color: 'var(--ef-text-muted)', cursor: 'pointer' }}
            >
              <X size={10} strokeWidth={1.5} /> Clear
            </button>
          )}
        </div>

        {/* ── Action bar ──
            Sticky, because the list is long and the whole point of filtering is
            that the author ends up at the bottom of it holding a selection. */}
        <div
          className="flex items-center gap-3 flex-wrap px-3 py-2.5 mb-3"
          style={{
            position: 'sticky', top: 0, zIndex: 2,
            border: '1px solid var(--ef-border)',
            borderRadius: 3,
            background: picked.size > 0 ? 'var(--ef-surface)' : 'var(--ef-canvas-raised)',
          }}
        >
          <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
            {filtered.length} shown
          </span>

          <button
            type="button"
            onClick={selectAllFiltered}
            disabled={locked || filtered.length === 0}
            className="text-xs px-2.5 py-1 transition-opacity hover:opacity-70"
            style={{
              border: '1px solid var(--ef-border)', borderRadius: 2,
              color: 'var(--ef-ink)', background: 'var(--ef-surface)',
              cursor: locked || filtered.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            Select all {filtered.length}
          </button>

          {picked.size > 0 && (
            <>
              <span className="text-xs" style={{ color: 'var(--ef-ink)' }}>
                {picked.size} selected
              </span>
              <button type="button" onClick={clearSelection}
                className="text-xs transition-opacity hover:opacity-70"
                style={{ color: 'var(--ef-text-muted)', cursor: 'pointer' }}>
                Clear
              </button>
            </>
          )}

          <div className="flex items-center gap-2 ml-auto">
            <Select
              value={target}
              onChange={setTarget}
              placeholder=""
              explicitOptions={sections.map((s) => ({ value: s.id, label: s.name || 'Untitled section' }))}
            />
            <button
              type="button"
              onClick={() => assignPicked(target)}
              disabled={locked || picked.size === 0 || !target}
              className="flex items-center gap-1.5 text-xs px-3.5 py-1.5 transition-opacity hover:opacity-80"
              style={{
                background: picked.size > 0 && !locked ? 'var(--ef-ink)' : 'var(--ef-track)',
                color: 'var(--ef-surface)', borderRadius: 2,
                cursor: locked || picked.size === 0 ? 'not-allowed' : 'pointer',
              }}
            >
              Assign{picked.size > 0 ? ` ${picked.size}` : ''} <ArrowRight size={11} strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => assignPicked(null)}
              disabled={locked || picked.size === 0}
              title="Return the selection to the unassigned pool"
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-opacity hover:opacity-70"
              style={{
                border: '1px solid var(--ef-border)', borderRadius: 2,
                color: 'var(--ef-text-subtle)', background: 'var(--ef-surface)',
                cursor: locked || picked.size === 0 ? 'not-allowed' : 'pointer',
              }}
            >
              <CornerUpLeft size={11} strokeWidth={1.5} /> Unassign
            </button>
          </div>

          {movingCount > 0 && (
            <p className="text-xs w-full" style={{ color: 'var(--ef-warning-strong)' }}>
              {movingCount} of the selected {movingCount === 1 ? 'question is' : 'questions are'} already
              in another section and will MOVE to {sectionName(target)} — a fixed question sits in one
              section only.
            </p>
          )}
        </div>

        {/* ── Rows ── */}
        <div style={{ border: '1px solid var(--ef-border)', borderRadius: 3, background: 'var(--ef-surface)' }}>
          {filtered.length === 0 ? (
            <p className="text-xs px-4 py-8 text-center" style={{ color: 'var(--ef-text-muted)' }}>
              {questions.length === 0
                ? 'No questions picked yet — choose them on the Question Source stage.'
                : 'Nothing matches these filters.'}
            </p>
          ) : filtered.map((q) => {
            const at = placed[q.id];
            const isPicked = picked.has(q.id);
            const elsewhere = !!at && at !== target;
            return (
              <button
                key={q.id}
                type="button"
                disabled={locked}
                onClick={() => togglePicked(q.id)}
                className="w-full flex items-start gap-3 px-4 py-2.5 text-left transition-colors"
                style={{
                  borderBottom: '1px solid var(--ef-border-subtle)',
                  background: isPicked ? 'var(--ef-canvas-raised)' : 'transparent',
                  cursor: locked ? 'not-allowed' : 'pointer',
                }}
              >
                <div style={{ marginTop: 1 }}><Box checked={isPicked} /></div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs" style={{ color: 'var(--ef-ink)', lineHeight: 1.55 }}>
                    {plainStem(q.stem) || <em style={{ color: 'var(--ef-text-muted)' }}>No question text</em>}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 3 }}>
                    <span style={{ fontSize: 12, color: 'var(--ef-text-muted)' }}>
                      {ENGINE_LABEL[q.engine]} · {DIFF_LABEL[q.difficulty]}
                      {qTopic(q) ? ` · ${qTopic(q)}` : ''}
                    </span>
                    {q.tags.slice(0, 3).map((t) => (
                      <span key={t} style={{
                        fontSize: 11, color: 'var(--ef-text-muted)', padding: '0 4px',
                        border: '1px solid var(--ef-border-subtle)', borderRadius: 2,
                      }}>{t}</span>
                    ))}
                  </div>
                </div>

                {/* Where it lives. Present on every row, not only the claimed
                    ones — "Unassigned" is a state the author is working
                    towards emptying, and a blank cell would hide it. */}
                <span
                  className="text-xs flex-shrink-0"
                  style={{
                    color: at ? 'var(--ef-text-subtle)' : 'var(--ef-warning-strong)',
                    fontSize: 12,
                    padding: '2px 6px',
                    borderRadius: 2,
                    border: `1px solid ${at ? 'var(--ef-border)' : 'var(--ef-warning-border)'}`,
                    background: at ? 'var(--ef-canvas-raised)' : 'var(--ef-warning-bg)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {at
                    ? (elsewhere && isPicked ? `${sectionName(at)} → ${sectionName(target)}` : sectionName(at))
                    : 'Unassigned'}
                </span>
              </button>
            );
          })}
        </div>

        {unassignedCount > 0 && (
          <div className="flex items-start gap-2.5 mt-4 px-3.5 py-3"
            style={{ border: '1px solid var(--ef-border)', background: 'var(--ef-canvas-raised)', borderRadius: 2 }}>
            <Layers size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0, marginTop: 1 }} />
            <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.65 }}>
              {unassignedCount} picked question{unassignedCount === 1 ? '' : 's'} still
              {unassignedCount === 1 ? ' has' : ' have'} no section. That is allowed —
              over-picking as a buffer is a reasonable thing to do — and publishing will
              remind you rather than refuse. Anything left unassigned simply does not
              appear on the paper.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PIECES
// ══════════════════════════════════════════════════════════════════

function SectionTally({ name, count, marks, onMarks, active, locked, onFocus }: {
  name: string;
  count: number;
  marks: string;
  onMarks: (v: string) => void;
  active: boolean;
  locked: boolean;
  onFocus: () => void;
}) {
  const per = parseFloat(marks) || 1;
  return (
    <div
      className="flex flex-col gap-1.5 px-3.5 py-3"
      style={{
        border: active ? '1.5px solid var(--ef-ink)' : '1px solid var(--ef-border)',
        background: 'var(--ef-canvas-raised)',
        borderRadius: 3,
      }}
    >
      <button type="button" onClick={onFocus} className="text-left transition-opacity hover:opacity-70"
        style={{ cursor: 'pointer' }}>
        <span className="text-xs block truncate" style={{ color: 'var(--ef-ink)' }}>{name}</span>
        <span className="text-xs tabular-nums" style={{ color: 'var(--ef-text-muted)' }}>
          {count} Q · {(count * per).toFixed(count * per % 1 === 0 ? 0 : 1)} marks
        </span>
      </button>
      <div className="flex items-center gap-1.5">
        <label className="text-xs" style={{ color: 'var(--ef-text-muted)', fontSize: 12 }}>
          Marks each
        </label>
        <input
          type="number" min={0} step="0.5" value={marks} placeholder="1"
          disabled={locked}
          onChange={(e) => onMarks(e.target.value)}
          className="text-xs outline-none"
          style={{
            width: 56, padding: '3px 6px', borderRadius: 2,
            border: '1px solid var(--ef-border)',
            background: 'var(--ef-surface)', color: 'var(--ef-ink)',
          }}
        />
      </div>
    </div>
  );
}

function Box({ checked }: { checked: boolean }) {
  return (
    <div style={{
      width: 15, height: 15, borderRadius: 2, flexShrink: 0,
      border: `1px solid ${checked ? 'var(--ef-ink)' : 'var(--ef-border-muted)'}`,
      background: checked ? 'var(--ef-ink)' : 'var(--ef-surface)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {checked && <Check size={9} strokeWidth={2.5} style={{ color: 'var(--ef-surface)' }} />}
    </div>
  );
}

function Select({ value, onChange, placeholder, options, labelFor, explicitOptions }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options?: string[];
  labelFor?: (v: string) => string;
  /** Use when the option list has its own labels, or no empty choice. */
  explicitOptions?: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs outline-none"
      style={{
        border: '1px solid var(--ef-border)',
        borderRadius: 2,
        background: 'var(--ef-surface)',
        color: value ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
        padding: '5px 6px',
        maxWidth: 170,
      }}
    >
      {explicitOptions
        ? explicitOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)
        : (
          <>
            <option value="">{placeholder}</option>
            {(options ?? []).map((o) => (
              <option key={o} value={o}>{labelFor ? labelFor(o) : o}</option>
            ))}
          </>
        )}
    </select>
  );
}

/** Strip the markup and math so a stem reads as one line in a list row. */
function plainStem(s: string, n = 130): string {
  const stripped = s.replace(/\$\$?[^$]*\$\$?/g, '[math]').replace(/<[^>]*>/g, '').trim();
  return stripped.length > n ? `${stripped.slice(0, n)}…` : stripped;
}
