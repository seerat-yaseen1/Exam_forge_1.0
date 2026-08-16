/**
 * builder/AssessmentPanel — full-page builder orchestrator: holds the draft
 * state shared by SetupStep and DetailsStep and performs the final save.
 * (Batch F1d: extracted verbatim from AssignmentsPage.tsx; no logic changes.)
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { X, RotateCcw, AlertTriangle, Loader2, CheckCircle2 } from 'lucide-react';
import { type Assessment, type AssessmentDraft, type AssessmentStatus, isGroupRule } from '../../../../lib/assessmentService';
import { type Question, type QuestionGroup } from '../../../../lib/questionBankService';
import { type Subject } from '../../../../lib/subjectService';
import { type AllocationNodeType } from '../../../../lib/allocationService';
import { makeSectionId, type RuleDraft, type SectionDraft } from './shared';
import { SetupStep } from './SetupStep';
import { DetailsStep } from './DetailsStep';
import { StageRail } from './StageRail';
import { paperTotals, stageDef, stageStatus, type BuilderStage } from './stages';
import { clearDraft, readDraft, stashDraft, type StashedDraft } from './draftStore';

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
  // Which stage is on screen. Free navigation — nothing here gates it; see
  // stages.ts for why the three-step wizard this replaced was the wrong shape.
  const [stage, setStage] = useState<BuilderStage>('basics');

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

  // ── The paper as it stands, and how far each stage has got ──────
  //
  // Both feed the rail. paperTotals handles the case a bare sum cannot: a
  // group rule drawing 'all' of its children has no knowable count until the
  // draw at publish, so it is excluded from the sum and the total is marked
  // approximate rather than reported as a confidently wrong number.
  const totals = paperTotals(sections);
  /** Which of the two step components owns the stage on screen. */
  const setupOwnsStage = stageDef(stage).owner === 'setup';
  const statusFor = useCallback(
    (id: BuilderStage) => stageStatus(id, { title, subjectPool, topicPool, sections }),
    [title, subjectPool, topicPool, sections],
  );

  // ══════════════════════════════════════════════════════════════
  // THE CRASH NET
  // ══════════════════════════════════════════════════════════════
  //
  // Everything above this line lived only in React state. Cancel called
  // onClose with no confirm; a refresh, a closed tab or a flat battery took
  // the lot. See draftStore.ts for why the snapshot is local rather than a
  // Firestore document.

  const stashKey = assessment?.id ?? null;

  /** Everything worth restoring. Deliberately the LIFTED state only —
   *  DetailsStep's schedule/grading/security values stay in its own hands, and
   *  a half-restored draft that carried some of them and not others would be
   *  worse than one that honestly restores the structural work. */
  const snapshot = useMemo(() => ({
    title, description, subject, status, subjectPool, topicPool, sections, deliveryMode,
  }), [title, description, subject, status, subjectPool, topicPool, sections, deliveryMode]);

  /** A restorable draft found at open. Offered, never applied silently. */
  const [recovered, setRecovered] = useState<StashedDraft<typeof snapshot> | null>(null);
  /** Suppresses the unsaved guard once a save has succeeded. */
  const savedRef = useRef(false);

  // Look for a stash once, at open. `mode` is in the key via assessment.id, so
  // an interrupted edit of one exam is never offered while opening another.
  useEffect(() => {
    const found = readDraft<typeof snapshot>(stashKey);
    if (found) setRecovered(found);
    // Intentionally once: re-running would re-offer a draft the author dismissed.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Mirror as they work. Debounced because this fires on every keystroke in
  // the title field, and localStorage writes are synchronous — an unthrottled
  // JSON.stringify of the whole draft per character is jank the author feels.
  useEffect(() => {
    if (savedRef.current) return;
    const t = setTimeout(() => stashDraft(stashKey, snapshot), 400);
    return () => clearTimeout(t);
  }, [snapshot, stashKey]);

  /** The draft exactly as the panel opened, for the edit-mode dirty check.
   *  Declared BEFORE the memo that reads it — useMemo runs its callback during
   *  render, so a later `const` would still be in the temporal dead zone. */
  const openedWithRef = useRef(snapshot);

  const isDirty = useMemo(() => {
    // In create mode, any title or section rule counts as work worth keeping.
    if (mode === 'create') {
      return title.trim().length > 0
        || subjectPool.length > 0
        || sections.some((s) => s.rules.length > 0);
    }
    // In edit mode everything starts populated, so "dirty" has to mean changed.
    // Compared against the snapshot the panel opened with rather than field by
    // field, so a field added later cannot quietly fall out of the check.
    return JSON.stringify(snapshot) !== JSON.stringify(openedWithRef.current);
  }, [mode, title, subjectPool, sections, snapshot]);

  // The browser-level half of the guard. Covers refresh, tab close and
  // navigation away — the cases a confirm dialog inside the app cannot see.
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  const [confirmingClose, setConfirmingClose] = useState(false);

  /** The save controls, published upward by DetailsStep — see its onSaveApi.
   *  A ref plus a version counter rather than plain state: the API object is
   *  rebuilt every DetailsStep render, and storing it in state directly would
   *  set state during render and loop. */
  const saveApiRef = useRef<{ save: (s?: AssessmentStatus) => void; saving: boolean } | null>(null);
  const [savingFlag, setSavingFlag] = useState(false);
  const receiveSaveApi = useCallback(
    (api: { save: (s?: AssessmentStatus) => void; saving: boolean }) => {
      saveApiRef.current = api;
      setSavingFlag((was) => (was === api.saving ? was : api.saving));
    },
    [],
  );

  const requestClose = useCallback(() => {
    if (isDirty && !savedRef.current) { setConfirmingClose(true); return; }
    onClose();
  }, [isDirty, onClose]);

  /** Discard: the author said so, so the stash goes too — leaving it would
   *  re-offer work they just chose to throw away, the next time they open. */
  const discardAndClose = useCallback(() => {
    clearDraft(stashKey);
    onClose();
  }, [stashKey, onClose]);

  const applyRecovered = useCallback(() => {
    if (!recovered) return;
    const d = recovered.data;
    setTitle(d.title); setDescription(d.description); setSubject(d.subject);
    setStatus(d.status); setSubjectPool(d.subjectPool); setTopicPool(d.topicPool);
    setSections(d.sections); setDeliveryMode(d.deliveryMode);
    setRecovered(null);
  }, [recovered]);

  const dismissRecovered = useCallback(() => {
    clearDraft(stashKey);
    setRecovered(null);
  }, [stashKey]);

  /** Wraps the caller's save so a success retires the net. Once the assessment
   *  exists, Firestore is the truth and a stale local copy racing it would be
   *  a data-loss bug wearing a safety net's clothes. */
  const handleSave = useCallback<typeof onSave>(async (draft, seb, allocation) => {
    await onSave(draft, seb, allocation);
    savedRef.current = true;
    clearDraft(stashKey);
  }, [onSave, stashKey]);

  return (
    <motion.div
      key="fullpage-panel"
      initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: 'var(--ef-canvas)' }}
    >
      {/* ── Top bar ──
          Identity and the way out. Progress moved to the rail, so this row no
          longer carries a stepper — and the totals chip it used to show is now
          the rail's paper summary, visible from the first stage instead of
          appearing only once the author reached step 2. */}
      <div className="flex items-center justify-between gap-4 px-6 flex-shrink-0"
        style={{ height: 56, borderBottom: '1px solid var(--ef-border)', background: 'var(--ef-surface)' }}>
        <div className="flex items-center gap-4 min-w-0">
          <button onClick={requestClose}
            className="flex items-center gap-1.5 text-xs transition-opacity hover:opacity-60 flex-shrink-0"
            style={{ color: 'var(--ef-text-muted)' }}>
            <X size={13} strokeWidth={1.5} />
            <span style={{ letterSpacing: '0.04em' }}>Close</span>
          </button>
          <div style={{ width: 1, height: 14, background: 'var(--ef-border)', flexShrink: 0 }} />
          <p className="text-xs flex-shrink-0" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
            {mode === 'create' ? 'NEW ASSESSMENT' : 'EDIT ASSESSMENT'}
          </p>
          {/* The title, once there is one. An author with four drafts open over
              a week needs to know which one this is without reading the form. */}
          {title.trim() && (
            <>
              <div style={{ width: 1, height: 14, background: 'var(--ef-border)', flexShrink: 0 }} />
              <p className="text-xs truncate" style={{ color: 'var(--ef-ink)' }}>{title}</p>
            </>
          )}
        </div>

        {/* Unsaved marker. Quiet — it is a statement of fact, not a warning,
            and the guard on Close is what actually protects the work. */}
        {isDirty && !savedRef.current && (
          <span className="text-xs flex-shrink-0" style={{ color: 'var(--ef-text-muted)' }}>
            Unsaved
          </span>
        )}
      </div>

      {/* ── Body: rail + stage ── */}
      <div className="flex-1 overflow-hidden flex">
        <StageRail
          current={stage}
          statusFor={statusFor}
          totals={totals}
          onSelect={setStage}
        />

        {/*
          BOTH step components stay mounted for the whole session, and each
          hides the stages it does not own.

          This is not an optimisation. DetailsStep holds every schedule,
          grading and security value in its own local state, and the builder it
          replaced unmounted it whenever the author stepped back to step 1 — so
          a deadline typed before revisiting the sections was silently reset.
          The old code worked around this by keying steps 2 and 3 into one
          wrapper; with eight freely-navigable stages the workaround does not
          generalise, and keeping both mounted removes the class of bug rather
          than the instance.
        */}
        <div className="flex-1 overflow-hidden flex flex-col" style={{ minWidth: 0 }}>
          <div className={setupOwnsStage ? 'flex-1 overflow-hidden flex flex-col' : 'hidden'}>
            <SetupStep
              stage={stage}
              title={title} setTitle={setTitle}
              description={description} setDescription={setDescription}
              subject={subject} setSubject={setSubject}
              status={status} setStatus={setStatus}
              sections={sections} setSections={setSections}
              onNavigate={setStage}
              originalStatus={assessment?.status}
              allQuestions={allQuestions}
              subjectPool={subjectPool} setSubjectPool={setSubjectPool}
              topicPool={topicPool} setTopicPool={setTopicPool}
              deliveryMode={deliveryMode}
            />
          </div>

          <div className={setupOwnsStage ? 'hidden' : 'flex-1 overflow-y-auto flex flex-col'}>
            <DetailsStep
              stage={stage}
              onSaveApi={receiveSaveApi}
              onNavigate={setStage}
              mode={mode} assessment={assessment} originalStatus={assessment?.status}
              allQuestions={allQuestions}
              allGroups={allGroups}
              sections={sections} setSections={setSections}
              onBack={() => setStage('sections')} onSave={handleSave}
              title={title} description={description} subject={subject} status={status}
              targetType={targetType} setTargetType={setTargetType}
              selectedInstituteIds={selectedInstituteIds} setSelectedInstituteIds={setSelectedInstituteIds}
              selectedStudentIds={selectedStudentIds} setSelectedStudentIds={setSelectedStudentIds}
              subjectPool={subjectPool}
              topicPool={topicPool}
              deliveryMode={deliveryMode} setDeliveryMode={setDeliveryMode}
              allocationPhase={stage === 'allocation'}
              onContinueToAllocation={() => setStage('allocation')}
              onBackToRules={() => setStage('security')}
            />
          </div>
        </div>
      </div>

      {/* ── Save bar ──
          Workspace chrome, not stage content. It used to live at the bottom of
          the allocation stage, which made that stage the only place in the
          builder where work could be committed at all. */}
      <div className="flex items-center justify-end gap-3 px-6 py-4 flex-shrink-0"
        style={{ borderTop: '1px solid var(--ef-border)', background: 'var(--ef-surface)' }}>
        {(() => {
          const api = saveApiRef.current;
          const busy = savingFlag;
          // Edit mode on a live or closed assessment: status is locked, so one
          // button — there is no draft to save back to.
          const lockedStatus = mode === 'edit' && (assessment?.status === 'active' || assessment?.status === 'closed');
          if (lockedStatus) {
            return (
              <button onClick={() => api?.save()} disabled={busy || !api}
                className="flex items-center gap-1.5 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
                style={{ background: busy ? 'var(--ef-track)' : 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: busy ? 'not-allowed' : 'pointer' }}>
                {busy ? <><Loader2 size={11} className="animate-spin" /> Saving…</> : <><CheckCircle2 size={11} /> Save changes</>}
              </button>
            );
          }
          return (
            <>
              <button onClick={() => api?.save('draft')} disabled={busy || !api}
                className="flex items-center gap-1.5 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
                style={{ background: 'var(--ef-surface)', color: 'var(--ef-ink)', border: '1px solid var(--ef-ink)', borderRadius: 2, cursor: busy ? 'not-allowed' : 'pointer' }}>
                {busy ? <><Loader2 size={11} className="animate-spin" /> Saving…</> : <>{mode === 'create' ? 'Save as draft' : 'Save draft'}</>}
              </button>
              <button onClick={() => api?.save('active')} disabled={busy || !api}
                className="flex items-center gap-1.5 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
                style={{ background: busy ? 'var(--ef-track)' : 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: busy ? 'not-allowed' : 'pointer' }}>
                {busy ? <><Loader2 size={11} className="animate-spin" /> Publishing…</> : <><CheckCircle2 size={11} /> {mode === 'create' ? 'Create & publish' : 'Save & publish'}</>}
              </button>
            </>
          );
        })()}
      </div>

      {/* ── Recovered draft ──
          Offered, never applied. A draft that silently reappears is
          indistinguishable from a bug the first time it happens, and the
          author cannot tell whether they are looking at their own work. */}
      {recovered && (
        <RecoveryPrompt
          savedAt={recovered.savedAt}
          onRestore={applyRecovered}
          onDismiss={dismissRecovered}
        />
      )}

      {/* ── Close with unsaved work ── */}
      {confirmingClose && (
        <ConfirmDiscard
          onKeepEditing={() => setConfirmingClose(false)}
          onDiscard={discardAndClose}
        />
      )}
    </motion.div>
  );
}


// ══════════════════════════════════════════════════════════════════
// DRAFT-SAFETY DIALOGS
// ══════════════════════════════════════════════════════════════════

/** How long ago, in words an author reads faster than a timestamp. */
function agoLabel(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'moments ago';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function Scrim({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.45)' }}>
      <div className="w-full" style={{ maxWidth: 420, background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}>
        {children}
      </div>
    </div>
  );
}

function RecoveryPrompt({ savedAt, onRestore, onDismiss }: {
  savedAt: string;
  onRestore: () => void;
  onDismiss: () => void;
}) {
  return (
    <Scrim>
      <div className="px-6 py-5" style={{ borderBottom: '1px solid var(--ef-border)' }}>
        <div className="flex items-center gap-2">
          <RotateCcw size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          <span className="text-xs" style={{ color: 'var(--ef-ink)', letterSpacing: '0.06em' }}>
            UNFINISHED WORK
          </span>
        </div>
      </div>
      <div className="px-6 py-5">
        <p className="text-xs" style={{ color: 'var(--ef-ink)', lineHeight: 1.7 }}>
          You were building this {agoLabel(savedAt)} and did not save it. Pick up where you left off?
        </p>
        <p className="text-xs mt-2" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
          Starting fresh discards it for good.
        </p>
      </div>
      <div className="flex items-center justify-end gap-2 px-6 py-4"
        style={{ borderTop: '1px solid var(--ef-border)', background: 'var(--ef-canvas-raised)' }}>
        <button onClick={onDismiss} className="text-xs px-4 py-2 transition-opacity hover:opacity-70"
          style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2, cursor: 'pointer' }}>
          Start fresh
        </button>
        <button onClick={onRestore} className="text-xs px-4 py-2 transition-opacity hover:opacity-80"
          style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: 'pointer' }}>
          Restore
        </button>
      </div>
    </Scrim>
  );
}

function ConfirmDiscard({ onKeepEditing, onDiscard }: {
  onKeepEditing: () => void;
  onDiscard: () => void;
}) {
  return (
    <Scrim>
      <div className="px-6 py-5" style={{ borderBottom: '1px solid var(--ef-border)' }}>
        <div className="flex items-center gap-2">
          <AlertTriangle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-warning)' }} />
          <span className="text-xs" style={{ color: 'var(--ef-ink)', letterSpacing: '0.06em' }}>
            UNSAVED CHANGES
          </span>
        </div>
      </div>
      <div className="px-6 py-5">
        <p className="text-xs" style={{ color: 'var(--ef-ink)', lineHeight: 1.7 }}>
          This assessment has not been saved. Close it and lose the changes?
        </p>
      </div>
      {/* Keep editing is the primary action. The destructive one is available
          and plainly labelled, but it is not the button a returning hand lands
          on — which is the whole reason this dialog exists. */}
      <div className="flex items-center justify-end gap-2 px-6 py-4"
        style={{ borderTop: '1px solid var(--ef-border)', background: 'var(--ef-canvas-raised)' }}>
        <button onClick={onDiscard} className="text-xs px-4 py-2 transition-opacity hover:opacity-70"
          style={{ border: '1px solid var(--ef-danger-border)', color: 'var(--ef-danger)', borderRadius: 2, cursor: 'pointer' }}>
          Discard changes
        </button>
        <button onClick={onKeepEditing} className="text-xs px-4 py-2 transition-opacity hover:opacity-80"
          style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: 'pointer' }}>
          Keep editing
        </button>
      </div>
    </Scrim>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════