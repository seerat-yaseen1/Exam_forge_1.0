/**
 * questionReportService — Student-flagged question reports
 *
 * A student can flag a question during an exam (from QuestionRenderer).
 * Flags are buffered in ExamShell and written to Firestore in a single
 * batch on final submit — this avoids extra writes mid-exam and keeps
 * the IntegrityEngine surface clean.
 *
 * Reviewer roles (Web Owner, Institute Admin, Faculty) read these
 * reports via list queries scoped to their ownership.
 */

import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  query,
  where,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { db } from './firebase';

// ══════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════

export type ReportReason =
  | 'wrong_answer'   // student believes the answer key is wrong
  | 'typo'           // typo / formatting issue in stem or options
  | 'ambiguous'      // unclear or has multiple valid interpretations
  | 'other';

export type ReportStatus =
  | 'open'           // newly submitted, awaiting review
  | 'reviewed'       // looked at, no action yet
  | 'dismissed'      // reviewer judged the report invalid
  | 'fixed';         // reviewer took action — see resolution

export type ResolutionAction =
  | 'no_change'              // nothing changed
  | 'question_edited'        // stem/options/key edited
  | 'answer_key_changed'     // correct answer was wrong; updated + regrade
  | 'question_invalidated';  // question dropped; full marks awarded

export type ReportResolution = {
  action: ResolutionAction;
  regradeApplied?: boolean;
  resolvedBy: string;        // userId of the reviewer
  resolvedByRole: 'web_owner' | 'institute' | 'faculty';
  resolvedAt: string;        // ISO 8601
  note?: string;             // visible to the student on results page
};

export type QuestionReport = {
  id: string;
  questionId: string;
  attemptId: string;
  studentId: string;
  studentName: string;
  assessmentId: string;
  assessmentTitle: string;
  ownerId: string;           // assessment.ownerId — for reviewer scoping
  ownerType: string;         // assessment.ownerType
  instituteId?: string;      // for institute-admin scoping
  reason: ReportReason;
  note?: string;             // student-supplied note (post-submit only)
  status: ReportStatus;
  resolution?: ReportResolution;
  createdAt: string;
  updatedAt: string;
};

// ══════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════

function newId(): string {
  return `report_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function now(): string {
  return new Date().toISOString();
}

function removeUndefined<T extends Record<string, any>>(obj: T): T {
  const out: any = {};
  for (const key in obj) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out as T;
}

const COLL = 'questionReports';

// ══════════════════════════════════════════════════════════════════
// WRITE — single + batch
// ══════════════════════════════════════════════════════════════════

export type FlagDraft = {
  questionId: string;
  reason: ReportReason;
};

/**
 * Persist a batch of flags raised during a single attempt.
 * Called from ExamShell at final-submit time.
 */
export async function createReportsForAttempt(params: {
  attemptId: string;
  studentId: string;
  studentName: string;
  assessmentId: string;
  assessmentTitle: string;
  ownerId: string;
  ownerType: string;
  instituteId?: string;
  flags: FlagDraft[];
}): Promise<void> {
  if (params.flags.length === 0) return;

  const batch = writeBatch(db);
  const ts = now();

  for (const flag of params.flags) {
    const id = newId();
    const ref = doc(db, COLL, id);
    const report: QuestionReport = removeUndefined({
      id,
      questionId: flag.questionId,
      attemptId: params.attemptId,
      studentId: params.studentId,
      studentName: params.studentName,
      assessmentId: params.assessmentId,
      assessmentTitle: params.assessmentTitle,
      ownerId: params.ownerId,
      ownerType: params.ownerType,
      instituteId: params.instituteId,
      reason: flag.reason,
      status: 'open',
      createdAt: ts,
      updatedAt: ts,
    });
    batch.set(ref, report);
  }

  await batch.commit();
}

/**
 * Student adds a free-text note to an existing report (post-submit, on
 * the results page). Keeps the during-exam flow distraction-free.
 */
export async function addStudentNote(reportId: string, note: string): Promise<void> {
  await updateDoc(doc(db, COLL, reportId), {
    note,
    updatedAt: now(),
  });
}

/**
 * Reviewer resolves a report. The regrade step (if needed) is owned by
 * submissionService; this function only records the decision.
 */
export async function resolveReport(params: {
  reportId: string;
  status: Exclude<ReportStatus, 'open'>;
  resolution: ReportResolution;
}): Promise<void> {
  await updateDoc(doc(db, COLL, params.reportId), removeUndefined({
    status: params.status,
    resolution: params.resolution,
    updatedAt: now(),
  }));
}

// ══════════════════════════════════════════════════════════════════
// READ
// ══════════════════════════════════════════════════════════════════

export async function getReport(id: string): Promise<QuestionReport | null> {
  const snap = await getDoc(doc(db, COLL, id));
  return snap.exists() ? (snap.data() as QuestionReport) : null;
}

// SCOPING NOTE (all list functions below): the questionReports read rule
// grants students access only where studentId == their claim, and staff
// access only where instituteId == their claim. Queries missing those
// filters are unprovable and rejected WHOLESALE. Pass the scope param for
// non-webOwner callers; omit only for webOwner.

export async function listReportsByAssessment(
  assessmentId: string,
  instituteId?: string | null
): Promise<QuestionReport[]> {
  const constraints = [where('assessmentId', '==', assessmentId)];
  if (instituteId) constraints.push(where('instituteId', '==', instituteId));
  const q = query(collection(db, COLL), ...constraints);
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as QuestionReport);
}

export async function listReportsByAttempt(
  attemptId: string,
  studentId?: string | null
): Promise<QuestionReport[]> {
  const constraints = [where('attemptId', '==', attemptId)];
  if (studentId) constraints.push(where('studentId', '==', studentId));
  const q = query(collection(db, COLL), ...constraints);
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as QuestionReport);
}

export async function listReportsByOwner(
  ownerId: string,
  instituteId?: string | null
): Promise<QuestionReport[]> {
  const constraints = [where('ownerId', '==', ownerId)];
  if (instituteId) constraints.push(where('instituteId', '==', instituteId));
  const q = query(collection(db, COLL), ...constraints);
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as QuestionReport);
}

export async function listReportsByInstitute(instituteId: string): Promise<QuestionReport[]> {
  const q = query(collection(db, COLL), where('instituteId', '==', instituteId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data() as QuestionReport);
}

/**
 * Web-owner inbox — every report in the system. Use sparingly; for a
 * scoped fetch prefer listReportsByOwner / listReportsByAssessment.
 */
export async function listAllReports(): Promise<QuestionReport[]> {
  const snap = await getDocs(collection(db, COLL));
  return snap.docs.map((d) => d.data() as QuestionReport);
}
