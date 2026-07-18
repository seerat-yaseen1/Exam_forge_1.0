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
import { getAllSubjects, type Subject } from '../../../../lib/subjectService';
import { makeSectionId, SECTION_LETTERS, defaultSectionName, mutabilityFor, type SectionDraft } from './shared';
import { Field, SectionLabel, inputStyle } from './controls';
import { SectionTopicPicker, SubjectPickerPhase, TopicPickerPhase } from './topicPickers';

export function SetupStep({
  title, setTitle, description, setDescription,
  subject, setSubject, status, setStatus,
  sections, setSections,
  onContinue, originalStatus,
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
  onContinue: () => void;
  originalStatus?: AssessmentStatus;
  allQuestions: Question[];
  subjectPool: string[];
  setSubjectPool: React.Dispatch<React.SetStateAction<string[]>>;
  topicPool: string[];
  setTopicPool: React.Dispatch<React.SetStateAction<string[]>>;
  deliveryMode: 'standard' | 'linear' | 'adaptive';
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

  // ── Right-column phase: 1=Subjects, 2=Topics, 3=Sections ─────
  // Restore the furthest-completed phase when returning from Step 2.
  const [rightPhase, setRightPhase] = useState<1 | 2 | 3>(() => {
    if (topicPool.length > 0) return 3;
    if (subjectPool.length > 0) return 2;
    return 1;
  });

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
      if (q.isDeleted || !q.subject || !q.topic) return;
      if (!map[q.subject]) map[q.subject] = new Set();
      map[q.subject].add(q.topic);
    });
    const sorted: Record<string, string[]> = {};
    for (const subj in map) sorted[subj] = [...map[subj]].sort();
    return sorted;
  }, [allQuestions]);

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
      { id: makeSectionId(), name: defaultSectionName(prev.length), timeLimit: '', questionTimeLimit: '', rules: [], assignedTopics: [], breakAfterMinutes: '', breakMandatory: false },
    ]);
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

  const sectionsValid = sections.length > 0 && sections.every((s) => s.name.trim() && parseInt(s.timeLimit, 10) >= 1);
  const canContinue = title.trim() !== '' && sectionsValid;

  const handleContinue = () => {
    if (!title.trim()) { setTitleError(true); return; }
    onContinue();
  };

  return (
    <motion.div
      key="step1"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="flex-1 overflow-y-auto"
      style={{ padding: '48px 48px 80px' }}
    >
      <div style={{ width: '100%', maxWidth: 1080, margin: '0 auto' }}>

        {/* Heading */}
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex items-center justify-center"
              style={{ width: 28, height: 28, borderRadius: 2, background: '#F7F6F3', border: '1px solid #EEECEA' }}>
              <Layers size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />
            </div>
            <p className="text-xs" style={{ color: '#C4C3BD', letterSpacing: '0.1em' }}>STEP 1 OF 3</p>
          </div>
          <h2 className="text-base mb-1" style={{ color: '#0C0C0B' }}>Assessment Setup</h2>
          <p className="text-xs" style={{ color: '#B0AEA8', lineHeight: 1.6 }}>
            Define the basics and configure sections. Question rules are set in the next step.
          </p>
          {originalStatus && originalStatus !== 'draft' && (
            <div className="flex items-start gap-2.5 mt-4 px-3 py-3"
              style={{ background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2 }}>
              <Lock size={11} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0, marginTop: 1 }} />
              <p className="text-xs" style={{ color: '#6B6B66', lineHeight: 1.6 }}>
                {originalStatus === 'active'
                  ? <>Some fields are locked because this test is <strong>live</strong>.</>
                  : <>Some fields are locked because this test is <strong>closed</strong>.</>}
              </p>
            </div>
          )}
        </div>

        {/* Stacked: Basics on top, Phase stepper below */}
        <div className="space-y-10">

          {/* ── TOP: Basics ── */}
          <div className="space-y-5">
            <SectionLabel label="BASICS" />

            {/* Row 1: Title · Subject — targeting now lives in Step 3 (Allocation) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <Field label="Title" required>
                <input
                  type="text" value={title}
                  onChange={(e) => { setTitle(e.target.value); if (e.target.value.trim()) setTitleError(false); }}
                  style={{ ...inputStyle, fontSize: 13, padding: '9px 12px', borderColor: titleError ? '#F2CECE' : '#E3E1DB', background: titleError ? '#FDF5F5' : '#FFFFFF' }}
                  placeholder="e.g., Midterm Exam — Mathematics" autoFocus
                />
                {titleError && <p className="text-xs mt-1" style={{ color: '#9B2828' }}>Title is required</p>}
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

          {/* ── BOTTOM: Phase stepper (Subjects → Topics → Sections) ── */}
          <div>

            {/* Phase indicator strip */}
            <div className="flex items-center mb-6">
              {[
                { n: 1 as const, label: 'Subjects' },
                { n: 2 as const, label: 'Topics' },
                { n: 3 as const, label: 'Sections' },
              ].map(({ n, label }, i) => {
                const isActive = rightPhase === n;
                const isDone = rightPhase > n;
                const canGoBack = rightPhase > n;
                return (
                  <React.Fragment key={n}>
                    {i > 0 && (
                      <div style={{
                        flex: 1, height: 1, margin: '0 8px',
                        background: isDone ? '#0C0C0B' : '#E3E1DB',
                        transition: 'background 0.2s',
                      }} />
                    )}
                    <button
                      type="button"
                      disabled={!canGoBack}
                      onClick={() => canGoBack && setRightPhase(n)}
                      className="flex items-center gap-1.5 flex-shrink-0 transition-opacity"
                      style={{ cursor: canGoBack ? 'pointer' : 'default', opacity: 1 }}
                    >
                      <div style={{
                        width: 18, height: 18, borderRadius: 9, fontSize: 9,
                        background: isActive ? '#0C0C0B' : isDone ? '#0C0C0B' : '#E3E1DB',
                        color: (isActive || isDone) ? '#FFFFFF' : '#9A9891',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                      }}>
                        {isDone
                          ? <CheckCircle2 size={10} strokeWidth={2.5} style={{ color: '#FFFFFF' }} />
                          : n}
                      </div>
                      <span style={{
                        fontSize: 11,
                        color: isActive ? '#0C0C0B' : isDone ? '#6B6B66' : '#C4C3BD',
                      }}>
                        {label}
                      </span>
                    </button>
                  </React.Fragment>
                );
              })}
            </div>

            {/* ── Phase 1: Subject Picker ── */}
            {rightPhase === 1 && (
              <SubjectPickerPhase
                subjects={allSubjectDocs}
                allQuestions={allQuestions}
                selectedIds={subjectPool}
                onToggle={toggleSubjectInPool}
                onNext={() => setRightPhase(2)}
                loading={loadingSubjects}
              />
            )}

            {/* ── Phase 2: Topic Picker ── */}
            {rightPhase === 2 && (
              <TopicPickerPhase
                allSubjects={allSubjectDocs}
                allQuestions={allQuestions}
                selectedSubjectIds={subjectPool}
                selectedTopics={topicPool}
                onToggleTopic={toggleTopicInPool}
                onBack={() => setRightPhase(1)}
                onNext={() => setRightPhase(3)}
              />
            )}

            {/* ── Phase 3: Section Builder ── */}
            {rightPhase === 3 && (
              <div>
                {/* Pool reminder strip */}
                {topicPool.length > 0 && (
                  <div className="flex items-center gap-2 px-3 py-2 mb-4"
                    style={{ background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2 }}>
                    <BookOpen size={10} strokeWidth={1.5} style={{ color: '#1E7B3C', flexShrink: 0 }} />
                    <span style={{ fontSize: 11, color: '#1E7B3C', flex: 1 }}>
                      Topic pool: {topicPool.length} topic{topicPool.length !== 1 ? 's' : ''} across {subjectPool.length} subject{subjectPool.length !== 1 ? 's' : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => setRightPhase(2)}
                      className="text-xs transition-opacity hover:opacity-70"
                      style={{ color: '#1E7B3C', flexShrink: 0 }}
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
                            border: '1px solid #E3E1DB',
                            borderRadius: 3,
                            overflow: 'hidden',
                            opacity: !mut.sections ? 0.5 : 1,
                            pointerEvents: !mut.sections ? 'none' : 'auto',
                          }}
                        >
                          {/* Top row: index + name + time + topics toggle + remove */}
                          <div className="flex items-center" style={{ gap: 8, padding: '8px 10px', background: '#FFFFFF' }}>
                            <div className="flex-shrink-0 flex items-center justify-center"
                              style={{ width: 26, height: 26, borderRadius: 2, background: '#F7F6F3', border: '1px solid #EEECEA', fontSize: 10, color: '#9A9891' }}>
                              {(idx + 1).toString().padStart(2, '0')}
                            </div>
                            <input
                              type="text" value={sec.name}
                              onChange={(e) => updateSection(idx, 'name', e.target.value)}
                              placeholder={`Section ${SECTION_LETTERS[idx] ?? idx + 1}`}
                              className="flex-1 outline-none text-xs"
                              style={{ border: '1px solid #E3E1DB', borderRadius: 2, color: '#0C0C0B', background: '#FFFFFF', padding: '7px 10px', minWidth: 0 }}
                            />
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <input
                                type="number" value={sec.timeLimit}
                                onChange={(e) => updateSection(idx, 'timeLimit', e.target.value)}
                                placeholder="—" min="1"
                                className="flex-shrink-0 outline-none text-center text-xs"
                                style={{ width: 52, padding: '7px 6px', border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B', MozAppearance: 'textfield' } as React.CSSProperties}
                                onWheel={(e) => (e.target as HTMLInputElement).blur()}
                                onKeyDown={(e) => { if (['-', 'e', '+', '.'].includes(e.key)) e.preventDefault(); }}
                              />
                              <span className="text-xs flex-shrink-0" style={{ color: '#9A9891' }}>min</span>
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
                                  style={{ width: 52, padding: '7px 6px', border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B', MozAppearance: 'textfield' } as React.CSSProperties}
                                  onWheel={(e) => (e.target as HTMLInputElement).blur()}
                                  onKeyDown={(e) => { if (['-', 'e', '+', '.'].includes(e.key)) e.preventDefault(); }}
                                />
                                <span className="text-xs flex-shrink-0" style={{ color: '#9A9891' }}>s/q</span>
                              </div>
                            )}
                            {/* Topics toggle button */}
                            <button
                              type="button"
                              onClick={() => toggleSectionExpanded(sec.id)}
                              className="flex-shrink-0 flex items-center gap-1 text-xs px-2 py-1.5 transition-all"
                              style={{
                                borderRadius: 2,
                                border: isPickerOpen ? '1px solid #0C0C0B' : (hasAssigned ? '1px solid #B8E6C8' : '1px solid #E3E1DB'),
                                background: isPickerOpen ? '#0C0C0B' : (hasAssigned ? '#F0F9F4' : '#FAFAF8'),
                                color: isPickerOpen ? '#FFFFFF' : (hasAssigned ? '#1E7B3C' : '#9A9891'),
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
                              style={{ width: 22, height: 22, borderRadius: 2, color: sections.length <= 1 ? '#E3E1DB' : '#C4C3BD', cursor: sections.length <= 1 ? 'not-allowed' : 'pointer' }}
                            >
                              <X size={12} strokeWidth={1.5} />
                            </button>
                          </div>

                          {/* Break-after-section row (hidden on last section) */}
                          {idx < sections.length - 1 && (
                            <div
                              className="flex items-center"
                              style={{
                                gap: 8,
                                padding: '6px 10px 8px 44px',
                                background: '#FFFFFF',
                                borderTop: '1px dashed #F0EFEB',
                              }}
                            >
                              <span className="text-xs flex-shrink-0" style={{ color: '#9A9891' }}>
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
                                style={{ width: 52, padding: '5px 6px', border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B', MozAppearance: 'textfield' } as React.CSSProperties}
                                onWheel={(e) => (e.target as HTMLInputElement).blur()}
                                onKeyDown={(e) => { if (['-', 'e', '+', '.'].includes(e.key)) e.preventDefault(); }}
                              />
                              <span className="text-xs flex-shrink-0" style={{ color: '#9A9891' }}>min</span>
                              <label
                                className="flex items-center gap-1.5 text-xs ml-2"
                                style={{
                                  color: sec.breakAfterMinutes ? '#4A4A45' : '#C4C3BD',
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
                              <span className="text-xs ml-auto" style={{ color: '#C4C3BD' }}>
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
                            <div className="flex flex-wrap gap-1.5 px-10 pb-2.5 pt-0" style={{ background: '#FFFFFF' }}>
                              {sec.assignedTopics.map((key) => {
                                const parts = key.split('::');
                                const subj = parts[0] ?? '';
                                const topic = parts[1] ?? key;
                                return (
                                  <span
                                    key={key}
                                    className="inline-flex items-center gap-1 px-2 py-0.5"
                                    style={{ background: '#F0F9F4', color: '#1E7B3C', border: '1px solid #B8E6C8', borderRadius: 2, fontSize: 10 }}
                                  >
                                    <span style={{ color: '#9A9891', fontSize: 9 }}>{subj}</span>
                                    <span style={{ color: '#C4C3BD', fontSize: 9 }}>›</span>
                                    <span>{topic}</span>
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); toggleAssignedTopic(idx, key); }}
                                      className="hover:opacity-60 transition-opacity"
                                      style={{ color: '#1E7B3C', lineHeight: 1, marginLeft: 1 }}
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
                  style={{ border: '1px dashed #DDDBD5', borderRadius: 3, color: '#9A9891', background: 'transparent', cursor: sections.length >= 26 || !mut.sections ? 'not-allowed' : 'pointer', opacity: !mut.sections ? 0.4 : 1 }}
                >
                  <Plus size={12} strokeWidth={1.5} /> Add Section
                </button>

                {/* Summary */}
                {(sections.length > 1 || totalSectionTime > 0) && (() => {
                  const totalAssigned = sections.reduce((s, sec) => s + sec.assignedTopics.length, 0);
                  return (
                    <div className="flex items-center gap-4 mt-4 px-4 py-3"
                      style={{ background: '#F7F6F3', border: '1px solid #EEECEA', borderRadius: 2 }}>
                      <span className="text-xs" style={{ color: '#9A9891' }}>
                        {sections.length} section{sections.length !== 1 ? 's' : ''}
                      </span>
                      {totalAssigned > 0 && (
                        <span className="text-xs flex items-center gap-1" style={{ color: '#1E7B3C' }}>
                          <BookOpen size={9} strokeWidth={1.5} />
                          {totalAssigned} topic{totalAssigned !== 1 ? 's' : ''} assigned
                        </span>
                      )}
                      {totalSectionTime > 0 && (
                        <span className="text-xs flex items-center gap-1.5 ml-auto" style={{ color: '#6B6B66' }}>
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

        {/* Continue */}
        <div className="mt-10 flex items-center justify-end">
          <button onClick={handleContinue} disabled={!canContinue}
            className="flex items-center gap-2 text-xs px-5 py-2.5 transition-opacity"
            style={{
              background: canContinue ? '#0C0C0B' : '#C8C7C2',
              color: '#FFFFFF', borderRadius: 2,
              cursor: canContinue ? 'pointer' : 'not-allowed',
              letterSpacing: '0.03em',
            }}>
            Continue to Rules <ChevronRight size={12} strokeWidth={2} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}