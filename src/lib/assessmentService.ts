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
import { db, functions, auth } from './firebase';

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
};

export function resolveQuestionsForSections(
  sections: AssessmentSection[],
  allQuestions: BankQuestion[]
): { sections: AssessmentSection[]; flatQuestions: AssessmentQuestion[] } {
  const usedIds = new Set<string>();
  let globalOrder = 0;

  const resolvedSections: AssessmentSection[] = sections.map((section) => {
    const sectionQuestions: AssessmentQuestion[] = [];

    for (const rule of section.rules) {
      if (rule.count <= 0) continue;

      // Build pool: matching subject + topic + difficulty, not deleted, not yet used
      const pool = allQuestions.filter(
        (q) =>
          !q.isDeleted &&
          q.subject === rule.subject &&
          q.topic === rule.topic &&
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
  allQuestions: BankQuestion[]
): { valid: boolean; results: RuleValidationResult[] } {
  const usedCounts: Record<string, number> = {};
  const results: RuleValidationResult[] = [];

  const key = (subject: string, topic: string, diff: string) =>
    `${subject}::${topic}::${diff}`;

  // Pre-compute total available per subject+topic+difficulty
  const totalAvailable: Record<string, number> = {};
  for (const q of allQuestions) {
    if (q.isDeleted) continue;
    const k = key(q.subject, q.topic, q.difficulty);
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
  showResults: boolean;         // show results to student after submission
  allowReview: boolean;         // allow student to review answers after submission

  // Section play order — 'sequential' (default) keeps the order set in the
  // builder; 'random' shuffles per student at startAttempt; 'student_choice'
  // (phase 2) lets the student pick the next section themselves.
  sectionStartOrder?: 'sequential' | 'random' | 'student_choice';

  // Status
  status: AssessmentStatus;

  // Block list — students prevented from entering/re-entering the exam
  // Checked as a gate in ExamBriefingPage; does not affect existing attempts
  blockedStudents?: string[];   // array of studentIds

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
  // whichever expires first ends the exam. Enforced in Phase 1.
  // undefined = no overall cap.
  overallTimeLimit?: number;

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

export async function updateAssessment(
  id: string,
  draft: Partial<AssessmentDraft>
): Promise<void> {
  const updates: any = { ...draft, updatedAt: now() };

  // Recalculate total marks if questions changed
  if (draft.questions) {
    updates.totalMarks = draft.questions.reduce((sum, q) => sum + q.marks, 0);
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
  'shuffleQuestions' | 'passingScore' | 'showResults' | 'allowReview' | 'sectionStartOrder'
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
  includeAllocations: boolean; // assignedTo targeting
};

export async function duplicateAssessment(
  sourceId: string,
  options: DuplicateOptions,
  titleOverride?: string,
): Promise<Assessment> {
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

    assignedTo: options.includeAllocations
      ? src.assignedTo
      : { type: 'students', studentIds: [] },

    startDate: options.includeScheduling ? src.startDate : undefined,
    endDate:   options.includeScheduling ? src.endDate   : undefined,

    // Settings (these three are required on Assessment, so always supplied)
    shuffleQuestions:    options.includeSettings ? src.shuffleQuestions : false,
    showResults:         options.includeSettings ? src.showResults      : false,
    allowReview:         options.includeSettings ? src.allowReview      : false,
    timeLimit:           options.includeSettings ? src.timeLimit           : undefined,
    overallTimeLimit:    options.includeSettings ? src.overallTimeLimit    : undefined,
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

  return created;
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

export async function getAssessmentsForStudent(
  studentId: string,
  instituteId: string
): Promise<Assessment[]> {
  // Fetch only active or closed assessments — students never see drafts.
  // Two queries (one per status value) instead of a full collection scan so
  // we don't pull every other institute's drafts across the wire.
  const [activeSnap, closedSnap] = await Promise.all([
    getDocs(query(collection(db, 'assessments'),
      where('status', '==', 'active'),
      where('isDeleted', '==', false))),
    getDocs(query(collection(db, 'assessments'),
      where('status', '==', 'closed'),
      where('isDeleted', '==', false))),
  ]);

  const all = [
    ...activeSnap.docs.map((d) => d.data() as Assessment),
    ...closedSnap.docs.map((d) => d.data() as Assessment),
  ];

  return all.filter((a) => {
    const t = a.assignedTo;
    if (t.type === 'all') return true;
    if (t.type === 'institutes') return t.instituteIds.includes(instituteId);
    if (t.type === 'students') return t.studentIds.includes(studentId);
    return false;
  });
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

export function formatAssignmentTarget(target: AssignmentTarget): string {
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