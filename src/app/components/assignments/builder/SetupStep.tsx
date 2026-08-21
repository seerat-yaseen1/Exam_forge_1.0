/**
 * builder/SetupStep — step 1 of the assessment builder: title, sections,
 * per-section selection rules and timing. (Batch F1d: extracted verbatim
 * from AssignmentsPage.tsx; no logic changes.)
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, X, CheckCircle2, Timer, ChevronRight, Layers, BookOpen, Lock } from 'lucide-react';
import { type Student } from '../../../../lib/firebaseService';
import { type Assessment, type AssessmentStatus } from '../../../../lib/assessmentService';
import { type Question } from '../../../../lib/questionBankService';
import { getAllSubjects, loadTaxonomyNameMaps, type Subject, type TaxonomyNameMaps } from '../../../../lib/subjectService';
import {
  EXECUTION_ENGINE_LABEL,
  EXECUTION_ENGINE_SUMMARY,
  isItemTypeLive,
  itemTypesForExecutionEngine,
  liveExecutionEngines,
  type ExecutionEngine,
} from '../../../../lib/itemTypes';
import { makeSectionId, SECTION_LETTERS, defaultSectionName, mutabilityFor, type SectionDraft } from './shared';
import { Field, SectionLabel, inputStyle } from './controls';
import { nextStageOf, type BuilderStage } from './stages';
import { StageHeading, LockedNotice } from './StageHeading';
import { SectionTopicPicker, SubjectPickerPhase, TopicPickerPhase } from './topicPickers';

/**
 * Engines a section can be locked to.
 *
 * Only the ones something can actually run in today — derived, so a runtime
 * appears here the moment the first item type on it goes live and never a
 * release before. Offering `code` now would let an author build a section that
 * resolves to nothing at publish.
 */
const SECTION_ENGINE_OPTIONS: ExecutionEngine[] = liveExecutionEngines();

/** How many live item types a lock admits — the author's sanity check. */
function sectionAcceptedTypeCount(engines: ExecutionEngine[]): number {
  return engines.reduce(
    (n, e) => n + itemTypesForExecutionEngine(e).filter((t) => isItemTypeLive(t.id)).length,
    0,
  );
}

export function SetupStep({
  stage,
  title, setTitle, description, setDescription,
  subject, setSubject, status, setStatus,
  sections, setSections,
  onNavigate, originalStatus,
  allQuestions,
  subjectPool, setSubjectPool,
  topicPool, setTopicPool,
  deliveryMode,
}: {
  title: string; setTitle: (v: string) => void;
  description: string; setDescription: (v: string) => void;
  subject: string; setSubject: (v: string) => void;
  status: AssessmentStatus; setStatus: (v: AssessmentStatus) => void;
  sections: SectionDraft[];
  setSections: React.Dispatch<React.SetStateAction<SectionDraft[]>>;
  /** Move the workspace to another stage. Used by the pickers' own Next/Back
   *  affordances, which stay because a first-time author following the flow
   *  should not have to find the rail to advance. */
  onNavigate: (s: BuilderStage) => void;
  originalStatus?: AssessmentStatus;
  allQuestions: Question[];
  subjectPool: string[];
  setSubjectPool: React.Dispatch<React.SetStateAction<string[]>>;
  topicPool: string[];
  setTopicPool: React.Dispatch<React.SetStateAction<string[]>>;
  deliveryMode: 'standard' | 'linear' | 'adaptive';
  /**
   * Which stage the workspace is showing. This component owns four of them —
   * basics, subjects, topics, sections — and renders exactly one at a time.
   *
   * It used to own all four AT ONCE, stacked, with its own internal three-phase
   * stepper for the last three. That stepper was the second progress indicator
   * on screen (the panel's own 1-2-3 was the first) and neither explained
   * itself; the rail replaces both. See stages.ts.
   */
  stage: BuilderStage;
}) {
  const [titleError, setTitleError] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const mut = mutabilityFor(originalStatus);

  // ── Subject docs (Phase 1) ────────────────────────────────────
  const [allSubjectDocs, setAllSubjectDocs] = useState<Subject[]>([]);
  const [loadingSubjects, setLoadingSubjects] = useState(true);

  useEffect(() => {
    getAllSubjects()
      .then(setAllSubjectDocs)
      .finally(() => setLoadingSubjects(false));
  }, []);

  // Taxonomy name maps (slug → current name) — see loadTaxonomyNameMaps. Makes
  // the bank tree below group renamed subjects/topics under their CURRENT name
  // instead of splitting old vs new. Empty = fall back to stored names.
  const [taxonomyMaps, setTaxonomyMaps] = useState<TaxonomyNameMaps>({ subjectNameById: {}, topicNameById: {} });
  useEffect(() => {
    loadTaxonomyNameMaps()
      .then(setTaxonomyMaps)
      .catch(() => setTaxonomyMaps({ subjectNameById: {}, topicNameById: {} }));
  }, []);
  const qSubject = useCallback(
    (q: Question): string => (q.subjectId && taxonomyMaps.subjectNameById[q.subjectId]) || q.subject,
    [taxonomyMaps]
  );
  const qTopic = useCallback(
    (q: Question): string => (q.topicId && taxonomyMaps.topicNameById[q.topicId]) || q.topic,
    [taxonomyMaps]
  );

  // The phase state that used to live here is gone: which stage is on screen
  // is now the workspace's business, and this component simply renders the one
  // it is told to. It also no longer has to GUESS the furthest-completed phase
  // on re-entry, which it did by inspecting the pools — a heuristic that put an
  // author who had deliberately cleared their topics back at the start.

  // ── Toggle subject in pool — cascades prune to topicPool + sections ─
  const toggleSubjectInPool = useCallback((id: string) => {
    const isRemoving = subjectPool.includes(id);
    if (isRemoving) {
      const subj = allSubjectDocs.find((s) => s.id === id);
      if (subj) {
        const subjName = subj.name;
        setTopicPool((tp) => tp.filter((k) => !k.startsWith(`${subjName}::`)));
        setSections((secs) => secs.map((sec) => ({
          ...sec,
          assignedTopics: sec.assignedTopics.filter((k) => !k.startsWith(`${subjName}::`)),
          rules: sec.rules.filter((r) => r.subject !== subjName),
        })));
      }
      setSubjectPool((prev) => prev.filter((x) => x !== id));
    } else {
      setSubjectPool((prev) => [...prev, id]);
    }
  }, [subjectPool, allSubjectDocs, setSubjectPool, setTopicPool, setSections]);

  // ── Toggle topic in pool ──────────────────────────────────────
  const toggleTopicInPool = useCallback((key: string) => {
    setTopicPool((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
    // If removing, also clear from any section's assignedTopics + rules
    if (topicPool.includes(key)) {
      const [subj, topic] = key.split('::');
      setSections((secs) => secs.map((sec) => ({
        ...sec,
        assignedTopics: sec.assignedTopics.filter((k) => k !== key),
        rules: sec.rules.filter((r) => !(r.subject === subj && r.topic === topic)),
      })));
    }
  }, [topicPool, setTopicPool, setSections]);

  // ── Full bank subject→topics map ──────────────────────────────
  // Build subject→topics map from the question bank
  const subjectTopics = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    allQuestions.forEach((q) => {
      const subj = qSubject(q);
      const top = qTopic(q);
      if (q.isDeleted || !subj || !top) return;
      if (!map[subj]) map[subj] = new Set();
      map[subj].add(top);
    });
    const sorted: Record<string, string[]> = {};
    for (const subj in map) sorted[subj] = [...map[subj]].sort();
    return sorted;
  }, [allQuestions, qSubject, qTopic]);

  // ── Scoped subjectTopics for Phase 3 section builder ─────────
  // When a topicPool is set, scope the section picker to only those topics.
  const scopedSubjectTopics = useMemo(() => {
    if (topicPool.length === 0) return subjectTopics;
    const result: Record<string, string[]> = {};
    topicPool.forEach((key) => {
      const idx = key.indexOf('::');
      if (idx === -1) return;
      const subj = key.slice(0, idx);
      const topic = key.slice(idx + 2);
      if (!result[subj]) result[subj] = [];
      if (!result[subj].includes(topic)) result[subj].push(topic);
    });
    for (const subj in result) result[subj].sort();
    return result;
  }, [topicPool, subjectTopics]);

  const toggleSectionExpanded = (id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAssignedTopic = (sectionIdx: number, key: string) => {
    setSections((prev) => prev.map((s, i) => {
      if (i !== sectionIdx) return s;
      const hasKey = s.assignedTopics.includes(key);
      return {
        ...s,
        assignedTopics: hasKey
          ? s.assignedTopics.filter((k) => k !== key)
          : [...s.assignedTopics, key],
        // If removing a topic, also clear its rules
        rules: hasKey
          ? s.rules.filter((r) => `${r.subject}::${r.topic}` !== key)
          : s.rules,
      };
    }));
  };

  const addSection = () => {
    setSections((prev) => [
      ...prev,
      { id: makeSectionId(), name: defaultSectionName(prev.length), timeLimit: '', questionTimeLimit: '', rules: [], assignedTopics: [], breakAfterMinutes: '', breakMandatory: false, engines: [] },
    ]);
  };

  /**
   * Toggle one execution engine on a section.
   *
   * Clearing the last engine returns the section to UNLOCKED (accepts
   * everything) rather than to "accepts nothing" — a section that admits no
   * item at all is never what an author means by unticking the last box, and
   * it would resolve to an empty section at publish.
   */
  const toggleSectionEngine = (idx: number, engine: ExecutionEngine) => {
    setSections((prev) => prev.map((s, i) => {
      if (i !== idx) return s;
      const has = s.engines.includes(engine);
      return {
        ...s,
        engines: has ? s.engines.filter((e) => e !== engine) : [...s.engines, engine],
      };
    }));
  };

  const removeSection = (idx: number) => {
    if (sections.length <= 1) return;
    setSections((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateSection = (idx: number, field: 'name' | 'timeLimit' | 'questionTimeLimit', value: string) => {
    if (field === 'timeLimit' || field === 'questionTimeLimit') {
      if (value !== '' && (parseInt(value, 10) || 0) < 1) return;
    }
    setSections((prev) => prev.map((s, i) => (i === idx ? { ...s, [field]: value } : s)));
  };

  const totalSectionTime = sections.reduce((sum, s) => sum + (parseInt(s.timeLimit, 10) || 0), 0);


  /** The stage after this one, for the forward affordance below. */
  const nextStage = nextStageOf(stage);

  return (
    <motion.div
      key={`setup-${stage}`}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="flex-1 overflow-y-auto"
      style={{ padding: '40px 48px 80px' }}
    >
      <div style={{ width: '100%', maxWidth: 1080, margin: '0 auto' }}>

        <StageHeading stage={stage} />
        {originalStatus && originalStatus !== 'draft' && (
          <LockedNotice status={originalStatus === 'active' ? 'active' : 'closed'} />
        )}

        <div>

          {/* ── Basics ── */}
          {stage === 'basics' && (
          <div className="space-y-5">

            {/* Row 1: Title · Subject — targeting now lives in Step 3 (Allocation) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <Field label="Title" required>
                <input
                  type="text" value={title}
                  onChange={(e) => { setTitle(e.target.value); if (e.target.value.trim()) setTitleError(false); }}
                  style={{ ...inputStyle, fontSize: 13, padding: '9px 12px', borderColor: titleError ? 'var(--ef-danger-border)' : 'var(--ef-border)', background: titleError ? 'var(--ef-danger-bg)' : 'var(--ef-surface)' }}
                  placeholder="e.g., Midterm Exam — Mathematics" autoFocus
                />
                {titleError && <p className="text-xs mt-1" style={{ color: 'var(--ef-danger)' }}>Title is required</p>}
              </Field>

              <Field label="Subject" hint="(optional)">
                <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
                  style={{ ...inputStyle, fontSize: 13, padding: '9px 12px' }} placeholder="e.g., Mathematics" />
              </Field>
            </div>

            {/* Row 2: Description (full-width) */}
            <Field label="Description" hint="(optional)">
              <textarea value={description} onChange={(e) => setDescription(e.target.value)}
                style={{ ...inputStyle, minHeight: 80, resize: 'none', fontSize: 13, padding: '9px 12px' }}
                placeholder="Instructions or notes visible to students" />
            </Field>
          </div>
          )}

          {/* The Subjects → Topics → Sections stepper that used to sit here is
              gone. It was a second progress indicator competing with the
              panel's own, and neither was labelled in a way that said which
              governed what. The rail is now the only answer to "where am I". */}
          <div>
            {/* ── Phase 1: Subject Picker ── */}
            {stage === 'subjects' && (
              <SubjectPickerPhase
                subjects={allSubjectDocs}
                allQuestions={allQuestions}
                selectedIds={subjectPool}
                onToggle={toggleSubjectInPool}
                onNext={() => onNavigate('topics')}
                loading={loadingSubjects}
                subjectNameById={taxonomyMaps.subjectNameById}
                topicNameById={taxonomyMaps.topicNameById}
              />
            )}

            {/* ── Phase 2: Topic Picker ── */}
            {stage === 'topics' && (
              <TopicPickerPhase
                allSubjects={allSubjectDocs}
                allQuestions={allQuestions}
                selectedSubjectIds={subjectPool}
                selectedTopics={topicPool}
                onToggleTopic={toggleTopicInPool}
                onBack={() => onNavigate('subjects')}
                onNext={() => onNavigate('sections')}
                subjectNameById={taxonomyMaps.subjectNameById}
                topicNameById={taxonomyMaps.topicNameById}
              />
            )}

            {/* ── Phase 3: Section Builder ── */}
            {stage === 'sections' && (
              <div>
                {/* Pool reminder strip */}
                {topicPool.length > 0 && (
                  <div className="flex items-center gap-2 px-3 py-2 mb-4"
                    style={{ background: 'var(--ef-success-bg)', border: '1px solid var(--ef-success-border)', borderRadius: 2 }}>
                    <BookOpen size={10} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)', flexShrink: 0 }} />
                    <span style={{ fontSize: 11, color: 'var(--ef-success-strong)', flex: 1 }}>
                      Topic pool: {topicPool.length} topic{topicPool.length !== 1 ? 's' : ''} across {subjectPool.length} subject{subjectPool.length !== 1 ? 's' : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => onNavigate('topics')}
                      className="text-xs transition-opacity hover:opacity-70"
                      style={{ color: 'var(--ef-success-strong)', flexShrink: 0 }}
                    >
                      Edit ↗
                    </button>
                  </div>
                )}

                {/* Section cards */}
                <div className="space-y-3">
                  <AnimatePresence initial={false}>
                    {sections.map((sec, idx) => {
                      const isPickerOpen = expandedSections.has(sec.id);
                      const hasAssigned = sec.assignedTopics.length > 0;
                      return (
                        <motion.div
                          key={sec.id}
                          initial={{ opacity: 0, y: -8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                          style={{
                            border: '1px solid var(--ef-border)',
                            borderRadius: 3,
                            overflow: 'hidden',
                            opacity: !mut.sections ? 0.5 : 1,
                            pointerEvents: !mut.sections ? 'none' : 'auto',
                          }}
                        >
                          {/* Top row: index + name + time + topics toggle + remove */}
                          <div className="flex items-center" style={{ gap: 8, padding: '8px 10px', background: 'var(--ef-surface)' }}>
                            <div className="flex-shrink-0 flex items-center justify-center"
                              style={{ width: 26, height: 26, borderRadius: 2, background: 'var(--ef-canvas)', border: '1px solid var(--ef-border-subtle)', fontSize: 10, color: 'var(--ef-text-muted)' }}>
                              {(idx + 1).toString().padStart(2, '0')}
                            </div>
                            <input
                              type="text" value={sec.name}
                              onChange={(e) => updateSection(idx, 'name', e.target.value)}
                              placeholder={`Section ${SECTION_LETTERS[idx] ?? idx + 1}`}
                              className="flex-1 outline-none text-xs"
                              style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-ink)', background: 'var(--ef-surface)', padding: '7px 10px', minWidth: 0 }}
                            />
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <input
                                type="number" value={sec.timeLimit}
                                onChange={(e) => updateSection(idx, 'timeLimit', e.target.value)}
                                placeholder="—" min="1"
                                className="flex-shrink-0 outline-none text-center text-xs"
                                style={{ width: 52, padding: '7px 6px', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', color: 'var(--ef-ink)', MozAppearance: 'textfield' } as React.CSSProperties}
                                onWheel={(e) => (e.target as HTMLInputElement).blur()}
                                onKeyDown={(e) => { if (['-', 'e', '+', '.'].includes(e.key)) e.preventDefault(); }}
                              />
                              <span className="text-xs flex-shrink-0" style={{ color: 'var(--ef-text-muted)' }}>min</span>
                            </div>
                            {/* Per-question timer (Phase 2.5) — authority toggle.
                                Only meaningful in sequential delivery; hidden in standard. */}
                            {deliveryMode !== 'standard' && (
                              <div className="flex items-center gap-1 flex-shrink-0" title="Seconds per question — auto-advances when it expires. Leave blank for no per-question limit.">
                                <input
                                  type="number" value={sec.questionTimeLimit}
                                  onChange={(e) => updateSection(idx, 'questionTimeLimit', e.target.value)}
                                  placeholder="—" min="1"
                                  className="flex-shrink-0 outline-none text-center text-xs"
                                  style={{ width: 52, padding: '7px 6px', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', color: 'var(--ef-ink)', MozAppearance: 'textfield' } as React.CSSProperties}
                                  onWheel={(e) => (e.target as HTMLInputElement).blur()}
                                  onKeyDown={(e) => { if (['-', 'e', '+', '.'].includes(e.key)) e.preventDefault(); }}
                                />
                                <span className="text-xs flex-shrink-0" style={{ color: 'var(--ef-text-muted)' }}>s/q</span>
                              </div>
                            )}
                            {/* Topics toggle button */}
                            <button
                              type="button"
                              onClick={() => toggleSectionExpanded(sec.id)}
                              className="flex-shrink-0 flex items-center gap-1 text-xs px-2 py-1.5 transition-all"
                              style={{
                                borderRadius: 2,
                                border: isPickerOpen ? '1px solid var(--ef-ink)' : (hasAssigned ? '1px solid var(--ef-success-border)' : '1px solid var(--ef-border)'),
                                background: isPickerOpen ? 'var(--ef-ink)' : (hasAssigned ? 'var(--ef-success-bg)' : 'var(--ef-canvas-raised)'),
                                color: isPickerOpen ? 'var(--ef-surface)' : (hasAssigned ? 'var(--ef-success-strong)' : 'var(--ef-text-muted)'),
                              }}
                              title={isPickerOpen ? 'Close topic picker' : 'Assign topics to this section'}
                            >
                              <BookOpen size={10} strokeWidth={1.5} />
                              <span>Topics{hasAssigned ? ` · ${sec.assignedTopics.length}` : ''}</span>
                              <ChevronRight size={9} strokeWidth={2} style={{ transform: isPickerOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                            </button>
                            <button
                              onClick={() => removeSection(idx)}
                              disabled={sections.length <= 1}
                              className="flex-shrink-0 flex items-center justify-center transition-opacity hover:opacity-60"
                              style={{ width: 22, height: 22, borderRadius: 2, color: sections.length <= 1 ? 'var(--ef-border)' : 'var(--ef-text-muted)', cursor: sections.length <= 1 ? 'not-allowed' : 'pointer' }}
                            >
                              <X size={12} strokeWidth={1.5} />
                            </button>
                          </div>

                          {/* ── Accepted-engines row ──────────────────────────
                              The section's item-type lock, expressed on the only
                              axis with a mechanical answer: which delivery
                              runtimes can this section run? Ticking Choice lets
                              MCQ, True/False and Fill in the Blank sit together
                              without anyone enumerating that, and a future item
                              type on an existing engine joins for free.

                              Nothing ticked = unlocked, which is the default and
                              what every pre-existing assessment loads as — so
                              this row is opt-in and changes nothing until used. */}
                          <div
                            className="flex items-center flex-wrap"
                            style={{
                              gap: 6,
                              padding: '6px 10px 8px 44px',
                              background: 'var(--ef-surface)',
                              borderTop: '1px dashed var(--ef-border-subtle)',
                            }}
                          >
                            <span className="text-xs flex-shrink-0" style={{ color: 'var(--ef-text-muted)' }}>
                              Accepts
                            </span>
                            {SECTION_ENGINE_OPTIONS.map((eng) => {
                              const on = sec.engines.includes(eng);
                              return (
                                <button
                                  key={eng}
                                  type="button"
                                  onClick={() => toggleSectionEngine(idx, eng)}
                                  title={EXECUTION_ENGINE_SUMMARY[eng]}
                                  className="text-xs px-2 py-1 transition-all"
                                  style={{
                                    borderRadius: 2,
                                    border: on ? '1px solid var(--ef-ink)' : '1px solid var(--ef-border)',
                                    background: on ? 'var(--ef-ink)' : 'var(--ef-canvas-raised)',
                                    color: on ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
                                  }}
                                >
                                  {EXECUTION_ENGINE_LABEL[eng]}
                                </button>
                              );
                            })}
                            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                              {sec.engines.length === 0
                                ? '— any item type'
                                : `— ${sectionAcceptedTypeCount(sec.engines)} item types`}
                            </span>
                          </div>

                          {/* Break-after-section row (hidden on last section) */}
                          {idx < sections.length - 1 && (
                            <div
                              className="flex items-center"
                              style={{
                                gap: 8,
                                padding: '6px 10px 8px 44px',
                                background: 'var(--ef-surface)',
                                borderTop: '1px dashed var(--ef-border-subtle)',
                              }}
                            >
                              <span className="text-xs flex-shrink-0" style={{ color: 'var(--ef-text-muted)' }}>
                                {/* Positional: this break applies after the (idx+1)th COMPLETED
                                    section, whichever section that turns out to be when the
                                    section order is Random or Student's choice. */}
                                Break after {idx + 1}{(['st', 'nd', 'rd'][idx] ?? 'th')} section completed
                              </span>
                              <input
                                type="number"
                                value={sec.breakAfterMinutes}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  if (v !== '' && (parseInt(v, 10) || 0) < 1) return;
                                  setSections((prev) => prev.map((s, i) => (i === idx ? { ...s, breakAfterMinutes: v } : s)));
                                }}
                                placeholder="—"
                                min="1"
                                className="flex-shrink-0 outline-none text-center text-xs"
                                style={{ width: 52, padding: '5px 6px', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', color: 'var(--ef-ink)', MozAppearance: 'textfield' } as React.CSSProperties}
                                onWheel={(e) => (e.target as HTMLInputElement).blur()}
                                onKeyDown={(e) => { if (['-', 'e', '+', '.'].includes(e.key)) e.preventDefault(); }}
                              />
                              <span className="text-xs flex-shrink-0" style={{ color: 'var(--ef-text-muted)' }}>min</span>
                              <label
                                className="flex items-center gap-1.5 text-xs ml-2"
                                style={{
                                  color: sec.breakAfterMinutes ? 'var(--ef-text-subtle)' : 'var(--ef-text-muted)',
                                  cursor: sec.breakAfterMinutes ? 'pointer' : 'not-allowed',
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={sec.breakMandatory}
                                  disabled={!sec.breakAfterMinutes}
                                  onChange={(e) =>
                                    setSections((prev) => prev.map((s, i) => (i === idx ? { ...s, breakMandatory: e.target.checked } : s)))
                                  }
                                />
                                Mandatory wait
                              </label>
                              <span className="text-xs ml-auto" style={{ color: 'var(--ef-text-muted)' }}>
                                {sec.breakAfterMinutes
                                  ? sec.breakMandatory
                                    ? 'Student must wait the full duration'
                                    : 'Student may skip and continue'
                                  : 'No break — next section starts immediately'}
                              </span>
                            </div>
                          )}

                          {/* Assigned topic tags (collapsed view) */}
                          {hasAssigned && !isPickerOpen && (
                            <div className="flex flex-wrap gap-1.5 px-10 pb-2.5 pt-0" style={{ background: 'var(--ef-surface)' }}>
                              {sec.assignedTopics.map((key) => {
                                const parts = key.split('::');
                                const subj = parts[0] ?? '';
                                const topic = parts[1] ?? key;
                                return (
                                  <span
                                    key={key}
                                    className="inline-flex items-center gap-1 px-2 py-0.5"
                                    style={{ background: 'var(--ef-success-bg)', color: 'var(--ef-success-strong)', border: '1px solid var(--ef-success-border)', borderRadius: 2, fontSize: 10 }}
                                  >
                                    <span style={{ color: 'var(--ef-text-muted)', fontSize: 9 }}>{subj}</span>
                                    <span style={{ color: 'var(--ef-text-muted)', fontSize: 9 }}>›</span>
                                    <span>{topic}</span>
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); toggleAssignedTopic(idx, key); }}
                                      className="hover:opacity-60 transition-opacity"
                                      style={{ color: 'var(--ef-success-strong)', lineHeight: 1, marginLeft: 1 }}
                                    >
                                      <X size={8} strokeWidth={2.5} />
                                    </button>
                                  </span>
                                );
                              })}
                            </div>
                          )}

                          {/* Expandable topic picker — scoped to topicPool */}
                          <AnimatePresence initial={false}>
                            {isPickerOpen && (
                              <motion.div
                                initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
                                animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
                                exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
                                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                              >
                                <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                                  <SectionTopicPicker
                                    sectionIdx={idx}
                                    sections={sections}
                                    assignedTopics={sec.assignedTopics}
                                    onToggleTopic={(key) => toggleAssignedTopic(idx, key)}
                                    subjectTopics={scopedSubjectTopics}
                                  />
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>

                {/* Add section */}
                <button
                  onClick={addSection}
                  disabled={sections.length >= 26 || !mut.sections}
                  className="w-full mt-3 flex items-center justify-center gap-1.5 py-2.5 text-xs transition-all hover:opacity-80"
                  style={{ border: '1px dashed var(--ef-border-muted)', borderRadius: 3, color: 'var(--ef-text-muted)', background: 'transparent', cursor: sections.length >= 26 || !mut.sections ? 'not-allowed' : 'pointer', opacity: !mut.sections ? 0.4 : 1 }}
                >
                  <Plus size={12} strokeWidth={1.5} /> Add Section
                </button>

                {/* Summary */}
                {(sections.length > 1 || totalSectionTime > 0) && (() => {
                  const totalAssigned = sections.reduce((s, sec) => s + sec.assignedTopics.length, 0);
                  return (
                    <div className="flex items-center gap-4 mt-4 px-4 py-3"
                      style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border-subtle)', borderRadius: 2 }}>
                      <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                        {sections.length} section{sections.length !== 1 ? 's' : ''}
                      </span>
                      {totalAssigned > 0 && (
                        <span className="text-xs flex items-center gap-1" style={{ color: 'var(--ef-success-strong)' }}>
                          <BookOpen size={9} strokeWidth={1.5} />
                          {totalAssigned} topic{totalAssigned !== 1 ? 's' : ''} assigned
                        </span>
                      )}
                      {totalSectionTime > 0 && (
                        <span className="text-xs flex items-center gap-1.5 ml-auto" style={{ color: 'var(--ef-text-muted)' }}>
                          <Timer size={10} strokeWidth={1.5} />
                          {totalSectionTime} min total
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>

        {/* ── Forward affordance ──
            The rail is how an author navigates, but a first-time author
            working through the builder in order should not have to find it to
            advance. This follows the stage list rather than naming a fixed
            destination — it used to read "Continue to Rules", which named a
            step that no longer exists under that name and was shown on every
            phase of the old step 1 regardless of where it would actually go.

            Never disabled. Blocking forward motion on a stage the author has
            not finished is what made the old wizard feel like a form to be got
            through; the rail already reports what is outstanding, and nothing
            is lost by letting them look ahead and come back. */}
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