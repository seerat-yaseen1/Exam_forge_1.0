/**
 * builder/DetailsStep — step 2 of the assessment builder: targeting,
 * allocation, scheduling, attempts, settings (incl. audience visibility),
 * security tier and SEB. (Batch F1d: extracted verbatim from
 * AssignmentsPage.tsx; no logic changes.)
 */
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { X, Loader2, ClipboardList, Clock, Calendar, AlertTriangle, CheckCircle2, FileText, Timer, Award, ChevronRight, AlertCircle, Shuffle, BarChart2, BookOpen, Shield, Upload } from 'lucide-react';
import { type Student } from '../../../../lib/firebaseService';
import { createAssessment, resolveQuestionsForSections, validateSelectionRules, applyTierDefaults, getAssessmentSEBKeys, getSEBSettings, getSEBPublicInfo, type Assessment, type AssessmentDraft, type AssessmentStatus, type AssignmentTarget, type AssessmentSection } from '../../../../lib/assessmentService';
import { deriveShowResultsTo, deriveAllowReviewTo, DEFAULT_SHOW_RESULTS_TO, DEFAULT_ALLOW_REVIEW_TO, type VisibilityAudience } from '../../../../lib/visibility';
import { AudienceSelector } from '../AudienceSelector';
import { type Question } from '../../../../lib/questionBankService';
import { getAllSubjects, type Subject } from '../../../../lib/subjectService';
import { AllocationPanelCore } from '../allocation/AllocationPanelCore';
import { emptyAllocationDraft, getAllocation, type AllocationDraft, type AllocationNodeType } from '../../../../lib/allocationService';
import { toDateTimeLocal, fromDateTimeLocal, formatDateTime, mutabilityFor, computeAutoOverallLimit, sumSectionsAndBreaksMinutes, DEFAULT_OVERALL_GRACE_SECONDS, type SectionDraft } from './shared';
import { Field, SectionLabel, selectStyle, DurationIndicator, StartScheduleControl, EndScheduleControl, LockedFieldWrapper, SettingsToggle } from './controls';
import { RuleBuilderPanel } from './topicPickers';
import { InstitutePicker, StudentPicker } from './targetPickers';

export function DetailsStep({
  mode, assessment, originalStatus, allQuestions, sections, setSections, onBack, onSave,
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
}) {
  const [startDate, setStartDate] = useState(toDateTimeLocal(assessment?.startDate));
  const [endDate, setEndDate] = useState(toDateTimeLocal(assessment?.endDate));
  const [passingScore, setPassingScore] = useState(assessment?.passingScore?.toString() ?? '');
  const [maxAttempts, setMaxAttempts] = useState(assessment?.maxAttempts?.toString() ?? '1');
  const [sectionGraceSeconds, setSectionGraceSeconds] = useState(assessment?.sectionGraceSeconds?.toString() ?? '');
  // ── Overall exam timer ─────────────────────────────────────────
  // overallGraceSeconds: its own knob (blank = 30s default).
  const [overallGraceSeconds, setOverallGraceSeconds] = useState(assessment?.overallGraceSeconds?.toString() ?? '');
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
  // ── Phase 3 (Stage 4): SEB authority toggle + config file link ───
  // requireSEB is the settled "default ON for high_stake, disable-able"
  // decision — until now it had no UI and applyTierDefaults reset it on
  // every save. Initialised from the existing assessment so an edit-save
  // no longer silently reverts a manual override. For a new assessment the
  // default follows the initial tier (normal → false).
  const [requireSEB, setRequireSEB] = useState<boolean>(
    assessment?.requireSEB ?? (assessment?.securityTier ?? 'normal') === 'high_stake',
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
          .filter((r) => (parseInt(r.count, 10) || 0) > 0)
          .map((r) => ({
            subject: r.subject,
            topic: r.topic,
            difficulty: r.difficulty,
            count: parseInt(r.count, 10),
            marksPerQuestion: parseFloat(r.marksPerQuestion) || 1,
          })),
        questions: [],
      };
      const tl = parseInt(sec.timeLimit, 10);
      if (tl > 0) out.timeLimit = tl;
      const qtl = parseInt(sec.questionTimeLimit, 10);
      if (qtl > 0) out.questionTimeLimit = qtl;
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

      // Each section must request at least 1 question.
      sections.forEach((s) => {
        const total = s.rules.reduce((sum, r) => sum + (parseInt(r.count, 10) || 0), 0);
        if (total < 1) {
          errors.push(`${s.name || 'Untitled section'} must have at least 1 question.`);
        }
      });

      const { valid, results } = validateSelectionRules(builtSections, allQuestions);
      if (!valid) {
        results
          .filter((r) => !r.ok)
          .forEach((r) => errors.push(`${r.sectionName}: ${r.subject} › ${r.topic} (${r.difficulty}) — requested ${r.requested}, only ${r.available} available`));
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
      const assignedTo: AssignmentTarget =
        targetType === 'all' ? { type: 'all' }
          : targetType === 'institutes' ? { type: 'institutes', instituteIds: selectedInstituteIds }
          : { type: 'students', studentIds: selectedStudentIds };

      let finalSections = builtSections;
      let flatQuestions = builtSections.flatMap((s) => s.questions);

      if (targetStatus === 'active') {
        const resolved = resolveQuestionsForSections(builtSections, allQuestions);
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
        passingScore: passingScore ? parseInt(passingScore, 10) : undefined,
        maxAttempts: maxAttempts ? parseInt(maxAttempts, 10) : undefined,
        sectionGraceSeconds: sectionGraceSeconds ? parseInt(sectionGraceSeconds, 10) : undefined,
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
        // camera on / mobile off / extension on). deliveryMode is chosen
        // independently. These flow through createAssessment's ...draft spread.
        // Phase 3 (Stage 4): requireSEB now carries the builder's toggle
        // instead of being reset to the tier default on every save; mock
        // still forces it false inside applyTierDefaults.
        ...applyTierDefaults(securityTier, { requireSEB }),
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
      <div className="flex-shrink-0" style={{ borderBottom: '1px solid #E3E1DB', background: '#FAFAF8' }}>
        <div style={{ padding: '20px 48px 24px' }}>

          {/* Back link */}
          <div className="flex items-center gap-2 mb-4">
            <button onClick={onBack}
              className="flex items-center gap-1 text-xs transition-opacity hover:opacity-60"
              style={{ color: '#B0AEA8' }}>
              <X size={11} strokeWidth={1.5} /> Back to Setup
            </button>
            <span style={{ color: '#DDDBD5', fontSize: 10 }}>·</span>
            <p className="text-xs" style={{ color: '#C4C3BD', letterSpacing: '0.1em' }}>STEP 2 OF 3 — RULES &amp; SETTINGS</p>
          </div>

          {/* Two-column layout: left stacks Schedule/Grading/Section Limits, right holds Settings.
              Collapses to a single column on screens under ~860px. */}
          <div
            className="gap-8"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              alignItems: 'start',
            }}
          >

            {/* LEFT COLUMN: Schedule + Grading + Section Limits */}
            <div className="space-y-6" style={{ minWidth: 0 }}>

            {/* SCHEDULE */}
            <div className="space-y-3">
              <SectionLabel label="SCHEDULE" />
              {mut.startDate ? (
                <StartScheduleControl startDate={startDate} setStartDate={setStartDate} />
              ) : (
                <LockedFieldWrapper label="Start Date & Time" reason={lockReason}>
                  <div className="flex items-center gap-2 px-3 py-2"
                    style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
                    <Calendar size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
                    <input type="datetime-local" value={startDate} readOnly className="flex-1 outline-none"
                      style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }} />
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
                      style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
                      <Calendar size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
                      <input type="datetime-local" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                        className="flex-1 outline-none"
                        style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }}
                        min={toDateTimeLocal(assessment?.endDate) || startDate || undefined} />
                    </div>
                  </Field>
                  <p className="text-xs mt-1.5 flex items-center gap-1" style={{ color: '#9A9891' }}>
                    <Clock size={9} strokeWidth={1.5} style={{ flexShrink: 0 }} />
                    You may only extend the deadline, not shorten it.
                  </p>
                </div>
              )}
              {mut.endDate === false && (
                <LockedFieldWrapper label="End Date & Time" reason={lockReason}>
                  <div className="flex items-center gap-2 px-3 py-2"
                    style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
                    <Calendar size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
                    <input type="datetime-local" value={endDate} readOnly className="flex-1 outline-none"
                      style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }} />
                  </div>
                </LockedFieldWrapper>
              )}

              {startDate && endDate && (
                <DurationIndicator startDate={startDate} endDate={endDate} totalSectionTime={totalSectionTime} />
              )}
            </div>

            {/* GRADING */}
            <div className="space-y-3">
              <SectionLabel label="GRADING" />
              <Field label="Passing Score" hint="(%, optional)">
                <div className="flex items-center gap-2 px-3 py-2"
                  style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
                  <Award size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
                  <input type="number" value={passingScore} onChange={(e) => setPassingScore(e.target.value)}
                    placeholder="e.g., 50" min="0" max="100" className="flex-1 outline-none"
                    style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }} />
                  {passingScore && <span style={{ color: '#C4C3BD', fontSize: 10 }}>%</span>}
                </div>
              </Field>

              <Field label="Max Attempts" hint="(per student, default 1)">
                <div className="flex items-center gap-2 px-3 py-2"
                  style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
                  <ClipboardList size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
                  <input type="number" value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)}
                    placeholder="e.g., 2" min="1" className="flex-1 outline-none"
                    style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }} />
                  {maxAttempts && <span style={{ color: '#C4C3BD', fontSize: 10 }}>attempts</span>}
                </div>
              </Field>

              <Field label="Section grace period" hint="(seconds past each section timer; blank = 30s default)">
                <div className="flex items-center gap-2 px-3 py-2"
                  style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
                  <Timer size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
                  <input type="number" value={sectionGraceSeconds} onChange={(e) => setSectionGraceSeconds(e.target.value)}
                    placeholder="e.g., 30" min="0" className="flex-1 outline-none"
                    style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }} />
                  {sectionGraceSeconds && <span style={{ color: '#C4C3BD', fontSize: 10 }}>seconds</span>}
                </div>
              </Field>

              {/* ── Overall exam timer ────────────────────────────────── */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs" style={{ color: '#6B6A65' }}>Overall time limit</span>
                    <span className="text-xs" style={{ color: '#C4C3BD' }}>(whole exam, optional)</span>
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
                      border: `1px solid ${overallAuto ? '#B8E6C8' : '#E3E1DB'}`,
                      background: overallAuto ? '#F0F9F4' : '#FFFFFF',
                    }}
                  >
                    <span className="text-xs" style={{ color: overallAuto ? '#1E7B3C' : '#9A9891' }}>
                      Auto
                    </span>
                    {overallAuto && <CheckCircle2 size={10} strokeWidth={2} style={{ color: '#1E7B3C' }} />}
                  </button>
                </div>
                <div className="flex items-center gap-2 px-3 py-2"
                  style={{
                    border: '1px solid #E3E1DB', borderRadius: 2,
                    background: overallAuto ? '#F7F6F3' : '#FFFFFF',
                  }}>
                  <Clock size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
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
                      color: overallAuto ? '#6B6A65' : '#0C0C0B',
                      fontSize: 12, border: 'none',
                    }}
                  />
                  {overallLimitDisplay && <span style={{ color: '#C4C3BD', fontSize: 10 }}>minutes</span>}
                </div>
                <p className="text-xs mt-1" style={{ color: '#9A9891', lineHeight: 1.5 }}>
                  {overallAuto
                    ? `Auto: sum of section time, section grace, breaks and overall grace (currently ${autoOverallLimit}m). Counts from when a student begins — time in breaks and gaps between sections counts against it.`
                    : 'Counts from when a student begins the exam. The exam hard-cuts when this runs out, even mid-section. Blank = no overall cap.'}
                </p>
              </div>

              <Field label="Overall grace period" hint={`(seconds past the overall timer; blank = ${DEFAULT_OVERALL_GRACE_SECONDS}s default)`}>
                <div className="flex items-center gap-2 px-3 py-2"
                  style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
                  <Timer size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
                  <input type="number" value={overallGraceSeconds} onChange={(e) => setOverallGraceSeconds(e.target.value)}
                    placeholder={`e.g., ${DEFAULT_OVERALL_GRACE_SECONDS}`} min="0" className="flex-1 outline-none"
                    style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }} />
                  {overallGraceSeconds && <span style={{ color: '#C4C3BD', fontSize: 10 }}>seconds</span>}
                </div>
              </Field>

              {status === 'active' && (
                <div className="flex items-start gap-2 px-3 py-3"
                  style={{ background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2 }}>
                  <CheckCircle2 size={12} strokeWidth={1.5} style={{ color: '#1E7B3C', flexShrink: 0, marginTop: 1 }} />
                  <p className="text-xs" style={{ color: '#1E7B3C', lineHeight: 1.6 }}>
                    Setting status to <strong>Active</strong> will validate and randomly resolve a unique question set per student at save time.
                  </p>
                </div>
              )}
            </div>

            {/* SECTION LIMITS */}
            {(sections.some((s) => s.timeLimit) || sections.slice(0, -1).some((s) => parseInt(s.breakAfterMinutes, 10) > 0)) && (
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
                            style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                            <span className="text-xs" style={{ color: '#6B6B66' }}>{sec.name}</span>
                            <span className="text-xs flex items-center gap-1" style={{ color: '#9A9891' }}>
                              <Timer size={10} strokeWidth={1.5} />{sec.timeLimit} min
                            </span>
                          </div>
                        )}
                        {breakMins > 0 && (
                          <div className="flex items-center justify-between px-3 py-1"
                            style={{ background: '#FAFAF8', border: '1px dashed #E3E1DB', borderRadius: 2 }}>
                            <span className="text-xs" style={{ color: '#9A9891' }}>
                              Break {sec.breakMandatory ? '(mandatory)' : '(skippable)'}
                            </span>
                            <span className="text-xs" style={{ color: '#9A9891' }}>{breakMins} min</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            </div>{/* /LEFT COLUMN */}

            {/* RIGHT COLUMN: SETTINGS */}
            <div className="space-y-3" style={{ minWidth: 0 }}>
              <SectionLabel label="SETTINGS" />

              {/* Security tier */}
              <div className="space-y-1.5">
                <p className="text-xs" style={{ color: '#6B6B66' }}>
                  Security tier
                </p>
                <div className="flex" style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', overflow: 'hidden' }}>
                  {([
                    { key: 'mock' as const,       label: 'Mock' },
                    { key: 'normal' as const,     label: 'Normal' },
                    { key: 'high_stake' as const, label: 'High-stake' },
                  ]).map((opt, i) => {
                    const active = securityTier === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => {
                          setSecurityTier(opt.key);
                          // Phase 3 (Stage 4): switching tier re-baselines the
                          // SEB toggle — back to the original override when
                          // returning to the assessment's saved tier, else to
                          // the new tier's default (high_stake ON, others OFF).
                          setRequireSEB(
                            opt.key === assessment?.securityTier
                              ? assessment?.requireSEB ?? opt.key === 'high_stake'
                              : opt.key === 'high_stake',
                          );
                        }}
                        className="flex-1 text-xs px-2 py-1.5 transition-colors"
                        style={{
                          background: active ? '#0C0C0B' : 'transparent',
                          color: active ? '#FFFFFF' : '#4A4A45',
                          borderLeft: i === 0 ? 'none' : '1px solid #E3E1DB',
                          cursor: 'pointer',
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs" style={{ color: '#9A9891' }}>
                  {securityTier === 'mock'
                    ? 'Practice mode — no proctoring. Camera off, phones allowed.'
                    : securityTier === 'high_stake'
                      ? 'Maximum security — camera required, desktop only, Safe Exam Browser (default on).'
                      : 'Deterrent proctoring — camera on by default, extension check, desktop by default.'}
                </p>
              </div>

              {/* ── Phase 3 (Stage 4): Safe Exam Browser ──────────────────
                  The authority toggle. High-stake defaults ON but is
                  disable-able (a school without SEB rollout can still run
                  high-stake with the web-tier deterrents); normal is opt-in;
                  mock never (applyTierDefaults forces it false). The server
                  re-derives this from the doc at startExam and freezes it
                  into the attempt's securityConfig. */}
              {securityTier !== 'mock' && (
                <div className="space-y-2">
                  <SettingsToggle
                    icon={<Shield size={12} strokeWidth={1.5} style={{ color: '#9A9891' }} />}
                    label="Require Safe Exam Browser"
                    hint={securityTier === 'high_stake'
                      ? 'Locks the exam to genuine SEB — blocks VPNs, remote desktop, userscripts. Default on for high-stake.'
                      : 'Opt-in SEB lockdown for this exam. Students need SEB and the .seb config to enter.'}
                    value={requireSEB}
                    onChange={setRequireSEB}
                  />
                  {requireSEB && (
                    <div className="space-y-1.5 px-4 py-3"
                      style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FAFAF8' }}>
                      <p className="text-xs" style={{ color: '#6B6B66' }}>
                        SEB configuration for this exam
                      </p>
                      <div className="flex" style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', overflow: 'hidden' }}>
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
                                background: active ? '#0C0C0B' : 'transparent',
                                color: active ? '#FFFFFF' : '#4A4A45',
                                borderLeft: i === 0 ? 'none' : '1px solid #E3E1DB',
                                cursor: 'pointer',
                              }}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                      {sebConfigSource === 'platform' ? (
                        <p className="text-xs" style={{ color: '#9A9891', lineHeight: 1.5 }}>
                          Uses the platform Config Keys and the platform .seb file from the
                          Safe Exam Browser page. Nothing else to set here.
                        </p>
                      ) : (
                        <>
                          <p className="text-xs pt-2" style={{ color: '#6B6B66' }}>
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
                              border: `1px solid ${sebKeysError ? '#F2CECE' : '#E3E1DB'}`,
                              borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B',
                              fontFamily: 'ui-monospace, monospace', outline: 'none', resize: 'vertical',
                            }}
                          />
                          {sebKeysError && (
                            <p className="text-xs" style={{ color: '#9B2828' }}>{sebKeysError}</p>
                          )}
                          <p className="text-xs pt-2" style={{ color: '#6B6B66' }}>
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
                              style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
                              <div className="flex items-center gap-2 min-w-0">
                                <FileText size={12} strokeWidth={1.5} style={{ color: '#1E7B3C', flexShrink: 0 }} />
                                <p className="text-xs truncate" style={{ color: '#0C0C0B' }}>{sebFile.name}</p>
                              </div>
                              <button
                                type="button"
                                onClick={() => setSebFile(null)}
                                className="p-1 flex-shrink-0"
                                style={{ color: '#9A9891', background: 'none', border: 'none', cursor: 'pointer' }}
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
                                border: '1px dashed #C8C7C2', borderRadius: 2,
                                background: '#FFFFFF', color: '#4A4A45', cursor: 'pointer',
                              }}
                            >
                              <Upload size={11} strokeWidth={1.5} />
                              {sebConfigFileUrl ? 'Choose .seb file to replace the current one…' : 'Choose .seb file…'}
                            </button>
                          )}
                          <p className="text-xs" style={{ color: '#9A9891', lineHeight: 1.5 }}>
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

              {/* Delivery mode */}
              <div className="space-y-1.5">
                <p className="text-xs" style={{ color: '#6B6B66' }}>
                  Delivery mode
                </p>
                <div className="flex" style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', overflow: 'hidden' }}>
                  {([
                    { key: 'standard' as const, label: 'Standard' },
                    { key: 'linear' as const,   label: 'Linear' },
                    { key: 'adaptive' as const, label: 'Adaptive' },
                  ]).map((opt, i) => {
                    const active = deliveryMode === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => setDeliveryMode(opt.key)}
                        className="flex-1 text-xs px-2 py-1.5 transition-colors"
                        style={{
                          background: active ? '#0C0C0B' : 'transparent',
                          color: active ? '#FFFFFF' : '#4A4A45',
                          borderLeft: i === 0 ? 'none' : '1px solid #E3E1DB',
                          cursor: 'pointer',
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs" style={{ color: '#9A9891' }}>
                  {deliveryMode === 'linear'
                    ? 'One question at a time, no going back. (Enforcement lands in a later phase.)'
                    : deliveryMode === 'adaptive'
                      ? 'One at a time; difficulty adapts to performance. (Enforcement lands in a later phase.)'
                      : 'All questions visible; students navigate freely.'}
                </p>
              </div>

              {/* Section start order */}
              <div className="space-y-1.5">
                <p className="text-xs" style={{ color: '#6B6B66' }}>
                  Section order
                </p>
                <div className="flex" style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', overflow: 'hidden' }}>
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
                          background: active ? '#0C0C0B' : 'transparent',
                          color: active ? '#FFFFFF' : '#4A4A45',
                          borderLeft: i === 0 ? 'none' : '1px solid #E3E1DB',
                          cursor: 'pointer',
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs" style={{ color: '#9A9891' }}>
                  {sectionStartOrder === 'random'
                    ? 'Each student gets sections in a different order. Breaks apply by completion count — after the 1st completed section, the 2nd, and so on.'
                    : sectionStartOrder === 'student_choice'
                      ? 'Students choose which section to take next. Breaks apply by completion count — after the 1st completed section, the 2nd, and so on.'
                      : 'Sections are taken in the order shown below.'}
                </p>
              </div>

              <div className="space-y-2">
                <SettingsToggle
                  icon={<Shuffle size={12} strokeWidth={1.5} style={{ color: '#9A9891' }} />}
                  label="Shuffle Questions"
                  hint="Randomise question order for each student"
                  value={shuffleQuestions}
                  onChange={setShuffleQuestions}
                  locked={!mut.shuffleQuestions}
                  lockReason={mut.shuffleQuestions ? undefined : lockReason}
                />
                <AudienceSelector
                  icon={<BarChart2 size={12} strokeWidth={1.5} style={{ color: '#9A9891' }} />}
                  label="Show Results"
                  hint="Who can see scores and outcomes after submission"
                  value={showResultsTo}
                  onChange={setShowResultsTo}
                />
                <AudienceSelector
                  icon={<BookOpen size={12} strokeWidth={1.5} style={{ color: '#9A9891' }} />}
                  label="Allow Review"
                  hint="Who can see the questions and correct answers after submission"
                  value={allowReviewTo}
                  onChange={setAllowReviewTo}
                />
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* ── BOTTOM: Rule Builder (full width) ── */}
      <RuleBuilderPanel
        sections={sections}
        activeSectionIdx={activeSectionIdx}
        setActiveSectionIdx={setActiveSectionIdx}
        setSections={setSections}
        allQuestions={allQuestions}
        locked={!mut.sections}
        subjectPoolNames={subjectPoolNames}
        topicPool={topicPool}
      />

      {/* Bottom bar — rules phase hands off to Step 3 (Allocation). Saving now
          happens there, so this bar only advances the wizard. */}
      <div className="flex items-center justify-end gap-3 px-12 py-5 mt-8"
        style={{ borderTop: '1px solid #E3E1DB', background: '#FAFAF8' }}>
        <button onClick={onContinueToAllocation}
          className="flex items-center gap-1.5 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
          style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, cursor: 'pointer' }}>
          Continue to Allocation <ChevronRight size={12} strokeWidth={2} />
        </button>
      </div>

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

        <div className="flex-shrink-0" style={{ background: '#FAFAF8' }}>
          <div style={{ padding: '20px 48px 24px' }}>

            {/* Back link */}
            <div className="flex items-center gap-2 mb-4">
              <button onClick={onBackToRules}
                className="flex items-center gap-1 text-xs transition-opacity hover:opacity-60"
                style={{ color: '#B0AEA8' }}>
                <X size={11} strokeWidth={1.5} /> Back to Rules &amp; Settings
              </button>
              <span style={{ color: '#DDDBD5', fontSize: 10 }}>·</span>
              <p className="text-xs" style={{ color: '#C4C3BD', letterSpacing: '0.1em' }}>STEP 3 OF 3 — ALLOCATION</p>
            </div>

            <div className="space-y-5" style={{ maxWidth: hierarchyMode ? 920 : 560 }}>
              <div>
                <SectionLabel label="ALLOCATION" />
                <p className="text-xs mt-2" style={{ color: '#9A9891' }}>
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
                    <select value={targetType} readOnly style={{ ...selectStyle, fontSize: 13, padding: '9px 12px' }}>
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

        {/* Save bar — moved verbatim from the rules phase */}
        <div className="flex items-center justify-end gap-3 px-12 py-5 mt-auto"
          style={{ borderTop: '1px solid #E3E1DB', background: '#FAFAF8' }}>
          {(() => {
            // Edit mode on a live or closed assessment: status is locked, single Save Changes.
            const lockedStatus = mode === 'edit' && (originalStatus === 'active' || originalStatus === 'closed');
            if (lockedStatus) {
              return (
                <button onClick={() => handleSave()} disabled={saving}
                  className="flex items-center gap-1.5 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
                  style={{ background: saving ? '#C8C7C2' : '#0C0C0B', color: '#FFFFFF', borderRadius: 2, cursor: saving ? 'not-allowed' : 'pointer' }}>
                  {saving
                    ? <><Loader2 size={11} className="animate-spin" /> Saving…</>
                    : <><CheckCircle2 size={11} /> Save Changes</>}
                </button>
              );
            }
            // Create mode, or edit on a draft: offer Save as Draft + Publish.
            const draftLabel = mode === 'create' ? 'Save as Draft' : 'Save Draft';
            const publishLabel = mode === 'create' ? 'Create & Publish' : 'Save & Publish';
            return (
              <>
                <button onClick={() => handleSave('draft')} disabled={saving}
                  className="flex items-center gap-1.5 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
                  style={{ background: '#FFFFFF', color: '#0C0C0B', border: '1px solid #0C0C0B', borderRadius: 2, cursor: saving ? 'not-allowed' : 'pointer' }}>
                  {saving ? <><Loader2 size={11} className="animate-spin" /> Saving…</> : <>{draftLabel}</>}
                </button>
                <button onClick={() => handleSave('active')} disabled={saving}
                  className="flex items-center gap-1.5 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
                  style={{ background: saving ? '#C8C7C2' : '#0C0C0B', color: '#FFFFFF', borderRadius: 2, cursor: saving ? 'not-allowed' : 'pointer' }}>
                  {saving ? <><Loader2 size={11} className="animate-spin" /> Publishing…</> : <><CheckCircle2 size={11} /> {publishLabel}</>}
                </button>
              </>
            );
          })()}
        </div>
      </motion.div>
      )}

      {/* Validation-error modal (hard-block) */}
      {validationErrors.length > 0 && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center px-6"
          style={{ background: 'rgba(12,12,11,0.45)' }}
          onClick={() => setValidationErrors([])}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3, maxWidth: 520, width: '100%' }}>
            <div className="px-6 py-5" style={{ borderBottom: '1px solid #E3E1DB' }}>
              <div className="flex items-center gap-2">
                <AlertCircle size={14} strokeWidth={1.5} style={{ color: '#9B2828' }} />
                <span className="text-xs" style={{ color: '#0C0C0B', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Fix the following before saving
                </span>
              </div>
            </div>
            <ul className="px-6 py-4 space-y-2.5">
              {validationErrors.map((err, i) => (
                <li key={i} className="flex items-start gap-2 text-xs" style={{ color: '#0C0C0B', lineHeight: 1.55 }}>
                  <span style={{ color: '#9B2828', flexShrink: 0, marginTop: 1 }}>•</span>
                  <span>{err}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end gap-2 px-6 py-4"
              style={{ borderTop: '1px solid #E3E1DB', background: '#FAFAF8' }}>
              <button onClick={() => setValidationErrors([])}
                className="text-xs px-4 py-2 transition-opacity hover:opacity-80"
                style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, cursor: 'pointer' }}>
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
            style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3, maxWidth: 520, width: '100%' }}>
            <div className="px-6 py-5" style={{ borderBottom: '1px solid #E3E1DB' }}>
              <div className="flex items-center gap-2">
                <AlertTriangle size={14} strokeWidth={1.5} style={{ color: '#B5651D' }} />
                <span className="text-xs" style={{ color: '#0C0C0B', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Confirm publish
                </span>
              </div>
              <p className="text-xs mt-2" style={{ color: '#6B6B66', lineHeight: 1.6 }}>
                Before publishing, please review the following:
              </p>
            </div>
            <ul className="px-6 py-4 space-y-2.5">
              {pendingPublish.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2 text-xs" style={{ color: '#0C0C0B', lineHeight: 1.55 }}>
                  <span style={{ color: '#B5651D', flexShrink: 0, marginTop: 1 }}>•</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end gap-2 px-6 py-4"
              style={{ borderTop: '1px solid #E3E1DB', background: '#FAFAF8' }}>
              <button onClick={() => setPendingPublish(null)}
                className="text-xs px-4 py-2 transition-opacity hover:opacity-80"
                style={{ background: '#FFFFFF', color: '#0C0C0B', border: '1px solid #C8C7C2', borderRadius: 2, cursor: 'pointer' }}>
                Go back
              </button>
              <button onClick={() => { setPendingPublish(null); handleSave('active', true); }} disabled={saving}
                className="flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity hover:opacity-80"
                style={{ background: saving ? '#C8C7C2' : '#0C0C0B', color: '#FFFFFF', borderRadius: 2, cursor: saving ? 'not-allowed' : 'pointer' }}>
                {saving ? <><Loader2 size={11} className="animate-spin" /> Publishing…</> : <><CheckCircle2 size={11} /> Publish anyway</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}