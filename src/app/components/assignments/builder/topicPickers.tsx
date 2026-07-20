/**
 * builder/topicPickers — the question-selection stack of the builder:
 * RuleBuilderPanel (per-section selection rules), SectionTopicPicker and the
 * Subject/Topic picker phases. (Batch F1c: extracted verbatim from
 * AssignmentsPage.tsx; no logic changes.)
 */
import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Loader2, CheckCircle2, Timer, ChevronRight, Layers, CheckSquare, Square, BookOpen, Lock, AlertCircle } from 'lucide-react';
import { type Question } from '../../../../lib/questionBankService';
import { type Subject } from '../../../../lib/subjectService';
import { DIFFICULTIES, type Difficulty, type RuleDraft, type SectionDraft } from './shared';
import { DifficultyRow, PenaltyInput } from './controls';
import { type GradingPolicy } from '../../../../lib/assessmentService';

export function RuleBuilderPanel({
  sections,
  activeSectionIdx,
  setActiveSectionIdx,
  setSections,
  allQuestions,
  locked,
  subjectPoolNames,
  topicPool,
  subjectNameById,
  topicNameById,
  grading,
}: {
  sections: SectionDraft[];
  activeSectionIdx: number;
  setActiveSectionIdx: (i: number) => void;
  setSections: React.Dispatch<React.SetStateAction<SectionDraft[]>>;
  allQuestions: Question[];
  locked?: boolean;
  subjectPoolNames?: string[];
  topicPool?: string[];
  // Slug → CURRENT canonical name maps. When provided, a question's subject/
  // topic is read from its subjectId/topicId via these maps, so a renamed
  // subject/topic still groups its old questions under the current name (and
  // never appears split across old + new names). Falls back to the stored
  // name when a question has no ID or the map lacks the ID (legacy docs).
  subjectNameById?: Record<string, string>;
  topicNameById?: Record<string, string>;
  // Negative-marking config surface (Standard/Linear only; undefined = feature
  // off/adaptive, so no grading UI renders). Lets each section get a section
  // override and each difficulty row a per-level override, resolving the
  // inherited value for display.
  grading?: {
    negMarkingOn: boolean;
    getSectionPolicy: (sectionId: string) => GradingPolicy | undefined;
    getRowPolicy: (sectionId: string, diff: 'easy' | 'medium' | 'hard') => GradingPolicy | undefined;
    resolveInherited: (sectionId: string, diff: 'easy' | 'medium' | 'hard') => string;
    setSectionPolicy: (sectionId: string, patch: Partial<GradingPolicy> | null) => void;
    setRowPolicy: (sectionId: string, diff: 'easy' | 'medium' | 'hard', patch: Partial<GradingPolicy> | null) => void;
  };
}) {
  const activeSection = sections[activeSectionIdx];

  // Resolve a question's subject/topic to its current canonical name. Keep in
  // sync with canonicalSubject/canonicalTopic in assessmentService — same rule.
  const qSubject = (q: Question): string =>
    (subjectNameById && q.subjectId && subjectNameById[q.subjectId]) || q.subject;
  const qTopic = (q: Question): string =>
    (topicNameById && q.topicId && topicNameById[q.topicId]) || q.topic;

  // ── Derived bank structure ──────────────────────────────────────
  // subjectTopics: subject → sorted list of topics
  // bankCount: subject::topic::difficulty → count
  const { subjectTopics, bankCount } = useMemo(() => {
    const topicsMap: Record<string, Set<string>> = {};
    const countMap: Record<string, number> = {};
    allQuestions.forEach((q) => {
      const subj = qSubject(q);
      const top = qTopic(q);
      if (q.isDeleted || !subj || !top) return;
      if (!topicsMap[subj]) topicsMap[subj] = new Set();
      topicsMap[subj].add(top);
      const k = `${subj}::${top}::${q.difficulty}`;
      countMap[k] = (countMap[k] ?? 0) + 1;
    });
    const sorted: Record<string, string[]> = {};
    for (const subj in topicsMap) {
      sorted[subj] = [...topicsMap[subj]].sort();
    }
    return { subjectTopics: sorted, bankCount: countMap };
  }, [allQuestions, subjectNameById, topicNameById]);

  // ── Filter by this section's assigned topics ────────────────────
  // If assignedTopics is non-empty, only show those subject/topic pairs.
  // If empty (no pre-assignment), fall back to showing the full bank.
  const filteredSubjectTopics = useMemo(() => {
    // Layer 1: start from full bank
    let base: Record<string, string[]> = subjectTopics;

    // Layer 2: narrow by global subjectPool / topicPool from Step 1
    const subjSet = subjectPoolNames && subjectPoolNames.length > 0 ? new Set(subjectPoolNames) : null;
    const topicSet = topicPool && topicPool.length > 0 ? new Set(topicPool) : null;
    if (subjSet || topicSet) {
      const narrowed: Record<string, string[]> = {};
      for (const subj in base) {
        if (subjSet && !subjSet.has(subj)) continue;
        const topics = base[subj].filter((t) => !topicSet || topicSet.has(`${subj}::${t}`));
        if (topics.length > 0) narrowed[subj] = topics;
      }
      base = narrowed;
    }

    // Layer 3: narrow further by per-section assignedTopics
    const assigned = activeSection?.assignedTopics ?? [];
    if (assigned.length === 0) return base;
    const result: Record<string, string[]> = {};
    assigned.forEach((key) => {
      const idx = key.indexOf('::');
      if (idx === -1) return;
      const subj = key.slice(0, idx);
      const topic = key.slice(idx + 2);
      if (!base[subj] || !base[subj].includes(topic)) return;
      if (!result[subj]) result[subj] = [];
      if (!result[subj].includes(topic)) result[subj].push(topic);
    });
    for (const subj in result) result[subj].sort();
    return result;
  }, [activeSection?.assignedTopics, subjectTopics, subjectPoolNames, topicPool]);

  const allSubjects = useMemo(() => Object.keys(filteredSubjectTopics).sort(), [filteredSubjectTopics]);

  const isTopicFiltered = (activeSection?.assignedTopics?.length ?? 0) > 0;

  // ── Cross-section topic map ─────────────────────────────────────
  // For each "subject::topic" key, which OTHER sections also have it assigned?
  const topicOtherSectionsMap = useMemo(() => {
    const map: Record<string, number[]> = {};
    sections.forEach((sec, si) => {
      if (si === activeSectionIdx) return;
      (sec.assignedTopics ?? []).forEach((key) => {
        if (!map[key]) map[key] = [];
        map[key].push(si);
      });
    });
    return map;
  }, [sections, activeSectionIdx]);

  // ── Prior-section committed counts ─────────────────────────────
  // key: subject::topic::difficulty
  const priorCommitted = useMemo(() => {
    const map: Record<string, number> = {};
    sections.forEach((sec, si) => {
      if (si >= activeSectionIdx) return;
      sec.rules.forEach((r) => {
        const count = parseInt(r.count, 10) || 0;
        if (!count) return;
        const k = `${r.subject}::${r.topic}::${r.difficulty}`;
        map[k] = (map[k] ?? 0) + count;
      });
    });
    return map;
  }, [sections, activeSectionIdx]);

  const getAvailable = (subject: string, topic: string, diff: Difficulty) => {
    const total = bankCount[`${subject}::${topic}::${diff}`] ?? 0;
    const used = priorCommitted[`${subject}::${topic}::${diff}`] ?? 0;
    return Math.max(0, total - used);
  };

  // ── Expand/select state ─────────────────────────────────────────
  // expandedSubjects: which subject accordions are open
  // selectedTopics: which topics are checked (key = subject::topic)

  // Helper: derive expanded subjects from both rules and pre-assigned topics
  function deriveExpandedSubjects(sec: SectionDraft | undefined): Set<string> {
    const set = new Set<string>();
    sec?.rules.forEach((r) => { if (r.subject) set.add(r.subject); });
    // Also auto-expand subjects of pre-assigned topics so faculty sees them immediately
    (sec?.assignedTopics ?? []).forEach((key) => {
      const subj = key.split('::')[0];
      if (subj) set.add(subj);
    });
    return set;
  }

  const [expandedSubjects, setExpandedSubjects] = useState<Set<string>>(() =>
    deriveExpandedSubjects(sections[activeSectionIdx])
  );

  const [selectedTopics, setSelectedTopics] = useState<Set<string>>(() => {
    const set = new Set<string>();
    sections[activeSectionIdx]?.rules.forEach((r) => {
      if (r.subject && r.topic) set.add(`${r.subject}::${r.topic}`);
    });
    return set;
  });

  // Re-sync when active section tab changes
  useEffect(() => {
    const newTopics = new Set<string>();
    sections[activeSectionIdx]?.rules.forEach((r) => {
      if (r.subject && r.topic) newTopics.add(`${r.subject}::${r.topic}`);
    });
    setExpandedSubjects(deriveExpandedSubjects(sections[activeSectionIdx]));
    setSelectedTopics(newTopics);
  }, [activeSectionIdx]); // eslint-disable-line

  const toggleSubject = (subject: string) => {
    setExpandedSubjects((prev) => {
      const next = new Set(prev);
      next.has(subject) ? next.delete(subject) : next.add(subject);
      return next;
    });
  };

  const toggleTopic = (subject: string, topic: string) => {
    const tk = `${subject}::${topic}`;
    setSelectedTopics((prev) => {
      const next = new Set(prev);
      if (next.has(tk)) {
        next.delete(tk);
        // Clear all rules for this topic in the active section
        setSections((secs) => secs.map((sec, i) =>
          i !== activeSectionIdx ? sec : {
            ...sec,
            rules: sec.rules.filter((r) => !(r.subject === subject && r.topic === topic)),
          }
        ));
      } else {
        next.add(tk);
        // Ensure subject is expanded
        setExpandedSubjects((es) => { const ns = new Set(es); ns.add(subject); return ns; });
      }
      return next;
    });
  };

  const updateRule = (
    subject: string, topic: string, diff: Difficulty,
    field: 'count' | 'marksPerQuestion', value: string
  ) => {
    setSections((secs) => secs.map((sec, i) => {
      if (i !== activeSectionIdx) return sec;
      const existing = sec.rules.find(
        (r) => r.subject === subject && r.topic === topic && r.difficulty === diff
      );
      if (existing) {
        return {
          ...sec,
          rules: sec.rules.map((r) =>
            r.subject === subject && r.topic === topic && r.difficulty === diff
              ? { ...r, [field]: value }
              : r
          ),
        };
      } else {
        const newRule: RuleDraft = { subject, topic, difficulty: diff, count: '', marksPerQuestion: '1', [field]: value };
        return { ...sec, rules: [...sec.rules, newRule] };
      }
    }));
  };

  const getRule = (subject: string, topic: string, diff: Difficulty) =>
    activeSection?.rules.find((r) => r.subject === subject && r.topic === topic && r.difficulty === diff);

  // ── Totals ──────────────────────────────────────────────────────
  const sectionTotalQ = activeSection?.rules.reduce((s, r) => s + (parseInt(r.count, 10) || 0), 0) ?? 0;
  const sectionTotalMarks = activeSection?.rules.reduce((s, r) =>
    s + (parseInt(r.count, 10) || 0) * (parseFloat(r.marksPerQuestion) || 0), 0) ?? 0;

  const grandTotalQ = sections.reduce((s, sec) =>
    s + sec.rules.reduce((ss, r) => ss + (parseInt(r.count, 10) || 0), 0), 0);
  const grandTotalMarks = sections.reduce((s, sec) =>
    sec.rules.reduce((ss, r) =>
      ss + (parseInt(r.count, 10) || 0) * (parseFloat(r.marksPerQuestion) || 0), s), 0);

  if (!activeSection) return null;

  return (
    <div className="flex" style={{ background: '#FFFFFF', minHeight: 560, alignItems: 'stretch' }}>

      {/* ── LEFT: Vertical section rail (sticky while page scrolls) ── */}
      <div className="flex-shrink-0 flex flex-col"
        style={{
          width: 172,
          borderRight: '1px solid #E3E1DB',
          background: '#FAFAF8',
          position: 'sticky',
          top: 0,
          alignSelf: 'flex-start',
        }}>

        <div className="flex-shrink-0 px-4 pt-4 pb-2">
          <p style={{ color: '#C4C3BD', fontSize: 10, letterSpacing: '0.09em' }}>SECTIONS</p>
        </div>

        <div className="flex-1">
          {sections.map((sec, idx) => {
            const isActive = idx === activeSectionIdx;
            const secQ = sec.rules.reduce((s, r) => s + (parseInt(r.count, 10) || 0), 0);
            const secMarks = sec.rules.reduce((s, r) => s + (parseInt(r.count, 10) || 0) * (parseFloat(r.marksPerQuestion) || 0), 0);
            return (
              <button
                key={sec.id}
                onClick={() => setActiveSectionIdx(idx)}
                className="w-full flex flex-col items-start px-4 py-3 transition-colors text-left"
                style={{
                  background: isActive ? '#FFFFFF' : 'transparent',
                  borderLeft: `2px solid ${isActive ? '#0C0C0B' : 'transparent'}`,
                  borderBottom: '1px solid #E3E1DB',
                }}
              >
                <span className="text-xs" style={{ color: isActive ? '#0C0C0B' : '#6B6B66', lineHeight: 1.4, wordBreak: 'break-word' }}>
                  {sec.name}
                </span>
                <span style={{ color: '#C4C3BD', fontSize: 10, marginTop: 2 }}>
                  {secQ > 0 ? `${secQ} Q · ${secMarks} mk` : 'no rules yet'}
                </span>
                {sec.timeLimit && (
                  <span className="flex items-center gap-1 mt-1" style={{ color: '#B0AEA8', fontSize: 10 }}>
                    <Timer size={9} strokeWidth={1.5} />{sec.timeLimit} min
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Grand total at rail bottom */}
        <div className="flex-shrink-0 px-4 py-3" style={{ borderTop: '1px solid #E3E1DB', background: '#F7F6F3' }}>
          <p style={{ color: '#9A9891', fontSize: 10 }}>{grandTotalQ} Q · {grandTotalMarks} marks</p>
          <p style={{ color: '#C4C3BD', fontSize: 10, marginTop: 1 }}>
            {sections.length} section{sections.length !== 1 ? 's' : ''} total
          </p>
        </div>
      </div>

      {/* ── RIGHT: Rule content (grows with content; outer page handles scroll) ── */}
      <div className="flex-1 flex flex-col" style={{ minWidth: 0 }}>

      {/* ── Instruction or lock banner ── */}
      {locked ? (
        <div className="px-5 py-2.5 flex-shrink-0 flex items-center gap-2"
          style={{ background: '#FEF9EC', borderBottom: '1px solid #F5DFA0' }}>
          <Lock size={11} strokeWidth={1.5} style={{ color: '#92680A', flexShrink: 0 }} />
          <p style={{ color: '#92680A', fontSize: 11, lineHeight: 1.5 }}>
            Question rules are locked — the question set was resolved when this test went live and cannot be changed.
          </p>
        </div>
      ) : isTopicFiltered ? (
        <div className="px-5 py-2.5 flex-shrink-0 flex items-center gap-2"
          style={{ background: '#F0F9F4', borderBottom: '1px solid #B8E6C8' }}>
          <BookOpen size={11} strokeWidth={1.5} style={{ color: '#1E7B3C', flexShrink: 0 }} />
          <p style={{ color: '#1E7B3C', fontSize: 11, lineHeight: 1.5 }}>
            Showing <strong>{activeSection?.assignedTopics.length}</strong> pre-assigned topic{(activeSection?.assignedTopics.length ?? 0) !== 1 ? 's' : ''} for this section.
            Set pick count &amp; marks per difficulty row.
          </p>
        </div>
      ) : (
        <div className="px-5 py-2.5 flex-shrink-0 flex items-center gap-2"
          style={{ background: '#FAFAF8', borderBottom: '1px solid #F0EFEB' }}>
          <Layers size={11} strokeWidth={1.5} style={{ color: '#C4C3BD', flexShrink: 0 }} />
          <p style={{ color: '#9A9891', fontSize: 11, lineHeight: 1.5 }}>
            No topics pre-assigned — showing full bank. Assign topics in Setup (Step 1) for a focused view.
          </p>
        </div>
      )}

      {/* ── Subject / topic / difficulty tree ── */}
      <div className="flex-1" style={locked ? { pointerEvents: 'none', opacity: 0.5 } : {}}>
        {allSubjects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16" style={{ color: '#C4C3BD' }}>
            {isTopicFiltered ? (
              <>
                <p className="text-xs">No topics assigned to this section</p>
                <p style={{ fontSize: 11, color: '#DDDBD5', marginTop: 4 }}>Go back to Setup to assign topics</p>
              </>
            ) : (
              <>
                <p className="text-xs">No subjects found in question bank</p>
                <p style={{ fontSize: 11, color: '#DDDBD5', marginTop: 4 }}>Add questions to the bank first</p>
              </>
            )}
          </div>
        ) : (
          allSubjects.map((subject) => {
            const isSubjectOpen = expandedSubjects.has(subject);
            const topics = filteredSubjectTopics[subject] ?? [];
            const totalInBank = topics.reduce(
              (s, t) => s + DIFFICULTIES.reduce((ss, d) => ss + (bankCount[`${subject}::${t}::${d}`] ?? 0), 0), 0
            );
            const subjectSelectedQ = activeSection.rules
              .filter((r) => r.subject === subject)
              .reduce((s, r) => s + (parseInt(r.count, 10) || 0), 0);
            const subjectSelectedTopics = topics.filter((t) => selectedTopics.has(`${subject}::${t}`)).length;

            return (
              <div key={subject} style={{ borderBottom: '1px solid #F0EFEB' }}>

                {/* Subject accordion header */}
                <button
                  className="w-full flex items-center gap-2.5 px-5 py-3 text-left transition-colors"
                  style={{ background: isSubjectOpen ? '#FAFAF8' : '#FFFFFF' }}
                  onClick={() => toggleSubject(subject)}
                >
                  {/* Chevron */}
                  <ChevronRight size={13} strokeWidth={1.5}
                    style={{ color: '#9A9891', flexShrink: 0, transition: 'transform 0.15s', transform: isSubjectOpen ? 'rotate(90deg)' : 'rotate(0deg)' }} />

                  <span className="flex-1 text-xs" style={{ color: '#0C0C0B' }}>{subject}</span>

                  {/* Badge: selected topics count */}
                  {subjectSelectedTopics > 0 && (
                    <span className="text-xs px-1.5 py-0.5 flex-shrink-0"
                      style={{ background: '#F7F6F3', color: '#6B6B66', border: '1px solid #E3E1DB', borderRadius: 2, fontSize: 10 }}>
                      {subjectSelectedTopics}/{topics.length} topic{topics.length !== 1 ? 's' : ''}
                    </span>
                  )}

                  {/* Badge: Q selected */}
                  {subjectSelectedQ > 0 && (
                    <span className="text-xs px-1.5 py-0.5 flex-shrink-0"
                      style={{ background: '#F0F9F4', color: '#1E7B3C', border: '1px solid #B8E6C8', borderRadius: 2 }}>
                      {subjectSelectedQ} Q
                    </span>
                  )}

                  <span style={{ color: '#C4C3BD', fontSize: 11, flexShrink: 0 }}>{totalInBank} in bank</span>
                </button>

                {/* Topics list */}
                <AnimatePresence initial={false}>
                  {isSubjectOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
                      animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
                      exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
                      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                      style={{ borderTop: '1px solid #F0EFEB' }}
                    >
                      <div className="py-1.5" style={{ background: '#FAFAF8' }}>
                        {topics.map((topic) => {
                          const tk = `${subject}::${topic}`;
                          const isTopicSelected = selectedTopics.has(tk);
                          const topicTotalInBank = DIFFICULTIES.reduce(
                            (s, d) => s + (bankCount[`${subject}::${topic}::${d}`] ?? 0), 0
                          );
                          const topicQ = activeSection.rules
                            .filter((r) => r.subject === subject && r.topic === topic)
                            .reduce((s, r) => s + (parseInt(r.count, 10) || 0), 0);
                          const topicMarks = activeSection.rules
                            .filter((r) => r.subject === subject && r.topic === topic)
                            .reduce((s, r) => s + (parseInt(r.count, 10) || 0) * (parseFloat(r.marksPerQuestion) || 0), 0);

                          // Cross-section sharing: which other sections also have this topic?
                          const otherSectionIdxs = topicOtherSectionsMap[tk] ?? [];

                          return (
                            <div key={topic} style={{ borderBottom: '1px solid #F0EFEB' }}>
                              {/* Topic row with checkbox */}
                              <button
                                className="w-full flex items-center gap-2.5 px-5 py-2.5 text-left transition-colors"
                                style={{ background: isTopicSelected ? '#FFFFFF' : 'transparent' }}
                                onClick={() => toggleTopic(subject, topic)}
                              >
                                {/* Checkbox */}
                                <span style={{ flexShrink: 0 }}>
                                  {isTopicSelected
                                    ? <CheckSquare size={13} strokeWidth={1.5} style={{ color: '#0C0C0B' }} />
                                    : <Square size={13} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />}
                                </span>

                                {/* Topic name */}
                                <span className="flex-1 text-xs" style={{ color: isTopicSelected ? '#0C0C0B' : '#6B6B66' }}>
                                  {topic}
                                </span>

                                {/* Cross-section "also in Sec X" badge */}
                                {otherSectionIdxs.length > 0 && (
                                  <span style={{ fontSize: 10, color: '#92680A', background: '#FEF9EC', border: '1px solid #F5DFA0', borderRadius: 2, padding: '1px 6px', flexShrink: 0 }}>
                                    also in {otherSectionIdxs.map((si) => sections[si]?.name ?? `Sec ${si + 1}`).join(', ')}
                                  </span>
                                )}

                                {/* Marks subtotal for this topic */}
                                {topicMarks > 0 && (
                                  <span style={{ color: '#9A9891', fontSize: 11, flexShrink: 0 }}>
                                    {topicMarks} mk
                                  </span>
                                )}

                                {/* Q count badge */}
                                {topicQ > 0 && (
                                  <span className="text-xs px-1.5 py-0.5 flex-shrink-0"
                                    style={{ background: '#F0F9F4', color: '#1E7B3C', border: '1px solid #B8E6C8', borderRadius: 2, fontSize: 10 }}>
                                    {topicQ} Q
                                  </span>
                                )}

                                <span style={{ color: '#C4C3BD', fontSize: 10, flexShrink: 0 }}>
                                  {topicTotalInBank} in bank
                                </span>
                              </button>

                              {/* Difficulty rows (only when topic is checked) */}
                              <AnimatePresence initial={false}>
                                {isTopicSelected && (
                                  <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                                    style={{ overflow: 'hidden', borderTop: '1px solid #F0EFEB', background: '#FFFFFF', paddingTop: 4, paddingBottom: 6 }}
                                  >
                                    {DIFFICULTIES.map((diff) => (
                                      <DifficultyRow
                                        key={diff}
                                        diff={diff}
                                        available={getAvailable(subject, topic, diff)}
                                        bankTotal={bankCount[`${subject}::${topic}::${diff}`] ?? 0}
                                        rule={getRule(subject, topic, diff)}
                                        onCountChange={(v) => updateRule(subject, topic, diff, 'count', v)}
                                        onMarksChange={(v) => updateRule(subject, topic, diff, 'marksPerQuestion', v)}
                                        negMarkingOn={grading?.negMarkingOn}
                                        rowPolicy={grading?.getRowPolicy(activeSection.id, diff)}
                                        inheritedPenaltyLabel={grading?.resolveInherited(activeSection.id, diff)}
                                        onRowPolicyChange={grading ? (patch) => grading.setRowPolicy(activeSection.id, diff, patch) : undefined}
                                      />
                                    ))}
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>
                          );
                        })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })
        )}
      </div>

      {/* ── Section-level negative-marking override (Standard/Linear) ── */}
      {grading?.negMarkingOn && sectionTotalQ > 0 && (() => {
        const secPol = grading.getSectionPolicy(activeSection.id);
        const secOverrides = !!secPol && (secPol.penaltyValue !== undefined || secPol.negativeMarking === false);
        return (
          <div className="flex-shrink-0 flex items-center gap-2 px-5 py-2"
            style={{ borderTop: '1px solid #F0EFEB', background: '#FDFBF7' }}>
            <AlertCircle size={12} strokeWidth={1.5} style={{ color: '#B0AEA8' }} />
            <span className="text-xs" style={{ color: '#9A9891' }}>Penalty for this section</span>
            {secOverrides ? (
              <div className="flex items-center gap-1.5 ml-auto">
                <PenaltyInput compact policy={secPol ?? {}} onChange={(patch) => grading.setSectionPolicy(activeSection.id, patch)} />
                <button type="button" onClick={() => grading.setSectionPolicy(activeSection.id, null)}
                  style={{ fontSize: 10, color: '#9A9891', padding: '2px 4px', background: 'none', border: 'none', cursor: 'pointer' }}>
                  reset
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => grading.setSectionPolicy(activeSection.id, { penaltyValue: 0 })}
                className="ml-auto flex items-center gap-1"
                style={{ fontSize: 10, color: '#9A9891', padding: '2px 8px', border: '1px dashed #E3E1DB', borderRadius: 2, background: 'transparent', cursor: 'pointer' }}>
                <span style={{ color: '#C4C3BD' }}>inherits exam default:</span>
                <span>{grading.resolveInherited(activeSection.id, 'medium')}</span>
                <span style={{ color: '#C4C3BD' }}>· override</span>
              </button>
            )}
          </div>
        );
      })()}

      {/* ── Footer: per-section total ── */}
      {sectionTotalQ > 0 && (
        <div className="flex-shrink-0 flex items-center justify-between px-5 py-2.5"
          style={{ borderTop: '1px solid #E3E1DB', background: '#FAFAF8' }}>
          <span className="text-xs" style={{ color: '#9A9891' }}>
            {activeSection.name} · {sectionTotalQ} question{sectionTotalQ !== 1 ? 's' : ''}
          </span>
          <span className="text-xs" style={{ color: '#0C0C0B' }}>{sectionTotalMarks} marks</span>
        </div>
      )}
      </div>{/* end right column */}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SECTION TOPIC PICKER — inline topic assignment for Step 1 section cards
// ══════════════════════════════════════════════════════════════════

export function SectionTopicPicker({
  sectionIdx,
  sections,
  assignedTopics,
  onToggleTopic,
  subjectTopics,
}: {
  sectionIdx: number;
  sections: SectionDraft[];
  assignedTopics: string[];
  onToggleTopic: (key: string) => void;
  subjectTopics: Record<string, string[]>;
}) {
  const allSubjects = useMemo(() => Object.keys(subjectTopics).sort(), [subjectTopics]);

  const [expandedSubjects, setExpandedSubjects] = useState<Set<string>>(() => {
    const set = new Set<string>();
    assignedTopics.forEach((key) => {
      const subj = key.split('::')[0];
      if (subj) set.add(subj);
    });
    return set;
  });

  // Topics in other sections (excluding this one)
  const topicOtherSections = useMemo(() => {
    const map: Record<string, number[]> = {};
    sections.forEach((sec, si) => {
      if (si === sectionIdx) return;
      (sec.assignedTopics ?? []).forEach((key) => {
        if (!map[key]) map[key] = [];
        map[key].push(si);
      });
    });
    return map;
  }, [sections, sectionIdx]);

  const toggleSubject = (subj: string) => {
    setExpandedSubjects((prev) => {
      const next = new Set(prev);
      next.has(subj) ? next.delete(subj) : next.add(subj);
      return next;
    });
  };

  if (allSubjects.length === 0) {
    return (
      <div className="py-5 text-center" style={{ borderTop: '1px solid #E3E1DB' }}>
        <p style={{ color: '#C4C3BD', fontSize: 11 }}>No subjects in question bank</p>
        <p style={{ color: '#DDDBD5', fontSize: 10, marginTop: 3 }}>Add questions first to assign topics</p>
      </div>
    );
  }

  return (
    <div style={{ borderTop: '1px solid #E3E1DB' }}>
      {allSubjects.map((subject) => {
        const topics = subjectTopics[subject] ?? [];
        const isOpen = expandedSubjects.has(subject);
        const assignedCount = topics.filter((t) => assignedTopics.includes(`${subject}::${t}`)).length;

        return (
          <div key={subject} style={{ borderBottom: '1px solid #F0EFEB' }}>
            {/* Subject header */}
            <button
              type="button"
              className="w-full flex items-center gap-2 px-4 py-2 text-left transition-colors"
              style={{ background: isOpen ? '#F7F6F3' : '#FAFAF8' }}
              onClick={() => toggleSubject(subject)}
            >
              <ChevronRight
                size={11} strokeWidth={1.5}
                style={{ color: '#9A9891', flexShrink: 0, transition: 'transform 0.15s', transform: isOpen ? 'rotate(90deg)' : 'none' }}
              />
              <span className="flex-1 text-xs" style={{ color: '#0C0C0B' }}>{subject}</span>
              {assignedCount > 0 && (
                <span style={{ fontSize: 10, color: '#1E7B3C', background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2, padding: '1px 6px', flexShrink: 0 }}>
                  {assignedCount}/{topics.length}
                </span>
              )}
            </button>

            {/* Topics list */}
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
                  animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
                  exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
                  transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                >
                  {topics.map((topic) => {
                    const key = `${subject}::${topic}`;
                    const isChecked = assignedTopics.includes(key);
                    const otherSecs = topicOtherSections[key] ?? [];

                    return (
                      <button
                        key={topic}
                        type="button"
                        className="w-full flex items-center gap-2.5 px-5 py-2 text-left transition-colors"
                        style={{ background: isChecked ? '#FAFAF8' : '#FFFFFF', borderTop: '1px solid #F7F6F3' }}
                        onClick={() => onToggleTopic(key)}
                      >
                        <span style={{ flexShrink: 0 }}>
                          {isChecked
                            ? <CheckSquare size={12} strokeWidth={1.5} style={{ color: '#0C0C0B' }} />
                            : <Square size={12} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />}
                        </span>
                        <span className="flex-1 text-xs" style={{ color: isChecked ? '#0C0C0B' : '#6B6B66' }}>
                          {topic}
                        </span>
                        {otherSecs.length > 0 && (
                          <span style={{ fontSize: 10, color: '#92680A', background: '#FEF9EC', border: '1px solid #F5DFA0', borderRadius: 2, padding: '1px 6px', flexShrink: 0 }}>
                            also in {otherSecs.map((si) => sections[si]?.name ?? `Sec ${si + 1}`).join(', ')}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SUBJECT PICKER PHASE — Phase 1 of the right column in Step 1
// Grid of subject cards; each shows name · topic count · Q count.
// ══════════════════════════════════════════════════════════════════

export function SubjectPickerPhase({
  subjects,
  allQuestions,
  selectedIds,
  onToggle,
  onNext,
  loading,
  subjectNameById,
  topicNameById,
}: {
  subjects: Subject[];
  allQuestions: Question[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onNext: () => void;
  loading: boolean;
  subjectNameById?: Record<string, string>;
  topicNameById?: Record<string, string>;
}) {
  // Derive unique topic count per subject name from live question bank.
  // Resolve each question's subject/topic to its CURRENT canonical name so a
  // renamed subject's count lands under subj.name (the lookup key below) and
  // renamed topics aren't double-counted across old + new labels.
  const topicCountBySubject = useMemo(() => {
    const qSub = (q: Question) => (subjectNameById && q.subjectId && subjectNameById[q.subjectId]) || q.subject;
    const qTop = (q: Question) => (topicNameById && q.topicId && topicNameById[q.topicId]) || q.topic;
    const map: Record<string, Set<string>> = {};
    allQuestions.forEach((q) => {
      const s = qSub(q); const t = qTop(q);
      if (q.isDeleted || !s || !t) return;
      if (!map[s]) map[s] = new Set();
      map[s].add(t);
    });
    const out: Record<string, number> = {};
    for (const subj in map) out[subj] = map[subj].size;
    return out;
  }, [allQuestions, subjectNameById, topicNameById]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-14">
        <Loader2 size={18} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
      </div>
    );
  }

  if (subjects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-14" style={{ color: '#C4C3BD' }}>
        <BookOpen size={22} strokeWidth={1} style={{ marginBottom: 10 }} />
        <p className="text-xs">No subjects in question bank</p>
        <p style={{ fontSize: 11, color: '#DDDBD5', marginTop: 4 }}>Add questions with subject metadata first</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs mb-4" style={{ color: '#9A9891', lineHeight: 1.6 }}>
        Select the subjects this assessment will draw from. Topics are chosen in the next step.
      </p>

      <div className="space-y-2">
        {subjects.map((subj) => {
          const isSelected = selectedIds.includes(subj.id);
          const topicCount = topicCountBySubject[subj.name] ?? 0;
          const qCount = subj.questionCount;

          return (
            <button
              key={subj.id}
              type="button"
              onClick={() => onToggle(subj.id)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left transition-all"
              style={{
                border: isSelected ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
                borderRadius: 3,
                background: isSelected ? '#FFFFFF' : '#FAFAF8',
              }}
            >
              {/* Checkbox */}
              <div style={{
                width: 16, height: 16, borderRadius: 2, flexShrink: 0,
                border: `1px solid ${isSelected ? '#0C0C0B' : '#DDDBD5'}`,
                background: isSelected ? '#0C0C0B' : '#FFFFFF',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {isSelected && <CheckCircle2 size={9} strokeWidth={2.5} style={{ color: '#FFFFFF' }} />}
              </div>

              {/* Name + meta */}
              <div className="flex-1 min-w-0">
                <p className="text-xs" style={{ color: isSelected ? '#0C0C0B' : '#4A4A45' }}>{subj.name}</p>
                <p style={{ fontSize: 10, color: '#B0AEA8', marginTop: 2 }}>
                  {topicCount} topic{topicCount !== 1 ? 's' : ''}{qCount > 0 ? ` · ${qCount} Q` : ''}
                </p>
              </div>

              {/* Selected tick */}
              {isSelected && (
                <CheckCircle2 size={13} strokeWidth={1.5} style={{ color: '#0C0C0B', flexShrink: 0 }} />
              )}
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between mt-5">
        <span className="text-xs" style={{ color: '#B0AEA8' }}>
          {selectedIds.length === 0
            ? 'Select at least one subject to continue'
            : `${selectedIds.length} subject${selectedIds.length !== 1 ? 's' : ''} selected`}
        </span>
        <button
          type="button"
          onClick={onNext}
          disabled={selectedIds.length === 0}
          className="flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity"
          style={{
            background: selectedIds.length > 0 ? '#0C0C0B' : '#C8C7C2',
            color: '#FFFFFF', borderRadius: 2,
            cursor: selectedIds.length > 0 ? 'pointer' : 'not-allowed',
          }}
        >
          Topics <ChevronRight size={11} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// TOPIC PICKER PHASE — Phase 2 of the right column in Step 1
// Accordion grouped by selected subjects; topics with Q counts.
// "Select All" per subject; orphaned topics (0 Q) are grayed out.
// ══════════════════════════════════════════════════════════════════

export function TopicPickerPhase({
  allSubjects,
  allQuestions,
  selectedSubjectIds,
  selectedTopics,
  onToggleTopic,
  onBack,
  onNext,
  subjectNameById,
  topicNameById,
}: {
  allSubjects: Subject[];
  allQuestions: Question[];
  selectedSubjectIds: string[];
  selectedTopics: string[];
  onToggleTopic: (key: string) => void;
  onBack: () => void;
  onNext: () => void;
  subjectNameById?: Record<string, string>;
  topicNameById?: Record<string, string>;
}) {
  // Resolve subject names from selected IDs
  const selectedSubjectNames = useMemo(
    () => allSubjects.filter((s) => selectedSubjectIds.includes(s.id)).map((s) => s.name),
    [allSubjects, selectedSubjectIds]
  );

  // Build topic lists + per-topic Q counts, scoped to selected subjects.
  // Questions are grouped by their CURRENT canonical subject/topic name so a
  // renamed subject (whose old questions still store the old name) still lands
  // under the selected subject's current name, and renamed topics group cleanly.
  const subjectData = useMemo(() => {
    const qSub = (q: Question) => (subjectNameById && q.subjectId && subjectNameById[q.subjectId]) || q.subject;
    const qTop = (q: Question) => (topicNameById && q.topicId && topicNameById[q.topicId]) || q.topic;
    const map: Record<string, { topics: string[]; counts: Record<string, number> }> = {};
    selectedSubjectNames.forEach((name) => {
      map[name] = { topics: [], counts: {} };
    });
    const topicSets: Record<string, Set<string>> = {};
    allQuestions.forEach((q) => {
      const s = qSub(q); const t = qTop(q);
      if (q.isDeleted || !s || !t) return;
      if (!map[s]) return;
      if (!topicSets[s]) topicSets[s] = new Set();
      topicSets[s].add(t);
      map[s].counts[t] = (map[s].counts[t] ?? 0) + 1;
    });
    for (const subj in topicSets) {
      map[subj].topics = [...topicSets[subj]].sort();
    }
    return map;
  }, [allQuestions, selectedSubjectNames, subjectNameById, topicNameById]);

  const [expandedSubjects, setExpandedSubjects] = useState<Set<string>>(
    () => new Set(selectedSubjectNames)
  );

  // Re-sync expanded set when going back and changing subjects
  useEffect(() => {
    setExpandedSubjects(new Set(selectedSubjectNames));
  }, [selectedSubjectNames.join(',')]); // eslint-disable-line

  const toggleSubjectAccordion = (name: string) => {
    setExpandedSubjects((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const selectAllForSubject = (subjName: string) => {
    const topics = subjectData[subjName]?.topics ?? [];
    topics.forEach((topic) => {
      const key = `${subjName}::${topic}`;
      const hasQ = (subjectData[subjName]?.counts[topic] ?? 0) > 0;
      if (hasQ && !selectedTopics.includes(key)) onToggleTopic(key);
    });
  };

  const clearAllForSubject = (subjName: string) => {
    const topics = subjectData[subjName]?.topics ?? [];
    topics.forEach((topic) => {
      const key = `${subjName}::${topic}`;
      if (selectedTopics.includes(key)) onToggleTopic(key);
    });
  };

  const totalAvailableTopics = Object.values(subjectData).reduce(
    (s, d) => s + d.topics.filter((t) => (d.counts[t] ?? 0) > 0).length, 0
  );

  if (selectedSubjectIds.length === 0) {
    return (
      <div className="py-10 text-center" style={{ color: '#C4C3BD' }}>
        <p className="text-xs">No subjects selected</p>
        <button type="button" onClick={onBack} className="mt-3 text-xs transition-opacity hover:opacity-70" style={{ color: '#9A9891' }}>
          ← Back to subjects
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs mb-3" style={{ color: '#9A9891', lineHeight: 1.6 }}>
        Choose which topics to include. Grayed-out topics have no questions yet.
      </p>

      <div style={{ border: '1px solid #E3E1DB', borderRadius: 3, overflow: 'hidden' }}>
        {selectedSubjectNames.map((subjName, si) => {
          const data = subjectData[subjName] ?? { topics: [], counts: {} };
          const topics = data.topics;
          const isOpen = expandedSubjects.has(subjName);
          const assignedCount = topics.filter((t) => selectedTopics.includes(`${subjName}::${t}`)).length;
          const availableCount = topics.filter((t) => (data.counts[t] ?? 0) > 0).length;
          const allAvailableSelected = availableCount > 0 && assignedCount >= availableCount;

          return (
            <div key={subjName} style={{ borderBottom: si < selectedSubjectNames.length - 1 ? '1px solid #E3E1DB' : 'none' }}>
              {/* Subject header row */}
              <div className="flex items-stretch">
                <button
                  type="button"
                  className="flex-1 flex items-center gap-2 px-3 py-2.5 text-left transition-colors min-w-0"
                  style={{ background: isOpen ? '#F7F6F3' : '#FAFAF8' }}
                  onClick={() => toggleSubjectAccordion(subjName)}
                >
                  <ChevronRight
                    size={11} strokeWidth={1.5}
                    style={{ color: '#9A9891', flexShrink: 0, transition: 'transform 0.15s', transform: isOpen ? 'rotate(90deg)' : 'none' }}
                  />
                  <span className="flex-1 text-xs truncate" style={{ color: '#0C0C0B' }}>{subjName}</span>
                  {assignedCount > 0 && (
                    <span style={{ fontSize: 10, color: '#1E7B3C', background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2, padding: '1px 6px', flexShrink: 0 }}>
                      {assignedCount}/{availableCount}
                    </span>
                  )}
                </button>
                {/* "Select all" / "Clear" toggle */}
                <button
                  type="button"
                  className="flex-shrink-0 px-3 text-xs transition-opacity hover:opacity-70"
                  style={{
                    color: '#6B6B66',
                    borderLeft: '1px solid #E3E1DB',
                    background: isOpen ? '#F7F6F3' : '#FAFAF8',
                    cursor: availableCount === 0 ? 'not-allowed' : 'pointer',
                    opacity: availableCount === 0 ? 0.4 : 1,
                  }}
                  disabled={availableCount === 0}
                  onClick={() => allAvailableSelected ? clearAllForSubject(subjName) : selectAllForSubject(subjName)}
                >
                  {allAvailableSelected ? 'Clear' : 'All'}
                </button>
              </div>

              {/* Topics list */}
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
                    animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
                    exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
                    transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                  >
                    {topics.length === 0 ? (
                      <div className="px-5 py-3" style={{ background: '#FFFFFF', borderTop: '1px solid #F0EFEB' }}>
                        <p style={{ color: '#C4C3BD', fontSize: 11 }}>No topics found for this subject</p>
                      </div>
                    ) : (
                      topics.map((topic) => {
                        const key = `${subjName}::${topic}`;
                        const isChecked = selectedTopics.includes(key);
                        const qCount = data.counts[topic] ?? 0;
                        const hasQ = qCount > 0;

                        return (
                          <button
                            key={topic}
                            type="button"
                            disabled={!hasQ}
                            onClick={() => hasQ && onToggleTopic(key)}
                            className="w-full flex items-center gap-2.5 px-5 py-2 text-left transition-colors"
                            style={{
                              background: isChecked ? '#FAFAF8' : '#FFFFFF',
                              borderTop: '1px solid #F7F6F3',
                              opacity: hasQ ? 1 : 0.4,
                              cursor: hasQ ? 'pointer' : 'not-allowed',
                            }}
                          >
                            <span style={{ flexShrink: 0 }}>
                              {isChecked
                                ? <CheckSquare size={12} strokeWidth={1.5} style={{ color: '#0C0C0B' }} />
                                : <Square size={12} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />}
                            </span>
                            <span className="flex-1 text-xs" style={{ color: isChecked ? '#0C0C0B' : '#6B6B66' }}>
                              {topic}
                            </span>
                            <span style={{ fontSize: 10, color: hasQ ? '#B0AEA8' : '#C4C3BD', flexShrink: 0 }}>
                              {hasQ ? `${qCount} Q` : 'No questions'}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between mt-5">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs px-3 py-2 transition-opacity hover:opacity-70"
          style={{ color: '#6B6B66', border: '1px solid #E3E1DB', borderRadius: 2 }}
        >
          ← Subjects
        </button>
        <div className="flex items-center gap-3">
          <span className="text-xs" style={{ color: '#B0AEA8' }}>
            {selectedTopics.length === 0
              ? `${totalAvailableTopics} available`
              : `${selectedTopics.length} of ${totalAvailableTopics} selected`}
          </span>
          <button
            type="button"
            onClick={onNext}
            disabled={selectedTopics.length === 0}
            className="flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity"
            style={{
              background: selectedTopics.length > 0 ? '#0C0C0B' : '#C8C7C2',
              color: '#FFFFFF', borderRadius: 2,
              cursor: selectedTopics.length > 0 ? 'pointer' : 'not-allowed',
            }}
          >
            Sections <ChevronRight size={11} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// STEP 1 — Setup (Basics + Sections, two-column)
// ══════════════════════════════════════════════════════════════════