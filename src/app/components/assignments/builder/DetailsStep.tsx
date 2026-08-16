/**
 * builder/DetailsStep — step 2 of the assessment builder: targeting,
 * allocation, scheduling, attempts, settings (incl. audience visibility),
 * security tier and SEB. (Batch F1d: extracted verbatim from
 * AssignmentsPage.tsx; no logic changes.)
 */
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { X, Loader2, ClipboardList, Clock, Calendar, AlertTriangle, CheckCircle2, FileText, Timer, Award, ChevronRight, AlertCircle, Shuffle, BarChart2, BookOpen, Shield, Upload, Smartphone, Tablet } from 'lucide-react';
import { type Student } from '../../../../lib/firebaseService';
import { createAssessment, resolveQuestionsForSections, validateSelectionRules, applyTierDefaults, getAssessmentSEBKeys, getSEBSettings, getSEBPublicInfo, type Assessment, type AssessmentDraft, type AssessmentStatus, type AssignmentTarget, type AssessmentSection, type AssessmentGradingConfig, type GradingPolicy, type PenaltyType, type QuestionSelectionRule } from '../../../../lib/assessmentService';
import { deriveShowResultsTo, deriveAllowReviewTo, DEFAULT_SHOW_RESULTS_TO, DEFAULT_ALLOW_REVIEW_TO, type VisibilityAudience } from '../../../../lib/visibility';
import { AudienceSelector } from '../AudienceSelector';
import { type Question, type QuestionGroup } from '../../../../lib/questionBankService';
import { getAllSubjects, loadTaxonomyNameMaps, type Subject, type TaxonomyNameMaps } from '../../../../lib/subjectService';
import { AllocationPanelCore } from '../allocation/AllocationPanelCore';
import { emptyAllocationDraft, getAllocation, type AllocationDraft, type AllocationNodeType } from '../../../../lib/allocationService';
import { toDateTimeLocal, fromDateTimeLocal, formatDateTime, mutabilityFor, computeAutoOverallLimit, sumSectionsAndBreaksMinutes, draftIsLive, draftQuestionCount, DEFAULT_OVERALL_GRACE_SECONDS, type SectionDraft } from './shared';
import { Field, SectionLabel, selectStyle, DurationIndicator, StartScheduleControl, EndScheduleControl, LockedFieldWrapper, SettingsToggle, PenaltyInput } from './controls';
import { StageHeading, LockedNotice } from './StageHeading';
import { CapabilityChoice } from './CapabilityChoice';
import type { BuilderStage } from './stages';
import { RuleBuilderPanel } from './topicPickers';
import { InstitutePicker, StudentPicker } from './targetPickers';

// Prepare the grading policy for persistence:
//  • adaptive delivery → no policy (feature is Standard + Linear only)
//  • master switch off → undefined (exam stores nothing, grades like legacy)
//  • prune empty section/row overrides so the doc stays clean
// The server re-resolves and re-gates regardless; this just keeps stored data
// honest and avoids "off but carries penalty numbers" cruft.
function sanitizeGradingConfig(
  config: AssessmentGradingConfig,
  deliveryMode: 'standard' | 'linear' | 'adaptive',
): AssessmentGradingConfig | undefined {
  if (deliveryMode === 'adaptive') return undefined;
  const exam = config.exam;
  if (exam?.negativeMarking !== true) {
    // Master off. Preserve blankScore only if a teacher deliberately set one
    // (blank handling is meaningful even with penalties off); otherwise nothing.
    if (exam && typeof exam.blankScore === 'number') {
      return { exam: { negativeMarking: false, blankScore: exam.blankScore } };
    }
    return undefined;
  }
  const clean: AssessmentGradingConfig = { exam };
  if (config.sections) {
    const sections: NonNullable<AssessmentGradingConfig['sections']> = {};
    for (const [sid, sp] of Object.entries(config.sections)) {
      const hasSection = sp.section && Object.keys(sp.section).length > 0;
      const rows = sp.byDifficulty
        ? Object.fromEntries(
            Object.entries(sp.byDifficulty).filter(([, p]) => p && Object.keys(p).length > 0)
          )
        : undefined;
      const hasRows = rows && Object.keys(rows).length > 0;
      if (hasSection || hasRows) {
        sections[sid] = {
          ...(hasSection ? { section: sp.section } : {}),
          ...(hasRows ? { byDifficulty: rows } : {}),
        };
      }
    }
    if (Object.keys(sections).length > 0) clean.sections = sections;
  }
  return clean;
}

/**
 * Parse the attempts field, refusing anything that is not a positive integer.
 *
 * The old expression was `maxAttempts ? parseInt(maxAttempts, 10) : undefined`,
 * which has no NaN guard. A non-numeric value reaches Firestore as NaN, and the
 * server gate is
 *   limitReached: finished >= effectiveMax
 * — every comparison against NaN is false, so the attempt limit silently
 * becomes unlimited. The roster's own override input already guards this way
 * (`if (isNaN(parsed) || parsed < 1) return`); the builder did not.
 *
 * Returning undefined for a blank field is correct and means ONE attempt —
 * the server reads `?? 1`. There is no "unlimited" value; see the note on
 * Assessment.maxAttempts in assessmentService.ts.
 */
function parsePositiveIntOrUndefined(raw: string): number | undefined {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return undefined;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

export function DetailsStep({
  stage,
  onSaveApi,
  onNavigate,
  mode, assessment, originalStatus, allQuestions, allGroups = [], sections, setSections, onBack, onSave,
  title, description, subject, status,
  targetType, setTargetType,
  selectedInstituteIds, setSelectedInstituteIds,
  selectedStudentIds, setSelectedStudentIds,
  subjectPool, topicPool,
  deliveryMode, setDeliveryMode,
  allocationPhase, onContinueToAllocation, onBackToRules,
}: {
  mode: 'create' | 'edit';
  assessment: Assessment | null;
  originalStatus?: AssessmentStatus;
  allQuestions: Question[];
  /** Question groups visible to the author — the pool group rules draw from. */
  allGroups?: QuestionGroup[];
  sections: SectionDraft[];
  setSections: React.Dispatch<React.SetStateAction<SectionDraft[]>>;
  onBack: () => void;
  onSave: (draft: AssessmentDraft, seb: { keys: string[]; file: File | null; clearFile: boolean }, allocation: { mode: 'legacy' | 'rules'; nodeType: AllocationNodeType | ''; nodeIds: string[]; expectedVersion: number }) => Promise<void>;
  title: string;
  description: string;
  subject: string;
  status: AssessmentStatus;
  targetType: 'all' | 'institutes' | 'students';
  setTargetType: (v: 'all' | 'institutes' | 'students') => void;
  selectedInstituteIds: string[]; setSelectedInstituteIds: (ids: string[]) => void;
  selectedStudentIds: string[]; setSelectedStudentIds: (ids: string[]) => void;
  subjectPool: string[];
  topicPool: string[];
  deliveryMode: 'standard' | 'linear' | 'adaptive';
  setDeliveryMode: React.Dispatch<React.SetStateAction<'standard' | 'linear' | 'adaptive'>>;
  /* Step 3 (Allocation) — the component stays mounted across steps 2↔3 so all
     local settings state (dates, toggles, SEB config) survives navigation. */
  allocationPhase: boolean;
  onContinueToAllocation: () => void;
  onBackToRules: () => void;
  /**
   * Which stage the workspace is showing. This component owns three of them —
   * schedule, grading, security — plus allocation, and renders one at a time.
   *
   * They were previously one scrolling page headed "STEP 2 OF 3 — RULES &
   * SETTINGS", which was wrong twice over: it contained no rules (those are in
   * the sections stage) and it stacked three unrelated decisions into a
   * two-column wall that an author had to read end to end to find any one of
   * them.
   */
  stage: BuilderStage;
  /**
   * Hands the save controls to the workspace.
   *
   * The save bar used to live inside this component, at the bottom of the
   * allocation stage — the ONLY place in the builder that could save anything.
   * An author who had spent ten minutes on sections and settings had to walk
   * forward to the last stage before "Save as Draft" existed at all, and in a
   * workspace where they move around freely that is untenable.
   *
   * The bar moved to the panel; the state behind it did not, because every
   * value a save reads — dates, grading config, SEB file — lives here. So this
   * publishes the handler instead of relocating four hundred lines of state.
   */
  onSaveApi?: (api: { save: (status?: AssessmentStatus) => void; saving: boolean }) => void;
  /** Move the workspace to another stage — the forward affordances below. */
  onNavigate: (s: BuilderStage) => void;
}) {
  const [startDate, setStartDate] = useState(toDateTimeLocal(assessment?.startDate));
  const [endDate, setEndDate] = useState(toDateTimeLocal(assessment?.endDate));
  const [passingScore, setPassingScore] = useState(assessment?.passingScore?.toString() ?? '');
  const [maxAttempts, setMaxAttempts] = useState(assessment?.maxAttempts?.toString() ?? '1');
  const [sectionGraceSeconds, setSectionGraceSeconds] = useState(assessment?.sectionGraceSeconds?.toString() ?? '');
  // ── Overall exam timer ─────────────────────────────────────────
  // overallGraceSeconds: its own knob (blank = 30s default).
  const [overallGraceSeconds, setOverallGraceSeconds] = useState(assessment?.overallGraceSeconds?.toString() ?? '');
  // A-10: questionGraceSeconds had six readers on the server and the client and
  // no authoring UI at all, so D-14's "one number, consumed by BOTH sides… and
  // configurable per assessment" was only ever the hardcoded 5s default. Only
  // meaningful in sequential delivery, where a per-question clock exists.
  const [questionGraceSeconds, setQuestionGraceSeconds] = useState(assessment?.questionGraceSeconds?.toString() ?? '');
  // overallAuto: when on, the limit field is DRIVEN by the sections
  // (sum of section time + section grace + breaks + overall grace) and stays
  // in sync as they change. Default on for a NEW exam (so a teacher who never
  // touches it still gets a correct cap instead of unlimited); off for an
  // existing exam that already has a saved value the author chose.
  const [overallAuto, setOverallAuto] = useState(
    assessment?.overallTimeLimit == null
  );
  // overallTimeLimit: the manual value (used only when overallAuto is off).
  const [overallTimeLimit, setOverallTimeLimit] = useState(assessment?.overallTimeLimit?.toString() ?? '');
  const [shuffleQuestions, setShuffleQuestions] = useState(assessment?.shuffleQuestions ?? false);

  // ── Grading policy (negative marking + blank handling) ───────────
  // One draft object mirroring AssessmentGradingConfig. The exam master switch
  // is the hard gate: when off, section/row overrides are inert (kept in state
  // so toggling back on restores them, but never sent as "on"). Standard +
  // Linear only — hidden entirely for adaptive.
  const [gradingConfig, setGradingConfig] = useState<AssessmentGradingConfig>(
    assessment?.gradingConfig ?? {}
  );
  const examPolicy = gradingConfig.exam ?? {};
  const negMarkingOn = examPolicy.negativeMarking === true;

  // Patch the exam-level policy (master switch, default penalty, blank rule).
  const patchExamPolicy = (patch: Partial<GradingPolicy>) =>
    setGradingConfig((c) => ({ ...c, exam: { ...(c.exam ?? {}), ...patch } }));

  // Patch a section-level override; null clears it entirely (back to inherit).
  const patchSectionPolicy = (sectionId: string, patch: Partial<GradingPolicy> | null) =>
    setGradingConfig((c) => {
      const sections = { ...(c.sections ?? {}) };
      const cur = sections[sectionId] ?? {};
      if (patch === null) {
        const { section: _drop, ...rest } = cur;
        if (Object.keys(rest).length > 0) sections[sectionId] = rest; else delete sections[sectionId];
      } else {
        sections[sectionId] = { ...cur, section: { ...(cur.section ?? {}), ...patch } };
      }
      return { ...c, sections };
    });

  // Format the penalty INHERITED at a given (section, difficulty) — i.e. what
  // applies when the row/section does NOT override. Walks section → exam (the
  // levels above the row). Used as placeholder text so "inherit" is legible.
  const formatPenalty = (p: GradingPolicy | undefined): string | null => {
    if (!p || p.penaltyValue === undefined || p.penaltyValue === null) return null;
    if (p.negativeMarking === false) return 'no penalty';
    return (p.penaltyType ?? 'fixed') === 'percent' ? `−${p.penaltyValue}%` : `−${p.penaltyValue} mk`;
  };
  const resolveInheritedPenalty = (sectionId: string, _diff: 'easy' | 'medium' | 'hard'): string => {
    const sp = gradingConfig.sections?.[sectionId]?.section;
    return formatPenalty(sp) ?? formatPenalty(examPolicy) ?? 'none';
  };

  const patchRowPolicy = (sectionId: string, difficulty: 'easy' | 'medium' | 'hard', patch: Partial<GradingPolicy> | null) =>
    setGradingConfig((c) => {
      const sections = { ...(c.sections ?? {}) };
      const cur = sections[sectionId] ?? {};
      const byDifficulty = { ...(cur.byDifficulty ?? {}) };
      if (patch === null) {
        delete byDifficulty[difficulty];
      } else {
        byDifficulty[difficulty] = { ...(byDifficulty[difficulty] ?? {}), ...patch };
      }
      const hasRows = Object.keys(byDifficulty).length > 0;
      const next = { ...cur, ...(hasRows ? { byDifficulty } : {}) };
      if (!hasRows) delete (next as { byDifficulty?: unknown }).byDifficulty;
      if (Object.keys(next).length > 0) sections[sectionId] = next; else delete sections[sectionId];
      return { ...c, sections };
    });

  const [sectionStartOrder, setSectionStartOrder] = useState<'sequential' | 'random' | 'student_choice'>(
    assessment?.sectionStartOrder ?? 'sequential'
  );
  // N5 final form — audience arrays are the source of truth; the booleans
  // above are kept only for state the older steps still read, and are
  // re-derived from the arrays at save time.
  const [showResultsTo, setShowResultsTo] = useState<VisibilityAudience[]>(
    assessment ? deriveShowResultsTo(assessment) : [...DEFAULT_SHOW_RESULTS_TO]);
  const [allowReviewTo, setAllowReviewTo] = useState<VisibilityAudience[]>(
    assessment ? deriveAllowReviewTo(assessment) : [...DEFAULT_ALLOW_REVIEW_TO]);
  // ── Security tier + delivery mode (Phase 0 wiring) ──────────────
  const [securityTier, setSecurityTier] = useState<'mock' | 'normal' | 'high_stake'>(
    assessment?.securityTier ?? 'normal',
  );
  // Tablets — the only device permission an author can move, and only at
  // 'normal'. Seeded from the saved assessment so an edit-save does not
  // silently revoke a deliberate opt-in, exactly as requireSEB is below.
  const [allowTablet, setAllowTablet] = useState<boolean>(assessment?.allowTablet ?? false);
  // ── Phase 3 (Stage 4): SEB authority toggle + config file link ───
  // requireSEB was "default ON for high_stake, disable-able". D-10 makes it
  // LOCKED at high_stake, so the toggle is only an authority decision on
  // 'normal' now; at high_stake it is a read-only statement of what the tier
  // means. Initialised from the existing assessment so an edit-save does not
  // silently revert a manual 'normal' opt-in.
  //
  // A high_stake assessment carrying requireSEB:false from before the lock
  // shows ON here, because that is what saving it will store — the toggle
  // must not display a value the save is about to override. Already-published
  // ones keep running as they are (grandfathered in startExam), and their
  // security fields are frozen against edits anyway.
  const [requireSEB, setRequireSEB] = useState<boolean>(
    (assessment?.securityTier ?? 'normal') === 'high_stake'
      ? true
      : assessment?.requireSEB ?? false,
  );
  const [sebConfigFileUrl, setSebConfigFileUrl] = useState(assessment?.sebConfigFileUrl ?? '');
  // Per-exam Config Keys (Stage 4). Held as one-key-per-line text; stored in
  // the webOwner-only sebAssessmentKeys collection, never on the assessment
  // doc (students can read that). Non-empty = overrides the platform keys.
  const [sebKeysText, setSebKeysText] = useState('');
  const [sebKeysError, setSebKeysError] = useState('');
  // Stage 4b: which configuration unlocks this exam.
  //  'platform' → platform keys + platform .seb file (SEB settings page)
  //  'custom'   → this exam's own keys + its own uploaded .seb file
  const [sebConfigSource, setSebConfigSource] = useState<'platform' | 'custom'>(
    assessment?.sebConfigFileUrl ? 'custom' : 'platform',
  );
  const [sebFile, setSebFile] = useState<File | null>(null);
  const sebFileInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!assessment?.id) return;
    getAssessmentSEBKeys(assessment.id)
      .then((k) => {
        setSebKeysText(k.join('\n'));
        if (k.length > 0) setSebConfigSource('custom');
      })
      .catch(() => {/* leave empty — platform keys apply */});
  }, [assessment?.id]);

  // ── Platform SEB availability (for the publish checklist) ─────────
  // When an exam is set to PLATFORM config, it inherits the platform Config
  // Keys and platform .seb file from the SEB settings page — the same
  // resolution the verification endpoint uses at exam time (per-exam override
  // → platform → env). The high-stake publish gate must therefore treat the
  // requirement as met when the platform actually has a key AND a file, not
  // demand per-exam artifacts the exam was never meant to carry. Loaded once
  // on mount; a fetch failure leaves both false (fail-safe: the gate asks for
  // explicit config rather than letting a possibly-unconfigured platform
  // through).
  const [platformHasKey, setPlatformHasKey] = useState(false);
  const [platformHasFile, setPlatformHasFile] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getSEBSettings()
      .then((s) => { if (!cancelled) setPlatformHasKey((s.configKeys?.length ?? 0) > 0); })
      .catch(() => {/* leave false — gate will ask for explicit config */});
    getSEBPublicInfo()
      .then((info) => { if (!cancelled) setPlatformHasFile(Boolean(info.configFileUrl)); })
      .catch(() => {/* leave false */});
    return () => { cancelled = true; };
  }, []);
  const [saving, setSaving] = useState(false);

  // ── D2: rule-based allocation (Step 3 "By Hierarchy" mode) ────────
  // Draft lives HERE (not in the panel) so it survives 2↔3 navigation —
  // DetailsStep stays mounted across those steps. While hierarchyMode is
  // on, saving is blocked: commit is server-only by design and the
  // resolveAllocation callable lands in Phase B (see plans/ALLOCATION_SYSTEM_PLAN.md).
  const [hierarchyMode, setHierarchyMode] = useState(false);
  const [allocationDraft, setAllocationDraft] = useState<AllocationDraft>(emptyAllocationDraft);
  const [allocationVersion, setAllocationVersion] = useState(0);

  // Edit mode: if this assessment already uses rule-based allocation, hydrate
  // the draft + version from the stored allocation doc so edits build on it.
  useEffect(() => {
    if (mode !== 'edit' || !assessment?.id) return;
    if ((assessment as { allocationMode?: string }).allocationMode !== 'rules') return;
    let cancelled = false;
    getAllocation(assessment.id).then((a) => {
      if (cancelled || !a) return;
      setHierarchyMode(true);
      setAllocationVersion(a.version);
      setAllocationDraft({
        instituteId: a.instituteId === '*' ? '' : a.instituteId,
        instituteName: a.nodes[0]?.breadcrumb?.split(' › ')[0] ?? '',
        nodeType: a.nodeType,
        nodeIds: a.nodeIds,
      });
    });
    return () => { cancelled = true; };
  }, [mode, assessment?.id]);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [activeSectionIdx, setActiveSectionIdx] = useState(0);

  // Resolve subjectPool IDs → names so RuleBuilderPanel can filter against q.subject (a name)
  const [subjectDocs, setSubjectDocs] = useState<Subject[]>([]);
  useEffect(() => {
    getAllSubjects().then(setSubjectDocs).catch(() => setSubjectDocs([]));
  }, []);
  // Taxonomy name maps (slug → current name) — make rule matching + the picker
  // rename-proof (see loadTaxonomyNameMaps / canonicalSubject). Empty maps mean
  // "fall back to stored names", so a load failure degrades to legacy behaviour.
  const [taxonomyMaps, setTaxonomyMaps] = useState<TaxonomyNameMaps>({ subjectNameById: {}, topicNameById: {} });
  useEffect(() => {
    loadTaxonomyNameMaps()
      .then(setTaxonomyMaps)
      .catch(() => setTaxonomyMaps({ subjectNameById: {}, topicNameById: {} }));
  }, []);
  const subjectPoolNames = useMemo(
    () => subjectDocs.filter((s) => subjectPool.includes(s.id)).map((s) => s.name),
    [subjectDocs, subjectPool]
  );

  const mut = mutabilityFor(originalStatus);
  const lockReason = originalStatus === 'active' ? 'test is live' : 'test is closed';

  const buildSections = (sectionDrafts: SectionDraft[]): AssessmentSection[] =>
    sectionDrafts.map((sec, idx) => {
      const breakMins = parseInt(sec.breakAfterMinutes, 10);
      const out: AssessmentSection = {
        id: sec.id,
        name: sec.name,
        assignedTopics: sec.assignedTopics,
        rules: sec.rules
          .filter(draftIsLive)
          .map((r): QuestionSelectionRule => r.kind === 'group'
            ? {
                kind: 'group',
                subject: r.subject,
                topic: r.topic,
                difficulty: r.difficulty,
                groupCount: parseInt(r.groupCount ?? '', 10) || 0,
                questionsPerGroup: !r.questionsPerGroup || r.questionsPerGroup === 'all'
                  ? 'all'
                  : parseInt(r.questionsPerGroup, 10) || 1,
                marksPerQuestion: parseFloat(r.marksPerQuestion) || 1,
                ...(r.groupKind ? { groupKind: r.groupKind } : {}),
                ...(r.fixedGroupIds?.length ? { fixedGroupIds: r.fixedGroupIds } : {}),
              }
            : {
                kind: 'topic',
                subject: r.subject,
                topic: r.topic,
                difficulty: r.difficulty,
                count: parseInt(r.count, 10) || 0,
                marksPerQuestion: parseFloat(r.marksPerQuestion) || 1,
                ...(r.fixedQuestionIds?.length ? { fixedQuestionIds: r.fixedQuestionIds } : {}),
              }),
        questions: [],
      };
      const tl = parseInt(sec.timeLimit, 10);
      if (tl > 0) out.timeLimit = tl;
      const qtl = parseInt(sec.questionTimeLimit, 10);
      if (qtl > 0) out.questionTimeLimit = qtl;
      // Only written when the author actually locked the section. An empty
      // array is the unlocked state and is left OFF the document, so a section
      // nobody locked is byte-identical to one written before locking existed.
      if (sec.engines.length > 0) out.engines = [...sec.engines];
      if (idx < sectionDrafts.length - 1 && breakMins > 0) {
        out.breakAfter = { durationMinutes: breakMins, mandatory: sec.breakMandatory };
      }
      return out;
    });

  const [pendingPublish, setPendingPublish] = useState<{ warnings: string[] } | null>(null);

  const handleSave = async (overrideStatus?: AssessmentStatus, bypassSoftWarnings = false) => {
    // Phase C: hierarchy allocation now commits (via resolveAllocation) after
    // the assessment is saved and its id exists. Here we only guard that a
    // selection was actually made — the empty/validation cases are surfaced by
    // the live preview, and the commit itself re-validates server-side.
    if (hierarchyMode) {
      if (!allocationDraft.nodeType ||
          (allocationDraft.nodeType !== 'institute' && allocationDraft.nodeIds.length === 0)) {
        setValidationErrors([
          'Choose who takes this exam before saving — pick a target level and at least one node, or switch "Assign To" back to a legacy option.',
        ]);
        return;
      }
    }
    setValidationErrors([]);
    const targetStatus: AssessmentStatus = overrideStatus ?? status;

    // ── HARD checks (apply to publish only; drafts skip all time checks) ──
    if (targetStatus === 'active') {
      const errors: string[] = [];
      const now = Date.now();
      const startMs = startDate ? new Date(fromDateTimeLocal(startDate)).getTime() : null;
      const endMs = endDate ? new Date(fromDateTimeLocal(endDate)).getTime() : null;

      if (startMs !== null && startMs < now) {
        errors.push('Start time is in the past — choose "Start immediately" or pick a future time.');
      }
      if (endMs !== null && endMs <= now) {
        errors.push('End time must be in the future.');
      }
      if (startMs !== null && endMs !== null && endMs <= startMs) {
        errors.push('End time must be after the start time.');
      }
      if (errors.length > 0) {
        setValidationErrors(errors);
        return;
      }
    }

    if (mut.endDate === 'extend-only' && assessment?.endDate && endDate) {
      const originalEnd = new Date(assessment.endDate).getTime();
      const newEnd = new Date(fromDateTimeLocal(endDate)).getTime();
      if (newEnd < originalEnd) {
        setValidationErrors([`The deadline cannot be moved earlier while the test is active — you may only extend it (current end: ${formatDateTime(assessment.endDate)}).`]);
        return;
      }
    }

    const builtSections = buildSections(sections);

    // ── HARD section/rule checks (publish only) — must run BEFORE soft warnings ──
    if (targetStatus === 'active') {
      const errors: string[] = [];

      // Each section must request at least 1 question. A group rule drawing
      // "all" children has no knowable count yet, so it counts as live rather
      // than as zero — otherwise a section made entirely of DI sets would be
      // rejected for being empty.
      sections.forEach((s) => {
        const anyLive = s.rules.some(draftIsLive);
        const known = s.rules.reduce((sum, r) => sum + (draftQuestionCount(r) ?? 0), 0);
        if (!anyLive || (known < 1 && !s.rules.some((r) => draftQuestionCount(r) === null))) {
          errors.push(`${s.name || 'Untitled section'} must have at least 1 question.`);
        }
      });

      const { valid, results } = validateSelectionRules(
        builtSections, allQuestions, taxonomyMaps, allGroups, deliveryMode,
      );
      if (!valid) {
        results
          .filter((r) => !r.ok)
          .forEach((r) => {
            // A blocked rule is a structural refusal, not a shortage — say so
            // instead of reporting an availability number that isn't the point.
            if (r.blocked) {
              errors.push(`${r.sectionName}: ${r.blocked}`);
              return;
            }
            const unit = r.unit === 'groups' ? 'set' : 'question';
            const plural = r.requested === 1 ? '' : 's';
            errors.push(
              `${r.sectionName}: ${r.subject} › ${r.topic} (${r.difficulty}) — `
              + `requested ${r.requested} ${unit}${plural}, only ${r.available} available`,
            );
          });
      }

      if (errors.length > 0) {
        setValidationErrors(errors);
        return;
      }
    }

    // ── SOFT warnings (publish only, can be bypassed) — run LAST so hard errors surface first ──
    if (targetStatus === 'active' && !bypassSoftWarnings) {
      const warnings: string[] = [];
      if (!startDate) {
        warnings.push('You\'re publishing with "Start immediately" — students will be able to begin as soon as the assessment is saved.');
      }
      if (!endDate) {
        warnings.push('You\'re publishing with "No deadline" — the assessment will stay open until you close it manually.');
      }
      // Window-vs-required time warning. Use now as the start when "immediate".
      const startMs = startDate ? new Date(fromDateTimeLocal(startDate)).getTime() : Date.now();
      const endMs = endDate ? new Date(fromDateTimeLocal(endDate)).getTime() : null;
      if (endMs !== null) {
        const windowMins = Math.floor((endMs - startMs) / 60000);
        const totalSectionTime = sections.reduce((sum, s) => sum + (parseInt(s.timeLimit, 10) || 0), 0);
        const totalBreakTime = sections.slice(0, -1).reduce((sum, s) => sum + (parseInt(s.breakAfterMinutes, 10) || 0), 0);
        const required = totalSectionTime + totalBreakTime;
        if (required > 0 && windowMins < required + 1) {
          warnings.push(`The scheduled window (${windowMins}m) is shorter than the total section time + breaks (${required}m). Some students may run out of clock time.`);
        }
      }
      // Impossible overall-limit warning (manual only — Auto can never be too
      // short). If the total exam cap is below the bare sum of section time +
      // breaks, students literally cannot finish every section within it.
      if (!overallAuto && effectiveOverallLimit && effectiveOverallLimit > 0) {
        const floorMins = sumSectionsAndBreaksMinutes(sections);
        if (floorMins > 0 && effectiveOverallLimit < floorMins) {
          warnings.push(`The overall time limit (${effectiveOverallLimit}m) is less than the total section time + breaks (${floorMins}m). Students cannot complete every section within it — the exam will hard-cut before they finish.`);
        }
      }
      if (warnings.length > 0) {
        setPendingPublish({ warnings });
        return;
      }
    }

    setSaving(true);
    try {
      // TARGETING: two systems, and this is where they fork.
      //
      // hierarchyMode ON  → targeting lives in assessmentMembers, materialized
      //                     server-side by resolveAllocation after this save.
      //                     assignedTo is NOT the source of truth and must not
      //                     be read back for display or roster building — use
      //                     describeAssignment() / resolveAllocatedStudents().
      // hierarchyMode OFF → assignedTo IS the source of truth.
      //
      // The empty students target below is a placeholder to satisfy the
      // required field, not a statement that nobody is assigned. Reading it as
      // one is exactly the July 2026 bug: hierarchy exams reported
      // "0 Students" and blank rosters while students sat them normally.
      const assignedTo: AssignmentTarget = hierarchyMode
        ? { type: 'students', studentIds: [] }
        : targetType === 'all' ? { type: 'all' }
          : targetType === 'institutes' ? { type: 'institutes', instituteIds: selectedInstituteIds }
          : { type: 'students', studentIds: selectedStudentIds };

      let finalSections = builtSections;
      let flatQuestions = builtSections.flatMap((s) => s.questions);

      if (targetStatus === 'active') {
        const resolved = resolveQuestionsForSections(builtSections, allQuestions, taxonomyMaps, allGroups);
        finalSections = resolved.sections;
        flatQuestions = resolved.flatQuestions;
      }

      const draft: AssessmentDraft = {
        ownerType: 'webOwner',
        ownerId: 'webOwner',
        title: title.trim(),
        description,
        subject,
        tags: [],
        questions: flatQuestions,
        sections: finalSections,
        subjectPool: subjectPool.length > 0 ? subjectPool : undefined,
        topicPool: topicPool.length > 0 ? topicPool : undefined,
        assignedTo,
        startDate: startDate ? fromDateTimeLocal(startDate) : undefined,
        endDate: endDate ? fromDateTimeLocal(endDate) : undefined,
        timeLimit: undefined,
        overallTimeLimit: effectiveOverallLimit,
        overallGraceSeconds: overallGraceSeconds ? parseInt(overallGraceSeconds, 10) : undefined,
        // Negative-marking policy. sanitizeGradingConfig strips the whole thing
        // to undefined when the master switch is off (so an off exam stores no
        // policy and grades exactly like legacy), and prunes empty overrides.
        gradingConfig: sanitizeGradingConfig(gradingConfig, deliveryMode),
        passingScore: passingScore ? parseInt(passingScore, 10) : undefined,
        maxAttempts: parsePositiveIntOrUndefined(maxAttempts),
        sectionGraceSeconds: sectionGraceSeconds ? parseInt(sectionGraceSeconds, 10) : undefined,
        // A-10: only stored for the modes that HAVE a question clock, so a
        // standard-delivery exam does not carry a number nothing will read.
        questionGraceSeconds: deliveryMode !== 'standard' && questionGraceSeconds
          ? parseInt(questionGraceSeconds, 10)
          : undefined,
        shuffleQuestions,
        sectionStartOrder,
        // Audience arrays are authoritative; legacy booleans mirror the
        // 'students' entry so pre-audience code paths keep working.
        showResults: showResultsTo.includes('students'),
        allowReview: allowReviewTo.includes('students'),
        showResultsTo,
        allowReviewTo,
        // ── Security tier + delivery mode (Phase 0 wiring) ──────────
        // applyTierDefaults enforces the per-tier floor (high-stake locks
        // camera on / phones off / tablets off / extension on; normal locks
        // phones off). deliveryMode is chosen independently. These flow
        // through createAssessment's ...draft spread.
        // Phase 3 (Stage 4): requireSEB now carries the builder's toggle
        // instead of being reset to the tier default on every save; mock
        // still forces it false inside applyTierDefaults. allowTablet rides
        // the same path — passed as an override, refused at high_stake.
        ...applyTierDefaults(securityTier, { requireSEB, allowTablet }),
        sebConfigFileUrl: sebConfigFileUrl.trim(),
        deliveryMode,
        status: targetStatus,
      };

      // Stage 4/4b: per-exam SEB config — validate before anything is written.
      const useCustomSeb = requireSEB && sebConfigSource === 'custom';
      const sebKeyLines = useCustomSeb
        ? sebKeysText.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean)
        : [];
      if (useCustomSeb) {
        const badLine = sebKeyLines.find((k) => !/^[0-9a-f]{64}$/.test(k));
        if (badLine) {
          setSebKeysError(`Not a valid Config Key (needs 64 hex characters): "${badLine.slice(0, 24)}…"`);
          setSaving(false);
          return;
        }
        if (sebKeyLines.length === 0) {
          setSebKeysError('Exam-specific config needs at least one Config Key — paste it from the Config Tool.');
          setSaving(false);
          return;
        }
      }
      setSebKeysError('');

      // Platform source (or SEB off): the exam carries no file link of its own —
      // the briefing falls back to the platform .seb published on the SEB page.
      if (!useCustomSeb) draft.sebConfigFileUrl = '';

      // Phase C — high_stake publish-readiness checklist. Only gates PUBLISH
      // (status → active), never draft saves. The .seb quit-URL is configured
      // inside the SEB config file itself, so it's surfaced as a reminder line
      // rather than a programmatic check (we can't parse the uploaded file).
      const publishing = (overrideStatus ?? status) === 'active';
      if (publishing && securityTier === 'high_stake') {
        const missing: string[] = [];
        // The SEB requirement is met by EITHER path:
        //   • custom   → this exam's own uploaded key + .seb file
        //   • platform → the platform Config Key + platform .seb file that the
        //                SEB settings page holds (inherited at exam time via
        //                the same per-exam → platform resolution the verifier
        //                uses). This is the fix for the false publish-block:
        //                previously both checks were gated on useCustomSeb, so
        //                a platform-config exam was blocked even though the
        //                platform already had a key and a file.
        const hasKeys = useCustomSeb ? sebKeyLines.length > 0 : platformHasKey;
        const hasFile = useCustomSeb
          ? (Boolean(sebFile) || Boolean(sebConfigFileUrl))
          : platformHasFile;
        if (requireSEB && !hasKeys) {
          missing.push(useCustomSeb
            ? 'a per-exam SEB Config Key'
            : 'a platform SEB Config Key (add one on the Safe Exam Browser page, or switch this exam to Exam-specific config)');
        }
        if (requireSEB && !hasFile) {
          missing.push(useCustomSeb
            ? 'an uploaded .seb configuration file'
            : 'a platform .seb configuration file (upload one on the Safe Exam Browser page, or switch this exam to Exam-specific config)');
        }
        if (hierarchyMode &&
            (!allocationDraft.nodeType ||
             (allocationDraft.nodeType !== 'institute' && allocationDraft.nodeIds.length === 0))) {
          missing.push('a non-empty allocation');
        }
        if (missing.length > 0) {
          setValidationErrors([
            `A high-stake exam can't be published until it has: ${missing.join(', ')}.`,
            ...(requireSEB && hasFile
              ? ['Reminder: confirm the .seb file has a Quit URL configured so students can exit the exam cleanly.']
              : []),
          ]);
          setSaving(false);
          return;
        }
      }

      await onSave(draft, {
        keys: sebKeyLines,
        file: useCustomSeb ? sebFile : null,
        clearFile: !useCustomSeb && Boolean(assessment?.sebConfigFileUrl),
      }, {
        mode: hierarchyMode ? 'rules' : 'legacy',
        nodeType: allocationDraft.nodeType,
        nodeIds: allocationDraft.nodeIds,
        expectedVersion: allocationVersion,
      });
    } finally {
      setSaving(false);
    }
  };

  // Republished on every render: handleSave closes over a great deal of state
  // and is recreated each time, so a dependency array here would either be
  // wrong or would have to list the whole component. The panel stores it in a
  // ref, so a new identity costs nothing.
  useEffect(() => {
    onSaveApi?.({ save: (status?: AssessmentStatus) => { void handleSave(status); }, saving });
  });

  const totalSectionTime = sections.reduce((sum, s) => sum + (parseInt(s.timeLimit, 10) || 0), 0);

  // ── Overall timer — Auto value + effective value ───────────────
  // When overallAuto is on, the field shows (and saves) this computed budget,
  // recomputed live as sections / grace change. sectionGraceSeconds and
  // overallGraceSeconds fall back to their 30s defaults when blank.
  const autoOverallLimit = useMemo(
    () => computeAutoOverallLimit(
      sections,
      sectionGraceSeconds ? parseInt(sectionGraceSeconds, 10) : undefined,
      overallGraceSeconds ? parseInt(overallGraceSeconds, 10) : undefined,
    ),
    [sections, sectionGraceSeconds, overallGraceSeconds]
  );
  // The value that will actually be saved: the auto budget when Auto is on,
  // otherwise the manual entry (blank manual = no overall cap).
  const effectiveOverallLimit = overallAuto
    ? autoOverallLimit
    : (overallTimeLimit ? parseInt(overallTimeLimit, 10) : undefined);
  // Displayed in the input box (read-only while Auto is on).
  const overallLimitDisplay = overallAuto ? String(autoOverallLimit) : overallTimeLimit;

  return (
    <div className="flex flex-col">
      {!allocationPhase ? (
      <>

      {/* ── TOP: Schedule + Grading + Section Limits | Settings (fixed natural height) ── */}
      <div className="flex-shrink-0" style={{ borderBottom: '1px solid var(--ef-border)', background: 'var(--ef-canvas-raised)' }}>
        <div style={{ padding: '20px 48px 24px' }}>

          <StageHeading stage={stage} />
          {originalStatus && originalStatus !== 'draft' && (
            <LockedNotice status={originalStatus === 'active' ? 'active' : 'closed'} />
          )}

          {/* ONE column, not two.
              These three stages used to share a two-column auto-fit grid:
              schedule, grading and section limits stacked on the left, the
              whole security block on the right. It packed a lot onto one
              screen and made every individual decision harder to find, because
              nothing on the left had anything to do with anything beside it.
              One stage at a time reads top to bottom, and the measure stays
              short enough for the explanatory copy to be worth reading. */}
          <div style={{ maxWidth: 680 }}>
            <div className="space-y-6" style={{ minWidth: 0 }}>

            {/* SCHEDULE */}
            {stage === 'schedule' && (
            <div className="space-y-3">
              {mut.startDate ? (
                <StartScheduleControl startDate={startDate} setStartDate={setStartDate} />
              ) : (
                <LockedFieldWrapper label="Start Date & Time" reason={lockReason}>
                  <div className="flex items-center gap-2 px-3 py-2"
                    style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
                    <Calendar size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
                    <input type="datetime-local" value={startDate} readOnly className="flex-1 outline-none"
                      style={{ background: 'transparent', color: 'var(--ef-ink)', fontSize: 12, border: 'none' }} />
                  </div>
                </LockedFieldWrapper>
              )}

              {mut.endDate === true && (
                <EndScheduleControl endDate={endDate} setEndDate={setEndDate} startDate={startDate} />
              )}
              {mut.endDate === 'extend-only' && (
                <div>
                  <Field label="End Date & Time">
                    <div className="flex items-center gap-2 px-3 py-2"
                      style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
                      <Calendar size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
                      <input type="datetime-local" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                        className="flex-1 outline-none"
                        style={{ background: 'transparent', color: 'var(--ef-ink)', fontSize: 12, border: 'none' }}
                        min={toDateTimeLocal(assessment?.endDate) || startDate || undefined} />
                    </div>
                  </Field>
                  <p className="text-xs mt-1.5 flex items-center gap-1" style={{ color: 'var(--ef-text-muted)' }}>
                    <Clock size={9} strokeWidth={1.5} style={{ flexShrink: 0 }} />
                    You may only extend the deadline, not shorten it.
                  </p>
                </div>
              )}
              {mut.endDate === false && (
                <LockedFieldWrapper label="End Date & Time" reason={lockReason}>
                  <div className="flex items-center gap-2 px-3 py-2"
                    style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
                    <Calendar size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
                    <input type="datetime-local" value={endDate} readOnly className="flex-1 outline-none"
                      style={{ background: 'transparent', color: 'var(--ef-ink)', fontSize: 12, border: 'none' }} />
                  </div>
                </LockedFieldWrapper>
              )}

              {startDate && endDate && (
                <DurationIndicator startDate={startDate} endDate={endDate} totalSectionTime={totalSectionTime} />
              )}
            </div>
            )}

            {/* GRADING */}
            {stage === 'grading' && (
            <div className="space-y-3">
              <Field label="Passing Score" hint="(%, optional)">
                <div className="flex items-center gap-2 px-3 py-2"
                  style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
                  <Award size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
                  <input type="number" value={passingScore} onChange={(e) => setPassingScore(e.target.value)}
                    placeholder="e.g., 50" min="0" max="100" className="flex-1 outline-none"
                    style={{ background: 'transparent', color: 'var(--ef-ink)', fontSize: 12, border: 'none' }} />
                  {passingScore && <span style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>%</span>}
                </div>
              </Field>

              <Field label="Max Attempts" hint="(per student, default 1)">
                <div className="flex items-center gap-2 px-3 py-2"
                  style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
                  <ClipboardList size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
                  <input type="number" value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)}
                    placeholder="e.g., 2" min="1" className="flex-1 outline-none"
                    style={{ background: 'transparent', color: 'var(--ef-ink)', fontSize: 12, border: 'none' }} />
                  {maxAttempts && <span style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>attempts</span>}
                </div>
              </Field>

              <Field label="Section grace period" hint="(seconds past each section timer; blank = 30s default)">
                <div className="flex items-center gap-2 px-3 py-2"
                  style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
                  <Timer size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
                  <input type="number" value={sectionGraceSeconds} onChange={(e) => setSectionGraceSeconds(e.target.value)}
                    placeholder="e.g., 30" min="0" className="flex-1 outline-none"
                    style={{ background: 'transparent', color: 'var(--ef-ink)', fontSize: 12, border: 'none' }} />
                  {sectionGraceSeconds && <span style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>seconds</span>}
                </div>
              </Field>

              {/* ── Overall exam timer ────────────────────────────────── */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs" style={{ color: '#6B6A65' }}>Overall time limit</span>
                    <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>(whole exam, optional)</span>
                  </div>
                  {/* Auto toggle — when on, the value is computed from the
                      sections and stays in sync. Off = manual entry. */}
                  <button
                    type="button"
                    onClick={() => {
                      // Turning Auto OFF seeds the manual box with the current
                      // computed value so the teacher edits from a sane number
                      // rather than an empty field.
                      if (overallAuto) setOverallTimeLimit(String(autoOverallLimit));
                      setOverallAuto((v) => !v);
                    }}
                    className="flex items-center gap-1 px-2 py-0.5"
                    style={{
                      borderRadius: 2,
                      border: `1px solid ${overallAuto ? 'var(--ef-success-border)' : 'var(--ef-border)'}`,
                      background: overallAuto ? 'var(--ef-success-bg)' : 'var(--ef-surface)',
                    }}
                  >
                    <span className="text-xs" style={{ color: overallAuto ? 'var(--ef-success-strong)' : 'var(--ef-text-muted)' }}>
                      Auto
                    </span>
                    {overallAuto && <CheckCircle2 size={10} strokeWidth={2} style={{ color: 'var(--ef-success-strong)' }} />}
                  </button>
                </div>
                <div className="flex items-center gap-2 px-3 py-2"
                  style={{
                    border: '1px solid var(--ef-border)', borderRadius: 2,
                    background: overallAuto ? 'var(--ef-canvas)' : 'var(--ef-surface)',
                  }}>
                  <Clock size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
                  <input
                    type="number"
                    value={overallLimitDisplay}
                    onChange={(e) => setOverallTimeLimit(e.target.value)}
                    readOnly={overallAuto}
                    placeholder="Blank = no overall cap"
                    min="1"
                    className="flex-1 outline-none"
                    style={{
                      background: 'transparent',
                      color: overallAuto ? '#6B6A65' : 'var(--ef-ink)',
                      fontSize: 12, border: 'none',
                    }}
                  />
                  {overallLimitDisplay && <span style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>minutes</span>}
                </div>
                <p className="text-xs mt-1" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
                  {overallAuto
                    ? `Auto: sum of section time, section grace, breaks and overall grace (currently ${autoOverallLimit}m). Counts from when a student begins — time in breaks and gaps between sections counts against it.`
                    : 'Counts from when a student begins the exam. The exam hard-cuts when this runs out, even mid-section. Blank = no overall cap.'}
                </p>
              </div>

              <Field label="Overall grace period" hint={`(seconds past the overall timer; blank = ${DEFAULT_OVERALL_GRACE_SECONDS}s default)`}>
                <div className="flex items-center gap-2 px-3 py-2"
                  style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
                  <Timer size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
                  <input type="number" value={overallGraceSeconds} onChange={(e) => setOverallGraceSeconds(e.target.value)}
                    placeholder={`e.g., ${DEFAULT_OVERALL_GRACE_SECONDS}`} min="0" className="flex-1 outline-none"
                    style={{ background: 'transparent', color: 'var(--ef-ink)', fontSize: 12, border: 'none' }} />
                  {overallGraceSeconds && <span style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>seconds</span>}
                </div>
              </Field>

              {/* A-10: the per-question grace, which had no authoring UI at all
                  despite six readers across the server and the shell. Shown
                  only for sequential delivery — standard mode has no
                  per-question clock for it to extend. */}
              {deliveryMode !== 'standard' && (
                <Field label="Question grace period" hint="(seconds past each question's timer; blank = 5s default)">
                  <div className="flex items-center gap-2 px-3 py-2"
                    style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
                    <Timer size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
                    <input type="number" value={questionGraceSeconds} onChange={(e) => setQuestionGraceSeconds(e.target.value)}
                      placeholder="e.g., 5" min="0" className="flex-1 outline-none"
                      style={{ background: 'transparent', color: 'var(--ef-ink)', fontSize: 12, border: 'none' }} />
                    {questionGraceSeconds && <span style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>seconds</span>}
                  </div>
                </Field>
              )}

              {/* NEGATIVE MARKING (Standard + Linear only) ─────────────── */}
              {deliveryMode !== 'adaptive' && (
                <div className="space-y-3 pt-1">
                  <SectionLabel label="NEGATIVE MARKING" />

                  {/* Master switch — the hard gate. Off = no penalty anywhere. */}
                  <button
                    type="button"
                    onClick={() => patchExamPolicy({ negativeMarking: !negMarkingOn })}
                    className="w-full flex items-center justify-between px-3 py-2.5"
                    style={{
                      borderRadius: 2,
                      border: `1px solid ${negMarkingOn ? 'var(--ef-danger-border)' : 'var(--ef-border)'}`,
                      background: negMarkingOn ? 'var(--ef-danger-bg)' : 'var(--ef-surface)',
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <AlertCircle size={13} strokeWidth={1.5} style={{ color: negMarkingOn ? 'var(--ef-danger)' : 'var(--ef-text-muted)' }} />
                      <span className="text-xs" style={{ color: negMarkingOn ? 'var(--ef-danger)' : '#6B6A65' }}>
                        Deduct marks for wrong answers
                      </span>
                    </div>
                    <span
                      className="flex items-center px-2 py-0.5"
                      style={{
                        borderRadius: 2, fontSize: 10,
                        border: `1px solid ${negMarkingOn ? 'var(--ef-danger-border)' : 'var(--ef-border)'}`,
                        background: negMarkingOn ? 'var(--ef-surface)' : 'var(--ef-canvas)',
                        color: negMarkingOn ? 'var(--ef-danger)' : 'var(--ef-text-muted)',
                      }}
                    >
                      {negMarkingOn ? 'ON' : 'OFF'}
                    </span>
                  </button>

                  {negMarkingOn && (
                    <>
                      {/* Exam default penalty */}
                      <Field label="Default penalty for wrong answers" hint="(applied unless a section or difficulty overrides it)">
                        <PenaltyInput
                          policy={examPolicy}
                          onChange={(patch) => patchExamPolicy(patch)}
                        />
                      </Field>

                      <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
                        Only <strong>fully wrong</strong> answers are penalised. Partially correct answers keep their partial marks, and blanks are never penalised. The exam total never drops below zero.
                      </p>
                    </>
                  )}

                  {/* Blank rule — meaningful even with penalties off; almost always 0. */}
                  <Field label="Score for a blank (unanswered) question" hint="(default 0 — a student is never penalised for not attempting)">
                    <div className="flex items-center gap-2 px-3 py-2"
                      style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
                      <input
                        type="number"
                        value={examPolicy.blankScore ?? ''}
                        onChange={(e) => patchExamPolicy({ blankScore: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                        placeholder="0"
                        step="0.5"
                        className="flex-1 outline-none"
                        style={{ background: 'transparent', color: 'var(--ef-ink)', fontSize: 12, border: 'none' }}
                      />
                      <span style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>marks</span>
                    </div>
                  </Field>
                </div>
              )}

              {status === 'active' && (
                <div className="flex items-start gap-2 px-3 py-3"
                  style={{ background: 'var(--ef-success-bg)', border: '1px solid var(--ef-success-border)', borderRadius: 2 }}>
                  <CheckCircle2 size={12} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)', flexShrink: 0, marginTop: 1 }} />
                  <p className="text-xs" style={{ color: 'var(--ef-success-strong)', lineHeight: 1.6 }}>
                    Setting status to <strong>Active</strong> will validate and randomly resolve a unique question set per student at save time.
                  </p>
                </div>
              )}
            </div>
            )}

            {/* SECTION LIMITS */}
            {stage === 'grading' && (sections.some((s) => s.timeLimit) || sections.slice(0, -1).some((s) => parseInt(s.breakAfterMinutes, 10) > 0)) && (
              <div className="space-y-3">
                <SectionLabel label="SECTION LIMITS" />
                <div className="space-y-1">
                  {sections.map((sec, sIdx) => {
                    const showSection = !!sec.timeLimit;
                    const breakMins = sIdx < sections.length - 1 ? parseInt(sec.breakAfterMinutes, 10) || 0 : 0;
                    if (!showSection && !breakMins) return null;
                    return (
                      <div key={sec.id} className="space-y-1">
                        {showSection && (
                          <div className="flex items-center justify-between px-3 py-1.5"
                            style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{sec.name}</span>
                            <span className="text-xs flex items-center gap-1" style={{ color: 'var(--ef-text-muted)' }}>
                              <Timer size={10} strokeWidth={1.5} />{sec.timeLimit} min
                            </span>
                          </div>
                        )}
                        {breakMins > 0 && (
                          <div className="flex items-center justify-between px-3 py-1"
                            style={{ background: 'var(--ef-canvas-raised)', border: '1px dashed var(--ef-border)', borderRadius: 2 }}>
                            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                              Break {sec.breakMandatory ? '(mandatory)' : '(skippable)'}
                            </span>
                            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{breakMins} min</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            </div>{/* /column */}


            {/* RIGHT COLUMN: SETTINGS */}
            {stage === 'security' && (
            <div className="space-y-3" style={{ minWidth: 0 }}>

              {/* ── Security tier ──
                  Three segmented buttons with one line of grey text before
                  this: to compare Normal against High-stake an author had to
                  click one, read, click the other, read, and hold both in
                  their head — so in practice nobody moved off the default. It
                  is the decision that governs whether the paper is proctored
                  at all, and it was presented like a font setting. */}
              <CapabilityChoice
                label="Security tier"
                value={securityTier}
                onChange={(next) => {
                  setSecurityTier(next);
                  // Phase 3 (Stage 4): switching tier re-baselines the SEB
                  // toggle — back to the original override when returning to
                  // the assessment's saved tier, else to the new tier's
                  // default. D-10: high_stake is not a default any more, it is
                  // forced, so it wins over a stored override on the way in.
                  setRequireSEB(
                    next === 'high_stake'
                      ? true
                      : next === assessment?.securityTier
                        ? assessment?.requireSEB ?? false
                        : false,
                  );
                }}
                options={[
                  {
                    value: 'mock',
                    label: 'Mock',
                    summary: 'Practice. The result does not count.',
                    points: [
                      'Phones and tablets welcome',
                      'No camera, no browser check',
                      'Violations recorded but never end the sitting',
                    ],
                  },
                  {
                    value: 'normal',
                    label: 'Normal',
                    summary: 'Proctored by in-page deterrents.',
                    points: [
                      'Camera on by default',
                      'Computer only — tablets optional',
                      'Three violations end the sitting',
                    ],
                  },
                  {
                    value: 'high_stake',
                    label: 'High-stake',
                    summary: 'Locked down. Everything below is forced on.',
                    points: [
                      'Safe Exam Browser required',
                      'Camera and clean-browser check required',
                      'Computer only, no exceptions',
                    ],
                  },
                ]}
              />

              {/* ── Device permissions ────────────────────────────────────
                  Phones are LOCKED off at both proctored tiers, so the only
                  device control an author has here is tablets. It is shown at
                  'normal' alone: at 'mock' both are already permitted and at
                  'high_stake' both are locked, so rendering a toggle that
                  cannot move would be a control in name only.

                  The row above it states the phone rule rather than offering
                  it, because an author reading "Tablets" with nothing said
                  about phones will reasonably assume phones are covered too. */}
              {securityTier !== 'mock' && (
                <div className="space-y-2">
                  <SettingsToggle
                    icon={<Smartphone size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />}
                    label="Allow phones"
                    hint="Phones cannot carry this tier's proctoring — there is no fullscreen on iOS Safari, and an on-screen keyboard looks identical to a docked developer panel. Choose Mock for an exam students may sit on a phone."
                    value={false}
                    onChange={() => {}}
                    locked
                    lockReason={securityTier === 'high_stake' ? 'Never at high-stake' : 'Never at normal'}
                  />
                  <SettingsToggle
                    icon={<Tablet size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />}
                    label="Allow tablets"
                    hint={securityTier === 'high_stake'
                      ? 'Tablets are refused at high-stake along with phones. Choose Normal to admit them.'
                      : 'Permits iPads and Android tablets. They carry more of the proctoring than a phone does, but still no fullscreen on iPadOS Safari.'}
                    value={securityTier === 'high_stake' ? false : allowTablet}
                    onChange={setAllowTablet}
                    locked={securityTier === 'high_stake'}
                    lockReason={securityTier === 'high_stake' ? 'Never at high-stake' : undefined}
                  />
                </div>
              )}

              {/* ── Phase 3 (Stage 4): Safe Exam Browser ──────────────────
                  D-10: LOCKED ON at high-stake, joining camera / desktop-only /
                  extension-check. It is the only control that reaches remote
                  desktop, VPNs and userscript managers, so a high-stake exam
                  without it was enforcing strictly less than the tier claims.
                  A school without an SEB rollout runs 'normal' — the tier that
                  means web deterrents only. Normal stays opt-in; mock never
                  (applyTierDefaults forces it false). The server re-derives
                  this at startExam and freezes it into securityConfig. */}
              {securityTier !== 'mock' && (
                <div className="space-y-2">
                  <SettingsToggle
                    icon={<Shield size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />}
                    label="Require Safe Exam Browser"
                    hint={securityTier === 'high_stake'
                      ? 'Locks the exam to genuine SEB — blocks VPNs, remote desktop, userscripts. Always on at high-stake; choose Normal to run without it.'
                      : 'Opt-in SEB lockdown for this exam. Students need SEB and the .seb config to enter.'}
                    value={requireSEB}
                    onChange={setRequireSEB}
                    locked={securityTier === 'high_stake'}
                    lockReason={securityTier === 'high_stake' ? 'Required at high-stake' : undefined}
                  />
                  {requireSEB && (
                    <div className="space-y-1.5 px-4 py-3"
                      style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-canvas-raised)' }}>
                      <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                        SEB configuration for this exam
                      </p>
                      <div className="flex" style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', overflow: 'hidden' }}>
                        {([
                          { key: 'platform' as const, label: 'Platform config' },
                          { key: 'custom' as const,   label: 'Exam-specific config' },
                        ]).map((opt, i) => {
                          const active = sebConfigSource === opt.key;
                          return (
                            <button
                              key={opt.key}
                              type="button"
                              onClick={() => { setSebConfigSource(opt.key); setSebKeysError(''); }}
                              className="flex-1 text-xs px-2 py-1.5 transition-colors"
                              style={{
                                background: active ? 'var(--ef-ink)' : 'transparent',
                                color: active ? 'var(--ef-surface)' : 'var(--ef-text-subtle)',
                                borderLeft: i === 0 ? 'none' : '1px solid var(--ef-border)',
                                cursor: 'pointer',
                              }}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                      {sebConfigSource === 'platform' ? (
                        <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
                          Uses the platform Config Keys and the platform .seb file from the
                          Safe Exam Browser page. Nothing else to set here.
                        </p>
                      ) : (
                        <>
                          <p className="text-xs pt-2" style={{ color: 'var(--ef-text-muted)' }}>
                            Config Keys for this exam (one per line)
                          </p>
                          <textarea
                            value={sebKeysText}
                            onChange={(e) => { setSebKeysText(e.target.value); setSebKeysError(''); }}
                            placeholder="64-character Config Key from the Config Tool — ONLY these keys unlock this exam."
                            rows={2}
                            spellCheck={false}
                            className="w-full text-xs px-3 py-2"
                            style={{
                              border: `1px solid ${sebKeysError ? 'var(--ef-danger-border)' : 'var(--ef-border)'}`,
                              borderRadius: 2, background: 'var(--ef-surface)', color: 'var(--ef-ink)',
                              fontFamily: 'ui-monospace, monospace', outline: 'none', resize: 'vertical',
                            }}
                          />
                          {sebKeysError && (
                            <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{sebKeysError}</p>
                          )}
                          <p className="text-xs pt-2" style={{ color: 'var(--ef-text-muted)' }}>
                            .seb file for this exam
                          </p>
                          <input
                            ref={sebFileInputRef}
                            type="file"
                            accept=".seb"
                            className="hidden"
                            onChange={(e) => {
                              setSebFile(e.target.files?.[0] ?? null);
                              if (sebFileInputRef.current) sebFileInputRef.current.value = '';
                            }}
                          />
                          {sebFile ? (
                            <div className="w-full flex items-center justify-between gap-3 px-3 py-2"
                              style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
                              <div className="flex items-center gap-2 min-w-0">
                                <FileText size={12} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)', flexShrink: 0 }} />
                                <p className="text-xs truncate" style={{ color: 'var(--ef-ink)' }}>{sebFile.name}</p>
                              </div>
                              <button
                                type="button"
                                onClick={() => setSebFile(null)}
                                className="p-1 flex-shrink-0"
                                style={{ color: 'var(--ef-text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
                                aria-label="Clear chosen file"
                              >
                                <X size={12} strokeWidth={1.5} />
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => sebFileInputRef.current?.click()}
                              className="w-full flex items-center justify-center gap-2 text-xs px-3 py-2 transition-colors"
                              style={{
                                border: '1px dashed var(--ef-track)', borderRadius: 2,
                                background: 'var(--ef-surface)', color: 'var(--ef-text-subtle)', cursor: 'pointer',
                              }}
                            >
                              <Upload size={11} strokeWidth={1.5} />
                              {sebConfigFileUrl ? 'Choose .seb file to replace the current one…' : 'Choose .seb file…'}
                            </button>
                          )}
                          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
                            {sebFile
                              ? `Will upload "${sebFile.name}" on save and offer it on this exam's briefing gate.`
                              : sebConfigFileUrl
                                ? 'A .seb file is already uploaded for this exam — choose a file only to replace it.'
                                : 'Upload the .seb saved by the Config Tool for THIS exam. The file and the keys above must describe the same configuration.'}
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Delivery mode ──
                  The other decision that was a segmented control with one line
                  of grey text. It governs whether a student can go back to a
                  question — which changes how the paper must be written, not
                  just how it is served — and the honest facts about each mode
                  are load-bearing rather than decorative:

                  C-1 / C-2: this copy once claimed enforcement was still to
                  come for both sequential modes. Linear has been fully enforced
                  server-side for some time — one question at a time, locked
                  questions refused, direct answer writes blocked by the rules —
                  so an author reading "later phase" could ship a genuinely
                  one-way exam believing it inert. Adaptive is the opposite
                  error: enforced exactly like Linear, with no difficulty ladder
                  behind it at all. Both say what actually happens. */}
              <CapabilityChoice
                label="Delivery mode"
                value={deliveryMode}
                onChange={setDeliveryMode}
                options={[
                  {
                    value: 'standard',
                    label: 'Standard',
                    summary: 'The whole paper, navigable.',
                    points: [
                      'Students revisit and change answers',
                      'Question navigator available',
                    ],
                  },
                  {
                    value: 'linear',
                    label: 'Linear',
                    summary: 'One question at a time, no going back.',
                    points: [
                      'Enforced server-side, not just hidden',
                      'Each answer commits as they advance',
                      'Optional per-question timer',
                    ],
                  },
                  {
                    value: 'adaptive',
                    label: 'Adaptive',
                    summary: 'Identical to Linear today.',
                    points: [
                      'Difficulty adaptation is not built yet',
                      'Negative marking is discarded on save',
                      'Choose Linear unless you are trialling this',
                    ],
                  },
                ]}
              />
              {deliveryMode === 'adaptive' && (
                <p className="text-xs" style={{ color: '#B4643C', lineHeight: 1.6 }}>
                  Negative marking is not applied in Adaptive delivery — any penalty
                  settings on the Grading stage are discarded when you save. Choose
                  Linear if you need one-at-a-time delivery with negative marking.
                </p>
              )}

              {/* Section start order */}
              <div className="space-y-1.5">
                <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                  Section order
                </p>
                <div className="flex" style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', overflow: 'hidden' }}>
                  {([
                    { key: 'sequential' as const, label: 'In order' },
                    { key: 'random' as const,     label: 'Random' },
                    { key: 'student_choice' as const, label: "Student's choice" },
                  ]).map((opt, i) => {
                    const active = sectionStartOrder === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => setSectionStartOrder(opt.key)}
                        className="flex-1 text-xs px-2 py-1.5 transition-colors"
                        style={{
                          background: active ? 'var(--ef-ink)' : 'transparent',
                          color: active ? 'var(--ef-surface)' : 'var(--ef-text-subtle)',
                          borderLeft: i === 0 ? 'none' : '1px solid var(--ef-border)',
                          cursor: 'pointer',
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                  {sectionStartOrder === 'random'
                    ? 'Each student gets sections in a different order. Breaks apply by completion count — after the 1st completed section, the 2nd, and so on.'
                    : sectionStartOrder === 'student_choice'
                      ? 'Students choose which section to take next. Breaks apply by completion count — after the 1st completed section, the 2nd, and so on.'
                      : 'Sections are taken in the order shown below.'}
                </p>
              </div>

              <div className="space-y-2">
                <SettingsToggle
                  icon={<Shuffle size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />}
                  label="Shuffle Questions"
                  hint="Randomise question order for each student"
                  value={shuffleQuestions}
                  onChange={setShuffleQuestions}
                  locked={!mut.shuffleQuestions}
                  lockReason={mut.shuffleQuestions ? undefined : lockReason}
                />
                <AudienceSelector
                  icon={<BarChart2 size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />}
                  label="Show Results"
                  hint="Who can see scores and outcomes after submission"
                  value={showResultsTo}
                  onChange={setShowResultsTo}
                />
                <AudienceSelector
                  icon={<BookOpen size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />}
                  label="Allow Review"
                  hint="Who can see the questions and correct answers after submission"
                  value={allowReviewTo}
                  onChange={setAllowReviewTo}
                />
              </div>
            </div>
            )}

            {/* Forward affordance for the settings stages — AFTER both column
                groups, so it follows the content on every one of them rather
                than leading on the stage whose block happens to render last. */}
            {(stage === 'schedule' || stage === 'grading' || stage === 'security') && (
              <div className="flex items-center justify-end mt-8">
                <button
                  onClick={() => onNavigate(stage === 'schedule' ? 'grading' : stage === 'grading' ? 'security' : 'allocation')}
                  className="flex items-center gap-1.5 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
                  style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: 'pointer' }}>
                  Continue to {stage === 'schedule' ? 'Grading' : stage === 'grading' ? 'Security' : 'Allocation'}
                  <ChevronRight size={12} strokeWidth={2} />
                </button>
              </div>
            )}

          </div>
        </div>
      </div>

      {/* ── The Questions stage ──
          The per-section rule builder. It used to sit below the settings wall
          on the same screen, so an author scrolled past schedule, grading and
          the entire security block to reach the thing they had come to do. It
          is its own stage now — and the "Sections" stage next to it is the
          section STRUCTURE, which is a genuinely different job. */}
      {stage === 'questions' && (
      <RuleBuilderPanel
        sections={sections}
        activeSectionIdx={activeSectionIdx}
        setActiveSectionIdx={setActiveSectionIdx}
        setSections={setSections}
        allQuestions={allQuestions}
        allGroups={allGroups}
        locked={!mut.sections}
        subjectPoolNames={subjectPoolNames}
        topicPool={topicPool}
        subjectNameById={taxonomyMaps.subjectNameById}
        topicNameById={taxonomyMaps.topicNameById}
        grading={deliveryMode !== 'adaptive' && negMarkingOn ? {
          negMarkingOn,
          getSectionPolicy: (sid) => gradingConfig.sections?.[sid]?.section,
          getRowPolicy: (sid, d) => gradingConfig.sections?.[sid]?.byDifficulty?.[d],
          resolveInherited: resolveInheritedPenalty,
          setSectionPolicy: patchSectionPolicy,
          setRowPolicy: patchRowPolicy,
        } : undefined}
      />
      )}

      {/* Advance affordance, matching the setup stages. It used to be a bar
          with its own top border pinned by mt-8 — which, now that the save bar
          is workspace chrome pinned below it, collided with it and clipped the
          button in half. Inline, in the scroll flow, like every other stage. */}
      {stage === 'questions' && (
        <div className="flex items-center justify-end px-12 py-6">
          <button onClick={() => onNavigate('schedule')}
            className="flex items-center gap-1.5 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
            style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: 'pointer' }}>
            Continue to Schedule <ChevronRight size={12} strokeWidth={2} />
          </button>
        </div>
      )}

      </>
      ) : (

      /* ══ STEP 3 — ALLOCATION ═══════════════════════════════════════
         The Assign To block relocated from Step 1 Basics (D1). Behavior is
         byte-identical to the old control: same three legacy modes, same
         pickers, same mutability lock. The rule-based mode (D2) mounts here
         later as a fourth option. DetailsStep stays mounted across 2↔3, so
         handleSave and all settings state work unchanged from this phase. */
      <motion.div key="allocation-phase" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        transition={{ duration: 0.18 }} className="flex flex-col flex-1">

        <div className="flex-shrink-0" style={{ background: 'var(--ef-canvas-raised)' }}>
          <div style={{ padding: '20px 48px 24px' }}>

            {/* Back link */}
            <div className="flex items-center gap-2 mb-4">
              <button onClick={onBackToRules}
                className="flex items-center gap-1 text-xs transition-opacity hover:opacity-60"
                style={{ color: 'var(--ef-text-muted)' }}>
                <X size={11} strokeWidth={1.5} /> Back to Rules &amp; Settings
              </button>
              <span style={{ color: 'var(--ef-border-muted)', fontSize: 10 }}>·</span>
              <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>STEP 3 OF 3 — ALLOCATION</p>
            </div>

            <div className="space-y-5" style={{ maxWidth: hierarchyMode ? 920 : 560 }}>
              <div>
                <SectionLabel label="ALLOCATION" />
                <p className="text-xs mt-2" style={{ color: 'var(--ef-text-muted)' }}>
                  Choose who takes this exam. Saving and publishing happen from this step.
                </p>
              </div>

              {mut.targetType ? (
                <Field label="Assign To">
                  <select
                    value={hierarchyMode ? 'hierarchy' : targetType}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === 'hierarchy') { setHierarchyMode(true); return; }
                      setHierarchyMode(false);
                      setTargetType(v as 'all' | 'institutes' | 'students');
                    }}
                    style={{ ...selectStyle, fontSize: 13, padding: '9px 12px' }}
                  >
                    <option value="all">All Students</option>
                    <option value="institutes">Specific Institutes</option>
                    <option value="students">Specific Students</option>
                    <option value="hierarchy">By Hierarchy — sections, groups, courses… (preview)</option>
                  </select>
                  {!hierarchyMode && targetType === 'institutes' && (
                    <InstitutePicker selectedIds={selectedInstituteIds} onChange={setSelectedInstituteIds} locked={false} />
                  )}
                  {!hierarchyMode && targetType === 'students' && (
                    <StudentPicker selectedIds={selectedStudentIds} onChange={setSelectedStudentIds} locked={false} />
                  )}
                </Field>
              ) : (
                <LockedFieldWrapper label="Assign To" reason={lockReason}>
                  <div>
                    {/* Audit L4: `readOnly` is not a valid attribute on <select> —
                        the DOM ignores it, so the control was locked only by being
                        a controlled value with no onChange, which also logs a React
                        warning. `disabled` is the attribute that actually locks it. */}
                    <select value={targetType} disabled style={{ ...selectStyle, fontSize: 13, padding: '9px 12px' }}>
                      <option value="all">All Students</option>
                      <option value="institutes">Specific Institutes</option>
                      <option value="students">Specific Students</option>
                    </select>
                    {targetType === 'institutes' && (
                      <InstitutePicker selectedIds={selectedInstituteIds} onChange={setSelectedInstituteIds} locked={true} />
                    )}
                    {targetType === 'students' && (
                      <StudentPicker selectedIds={selectedStudentIds} onChange={setSelectedStudentIds} locked={true} />
                    )}
                  </div>
                </LockedFieldWrapper>
              )}

              {/* Phase C — rule-based allocation surface (server-resolved) */}
              {hierarchyMode && mut.targetType && (
                <AllocationPanelCore
                  draft={allocationDraft}
                  setDraft={setAllocationDraft}
                  assessmentId={mode === 'edit' ? assessment?.id : undefined}
                  version={allocationVersion}
                />
              )}
            </div>
          </div>
        </div>

      </motion.div>
      )}

      {/* Validation-error modal (hard-block) */}
      {validationErrors.length > 0 && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center px-6"
          style={{ background: 'rgba(12,12,11,0.45)' }}
          onClick={() => setValidationErrors([])}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3, maxWidth: 520, width: '100%' }}>
            <div className="px-6 py-5" style={{ borderBottom: '1px solid var(--ef-border)' }}>
              <div className="flex items-center gap-2">
                <AlertCircle size={14} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />
                <span className="text-xs" style={{ color: 'var(--ef-ink)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Fix the following before saving
                </span>
              </div>
            </div>
            <ul className="px-6 py-4 space-y-2.5">
              {validationErrors.map((err, i) => (
                <li key={i} className="flex items-start gap-2 text-xs" style={{ color: 'var(--ef-ink)', lineHeight: 1.55 }}>
                  <span style={{ color: 'var(--ef-danger)', flexShrink: 0, marginTop: 1 }}>•</span>
                  <span>{err}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end gap-2 px-6 py-4"
              style={{ borderTop: '1px solid var(--ef-border)', background: 'var(--ef-canvas-raised)' }}>
              <button onClick={() => setValidationErrors([])}
                className="text-xs px-4 py-2 transition-opacity hover:opacity-80"
                style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: 'pointer' }}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Soft-warning confirmation modal (publish only) */}
      {pendingPublish && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center px-6"
          style={{ background: 'rgba(12,12,11,0.45)' }}
          onClick={() => setPendingPublish(null)}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3, maxWidth: 520, width: '100%' }}>
            <div className="px-6 py-5" style={{ borderBottom: '1px solid var(--ef-border)' }}>
              <div className="flex items-center gap-2">
                <AlertTriangle size={14} strokeWidth={1.5} style={{ color: '#B5651D' }} />
                <span className="text-xs" style={{ color: 'var(--ef-ink)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Confirm publish
                </span>
              </div>
              <p className="text-xs mt-2" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                Before publishing, please review the following:
              </p>
            </div>
            <ul className="px-6 py-4 space-y-2.5">
              {pendingPublish.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2 text-xs" style={{ color: 'var(--ef-ink)', lineHeight: 1.55 }}>
                  <span style={{ color: '#B5651D', flexShrink: 0, marginTop: 1 }}>•</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end gap-2 px-6 py-4"
              style={{ borderTop: '1px solid var(--ef-border)', background: 'var(--ef-canvas-raised)' }}>
              <button onClick={() => setPendingPublish(null)}
                className="text-xs px-4 py-2 transition-opacity hover:opacity-80"
                style={{ background: 'var(--ef-surface)', color: 'var(--ef-ink)', border: '1px solid var(--ef-track)', borderRadius: 2, cursor: 'pointer' }}>
                Go back
              </button>
              <button onClick={() => { setPendingPublish(null); handleSave('active', true); }} disabled={saving}
                className="flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity hover:opacity-80"
                style={{ background: saving ? 'var(--ef-track)' : 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: saving ? 'not-allowed' : 'pointer' }}>
                {saving ? <><Loader2 size={11} className="animate-spin" /> Publishing…</> : <><CheckCircle2 size={11} /> Publish anyway</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}