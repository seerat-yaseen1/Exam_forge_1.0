/**
 * builder/AssessmentPanel — full-page builder orchestrator: holds the draft
 * state shared by SetupStep and DetailsStep and performs the final save.
 * (Batch F1d: extracted verbatim from AssignmentsPage.tsx; no logic changes.)
 */
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, ChevronRight, Lock } from 'lucide-react';
import { type Assessment, type AssessmentDraft, type AssessmentStatus, isGroupRule } from '../../../../lib/assessmentService';
import { type Question, type QuestionGroup } from '../../../../lib/questionBankService';
import { type Subject } from '../../../../lib/subjectService';
import { type AllocationNodeType } from '../../../../lib/allocationService';
import { makeSectionId, draftQuestionCount, draftTotalMarks, type RuleDraft, type SectionDraft } from './shared';
import { SetupStep } from './SetupStep';
import { DetailsStep } from './DetailsStep';

// ══════════════════════════════════════════════════════════════════
// ASSESSMENT PANEL — full-page orchestrator
// ══════════════════════════════════════════════════════════════════

export function AssessmentPanel({ mode, assessment, allQuestions, allGroups = [], onSave, onClose }: {
  mode: 'create' | 'edit';
  assessment: Assessment | null;
  allQuestions: Question[];
  /** Question groups visible to the author — the pool group rules draw from. */
  allGroups?: QuestionGroup[];
  onSave: (draft: AssessmentDraft, seb: { keys: string[]; file: File | null; clearFile: boolean }, allocation: { mode: 'legacy' | 'rules'; nodeType: AllocationNodeType | ''; nodeIds: string[]; expectedVersion: number }) => Promise<void>;
  onClose: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Lock body scroll while the panel is open so the page underneath doesn't
  // contribute its own scrollbar alongside the panel's scrollbar.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // ── Lifted basics state ──────────────────────────────────────────
  const [title, setTitle] = useState(assessment?.title ?? '');
  const [description, setDescription] = useState(assessment?.description ?? '');
  const [subject, setSubject] = useState(assessment?.subject ?? '');
  const [status, setStatus] = useState<AssessmentStatus>(assessment?.status ?? 'draft');
  const [targetType, setTargetType] = useState<'all' | 'institutes' | 'students'>(
    assessment?.assignedTo.type ?? 'all'
  );
  const [selectedInstituteIds, setSelectedInstituteIds] = useState<string[]>(
    assessment?.assignedTo.type === 'institutes' ? assessment.assignedTo.instituteIds : []
  );
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>(
    assessment?.assignedTo.type === 'students' ? assessment.assignedTo.studentIds : []
  );

  // ── Subject / topic pool (Step 1 Phases 1 & 2) ──────────────────
  const [subjectPool, setSubjectPool] = useState<string[]>(assessment?.subjectPool ?? []);
  const [topicPool, setTopicPool] = useState<string[]>(assessment?.topicPool ?? []);

  // ── Delivery mode (Phase 0 wiring) — lifted so both Step 1 (Sections,
  // which conditionally shows the per-question timer) and Step 2 (Details,
  // which owns the selector) can read/write it. ──────────────────────
  const [deliveryMode, setDeliveryMode] = useState<'standard' | 'linear' | 'adaptive'>(
    assessment?.deliveryMode ?? 'standard',
  );

  const [sections, setSections] = useState<SectionDraft[]>(() => {
    if (assessment?.sections && assessment.sections.length > 0) {
      return assessment.sections.map((sec) => ({
        id: sec.id,
        name: sec.name,
        timeLimit: sec.timeLimit?.toString() ?? '',
        questionTimeLimit: sec.questionTimeLimit?.toString() ?? '',
        // Restore assigned topics; fall back to inferring from existing rules for old assessments
        assignedTopics: sec.assignedTopics ?? [...new Set(sec.rules.map((r) => `${r.subject}::${r.topic}`))],
        // Both rule kinds round-trip. A group rule that came back as a topic
        // draft would be silently rewritten into a random topic draw the next
        // time the author saved — losing the set structure without telling
        // them — so the discriminant is carried explicitly.
        rules: sec.rules.map((r): RuleDraft => isGroupRule(r)
          ? {
              kind: 'group',
              subject: r.subject,
              topic: r.topic,
              difficulty: r.difficulty,
              count: '',
              marksPerQuestion: r.marksPerQuestion.toString(),
              groupKind: r.groupKind,
              groupCount: r.groupCount.toString(),
              questionsPerGroup: r.questionsPerGroup === 'all' ? 'all' : r.questionsPerGroup.toString(),
              ...(r.fixedGroupIds ? { fixedGroupIds: r.fixedGroupIds } : {}),
            }
          : {
              kind: 'topic',
              subject: r.subject,
              topic: r.topic,
              difficulty: r.difficulty,
              count: r.count.toString(),
              marksPerQuestion: r.marksPerQuestion.toString(),
              ...(r.fixedQuestionIds ? { fixedQuestionIds: r.fixedQuestionIds } : {}),
            }),
        breakAfterMinutes: sec.breakAfter?.durationMinutes?.toString() ?? '',
        breakMandatory: sec.breakAfter?.mandatory ?? false,
        // Absent on every assessment built before section locking — loads as
        // unlocked, which is exactly how it has been behaving.
        engines: sec.engines ?? [],
      }));
    }
    return [{
      id: makeSectionId(),
      name: 'Section A',
      timeLimit: '',
      rules: [],
      assignedTopics: [],
      breakAfterMinutes: '',
      questionTimeLimit: '',
      breakMandatory: false,
      engines: [],
    }];
  });

  // A group rule set to "all children" has no knowable count until the draw
  // happens at publish. Rather than counting it as zero — which would show a
  // confidently wrong total — those rules are excluded from the sum and the
  // total is marked approximate.
  const allRules = sections.flatMap((sec) => sec.rules);
  const hasUnknownCount = allRules.some((r) => draftQuestionCount(r) === null);
  const grandTotalQ = allRules.reduce((s, r) => s + (draftQuestionCount(r) ?? 0), 0);
  const grandTotalMarks = allRules.reduce((s, r) => s + (draftTotalMarks(r) ?? 0), 0);

  return (
    <motion.div
      key="fullpage-panel"
      initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: 'var(--ef-canvas)' }}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-8 flex-shrink-0"
        style={{ height: 56, borderBottom: '1px solid var(--ef-border)', background: 'var(--ef-surface)' }}>
        {/* Left */}
        <div className="flex items-center gap-4">
          <button onClick={onClose}
            className="flex items-center gap-1.5 text-xs transition-opacity hover:opacity-60"
            style={{ color: 'var(--ef-text-muted)' }}>
            <X size={13} strokeWidth={1.5} />
            <span style={{ letterSpacing: '0.04em' }}>Cancel</span>
          </button>
          <div style={{ width: 1, height: 14, background: 'var(--ef-border)' }} />
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
            {mode === 'create' ? 'NEW ASSESSMENT' : 'EDIT ASSESSMENT'}
          </p>
          {/* Step indicator */}
          <div className="flex items-center gap-1.5">
            {[1, 2, 3].map((n, i) => (
              <React.Fragment key={n}>
                {i > 0 && <div style={{ width: 16, height: 1, background: step >= n ? 'var(--ef-ink)' : 'var(--ef-border)' }} />}
                <div className="flex items-center justify-center"
                  style={{ width: 18, height: 18, borderRadius: 9, background: step >= n ? 'var(--ef-ink)' : 'var(--ef-border)', fontSize: 9, color: step >= n ? 'var(--ef-surface)' : 'var(--ef-text-muted)' }}>
                  {n}
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* Center */}
        {step >= 2 && grandTotalQ > 0 && (
          <span className="text-xs px-2.5 py-1"
            style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)' }}>
            {sections.length} section{sections.length !== 1 ? 's' : ''} · {hasUnknownCount ? '≥ ' : ''}{grandTotalQ} Q · {hasUnknownCount ? '≥ ' : ''}{grandTotalMarks} marks
          </span>
        )}

        {/* Right */}
        {step === 1 ? (
          <button
            onClick={() => setStep(2)}
            disabled={!title.trim() || !sections.every((s) => s.name.trim() && parseInt(s.timeLimit, 10) >= 1)}
            className="flex items-center gap-1.5 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
            style={{
              background: title.trim() && sections.every((s) => s.name.trim() && parseInt(s.timeLimit, 10) >= 1) ? 'var(--ef-ink)' : 'var(--ef-track)',
              color: 'var(--ef-surface)', borderRadius: 2,
              cursor: title.trim() && sections.every((s) => s.name.trim() && parseInt(s.timeLimit, 10) >= 1) ? 'pointer' : 'not-allowed',
            }}>
            Continue to Rules <ChevronRight size={12} strokeWidth={2} />
          </button>
        ) : null}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <AnimatePresence mode="wait">
          {step === 1 ? (
            <SetupStep
              key="step1"
              title={title} setTitle={setTitle}
              description={description} setDescription={setDescription}
              subject={subject} setSubject={setSubject}
              status={status} setStatus={setStatus}
              sections={sections} setSections={setSections}
              onContinue={() => setStep(2)}
              originalStatus={assessment?.status}
              allQuestions={allQuestions}
              subjectPool={subjectPool} setSubjectPool={setSubjectPool}
              topicPool={topicPool} setTopicPool={setTopicPool}
              deliveryMode={deliveryMode}
            />
          ) : (
            /* Steps 2 and 3 share one keyed wrapper so DetailsStep never
               remounts across 2↔3 — its local settings state (dates, toggles,
               SEB config) must survive Back navigation from Allocation. */
            <motion.div key="step2" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }} className="flex-1 overflow-y-auto flex flex-col">
              <DetailsStep
                mode={mode} assessment={assessment} originalStatus={assessment?.status}
                allQuestions={allQuestions}
                allGroups={allGroups}
                sections={sections} setSections={setSections}
                onBack={() => setStep(1)} onSave={onSave}
                title={title} description={description} subject={subject} status={status}
                targetType={targetType} setTargetType={setTargetType}
                selectedInstituteIds={selectedInstituteIds} setSelectedInstituteIds={setSelectedInstituteIds}
                selectedStudentIds={selectedStudentIds} setSelectedStudentIds={setSelectedStudentIds}
                subjectPool={subjectPool}
                topicPool={topicPool}
                deliveryMode={deliveryMode} setDeliveryMode={setDeliveryMode}
                allocationPhase={step === 3}
                onContinueToAllocation={() => setStep(3)}
                onBackToRules={() => setStep(2)}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════