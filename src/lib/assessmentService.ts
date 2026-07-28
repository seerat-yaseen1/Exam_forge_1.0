import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  getDocs,
  query,
  where,
  arrayUnion,
  arrayRemove,
  deleteField,
  deleteDoc,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions, auth, storage } from './firebase';
import {
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from 'firebase/storage';

// ══════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ══════════════════════════════════════════════════════════════════

function removeUndefined<T extends Record<string, any>>(obj: T): T {
  const out: any = {};
  for (const key in obj) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out as T;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function now(): string {
  return new Date().toISOString();
}

// ══════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ══════════════════════════════════════════════════════════════════

export type AssessmentStatus = 'draft' | 'active' | 'closed';

export type AssessmentOwnerType = 'webOwner' | 'institute' | 'faculty';

// ── Question reference for assessments ───────────────────────────
// Each question in an assessment has a point value and optional config

// ── Grading policy (negative marking + blank handling) ────────────
// A grading policy controls how a WRONG or BLANK answer scores, on top of the
// existing correct/partial award. It exists at up to three levels that form an
// inheritance chain, gated at the top:
//
//   exam master  →  section override  →  difficulty-row override
//
// Resolution per question: the row policy wins if present, else the section's,
// else the exam's. The exam master switch is a HARD GATE — when negative
// marking is OFF at the exam level, NO section or row can apply a penalty
// (resolution short-circuits to "no penalty"). blankScore is always honoured
// (default 0). Applies to Standard + Linear delivery only.
//
// Frozen onto the attempt at start (like securityConfig), so editing the exam
// mid-flight cannot change how an in-progress student is graded.

export type PenaltyType = 'fixed' | 'percent';  // fixed marks | percent of the question's marks

// The rule a single level expresses. A level with negativeMarking:false (or
// absent) contributes no penalty; blankScore defaults to 0 when absent.
export type GradingPolicy = {
  negativeMarking?: boolean;     // this level penalises wrong answers
  penaltyType?: PenaltyType;     // how the penalty magnitude is interpreted
  penaltyValue?: number;         // POSITIVE magnitude to deduct (teacher never types a minus)
  blankScore?: number;           // marks for an unanswered question (default 0)
};

// Per-section policy: an optional section-level override plus optional
// per-difficulty-row overrides. Any absent level inherits the one above.
export type SectionGradingPolicy = {
  section?: GradingPolicy;                                  // section-level override
  byDifficulty?: Partial<Record<'easy' | 'medium' | 'hard', GradingPolicy>>;
};

// The whole exam's grading configuration. exam is the master (and the gate);
// sections is keyed by section id.
export type AssessmentGradingConfig = {
  exam?: GradingPolicy;                          // master default + hard gate
  sections?: Record<string, SectionGradingPolicy>;
};

// The single resolved policy that actually applies to one question. Produced
// by resolveGradingPolicy; this is what the scorer and the frozen attempt use.
export type ResolvedGradingPolicy = {
  negativeMarking: boolean;
  penaltyType: PenaltyType;
  penaltyValue: number;   // positive magnitude; 0 when negativeMarking is false
  blankScore: number;     // default 0
};

export const NO_PENALTY_POLICY: ResolvedGradingPolicy = {
  negativeMarking: false,
  penaltyType: 'fixed',
  penaltyValue: 0,
  blankScore: 0,
};

// Resolve the effective policy for one question given its difficulty.
// Chain: row → section → exam, first defined wins per FIELD, with the exam
// master switch as a hard gate. Keep in sync with the server twin in
// functions/src/index.ts.
export function resolveGradingPolicy(
  config: AssessmentGradingConfig | undefined,
  sectionId: string,
  difficulty: 'easy' | 'medium' | 'hard',
): ResolvedGradingPolicy {
  const exam = config?.exam;
  // HARD GATE: master off (or unset) → no penalty anywhere. blankScore still
  // resolves (a teacher may set blank handling even with penalties off), but
  // negativeMarking can never be switched back on below the exam level.
  const gateOpen = exam?.negativeMarking === true;

  const sectionPol = config?.sections?.[sectionId];
  const rowPol = sectionPol?.byDifficulty?.[difficulty];

  // First-defined-wins per field, tightest level first.
  const pick = <K extends keyof GradingPolicy>(k: K): GradingPolicy[K] | undefined =>
    rowPol?.[k] ?? sectionPol?.section?.[k] ?? exam?.[k];

  const blankScore = pick('blankScore') ?? 0;

  if (!gateOpen) {
    return { negativeMarking: false, penaltyType: 'fixed', penaltyValue: 0, blankScore };
  }

  // Gate open: a level may still opt OUT of negative marking for its scope by
  // setting negativeMarking:false at the row/section. Resolve that flag the
  // same first-defined-wins way.
  const negOn = pick('negativeMarking') ?? true;   // gate open + no explicit flag below → on
  if (!negOn) {
    return { negativeMarking: false, penaltyType: 'fixed', penaltyValue: 0, blankScore };
  }

  return {
    negativeMarking: true,
    penaltyType: pick('penaltyType') ?? 'fixed',
    penaltyValue: Math.max(0, pick('penaltyValue') ?? 0),
    blankScore,
  };
}

export type AssessmentQuestion = {
  questionId: string;
  marks: number;           // points awarded for this question
  order: number;           // display order in the test
};

// ── Assessment section ────────────────────────────────────────────
// An assessment can have multiple ordered sections.
// Each section has its own time limit and question list.

export type QuestionSelectionRule = {
  subject: string;
  topic: string;       // specific topic within the subject
  difficulty: 'easy' | 'medium' | 'hard';
  count: number;
  marksPerQuestion: number;
};

export type SectionBreak = {
  durationMinutes: number;  // length of the break
  mandatory: boolean;       // true = student must wait full duration; false = may skip
};

export type AssessmentSection = {
  id: string;
  name: string;            // e.g., "Section A", "Reading Comprehension"
  timeLimit?: number;      // minutes for this section; undefined = no per-section limit
  rules: QuestionSelectionRule[];  // spec: what to randomly draw at publish time
  questions: AssessmentQuestion[]; // resolved at publish time (status → active)
  assignedTopics?: string[];       // "subject::topic" keys pre-assigned in Step 1
  breakAfter?: SectionBreak;       // optional break inserted before the next section

  // ── Reserved (Phase 0) — not yet enforced ─────────────────────────
  // Later flexibility: min/max time per section. maxTimeMinutes mirrors the
  // existing timeLimit as the hard cap; minTimeMinutes would prevent leaving
  // a section before it elapses. questionTimeLimit is for linear/adaptive
  // per-question timing (Phase 2.5). Declared now so adding the behavior
  // later needs no attempt/assessment migration.
  minTimeMinutes?: number;         // minutes; student may not leave before this elapses
  maxTimeMinutes?: number;         // minutes; hard cap (kept alongside timeLimit for clarity)
  questionTimeLimit?: number;      // seconds per question; undefined = no per-question cap
};

// ── Resolution helpers ────────────────────────────────────────────
// resolveQuestionsForSections: randomly picks questions per rule,
// deduplicating across sections (section order = priority).
// Pass in all available (non-deleted) questions from the bank.

type BankQuestion = {
  id: string;
  subject: string;
  topic: string;       // needed for topic-level filtering
  difficulty: string;
  isDeleted: boolean;
  // Slug links to the taxonomy docs. PREFERRED over the name strings above:
  // renaming a subject/topic updates the doc but NOT the name stored on old
  // questions, so name-only matching silently drops renamed questions from
  // selection. When taxonomy maps are supplied, we resolve these IDs to the
  // CURRENT canonical name so a rename can never orphan a question.
  subjectId?: string;
  topicId?: string;
};

// ── Taxonomy canonicalisation (rename-proof matching) ─────────────
// The assessment builder matches questions to selection rules by subject +
// topic NAME. That breaks after a rename: the rule and the picker show the
// new name, but old questions still carry the old name (renameSubject keeps
// the old name only as an alias, which the assessment path never consults).
//
// Fix: resolve every question's stored subjectId/topicId to the CURRENT name
// via these maps before matching, so both sides speak the same, always-current
// name. Falls back to the stored name when a question has no ID (legacy docs)
// or no map is supplied — so behaviour is unchanged when maps are absent, and
// nothing regresses for questions that predate the slug system.
export type TaxonomyMaps = {
  subjectNameById: Record<string, string>;  // subjectId → current Subject.name
  topicNameById: Record<string, string>;    // topicId   → current Topic.name
};

function canonicalSubject(q: BankQuestion, maps?: TaxonomyMaps): string {
  if (maps && q.subjectId && maps.subjectNameById[q.subjectId]) {
    return maps.subjectNameById[q.subjectId];
  }
  return q.subject;
}

function canonicalTopic(q: BankQuestion, maps?: TaxonomyMaps): string {
  if (maps && q.topicId && maps.topicNameById[q.topicId]) {
    return maps.topicNameById[q.topicId];
  }
  return q.topic;
}

export function resolveQuestionsForSections(
  sections: AssessmentSection[],
  allQuestions: BankQuestion[],
  taxonomy?: TaxonomyMaps
): { sections: AssessmentSection[]; flatQuestions: AssessmentQuestion[] } {
  const usedIds = new Set<string>();
  let globalOrder = 0;

  const resolvedSections: AssessmentSection[] = sections.map((section) => {
    const sectionQuestions: AssessmentQuestion[] = [];

    for (const rule of section.rules) {
      if (rule.count <= 0) continue;

      // Build pool: matching subject + topic + difficulty, not deleted, not yet
      // used. Subject/topic are compared against each question's CURRENT
      // canonical name (resolved from its slug ID when taxonomy maps are given),
      // so a renamed subject/topic still matches its old questions.
      const pool = allQuestions.filter(
        (q) =>
          !q.isDeleted &&
          canonicalSubject(q, taxonomy) === rule.subject &&
          canonicalTopic(q, taxonomy) === rule.topic &&
          q.difficulty === rule.difficulty &&
          !usedIds.has(q.id)
      );

      // Fisher-Yates shuffle for true randomness
      const shuffled = [...pool];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      const picked = shuffled.slice(0, rule.count);
      picked.forEach((q) => {
        usedIds.add(q.id);
        sectionQuestions.push({
          questionId: q.id,
          marks: rule.marksPerQuestion,
          order: globalOrder++,
        });
      });
    }

    return { ...section, questions: sectionQuestions };
  });

  const flatQuestions = resolvedSections.flatMap((s) => s.questions);
  return { sections: resolvedSections, flatQuestions };
}

// validateSelectionRules: checks each rule has enough questions available.
// Returns per-rule validation and an overall validity flag.

export type RuleValidationResult = {
  subject: string;
  topic: string;
  difficulty: string;
  sectionName: string;
  requested: number;
  available: number;   // after prior sections' usage
  ok: boolean;
};

export function validateSelectionRules(
  sections: AssessmentSection[],
  allQuestions: BankQuestion[],
  taxonomy?: TaxonomyMaps
): { valid: boolean; results: RuleValidationResult[] } {
  const usedCounts: Record<string, number> = {};
  const results: RuleValidationResult[] = [];

  const key = (subject: string, topic: string, diff: string) =>
    `${subject}::${topic}::${diff}`;

  // Pre-compute total available per subject+topic+difficulty, keyed by the
  // CURRENT canonical name (same resolution the pool uses), so the count a
  // rule sees matches what resolveQuestionsForSections will actually draw.
  const totalAvailable: Record<string, number> = {};
  for (const q of allQuestions) {
    if (q.isDeleted) continue;
    const k = key(canonicalSubject(q, taxonomy), canonicalTopic(q, taxonomy), q.difficulty);
    totalAvailable[k] = (totalAvailable[k] ?? 0) + 1;
  }

  for (const section of sections) {
    for (const rule of section.rules) {
      if (rule.count <= 0) continue;
      const k = key(rule.subject, rule.topic, rule.difficulty);
      const total = totalAvailable[k] ?? 0;
      const alreadyUsed = usedCounts[k] ?? 0;
      const effectiveAvailable = total - alreadyUsed;
      const ok = rule.count <= effectiveAvailable;
      results.push({
        subject: rule.subject,
        topic: rule.topic,
        difficulty: rule.difficulty,
        sectionName: section.name,
        requested: rule.count,
        available: effectiveAvailable,
        ok,
      });
      if (ok) {
        usedCounts[k] = alreadyUsed + rule.count;
      }
    }
  }

  return { valid: results.every((r) => r.ok), results };
}

// ── Assignment targeting ──────────────────────────────────────────
// Who should receive this assessment?
// - 'all' → all students across all institutes
// - 'institutes' → students in specific institutes
// - 'students'  specific individual students

export type AssignmentTarget =
  | { type: 'all' }
  | { type: 'institutes'; instituteIds: string[] }
  | { type: 'students'; studentIds: string[] };

// ── Assessment document ───────────────────────────────────────────

export type Assessment = {
  id: string;

  // Ownership
  ownerType: AssessmentOwnerType;  // 'webOwner', 'institute', 'faculty'
  ownerId: string;                 // 'webOwner', instituteId, or facultyId

  // Metadata
  title: string;
  description: string;
  subject: string;
  tags: string[];

  // Questions — frozen snapshot of question IDs + config at creation time
  questions: AssessmentQuestion[];

  // Sections — ordered groups of questions, each with optional per-section time limit
  // Introduced in Phase 7. Undefined for assessments created before sections were added.
  sections?: AssessmentSection[];

  // Topic/subject pool — sourced in Step 1 Phases 1 & 2
  // subjectPool: stable Subject document IDs selected in Phase 1
  // topicPool:   "subjectName::topicName" compound keys selected in Phase 2
  subjectPool?: string[];
  topicPool?: string[];

  // Targeting
  assignedTo: AssignmentTarget;

  // Timing
  startDate?: string;   // ISO 8601; undefined = starts immediately
  endDate?: string;     // ISO 8601; undefined = no end date
  timeLimit?: number;   // minutes; undefined = unlimited

  // Grading
  totalMarks: number;   // calculated sum of all question marks
  passingScore?: number; // percentage (0-100); undefined = no pass threshold

  // Settings
  shuffleQuestions: boolean;
  showResults: boolean;         // legacy boolean — students entry of showResultsTo (kept in sync)
  allowReview: boolean;         // legacy boolean — students entry of allowReviewTo (kept in sync)
  // N5 final form (2026-07-17) — audience-scoped visibility. Optional: when
  // absent (legacy docs) the booleans above govern; see lib/visibility.ts
  // for exact legacy semantics (server mirror: reviewAudienceAllows in
  // functions/src/index.ts).
  showResultsTo?: Array<'students' | 'institute' | 'faculty'>;
  allowReviewTo?: Array<'students' | 'institute' | 'faculty'>;

  // Section play order — 'sequential' (default) keeps the order set in the
  // builder; 'random' shuffles per student at startAttempt; 'student_choice'
  // (phase 2) lets the student pick the next section themselves.
  sectionStartOrder?: 'sequential' | 'random' | 'student_choice';

  // Status
  status: AssessmentStatus;

  // Block list — students prevented from entering/re-entering the exam
  // Checked as a gate in ExamBriefingPage; does not affect existing attempts
  blockedStudents?: string[];   // array of studentIds

  // Phase C — when 'rules', targeting comes from the materialized
  // assessmentMembers list, not assignedTo. undefined = legacy path.
  allocationMode?: 'rules';

  // Denormalized head-count for rule-allocated exams, written by
  // resolveAllocation / addManualMember. DISPLAY ONLY — never an
  // authorization input (the gate is the assessmentMembers list).
  //
  // It exists because `allocations` and `assessmentMembers` are webOwner-only
  // in firestore.rules, so institute/faculty staff cannot read the real list.
  // This is the one allocation number they CAN see, and it rides along on the
  // assessment doc they already fetch — no extra read, no rules change.
  allocatedCount?: number;

  // Attempt limits
  // maxAttempts: undefined = unlimited; integer = max finished attempts allowed
  // attemptOverrides: per-student override of maxAttempts
  maxAttempts?: number;
  attemptOverrides?: Record<string, number>;

  // Section grace period — extra seconds allowed past each section's timer
  // before the server rejects a late submit. undefined = default (30 s).
  // Enforced server-side in the submitSection Cloud Function.
  sectionGraceSeconds?: number;

  // ── Security tier (Phase 0) ───────────────────────────────────────
  // Editable freely UNTIL the first attempt starts; frozen thereafter
  // (see securityLockedAt). undefined tier = legacy → startExam treats it
  // exactly as today (no camera / no extension gate).
  securityTier?: 'mock' | 'normal' | 'high_stake';
  deliveryMode?: 'standard' | 'linear' | 'adaptive';   // undefined = 'standard'

  // Authority-controlled toggles. Tier-aware defaults set at create via
  // applyTierDefaults(). Effective values are re-derived server-side in
  // startExam — never trusted raw from the client.
  autoResume?: boolean;              // normal: auto-clear extension freeze when re-check passes
  allowMobile?: boolean;             // normal only; high_stake is always desktop-only
  requireCamera?: boolean;           // mock: off, normal: on, high_stake: locked on
  requireExtensionCheck?: boolean;   // normal/high_stake pre-exam hard block

  // ── Phase 3: Safe Exam Browser ─────────────────────────────────
  // requireSEB: authority toggle. Default ON for high_stake (disable-able),
  // OFF elsewhere. When true, every exam callable verifies that the request
  // carries a valid SEB Config Key hash — the only control that reaches
  // VPNs, remote-desktop and userscript managers.
  requireSEB?: boolean;
  // sebConfigKeys: OPTIONAL per-assessment override of the platform-wide
  // Config Keys. Normally undefined → the platform keys apply. Designed in
  // now so a per-exam config is a config change, not a migration.
  // An ARRAY because key rotation needs an overlap window (old + new valid).
  sebConfigKeys?: string[];
  // sebConfigFileUrl: OPTIONAL link to the .seb configuration file for this
  // exam (Stage 3). Shown to students on the briefing gate and on SEB_REQUIRED
  // error screens. When absent, the UI tells the student to use the .seb file
  // distributed by their institute. Builder UI for this field is Stage 4;
  // until then the webOwner can set it directly on the assessment document.
  // NOTE: the .seb file is student-facing BY DESIGN (they need it to sit the
  // exam) — secrecy comes from distributing it close to exam time and
  // rotating the config between sittings, not from hiding the link.
  sebConfigFileUrl?: string;

  // Overall exam time limit (minutes) — runs ALONGSIDE per-section timeLimit;
  // whichever expires first ends the exam. undefined = no overall cap.
  // Enforced server-side in submitSection (hard cut on the whole attempt).
  // Anchored on attempt.startedAt (the wall-clock start of the sitting), so
  // time spent in breaks and idle gaps between sections counts against it.
  overallTimeLimit?: number;

  // Grace window (seconds) on the OVERALL clock — its own knob, independent of
  // sectionGraceSeconds. Absorbs network lag / the final submit click so a
  // slow connection at the buzzer is not penalised. undefined = 30s default.
  overallGraceSeconds?: number;

  // Grade a wrong/blank answer per the negative-marking policy. Absent =
  // no negative marking anywhere (identical to legacy scoring). Resolved
  // per question (exam → section → difficulty-row) and frozen onto the
  // attempt at start. Standard + Linear delivery only.
  gradingConfig?: AssessmentGradingConfig;

  // Set by startExam on the FIRST attempt. Presence = security config frozen.
  // Written only by the Cloud Function (Admin SDK); clients cannot set it
  // (firestore.rules forbids editing security fields once this is present).
  securityLockedAt?: string;         // ISO

  // System
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
};

// ── Draft (for create/update) ─────────────────────────────────────

export type AssessmentDraft = Omit<
  Assessment,
  'id' | 'totalMarks' | 'isDeleted' | 'createdAt' | 'updatedAt'
>;

// ══════════════════════════════════════════════════════════════════
// CRUD OPERATIONS
// ══════════════════════════════════════════════════════════════════

// ── Create assessment ─────────────────────────────────────────────

// ── Tier-aware security defaults (Phase 0) ────────────────────────
// Call when the author picks/changes a tier in the builder, then merge the
// returned fields onto the draft before createAssessment. High-stake LOCKS
// camera/mobile/extension-check regardless of overrides (the tier sets a
// floor; the authority may only tune above it). deliveryMode is chosen
// separately and defaults to 'standard'.
export function applyTierDefaults(
  tier: 'mock' | 'normal' | 'high_stake',
  overrides?: {
    requireCamera?: boolean;
    allowMobile?: boolean;
    autoResume?: boolean;
    requireExtensionCheck?: boolean;
    requireSEB?: boolean;
  },
): {
  securityTier: 'mock' | 'normal' | 'high_stake';
  requireCamera: boolean;
  allowMobile: boolean;
  autoResume: boolean;
  requireExtensionCheck: boolean;
  requireSEB: boolean;
} {
  if (tier === 'mock') {
    return {
      securityTier: 'mock',
      requireCamera: overrides?.requireCamera ?? false,        // default OFF
      allowMobile: overrides?.allowMobile ?? true,             // phones welcome
      autoResume: overrides?.autoResume ?? true,
      requireExtensionCheck: overrides?.requireExtensionCheck ?? false,
      requireSEB: false,                                       // never for practice
    };
  }
  if (tier === 'high_stake') {
    return {
      securityTier: 'high_stake',
      requireCamera: true,           // LOCKED on
      allowMobile: false,            // LOCKED desktop-only
      autoResume: overrides?.autoResume ?? false,
      requireExtensionCheck: true,   // LOCKED on
      // Phase 3: SEB is the only real lockdown for high-stake. Default ON,
      // but (per authority decision) it may be disabled — unlike camera /
      // mobile / extension, which are locked. Deliberate: a school without
      // SEB rollout can still run high-stake with the web-tier deterrents.
      requireSEB: overrides?.requireSEB ?? true,
    };
  }
  // normal
  return {
    securityTier: 'normal',
    requireCamera: overrides?.requireCamera ?? true,           // default ON
    allowMobile: overrides?.allowMobile ?? false,              // default OFF (D-B)
    autoResume: overrides?.autoResume ?? false,
    requireExtensionCheck: overrides?.requireExtensionCheck ?? true,
    requireSEB: overrides?.requireSEB ?? false,                // opt-in only
  };
}

export async function createAssessment(
  draft: AssessmentDraft
): Promise<Assessment> {
  const id = newId('assess');

  // Calculate total marks from questions
  const totalMarks = draft.questions.reduce((sum, q) => sum + q.marks, 0);

  const assessment: Assessment = {
    ...draft,
    id,
    totalMarks,
    isDeleted: false,
    createdAt: now(),
    updatedAt: now(),
    // Freeze the security config AT PUBLISH (audit P-01). See
    // stampIfPublishing below for why this moved off the first-attempt path.
    ...(draft.status === 'active' && !draft.securityLockedAt
      ? { securityLockedAt: now() }
      : {}),
  };

  await setDoc(doc(db, 'assessments', id), removeUndefined(assessment));
  return assessment;
}

// ── Get single assessment ─────────────────────────────────────────

export async function getAssessment(id: string): Promise<Assessment | null> {
  const snap = await getDoc(doc(db, 'assessments', id));
  if (!snap.exists()) return null;
  return snap.data() as Assessment;
}

// ── Get all assessments (Web Owner) ───────────────────────────────

export async function getAllAssessments(): Promise<Assessment[]> {
  const snap = await getDocs(collection(db, 'assessments'));
  return snap.docs
    .map((d) => d.data() as Assessment)
    .filter((a) => !a.isDeleted);
}

// ── Get assessments by owner ──────────────────────────────────────

export async function getAssessmentsByOwner(
  ownerType: AssessmentOwnerType,
  ownerId: string
): Promise<Assessment[]> {
  const q = query(
    collection(db, 'assessments'),
    where('ownerType', '==', ownerType),
    where('ownerId', '==', ownerId),
    where('isDeleted', '==', false)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as Assessment);
}

// ── Get assessments visible to an institute admin ─────────────────
// Replaces getAllAssessments() on the institute dashboard, which was an
// unfiltered collection scan the security rules (correctly) reject for
// non-webOwner roles. Every query below carries exactly the filters the
// assessments read rule needs to prove access:
//   1. assessments the institute OWNS (any status, incl. drafts)
//   2. published assessments assigned to ALL institutes
//   3. published assessments whose assignedTo.instituteIds contains us
// Results are deduplicated by id.

export async function getAssessmentsVisibleToInstitute(
  instituteId: string
): Promise<Assessment[]> {
  const col = collection(db, 'assessments');
  const publishedStatuses: AssessmentStatus[] = ['active', 'closed'];

  const queries = [
    // 1. Own assessments (drafts included — owner may always read own docs)
    query(col,
      where('ownerType', '==', 'institute'),
      where('ownerId', '==', instituteId),
      where('isDeleted', '==', false)),
    // 2 & 3. Assigned published assessments, one query per status value so
    // the rule clause `status in ['active','closed']` is provable.
    ...publishedStatuses.map((s) =>
      query(col,
        where('assignedTo.type', '==', 'all'),
        where('status', '==', s),
        where('isDeleted', '==', false))),
    ...publishedStatuses.map((s) =>
      query(col,
        where('assignedTo.instituteIds', 'array-contains', instituteId),
        where('status', '==', s),
        where('isDeleted', '==', false))),
  ];

  const snaps = await Promise.all(queries.map((q) => getDocs(q)));
  const byId = new Map<string, Assessment>();
  for (const snap of snaps) {
    for (const d of snap.docs) {
      const a = d.data() as Assessment;
      byId.set(a.id, a);
    }
  }
  return [...byId.values()];
}

// ── Update assessment ─────────────────────────────────────────────

/**
 * Freeze the security config the moment an assessment goes live.
 *
 * Audit P-01, and a security decision as much as a scale one.
 *
 * SECURITY: previously the freeze happened when the FIRST STUDENT STARTED, so
 * between publishing and that first start there was a window where staff could
 * downgrade securityTier, deliveryMode, requireCamera, allowMobile,
 * requireExtensionCheck or autoResume — after students had already seen the
 * briefing describing the requirements they'd face. Publishing is the honest
 * moment to lock: it is when the exam becomes real to students. Once live, the
 * security posture is what was advertised, and nobody can quietly soften it.
 *
 * SCALE: it also removes the only shared-document write from the exam hot
 * path. The old lazy stamp lived inside startExam, so at a 10,000-student
 * opening every invocation that read the doc before the first write propagated
 * ALSO wrote — hundreds to thousands of writes onto one document, against
 * Firestore's ~1-write-per-second-per-document limit. Worse, that write was
 * not wrapped, so a contention failure threw and blocked that student from
 * starting at all. Stamping here means the hot path writes nothing shared.
 *
 * NOT reversible by design. There is deliberately no unlock: an escape hatch
 * from a security freeze is the thing the freeze exists to prevent. If a
 * published exam has the wrong security settings, duplicate it — duplication
 * already resets status to draft and clears this stamp — and publish the copy.
 *
 * Enforced in firestore.rules too, not just here. A client-side stamp alone
 * would be a convention; the rule makes publishing without it impossible.
 */
function stampIfPublishing<T extends { status?: AssessmentStatus; securityLockedAt?: string }>(
  patch: T,
  currentStatus?: AssessmentStatus,
): T {
  const goingLive = patch.status === 'active' && currentStatus !== 'active';
  if (!goingLive || patch.securityLockedAt) return patch;
  return { ...patch, securityLockedAt: now() };
}

export async function updateAssessment(
  id: string,
  draft: Partial<AssessmentDraft>
): Promise<void> {
  const updates: any = { ...draft, updatedAt: now() };

  // Recalculate total marks if questions changed
  if (draft.questions) {
    updates.totalMarks = draft.questions.reduce((sum, q) => sum + q.marks, 0);
  }

  // Read-before-write ONLY on the publish transition, so an ordinary edit to a
  // live exam costs nothing extra. Publishing happens once per assessment, by
  // one member of staff — there is no contention here to worry about.
  if (draft.status === 'active') {
    const existing = await getDoc(doc(db, 'assessments', id));
    const currentStatus = existing.exists()
      ? (existing.data() as Assessment).status
      : undefined;
    const alreadyStamped = existing.exists()
      ? Boolean((existing.data() as Assessment).securityLockedAt)
      : false;
    if (!alreadyStamped) {
      Object.assign(updates, stampIfPublishing({ status: 'active' as const }, currentStatus));
    }
  }

  await updateDoc(doc(db, 'assessments', id), removeUndefined(updates));
}

// ── Narrow patch helpers (focused edit panels) ────────────────────
// Each helper writes only the fields its panel owns. Pages should prefer
// these over updateAssessment() so saves don't accidentally overwrite
// unrelated fields.

export type DetailsPatch = Partial<Pick<Assessment, 'title' | 'description' | 'subject' | 'tags'>>;
export async function updateAssessmentDetails(id: string, patch: DetailsPatch): Promise<void> {
  await updateDoc(doc(db, 'assessments', id), removeUndefined({ ...patch, updatedAt: now() }));
}

export type SchedulePatch = Partial<Pick<Assessment, 'startDate' | 'endDate' | 'maxAttempts' | 'attemptOverrides' | 'sectionGraceSeconds'>>;
export async function updateAssessmentSchedule(id: string, patch: SchedulePatch): Promise<void> {
  await updateDoc(doc(db, 'assessments', id), removeUndefined({ ...patch, updatedAt: now() }));
}

export type AccessPatch = Partial<Pick<Assessment, 'assignedTo' | 'blockedStudents'>>;
export async function updateAssessmentAccess(id: string, patch: AccessPatch): Promise<void> {
  await updateDoc(doc(db, 'assessments', id), removeUndefined({ ...patch, updatedAt: now() }));
}

export type BehaviourPatch = Partial<Pick<Assessment,
  'shuffleQuestions' | 'passingScore' | 'showResults' | 'allowReview'
  | 'showResultsTo' | 'allowReviewTo' | 'sectionStartOrder'
  | 'overallTimeLimit' | 'overallGraceSeconds'
>>;
export async function updateAssessmentBehaviour(id: string, patch: BehaviourPatch): Promise<void> {
  await updateDoc(doc(db, 'assessments', id), removeUndefined({ ...patch, updatedAt: now() }));
}

// ── Duplicate an assessment ───────────────────────────────────────
// Creates a NEW draft assessment from an existing one. The author chooses
// what to carry over. Nothing student-specific is ever copied: attempts,
// responses, results, reports and activity logs live in other collections
// (attempts / questionReports / …) and are keyed by assessmentId, so a new
// assessmentId simply has none of them.
//
// Fields that are ALWAYS reset (never copied), because carrying them over
// would be wrong or unsafe:
//   • id / createdAt / updatedAt / totalMarks — regenerated by createAssessment
//   • status            → always 'draft' (a copy is never born published)
//   • securityLockedAt  → cleared; otherwise the fresh draft would be frozen
//                         by the Phase 0 rule and could never be edited
//   • blockedStudents   → per-student moderation state from the old run
//   • attemptOverrides  → per-student attempt grants from the old run
//   • isDeleted         → false

export type DuplicateOptions = {
  includeSections: boolean;    // section structure (names, marks, timers, breaks)
  includeQuestions: boolean;   // the questions inside those sections (needs sections)
  includeSettings: boolean;    // timing, attempts, shuffle, review, results
  includeScheduling: boolean;  // startDate / endDate window
  includeSecurity: boolean;    // tier, delivery mode, camera/mobile/extension
  includeAllocations: boolean; // assignedTo targeting, or hierarchy re-resolution
};

/** What duplicateAssessment did about targeting — surfaced to the user. */
export type DuplicateAllocationOutcome =
  | { kind: 'legacy' }              // assignedTo copied (or intentionally cleared)
  | { kind: 'rules_recreated'; count: number }   // hierarchy re-resolved onto the copy
  | { kind: 'rules_failed'; reason: string };    // hierarchy could NOT be carried

export async function duplicateAssessment(
  sourceId: string,
  options: DuplicateOptions,
  titleOverride?: string,
): Promise<{ assessment: Assessment; allocation: DuplicateAllocationOutcome }> {
  const src = await getAssessment(sourceId);
  if (!src) throw new Error('Assessment not found.');

  const wantQuestions = options.includeSections && options.includeQuestions;

  // Sections: keep structure; strip the question list when questions aren't copied.
  const sections: AssessmentSection[] | undefined = options.includeSections
    ? (src.sections ?? []).map((s) => ({
        ...s,
        questions: wantQuestions ? [...s.questions] : [],
      }))
    : undefined;

  // Security: copy, or fall back to the safe 'normal' tier defaults.
  const security = options.includeSecurity
    ? {
        securityTier: src.securityTier,
        deliveryMode: src.deliveryMode,
        autoResume: src.autoResume,
        allowMobile: src.allowMobile,
        requireCamera: src.requireCamera,
        requireExtensionCheck: src.requireExtensionCheck,
        // Phase 3 — a duplicated high-stake exam must not silently lose its
        // SEB requirement. Copied with the rest of the security contract.
        requireSEB: src.requireSEB,
        sebConfigKeys: src.sebConfigKeys,
        sebConfigFileUrl: src.sebConfigFileUrl,
      }
    : { ...applyTierDefaults('normal'), deliveryMode: 'standard' as const };

  const draft: AssessmentDraft = {
    ownerType: src.ownerType,
    ownerId: src.ownerId,
    title: titleOverride?.trim() || `${src.title} (Copy)`,
    description: src.description,
    subject: src.subject,
    tags: [...(src.tags ?? [])],

    questions: wantQuestions ? [...src.questions] : [],
    sections,
    subjectPool: wantQuestions ? src.subjectPool : undefined,
    topicPool:   wantQuestions ? src.topicPool   : undefined,

    // Rule-allocated sources carry a meaningless assignedTo (see the note on
    // describeAssignment). Copying it would stamp the duplicate with an empty
    // legacy target that LOOKS authoritative. The hierarchy is re-resolved
    // after creation instead — see the allocation block below.
    assignedTo: options.includeAllocations && !isRuleAllocated(src)
      ? src.assignedTo
      : { type: 'students', studentIds: [] },

    startDate: options.includeScheduling ? src.startDate : undefined,
    endDate:   options.includeScheduling ? src.endDate   : undefined,

    // Settings (these three are required on Assessment, so always supplied)
    shuffleQuestions:    options.includeSettings ? src.shuffleQuestions : false,
    showResults:         options.includeSettings ? src.showResults      : false,
    allowReview:         options.includeSettings ? src.allowReview      : false,
    showResultsTo:       options.includeSettings ? src.showResultsTo    : undefined,
    allowReviewTo:       options.includeSettings ? src.allowReviewTo    : undefined,
    timeLimit:           options.includeSettings ? src.timeLimit           : undefined,
    overallTimeLimit:    options.includeSettings ? src.overallTimeLimit    : undefined,
    overallGraceSeconds: options.includeSettings ? src.overallGraceSeconds : undefined,
    gradingConfig:       options.includeSettings ? src.gradingConfig       : undefined,
    passingScore:        options.includeSettings ? src.passingScore        : undefined,
    maxAttempts:         options.includeSettings ? src.maxAttempts         : 1,
    sectionStartOrder:   options.includeSettings ? src.sectionStartOrder   : undefined,
    sectionGraceSeconds: options.includeSettings ? src.sectionGraceSeconds : undefined,

    ...security,

    // Always reset — see note above.
    status: 'draft',
    securityLockedAt: undefined,
    blockedStudents: undefined,
    attemptOverrides: undefined,
  };

  const created = await createAssessment(draft);

  // Phase 3 Stage 4: per-exam SEB keys live in a side collection (webOwner
  // only), so the field copy above cannot carry them — copy the doc when
  // settings are copied. Best-effort: a duplicated exam without its override
  // simply falls back to the platform keys.
  if (options.includeSettings) {
    try {
      const srcKeys = await getAssessmentSEBKeys(sourceId);
      if (srcKeys.length > 0) await setAssessmentSEBKeys(created.id, srcKeys);
    } catch { /* non-fatal — platform keys apply */ }
  }

  // ── Allocation (hierarchy sources) ──────────────────────────────
  // Membership is materialized per-assessment, so it cannot be "copied" —
  // the duplicate must re-resolve the SAME node selection against today's
  // hierarchy. That is intentional: the copy targets the same batches/
  // sections, and if a student has since joined one, they are included.
  //
  // The copy's roster can therefore differ from the source's. That is the
  // correct reading of "same selection", and the outcome is returned so the
  // caller can tell the user the number rather than leaving them to discover
  // it on the roster.
  let allocation: DuplicateAllocationOutcome = { kind: 'legacy' };
  if (options.includeAllocations && isRuleAllocated(src)) {
    try {
      const alloc = await getAllocationForDuplicate(sourceId);
      if (!alloc || !alloc.nodeType) {
        allocation = { kind: 'rules_failed', reason: 'the original allocation could not be read' };
      } else {
        const res = await commitAllocationForDuplicate(
          created.id, alloc.nodeType, alloc.nodeIds,
        );
        created.allocationMode = 'rules';
        created.allocatedCount = res.resolvedCount;
        allocation = { kind: 'rules_recreated', count: res.resolvedCount };
      }
    } catch (e: any) {
      // Never fail the whole duplicate over allocation — the copy exists as a
      // draft targeting nobody, which is safe and re-allocatable by hand.
      allocation = {
        kind: 'rules_failed',
        reason: e?.message || 'the hierarchy selection could not be re-resolved',
      };
    }
  }

  return { assessment: created, allocation };
}

// Local thin wrappers over the allocation callables. Declared here rather
// than imported from allocationService to avoid a circular import
// (allocationService already imports from firebaseService, and the roster
// imports both) — duplicate is the only consumer.
async function getAllocationForDuplicate(assessmentId: string): Promise<{
  nodeType: string; nodeIds: string[];
} | null> {
  const snap = await getDocs(query(
    collection(db, 'allocations'),
    where('assessmentId', '==', assessmentId),
  ));
  const d = snap.docs[0];
  if (!d) return null;
  return { nodeType: String(d.get('nodeType') ?? ''), nodeIds: (d.get('nodeIds') ?? []) as string[] };
}

async function commitAllocationForDuplicate(
  assessmentId: string, nodeType: string, nodeIds: string[],
): Promise<{ resolvedCount: number }> {
  const call = httpsCallable<
    { assessmentId: string; nodeType: string; nodeIds: string[]; expectedVersion: number; dryRun: boolean },
    { resolvedCount: number }
  >(functions, 'resolveAllocation');
  // expectedVersion 0 — the duplicate is brand new, so it has no allocation doc.
  const res = await call({ assessmentId, nodeType, nodeIds, expectedVersion: 0, dryRun: false });
  return { resolvedCount: res.data.resolvedCount ?? 0 };
}

// ── Phase 3: platform-wide SEB settings ───────────────────────────
// Stored at platformSettings/seb. `configKeys` is an ARRAY from day one:
// rotating a .seb config needs an overlap window where the old and new keys
// are both accepted (Moodle allows several keys for the same reason).
//
// The Config Key is a checksum of the .seb config's settings. It does NOT
// include the SEB version, so ONE key covers Windows/macOS and all versions —
// which is why we verify the Config Key rather than the Browser Exam Key.

export type SEBPlatformSettings = {
  configKeys: string[];
  updatedAt?: string;
};

export async function getSEBSettings(): Promise<SEBPlatformSettings> {
  const snap = await getDoc(doc(db, 'platformSettings', 'seb'));
  if (!snap.exists()) return { configKeys: [] };
  const d = snap.data() as Partial<SEBPlatformSettings>;
  return { configKeys: d.configKeys ?? [], updatedAt: d.updatedAt };
}

export async function setSEBSettings(configKeys: string[]): Promise<void> {
  // Normalise: SEB emits lowercase hex; compare case-insensitively later, but
  // store canonically so the admin UI shows one consistent form.
  const cleaned = configKeys
    .map((k) => k.trim().toLowerCase())
    .filter((k) => /^[0-9a-f]{64}$/.test(k));
  await setDoc(
    doc(db, 'platformSettings', 'seb'),
    { configKeys: cleaned, updatedAt: now() },
    { merge: true },
  );
}

// ── Phase 3 Stage 4: per-assessment SEB Config Keys ───────────────
// Stored in a SEPARATE, webOwner-only collection (sebAssessmentKeys/{id}) and
// deliberately NOT on the assessment document, which students can read —
// possessing a Config Key is what lets an attacker forge the SEB hash. The
// verification endpoint reads this collection with a service account.
// Resolution there: these keys (when non-empty) OVERRIDE the platform keys.

export async function getAssessmentSEBKeys(assessmentId: string): Promise<string[]> {
  const snap = await getDoc(doc(db, 'sebAssessmentKeys', assessmentId));
  if (!snap.exists()) return [];
  const keys = (snap.data() as { keys?: string[] }).keys;
  return Array.isArray(keys) ? keys : [];
}

export async function setAssessmentSEBKeys(assessmentId: string, keys: string[]): Promise<void> {
  const cleaned = keys
    .map((k) => k.trim().toLowerCase())
    .filter((k) => /^[0-9a-f]{64}$/.test(k));
  if (cleaned.length === 0) {
    // Empty override = no override: delete the doc so resolution falls back
    // to the platform keys, rather than leaving an empty doc to reason about.
    await deleteDoc(doc(db, 'sebAssessmentKeys', assessmentId)).catch(() => {});
    return;
  }
  await setDoc(doc(db, 'sebAssessmentKeys', assessmentId), {
    keys: cleaned,
    updatedAt: now(),
  });
}

// ── Phase 3 Stage 4b: SEB config FILES ────────────────────────────
// The .seb files themselves. Platform file: uploaded once on the SEB settings
// page, auto-offered on every SEB exam's briefing. Per-exam file: uploaded in
// the builder alongside that exam's Config Keys. The download link is NOT a
// secret (students need the file); the key derived from the file's contents
// is — and that stays in webOwner-only docs.

/** Student-readable platform SEB info (publicSettings/seb) — link only, never keys. */
export interface SEBPublicInfo {
  configFileUrl?: string;
  fileName?: string;
  updatedAt?: string;
}

export async function getSEBPublicInfo(): Promise<SEBPublicInfo> {
  try {
    const snap = await getDoc(doc(db, 'publicSettings', 'seb'));
    return snap.exists() ? (snap.data() as SEBPublicInfo) : {};
  } catch {
    return {}; // briefing degrades to "provided by your institute" wording
  }
}

/** Upload/replace the PLATFORM .seb file and publish its link for students. */
export async function uploadPlatformSebFile(file: File): Promise<SEBPublicInfo> {
  const r = storageRef(storage, 'seb-configs/platform.seb');
  await uploadBytes(r, file, { contentType: 'application/octet-stream' });
  const url = await getDownloadURL(r);
  const info: SEBPublicInfo = { configFileUrl: url, fileName: file.name, updatedAt: now() };
  await setDoc(doc(db, 'publicSettings', 'seb'), info);
  return info;
}

export async function removePlatformSebFile(): Promise<void> {
  await deleteObject(storageRef(storage, 'seb-configs/platform.seb')).catch(() => {});
  await setDoc(doc(db, 'publicSettings', 'seb'), { updatedAt: now() });
}

/** Upload/replace a PER-EXAM .seb file. Returns the download URL to store on the assessment. */
export async function uploadAssessmentSebFile(assessmentId: string, file: File): Promise<string> {
  const r = storageRef(storage, `seb-configs/assessments/${assessmentId}.seb`);
  await uploadBytes(r, file, { contentType: 'application/octet-stream' });
  return getDownloadURL(r);
}

export async function deleteAssessmentSebFile(assessmentId: string): Promise<void> {
  await deleteObject(storageRef(storage, `seb-configs/assessments/${assessmentId}.seb`)).catch(() => {});
}

// ── Phase 3: SEB diagnostic (Stage 1, webOwner-only) ──────────────
/**
 * Ask the server what it actually received. Run this ONCE from inside a real
 * Safe Exam Browser to discover (a) whether SEB injects its ConfigKeyHash
 * header into our cross-origin callables at all, and (b) which absolute-URL
 * reconstruction reproduces the hash. Enforcement (Stage 2) is written
 * against these facts rather than guessed.
 *
 * Pass the Config Key from the SEB Config Tool as `candidateConfigKey` and
 * read `matches` — the URL form that reports `true` is the one to verify with.
 */
export async function sebDiagnostics(candidateConfigKey?: string): Promise<{
  ok: true;
  sawAnySebHeader: boolean;
  sebHeaders: Record<string, string>;
  receivedConfigKeyHash: string | null;
  urlCandidates: Record<string, string>;
  matches: Record<string, boolean>;
  raw: Record<string, unknown>;
  userAgent: string | null;
}> {
  const call = httpsCallable<
    { candidateConfigKey?: string },
    {
      ok: true; sawAnySebHeader: boolean; sebHeaders: Record<string, string>;
      receivedConfigKeyHash: string | null; urlCandidates: Record<string, string>;
      matches: Record<string, boolean>; raw: Record<string, unknown>; userAgent: string | null;
    }
  >(functions, 'sebDiagnostics');
  const res = await call({ candidateConfigKey });
  return res.data;
}

// ── Phase 3: client-side SEB detection (UX ONLY) ──────────────────
/**
 * Best-effort detection so the briefing can tell a student "you need SEB".
 * NEVER a security control: a user agent is trivially spoofed, and a
 * header-modifying extension can fake the SEB headers. The server's hash
 * check is the only thing that decides. This exists purely so a student in
 * Chrome sees a helpful message instead of a cryptic rejection.
 */
export function looksLikeSEB(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const hasUA = /\bSEB[\s/]/i.test(ua) || /SafeExamBrowser/i.test(ua);
  // SEB 3.0+ (macOS/iOS) and 3.4+ (Windows) expose a JS API object.
  const hasJsApi = typeof (window as unknown as { SafeExamBrowser?: unknown }).SafeExamBrowser
    !== 'undefined';
  return hasUA || hasJsApi;
}

// ── Phase 3: obtain a SEB proof from our own origin ───────────────
/**
 * Calls /api/seb-verify on THIS origin (where SEB injects its ConfigKeyHash
 * header — measured; it does not inject into cross-origin Firebase calls).
 * Vercel checks the hash, authenticates the Firebase ID token, and returns a
 * short-lived proof bound to this user. Exam callables require that proof.
 *
 * Returns null when the caller is not in SEB (or the hash doesn't match), so
 * the UI can show a specific message instead of a generic failure.
 */
export async function getSebToken(assessmentId: string): Promise<{
  ok: boolean;
  sebToken?: string;
  expiresAt?: number;
  error?: string;
}> {
  const user = auth.currentUser;
  if (!user) return { ok: false, error: 'AUTH_REQUIRED' };
  try {
    const idToken = await user.getIdToken();
    const res = await fetch('/api/seb-verify', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      // Stage 4: the endpoint resolves per-exam Config Keys by assessmentId
      // and binds the minted token to it — assertSEB rejects a token minted
      // for a different exam.
      body: JSON.stringify({ assessmentId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      return { ok: false, error: (data && data.error) || `HTTP_${res.status}` };
    }
    return { ok: true, sebToken: data.sebToken, expiresAt: data.expiresAt };
  } catch {
    return { ok: false, error: 'SEB_VERIFY_UNREACHABLE' };
  }
}

// ── Phase 3: SEB token lifecycle (Stage 2b) ───────────────────────
// The proof is short-lived by design (~90s) so that quitting SEB and moving to
// Chrome kills access quickly. That means it must be refreshed transparently,
// or a student would be rejected mid-answer. We cache it and re-mint when it
// is close to expiry; the exam's existing 15s heartbeat keeps it warm.
//
// `sebRequired` is set once when a SEB exam starts. When false, every helper
// returns undefined and nothing changes for normal/mock exams.

let sebRequired = false;
let sebAssessmentId = '';
let cachedSeb: { token: string; expiresAt: number } | null = null;

export function setSebRequired(required: boolean, assessmentId = ''): void {
  sebRequired = required;
  sebAssessmentId = required ? assessmentId : '';
  if (!required) cachedSeb = null;
}

/** Returns a valid proof, minting one if needed. undefined when SEB isn't required. */
export async function ensureSebToken(): Promise<string | undefined> {
  if (!sebRequired) return undefined;
  const now = Math.floor(Date.now() / 1000);
  // Refresh with 25s of headroom so an in-flight call can't expire mid-request.
  if (cachedSeb && cachedSeb.expiresAt - now > 25) return cachedSeb.token;
  const r = await getSebToken(sebAssessmentId);
  if (!r.ok || !r.sebToken || !r.expiresAt) {
    cachedSeb = null;
    throw new Error(`SEB_REQUIRED:${r.error ?? 'unknown'}`);
  }
  cachedSeb = { token: r.sebToken, expiresAt: r.expiresAt };
  return cachedSeb.token;
}

/** Discard the cached proof and mint a fresh one (used after SEB_EXPIRED). */
export async function forceRefreshSebToken(): Promise<string | undefined> {
  cachedSeb = null;
  return ensureSebToken();
}

// ── Soft delete assessment ────────────────────────────────────────

export async function softDeleteAssessment(id: string): Promise<void> {
  await updateDoc(doc(db, 'assessments', id), {
    isDeleted: true,
    updatedAt: now(),
  });
}

// ── Restore soft-deleted assessment ───────────────────────────────

export async function restoreAssessment(id: string): Promise<void> {
  await updateDoc(doc(db, 'assessments', id), {
    isDeleted: false,
    updatedAt: now(),
  });
}

// ── Block / unblock a student from entering an assessment ─────────

export async function blockStudent(
  assessmentId: string,
  studentId: string
): Promise<void> {
  await updateDoc(doc(db, 'assessments', assessmentId), {
    blockedStudents: arrayUnion(studentId),
    updatedAt: now(),
  });
}

export async function unblockStudent(
  assessmentId: string,
  studentId: string
): Promise<void> {
  await updateDoc(doc(db, 'assessments', assessmentId), {
    blockedStudents: arrayRemove(studentId),
    updatedAt: now(),
  });
}

// ── Per-student attempt override ──────────────────────────────────
// Sets a custom maxAttempts for a single student on this assessment.
// Pass value = null to clear the override and revert to the global limit.

export async function setAttemptOverride(
  assessmentId: string,
  studentId: string,
  value: number | null
): Promise<void> {
  if (value === null) {
    await updateDoc(doc(db, 'assessments', assessmentId), {
      [`attemptOverrides.${studentId}`]: deleteField(),
      updatedAt: now(),
    });
  } else {
    await updateDoc(doc(db, 'assessments', assessmentId), {
      [`attemptOverrides.${studentId}`]: value,
      updatedAt: now(),
    });
  }
}

// ── Update assessment status ──────────────────────────────────────

export async function updateAssessmentStatus(
  id: string,
  status: AssessmentStatus
): Promise<void> {
  await updateDoc(doc(db, 'assessments', id), {
    status,
    updatedAt: now(),
  });
}

// ── Get assessments visible to a student ─────────────────────────
// Fetches all non-deleted published (active | closed) assessments and
// filters client-side by the assignment target.
// Students never see draft assessments.

/**
 * The student's own assessment list, resolved SERVER-SIDE.
 *
 * Audit 2026-07-26 S-04. This function used to run two unfiltered collection
 * queries — every 'active' doc and every 'closed' doc, with no tenant or
 * assignment constraint — and then filter the result in the browser. The
 * filter was cosmetic: every assessment on the platform, including other
 * institutes', had already crossed the wire, and firestore.rules permitted it
 * because the student read branch checked only `status in ['active','closed']`.
 * Titles, schedules, blueprints, pass marks and the ids of blocked students
 * were all readable by any signed-in student from the console.
 *
 * Identity is no longer passed in. The callable derives studentId and
 * instituteId from the verified ID token, so the caller cannot ask for someone
 * else's list — the previous signature took them as arguments, which was
 * harmless while the filtering was client-side and pointless afterwards.
 *
 * Visibility logic is unchanged and now lives in getStudentAssessments
 * (functions/src/index.ts): rules-mode exams resolve through assessmentMembers,
 * everything else through assignedTo, legacy docs without assignedTo stay
 * webOwner-global. The server also reduces blockedStudents and attemptOverrides
 * to this student's own entry before returning.
 */
export async function getAssessmentsForStudent(): Promise<Assessment[]> {
  const call = httpsCallable<
    Record<string, never>,
    { ok: true; assessments: Assessment[] }
  >(functions, 'getStudentAssessments');
  const res = await call({});
  return res.data.assessments ?? [];
}

// ══════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════════════

// ── Status badge helpers ──────────────────────────────────────────

export function statusColor(status: AssessmentStatus): {
  bg: string;
  text: string;
  border: string;
} {
  switch (status) {
    case 'draft':
      return { bg: '#F7F6F3', text: '#9A9891', border: '#E3E1DB' };
    case 'active':
      return { bg: '#F0F9F4', text: '#1E7B3C', border: '#B8E6C8' };
    case 'closed':
      return { bg: '#F5F5F5', text: '#6B6B66', border: '#DDDBD5' };
  }
}

// ── Format assignment target for display ─────────────────────────
//
// TWO TARGETING SYSTEMS LIVE SIDE BY SIDE. Read this before touching any
// code that answers "who is this exam for?":
//
//   LEGACY  — assignedTo: { all | institutes | students }. Self-describing;
//             the ids are right there on the assessment doc.
//   RULES   — allocationMode === 'rules'. assignedTo is MEANINGLESS (the
//             builder writes an empty students target as a side effect of
//             its ternary). Truth lives in assessmentMembers/*, with the
//             head-count denormalized onto assessment.allocatedCount.
//
// Reading assignedTo on a rules exam yields "0 Students" — it is the wrong
// field, not a wrong value. That mismatch caused the July 2026 roster bug:
// students were correctly allocated and could sit the exam, while every
// staff surface reported zero.
//
// The rule going forward: NEVER branch on assignedTo directly. Call
// describeAssignment() to render it and resolveAllocatedStudents() to list
// members. Both handle the mode split in one place, so a third targeting
// mode only has to be taught to this file.

/**
 * Legacy-only formatter. Kept for pre-rules assessments and for callers that
 * genuinely hold nothing but an AssignmentTarget.
 *
 * Prefer describeAssignment(assessment) — this function cannot see
 * allocationMode and so cannot tell a rules exam from an empty legacy one.
 */
export function formatAssignmentTarget(target: AssignmentTarget): string {
  if (!target) return '—';
  if (target.type === 'all') return 'All Students';
  if (target.type === 'institutes')
    return `${target.instituteIds.length} Institute${
      target.instituteIds.length === 1 ? '' : 's'
    }`;
  if (target.type === 'students')
    return `${target.studentIds.length} Student${
      target.studentIds.length === 1 ? '' : 's'
    }`;
  return '—';
}

/** The minimum an assessment-like object needs for the helpers below. */
export type AssignmentDescribable = {
  assignedTo: AssignmentTarget;
  allocationMode?: 'rules';
  allocatedCount?: number;
};

/** True when targeting comes from assessmentMembers, not assignedTo. */
export function isRuleAllocated(a: AssignmentDescribable | null | undefined): boolean {
  return a?.allocationMode === 'rules';
}

/**
 * Human-readable "who takes this exam", correct for BOTH targeting systems.
 * This is what every staff surface should render.
 *
 * A rules exam with no count yet (mid-materialization, or an older doc saved
 * before allocatedCount existed) reads "By hierarchy" rather than claiming a
 * number it doesn't have — an honest unknown beats a confident zero.
 */
export function describeAssignment(a: AssignmentDescribable | null | undefined): string {
  if (!a) return '—';
  if (isRuleAllocated(a)) {
    const n = a.allocatedCount;
    if (typeof n !== 'number') return 'By hierarchy';
    return `${n} Student${n === 1 ? '' : 's'} · by hierarchy`;
  }
  return formatAssignmentTarget(a.assignedTo);
}

/**
 * Resolve the students allocated to an assessment — the SINGLE source of
 * truth for every staff-side roster, export and invigilation list.
 *
 * Callers pass the full student pool they are already allowed to see (the
 * roster fetches it anyway), and get back the allocated subset.
 *
 * WHY THIS ISN'T JUST A FILTER
 * The two targeting systems need different reads:
 *   • legacy → pure filter over assignedTo. No I/O.
 *   • rules  → the member list, which lives in assessmentMembers.
 *
 * And assessmentMembers is webOwner-only in firestore.rules. Institute and
 * faculty staff CANNOT read it. Rather than loosen the rules (the member list
 * is the exam gate — widening reads on it widens the blast radius of any
 * future rules mistake), non-owner staff fall back to the pool they can
 * already see, scoped to their institute by the caller.
 *
 * That fallback is deliberately conservative: for an institute admin, "every
 * student in my institute" is a superset of "my students allocated to this
 * exam". They may see a not-yet-attempted student who wasn't allocated, but
 * they never MISS one who was — and no attempt data leaks, because attempts
 * are subscribed separately under their own rules. A blank roster is the
 * worse failure: it hides live exam-takers from the people invigilating them.
 *
 * Returns `exact: false` when that fallback is in play so the UI can say so
 * instead of quietly overstating.
 */
export async function resolveAllocatedStudents<T extends { id: string; instituteId: string }>(
  assessment: AssignmentDescribable,
  pool: T[],
  opts: { canReadMembers: boolean },
): Promise<{ students: T[]; exact: boolean }> {
  if (!isRuleAllocated(assessment)) {
    const t = assessment.assignedTo;
    const students = pool.filter((s) => {
      if (!t) return true;
      if (t.type === 'all') return true;
      if (t.type === 'institutes') return t.instituteIds.includes(s.instituteId);
      if (t.type === 'students') return t.studentIds.includes(s.id);
      return false;
    });
    return { students, exact: true };
  }

  // ── Rule-allocated ──────────────────────────────────────────────
  if (!opts.canReadMembers) {
    // Non-owner staff: show the institute-scoped pool (see note above).
    return { students: pool, exact: false };
  }

  const ids = await getAssessmentMemberIds(assessment as Assessment);
  if (ids === null) {
    // The read failed (rules, transient, or offline). Degrade to the pool
    // rather than rendering an empty roster during a live exam.
    return { students: pool, exact: false };
  }
  const idSet = new Set(ids);
  return { students: pool.filter((s) => idSet.has(s.id)), exact: true };
}

/**
 * Every studentId materialized against this assessment.
 * Returns null when the read is not permitted or fails — callers must
 * distinguish "no members" from "couldn't tell", since the two demand
 * opposite UI (empty state vs. fallback).
 */
export async function getAssessmentMemberIds(assessment: Assessment): Promise<string[] | null> {
  try {
    const snap = await getDocs(query(
      collection(db, 'assessmentMembers'),
      where('assessmentId', '==', assessment.id),
      where('active', '==', true),
    ));
    return snap.docs.map((d) => String(d.get('studentId')));
  } catch {
    return null;
  }
}