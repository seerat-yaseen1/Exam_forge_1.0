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
} from 'firebase/firestore';
import { db } from './firebase';

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

export type AssessmentSection = {
  id: string;
  name: string;            // e.g., "Section A", "Reading Comprehension"
  timeLimit?: number;      // minutes for this section; undefined = no per-section limit
  rules: QuestionSelectionRule[];  // spec: what to randomly draw at publish time
  questions: AssessmentQuestion[]; // resolved at publish time (status → active)
  assignedTopics?: string[];       // "subject::topic" keys pre-assigned in Step 1
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
  const snap = await getDocs(
    query(collection(db, 'assessments'), where('isDeleted', '==', false))
  );
  const all = snap.docs.map((d) => d.data() as Assessment);

  return all.filter((a) => {
    // Hide drafts from students
    if (a.status === 'draft') return false;

    // Check assignment target
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