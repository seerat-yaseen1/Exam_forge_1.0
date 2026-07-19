// ── Question requests service (permission-model Phase 3) ──────────
// Client half of the request/approval workflow. Faculty submit requests for
// actions their grant only permits in REQUEST mode; the institute admin
// resolves them. Both mutations go through callables (submitQuestionRequest /
// resolveQuestionRequest) — the server enforces rights and EXECUTES approved
// actions. Reads are plain Firestore queries scoped by the questionRequests
// rules.

import { httpsCallable } from 'firebase/functions';
import {
  collection, query, where, orderBy, getDocs,
} from 'firebase/firestore';
import { db, functions } from './firebase';

export type QuestionRequestType = 'create' | 'edit' | 'delete' | 'share';
export type QuestionRequestStatus = 'pending' | 'approved' | 'rejected';

export type QuestionRequest = {
  id: string;
  type: QuestionRequestType;
  status: QuestionRequestStatus;
  facultyId: string;
  facultyName: string;
  instituteId: string;
  questionId?: string | null;
  questionStem?: string | null;
  payload?: {
    question?: Record<string, unknown> | null;
    recipients?: Array<{ id: string; type: 'faculty' | 'institute' }> | null;
    note?: string | null;
    subjectId?: string | null;
    topicId?: string | null;
    prevSubjectId?: string | null;
    prevTopicId?: string | null;
  };
  reviewedBy?: string;
  reviewNote?: string;
  createdAt: string;
  updatedAt: string;
};

const COL = 'questionRequests';

// ── Faculty: submit a request ─────────────────────────────────────

export type SubmitRequestInput = {
  type: QuestionRequestType;
  question?: Record<string, unknown>;
  questionId?: string;
  questionStem?: string;
  subjectId?: string | null;
  topicId?: string | null;
  prevSubjectId?: string | null;
  prevTopicId?: string | null;
  recipients?: Array<{ id: string; type: 'faculty' | 'institute' }>;
  note?: string;
};

export async function submitQuestionRequest(input: SubmitRequestInput): Promise<{ id: string }> {
  const call = httpsCallable<SubmitRequestInput, { ok: boolean; id: string }>(functions, 'submitQuestionRequest');
  const res = await call(input);
  return { id: res.data.id };
}

// ── Institute admin: resolve a request ────────────────────────────

export async function resolveQuestionRequest(
  requestId: string,
  decision: 'approve' | 'reject',
  reviewNote?: string,
): Promise<{ status: 'approved' | 'rejected' }> {
  const call = httpsCallable<
    { requestId: string; decision: 'approve' | 'reject'; reviewNote?: string },
    { ok: boolean; status: 'approved' | 'rejected' }
  >(functions, 'resolveQuestionRequest');
  const res = await call({ requestId, decision, reviewNote });
  return { status: res.data.status };
}

// ── Reads ─────────────────────────────────────────────────────────

/** All requests inside an institute (institute-admin inbox). */
export async function getRequestsForInstitute(
  instituteId: string,
  status?: QuestionRequestStatus,
): Promise<QuestionRequest[]> {
  const constraints = [where('instituteId', '==', instituteId)];
  if (status) constraints.push(where('status', '==', status));
  const snap = await getDocs(query(collection(db, COL), ...constraints));
  const list = snap.docs.map((d) => d.data() as QuestionRequest);
  // Newest first (client sort avoids an extra composite index).
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A faculty member's own requests. */
export async function getRequestsForFaculty(
  facultyId: string,
): Promise<QuestionRequest[]> {
  const snap = await getDocs(query(collection(db, COL), where('facultyId', '==', facultyId)));
  const list = snap.docs.map((d) => d.data() as QuestionRequest);
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Count of pending requests for the institute inbox badge. */
export async function getPendingRequestCount(instituteId: string): Promise<number> {
  const snap = await getDocs(query(
    collection(db, COL),
    where('instituteId', '==', instituteId),
    where('status', '==', 'pending'),
  ));
  return snap.size;
}