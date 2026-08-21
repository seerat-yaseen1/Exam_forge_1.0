/**
 * builder/QuestionSourceStep — where this paper may draw from at all.
 *
 * ── WHY THIS IS A STAGE AND NOT A FIELD ───────────────────────────
 * Every other narrowing in the builder happens inside a universe nobody ever
 * chose. "All questions I can see" was an assumption, not a decision, and it
 * was wrong for the two commonest cases: a department that keeps curated banks
 * per paper, and a teacher who wants to hand-build a revision test out of forty
 * specific questions. Both were possible before only by building a matrix and
 * hoping the draw happened to land on the right things.
 *
 * ── WHY IT RUNS BEFORE SUBJECTS ───────────────────────────────────
 * Because the pool narrows the taxonomy, not the other way round. Asked after
 * Subjects, a teacher could pick Physics, pick six topics under it, build a
 * matrix, and only learn at publish that the bank they chose has no Physics in
 * it. Asked first, the subject list simply never offers Physics. See stages.ts.
 *
 * ── THE ONE SCREEN, THREE SHAPES ──────────────────────────────────
 * The three pool modes want very different controls — nothing, a list of banks,
 * a question picker — and the temptation is three sub-stages. They stay one
 * screen because they are one decision: an author comparing "a bank" against
 * "pick them myself" needs both consequences visible while they choose, which
 * is the same reason CapabilityChoice exists.
 */

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  ChevronRight, Layers, Loader2, Pin, Search, Shuffle, X, Check, AlertCircle, Library,
} from 'lucide-react';
import {
  poolMode,
  poolRandomizes,
  type QuestionPoolMode,
  type QuestionSource,
} from '../../../../lib/assessmentService';
import {
  getAllQuestionBanks,
  type Difficulty,
  type Question,
  type QuestionBank,
  type QuestionEngine,
} from '../../../../lib/questionBankService';
import { StageHeading, LockedNotice } from './StageHeading';
import { CapabilityChoice, type CapabilityOption } from './CapabilityChoice';
import { SettingsToggle } from './controls';
import { DIFF_LABEL, type SectionDraft } from './shared';
import type { StageDef } from './stages';

const POOL_OPTIONS: readonly CapabilityOption<QuestionPoolMode>[] = [
  {
    value: 'all',
    label: 'All questions',
    summary: 'Everything you can see — your own questions and any shared with you.',
    points: ['Widest choice at every later step', 'Best when the paper is defined by topic, not by source'],
  },
  {
    value: 'banks',
    label: 'Question banks',
    summary: 'Only the banks you name here.',
    points: ['Subjects and topics narrow to what those banks hold', 'Keeps a paper inside a curated, reviewed set'],
  },
  {
    value: 'manual',
    label: 'Manual selection',
    summary: 'Only the questions you pick, one by one.',
    points: ['Randomize on: sections still draw, from your smaller set', 'Randomize off: your picks are the paper, exactly as picked'],
  },
];

export function QuestionSourceStep({
  source,
  setSource,
  allQuestions,
  pooledQuestions,
  sections,
  manualMarks,
  setManualMarks,
  banks,
  banksLoading,
  onNavigate,
  nextStage,
  locked,
  lockReason,
  qSubject,
  qTopic,
}: {
  source: QuestionSource;
  setSource: (next: QuestionSource) => void;
  /** The author's whole visible bank — what the manual picker chooses FROM. */
  allQuestions: Question[];
  /** The bank after this source is applied — what anchors are picked from. */
  pooledQuestions: Question[];
  sections: SectionDraft[];
  /** What each hand-picked question is worth. '' reads as 1. */
  manualMarks: string;
  setManualMarks: (v: string) => void;
  banks: QuestionBank[];
  banksLoading: boolean;
  onNavigate: (id: StageDef['id']) => void;
  nextStage: StageDef | null;
  locked: boolean;
  lockReason: string;
  /** Canonical (post-rename) names, resolved by the panel. */
  qSubject: (q: Question) => string;
  qTopic: (q: Question) => string;
}) {
  const mode = poolMode(source);
  const randomize = poolRandomizes(source);
  const manualIds = useMemo(
    () => new Set(source.manualQuestionIds ?? []),
    [source.manualQuestionIds],
  );
  const anchorIds = useMemo(
    () => new Set(source.anchorQuestionIds ?? []),
    [source.anchorQuestionIds],
  );

  const [anchorsOpen, setAnchorsOpen] = useState(anchorIds.size > 0);

  // ── Mode changes keep the other modes' work ──────────────────────
  // Switching from Manual to Banks and back should not lose forty picked
  // questions. sanitizeQuestionSource drops whatever the saved mode does not
  // use, so nothing stale reaches Firestore — but while the panel is open, the
  // author is allowed to change their mind for free.
  const patch = (p: Partial<QuestionSource>) => setSource({ ...source, ...p });

  const setMode = (m: QuestionPoolMode) => patch({ mode: m });

  const toggleBank = (id: string) => {
    const current = source.bankIds ?? [];
    patch({
      bankIds: current.includes(id) ? current.filter((b) => b !== id) : [...current, id],
    });
  };

  const toggleManual = (id: string) => {
    const next = new Set(manualIds);
    if (!next.delete(id)) next.add(id);
    // An anchor that leaves the pool stops being an anchor. Keeping it would
    // make the pool a suggestion — see anchorIdsInPool.
    patch({
      manualQuestionIds: [...next],
      anchorQuestionIds: (source.anchorQuestionIds ?? []).filter((a) => next.has(a)),
    });
  };

  const toggleAnchor = (id: string) => {
    const next = new Set(anchorIds);
    if (!next.delete(id)) next.add(id);
    patch({ anchorQuestionIds: [...next] });
  };

  // ── What the pool actually contains ──────────────────────────────
  const reach = useMemo(() => {
    const subjects = new Set<string>();
    const topics = new Set<string>();
    for (const q of pooledQuestions) {
      if (q.isDeleted) continue;
      const s = qSubject(q);
      if (s) subjects.add(s);
      const t = qTopic(q);
      if (s && t) topics.add(`${s}::${t}`);
    }
    return { questions: pooledQuestions.length, subjects: subjects.size, topics: topics.size };
  }, [pooledQuestions, qSubject, qTopic]);

  /** Manual Selection with randomization off, across more than one section. */
  const multiSectionFixedPaper = mode === 'manual' && !randomize && sections.length > 1;

  return (
    <motion.div
      key="question-source"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="flex-1 overflow-y-auto"
      style={{ padding: '40px 48px 80px' }}
    >
      <div style={{ width: '100%', maxWidth: 1080, margin: '0 auto' }}>
        <StageHeading stage="questionSource" />
        {locked && <LockedNotice status={lockReason === 'closed' ? 'closed' : 'active'} />}

        <div className="space-y-6">
          <CapabilityChoice
            label="Pool"
            value={mode}
            options={POOL_OPTIONS}
            onChange={setMode}
            locked={locked}
            lockReason={locked ? 'Locked after publish' : undefined}
          />

          {mode === 'banks' && (
            <BankPicker
              banks={banks}
              loading={banksLoading}
              selected={source.bankIds ?? []}
              onToggle={toggleBank}
              locked={locked}
            />
          )}

          {mode === 'manual' && (
            <div className="space-y-4">
              <SettingsToggle
                icon={<Shuffle size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />}
                label="Randomize within my selection"
                hint={randomize
                  ? 'Sections draw at random, but only from the questions you pick here.'
                  : 'No draw. Every question you pick appears, in the order you picked it — so topics and the question matrix are skipped.'}
                value={randomize}
                onChange={(v) => patch({ randomize: v })}
                locked={locked}
                lockReason={locked ? 'Locked' : undefined}
              />

              {multiSectionFixedPaper && (
                <Notice tone="warning">
                  A hand-picked paper with randomization off can only be built as a{' '}
                  <strong>single section</strong> today — a fixed question is one specific
                  instance, so it belongs to exactly one section, and the per-section
                  assignment step that decides which is not built yet. Publish will refuse
                  this combination. Turn Randomize back on, or reduce the paper to one
                  section on the Sections stage.
                </Notice>
              )}

              {/* Marks only appear once there is no matrix to carry them.
                  While randomization is on, marks belong per rule on the
                  Questions stage, and a second control here would be a
                  second answer to the same question. */}
              {!randomize && (
                <div className="flex items-center gap-3">
                  <label className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                    Marks per question
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.5"
                    value={manualMarks}
                    disabled={locked}
                    onChange={(e) => setManualMarks(e.target.value)}
                    placeholder="1"
                    className="text-xs outline-none"
                    style={{
                      width: 72, padding: '6px 8px', borderRadius: 2,
                      border: '1px solid var(--ef-border)',
                      background: 'var(--ef-surface)', color: 'var(--ef-ink)',
                    }}
                  />
                  <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                    Applies to every question you pick. Per-question marks come with the
                    marks-configuration work.
                  </span>
                </div>
              )}

              <QuestionMultiPicker
                title="Questions in this paper's pool"
                questions={allQuestions}
                selected={manualIds}
                onToggle={toggleManual}
                locked={locked}
                qSubject={qSubject}
                qTopic={qTopic}
                emptyHint="No questions match these filters."
              />
            </div>
          )}

          {/* ── Reach ──
              The number that makes the dependency rule visible. An author who
              ticks two banks and sees "0 questions" learns it here, where the
              fix is one click away, instead of four stages later when the
              subject list is mysteriously empty. */}
          <PoolReach
            mode={mode}
            {...reach}
            // A bank pool reads as empty until the bank list lands. Warning
            // about that would be a false alarm on an assessment that is in
            // fact configured correctly.
            pending={mode === 'banks' && banksLoading}
          />

          {/* ── Anchors ──
              Deliberately below the pool and collapsed by default: it is a
              refinement WITHIN the pool, not a fourth way of choosing one, and
              presenting it as a peer of the three modes is exactly the
              misreading the spec calls out. */}
          <div>
            <button
              type="button"
              onClick={() => setAnchorsOpen((v) => !v)}
              className="flex items-center gap-2 text-xs transition-opacity hover:opacity-70"
              style={{ color: 'var(--ef-ink)' }}
            >
              <Pin size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
              <span>Anchor questions</span>
              <span style={{ color: 'var(--ef-text-muted)' }}>
                {anchorIds.size > 0 ? `· ${anchorIds.size} pinned` : '· optional'}
              </span>
              <ChevronRight
                size={11}
                strokeWidth={2}
                style={{
                  color: 'var(--ef-text-muted)',
                  transform: anchorsOpen ? 'rotate(90deg)' : 'none',
                  transition: 'transform 0.15s',
                }}
              />
            </button>

            {anchorsOpen && (
              <div className="mt-3 space-y-3">
                <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6, maxWidth: 620 }}>
                  A pinned question always appears and never takes part in a random draw.
                  It fills one of the slots in whichever section rule matches its topic and
                  level — so pin three, and the rest of that section still randomizes
                  normally. A pin no rule can place will stop the publish rather than
                  disappear quietly.
                </p>
                {reach.questions === 0 ? (
                  <Notice tone="muted">Choose a pool first — anchors are picked from within it.</Notice>
                ) : (
                  <QuestionMultiPicker
                    title="Pinned"
                    questions={pooledQuestions}
                    selected={anchorIds}
                    onToggle={toggleAnchor}
                    locked={locked}
                    qSubject={qSubject}
                    qTopic={qTopic}
                    emptyHint="No questions in the pool match these filters."
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {nextStage && (
          <div className="mt-10 flex items-center justify-end">
            <button onClick={() => onNavigate(nextStage.id)}
              className="flex items-center gap-2 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
              style={{
                background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2,
                cursor: 'pointer', letterSpacing: '0.03em',
              }}>
              Continue to {nextStage.label} <ChevronRight size={12} strokeWidth={2} />
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// POOL REACH
// ══════════════════════════════════════════════════════════════════

function PoolReach({ mode, questions, subjects, topics, pending }: {
  mode: QuestionPoolMode;
  questions: number;
  subjects: number;
  topics: number;
  pending: boolean;
}) {
  if (pending) {
    return (
      <div className="flex items-center gap-3 px-4 py-3"
        style={{ border: '1px solid var(--ef-border)', background: 'var(--ef-canvas-raised)', borderRadius: 3 }}>
        <Loader2 size={12} strokeWidth={1.5} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Reading the banks…</p>
      </div>
    );
  }

  const empty = questions === 0;
  return (
    <div
      className="flex items-center gap-3 px-4 py-3"
      style={{
        border: `1px solid ${empty ? 'var(--ef-warning-border)' : 'var(--ef-border)'}`,
        background: empty ? 'var(--ef-warning-bg)' : 'var(--ef-canvas-raised)',
        borderRadius: 3,
      }}
    >
      {empty
        ? <AlertCircle size={12} strokeWidth={1.5} style={{ color: 'var(--ef-warning)', flexShrink: 0 }} />
        : <Layers size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />}
      {empty ? (
        <p className="text-xs" style={{ color: 'var(--ef-warning-strong)', lineHeight: 1.6 }}>
          {mode === 'banks'
            ? 'These banks hold no questions this assessment can use. Every later stage will be empty until you add a bank.'
            : 'Nothing picked yet — every later stage will be empty until you pick at least one question.'}
        </p>
      ) : (
        <p className="text-xs" style={{ color: 'var(--ef-ink)', lineHeight: 1.6 }}>
          <strong style={{ fontWeight: 500 }}>{questions}</strong> question{questions === 1 ? '' : 's'} available
          {' · '}
          <strong style={{ fontWeight: 500 }}>{subjects}</strong> subject{subjects === 1 ? '' : 's'}
          {' · '}
          <strong style={{ fontWeight: 500 }}>{topics}</strong> topic{topics === 1 ? '' : 's'}
          <span style={{ color: 'var(--ef-text-muted)' }}>
            {' — '}the later stages will offer these and nothing else.
          </span>
        </p>
      )}
    </div>
  );
}

function Notice({ tone, children }: { tone: 'warning' | 'muted'; children: React.ReactNode }) {
  const warn = tone === 'warning';
  return (
    <div
      className="flex items-start gap-2.5 px-3.5 py-3"
      style={{
        border: `1px solid ${warn ? 'var(--ef-warning-border)' : 'var(--ef-border)'}`,
        background: warn ? 'var(--ef-warning-bg)' : 'var(--ef-canvas-raised)',
        borderRadius: 2,
      }}
    >
      {warn && <AlertCircle size={12} strokeWidth={1.5} style={{ color: 'var(--ef-warning)', flexShrink: 0, marginTop: 1 }} />}
      <p className="text-xs" style={{ color: warn ? 'var(--ef-warning-strong)' : 'var(--ef-text-muted)', lineHeight: 1.65 }}>
        {children}
      </p>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// BANK PICKER
// ══════════════════════════════════════════════════════════════════

function BankPicker({ banks, loading, selected, onToggle, locked }: {
  banks: QuestionBank[];
  loading: boolean;
  selected: string[];
  onToggle: (id: string) => void;
  locked: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 size={16} strokeWidth={1} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
      </div>
    );
  }

  if (banks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10" style={{ color: 'var(--ef-text-muted)' }}>
        <Library size={20} strokeWidth={1} style={{ marginBottom: 8 }} />
        <p className="text-xs">No question banks yet</p>
        <p style={{ fontSize: 11, color: 'var(--ef-border-muted)', marginTop: 4 }}>
          Create one in the question bank, or pick a different pool.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {banks.map((bank) => {
        const isSelected = selected.includes(bank.id);
        return (
          <button
            key={bank.id}
            type="button"
            disabled={locked}
            onClick={() => onToggle(bank.id)}
            className="w-full flex items-center gap-3 px-4 py-3 text-left transition-all"
            style={{
              border: isSelected ? '1px solid var(--ef-ink)' : '1px solid var(--ef-border)',
              borderRadius: 3,
              background: isSelected ? 'var(--ef-surface)' : 'var(--ef-canvas-raised)',
              cursor: locked ? 'not-allowed' : 'pointer',
              opacity: locked && !isSelected ? 0.5 : 1,
            }}
          >
            <Box checked={isSelected} />
            <div className="flex-1 min-w-0">
              <p className="text-xs" style={{ color: isSelected ? 'var(--ef-ink)' : 'var(--ef-text-subtle)' }}>
                {bank.name}
              </p>
              <p style={{ fontSize: 10, color: 'var(--ef-text-muted)', marginTop: 2 }}>
                {bank.questionIds.length} question{bank.questionIds.length === 1 ? '' : 's'}
                {bank.subject ? ` · ${bank.subject}` : ''}
                {bank.description ? ` · ${bank.description}` : ''}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// QUESTION MULTI-PICKER
// ══════════════════════════════════════════════════════════════════
//
// One component for both jobs on this screen — building a manual pool, and
// pinning anchors inside whatever pool exists — because they are the same
// interaction over a different list. The alternative was two pickers that
// would drift apart the first time either grew a filter.
//
// The render is capped rather than virtualized. A bank of 10,000 questions
// would otherwise mount 10,000 rows the moment the stage opens, and the honest
// fix at this size is to say so and make the author filter, not to build a
// windowing layer for a list nobody scrolls to the bottom of.

const RENDER_CAP = 150;

function QuestionMultiPicker({
  title, questions, selected, onToggle, locked, qSubject, qTopic, emptyHint,
}: {
  title: string;
  questions: Question[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  locked: boolean;
  qSubject: (q: Question) => string;
  qTopic: (q: Question) => string;
  emptyHint: string;
}) {
  const [search, setSearch] = useState('');
  const [subject, setSubject] = useState('');
  const [topic, setTopic] = useState('');
  const [difficulty, setDifficulty] = useState<Difficulty | ''>('');
  const [engine, setEngine] = useState<QuestionEngine | ''>('');
  const [selectedOnly, setSelectedOnly] = useState(false);

  const live = useMemo(() => questions.filter((q) => !q.isDeleted), [questions]);

  const subjects = useMemo(
    () => [...new Set(live.map(qSubject).filter(Boolean))].sort(),
    [live, qSubject],
  );

  const topics = useMemo(() => {
    const scope = subject ? live.filter((q) => qSubject(q) === subject) : live;
    return [...new Set(scope.map(qTopic).filter(Boolean))].sort();
  }, [live, subject, qSubject, qTopic]);

  // A topic filter left pointing at a topic the subject filter no longer
  // admits would show an empty list with two filters set and no clue which one
  // is at fault.
  useEffect(() => {
    if (topic && !topics.includes(topic)) setTopic('');
  }, [topic, topics]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return live.filter((q) => {
      if (selectedOnly && !selected.has(q.id)) return false;
      if (subject && qSubject(q) !== subject) return false;
      if (topic && qTopic(q) !== topic) return false;
      if (difficulty && q.difficulty !== difficulty) return false;
      if (engine && q.engine !== engine) return false;
      if (!term) return true;
      return (
        q.stem.toLowerCase().includes(term)
        || qSubject(q).toLowerCase().includes(term)
        || qTopic(q).toLowerCase().includes(term)
        || q.tags.some((t) => t.toLowerCase().includes(term))
      );
    });
  }, [live, selected, selectedOnly, subject, topic, difficulty, engine, search, qSubject, qTopic]);

  const shown = filtered.slice(0, RENDER_CAP);

  return (
    <div style={{ border: '1px solid var(--ef-border)', borderRadius: 3, background: 'var(--ef-surface)' }}>
      {/* Header + count */}
      <div className="flex items-center justify-between gap-3 px-4 py-3"
        style={{ borderBottom: '1px solid var(--ef-border)' }}>
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
          {title.toUpperCase()}
        </p>
        <button
          type="button"
          onClick={() => setSelectedOnly((v) => !v)}
          className="text-xs px-2 py-1 transition-colors"
          style={{
            border: `1px solid ${selectedOnly ? 'var(--ef-ink)' : 'var(--ef-border)'}`,
            background: selectedOnly ? 'var(--ef-ink)' : 'transparent',
            color: selectedOnly ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
            borderRadius: 2,
            cursor: 'pointer',
          }}
        >
          {selected.size} selected
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 px-4 py-2.5 flex-wrap"
        style={{ borderBottom: '1px solid var(--ef-border-subtle)', background: 'var(--ef-canvas-raised)' }}>
        <div className="flex items-center gap-1.5 px-2 py-1 flex-1"
          style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', minWidth: 160 }}>
          <Search size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search text, subject, topic or tag"
            className="flex-1 outline-none text-xs"
            style={{ background: 'transparent', color: 'var(--ef-ink)', border: 'none', minWidth: 0 }}
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} style={{ cursor: 'pointer' }}>
              <X size={10} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
            </button>
          )}
        </div>

        <Select value={subject} onChange={setSubject} placeholder="All subjects" options={subjects} />
        <Select value={topic} onChange={setTopic} placeholder="All topics" options={topics} />
        <Select
          value={difficulty}
          onChange={(v) => setDifficulty(v as Difficulty | '')}
          placeholder="Any level"
          options={['easy', 'medium', 'hard']}
          labelFor={(v) => DIFF_LABEL[v as Difficulty]}
        />
        <Select
          value={engine}
          onChange={(v) => setEngine(v as QuestionEngine | '')}
          placeholder="Any type"
          options={['mcq', 'text', 'match', 'code']}
          labelFor={(v) => ENGINE_LABEL[v as QuestionEngine]}
        />
      </div>

      {/* Rows */}
      <div style={{ maxHeight: 340, overflowY: 'auto' }}>
        {shown.length === 0 ? (
          <p className="text-xs px-4 py-6 text-center" style={{ color: 'var(--ef-text-muted)' }}>
            {emptyHint}
          </p>
        ) : shown.map((q) => {
          const isSelected = selected.has(q.id);
          return (
            <button
              key={q.id}
              type="button"
              disabled={locked}
              onClick={() => onToggle(q.id)}
              className="w-full flex items-start gap-3 px-4 py-2.5 text-left transition-colors"
              style={{
                borderBottom: '1px solid var(--ef-border-subtle)',
                background: isSelected ? 'var(--ef-canvas-raised)' : 'transparent',
                cursor: locked ? 'not-allowed' : 'pointer',
              }}
            >
              <div style={{ marginTop: 1 }}><Box checked={isSelected} /></div>
              <div className="flex-1 min-w-0">
                <p className="text-xs" style={{ color: 'var(--ef-ink)', lineHeight: 1.55 }}>
                  {plainStem(q.stem) || <em style={{ color: 'var(--ef-text-muted)' }}>No question text</em>}
                </p>
                <p style={{ fontSize: 10, color: 'var(--ef-text-muted)', marginTop: 3 }}>
                  {ENGINE_LABEL[q.engine]} · {DIFF_LABEL[q.difficulty]}
                  {qSubject(q) ? ` · ${qSubject(q)}` : ''}
                  {qTopic(q) ? ` › ${qTopic(q)}` : ''}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {filtered.length > shown.length && (
        <p className="text-xs px-4 py-2.5" style={{ color: 'var(--ef-text-muted)', borderTop: '1px solid var(--ef-border-subtle)' }}>
          Showing {shown.length} of {filtered.length} matches — narrow the filters to see the rest.
        </p>
      )}
    </div>
  );
}

const ENGINE_LABEL: Record<QuestionEngine, string> = {
  mcq: 'Objective',
  text: 'Subjective',
  match: 'Match',
  code: 'Coding',
};

/** Strip the markup and math so a stem reads as one line in a list row. */
function plainStem(s: string, n = 130): string {
  const stripped = s.replace(/\$\$?[^$]*\$\$?/g, '[math]').replace(/<[^>]*>/g, '').trim();
  return stripped.length > n ? `${stripped.slice(0, n)}…` : stripped;
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

function Select({ value, onChange, placeholder, options, labelFor }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: string[];
  labelFor?: (v: string) => string;
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
        maxWidth: 150,
      }}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o} value={o}>{labelFor ? labelFor(o) : o}</option>
      ))}
    </select>
  );
}

// ══════════════════════════════════════════════════════════════════
// BANK LOADING
// ══════════════════════════════════════════════════════════════════

/**
 * Loaded by the panel rather than by this component so the list survives the
 * author stepping away to Subjects and back — the same reason both step
 * components stay mounted. Banks change on a human timescale; one fetch per
 * builder session is the right cadence.
 */
export function useQuestionBanks(): { banks: QuestionBank[]; loading: boolean } {
  const [banks, setBanks] = useState<QuestionBank[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    getAllQuestionBanks()
      .then((b) => { if (alive) setBanks(b); })
      .catch(() => { if (alive) setBanks([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  return { banks, loading };
}
