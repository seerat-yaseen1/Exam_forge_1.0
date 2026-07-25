// ── Subject requests (Feature #15, Phase 7b) ──────────────────────
// The record of who asked for their data, when, and what was decided.
//
// Records decisions. Destroys nothing. Requires no policy configuration.
//
// WHY REFUSAL IS AS IMPORTANT AS FULFILMENT
// If examination records carry a mandatory retention period, erasure requests
// received inside that window are lawfully refusable. But refusing is not
// ignoring — a dated, reasoned refusal is the artifact that shows the request
// was received, considered and answered. The server requires a reason on
// every refusal for exactly that purpose.

import { httpsCallable } from 'firebase/functions';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db, functions } from './firebase';

export type SubjectRequestType = 'access' | 'erasure';
export type SubjectRequestStatus = 'open' | 'fulfilled' | 'refused' | 'erased';

export type SubjectRequest = {
  id: string;
  type: SubjectRequestType;
  status: SubjectRequestStatus;
  subjectRole: 'student' | 'faculty';
  subjectId: string;
  subjectLabel: string | null;
  requestedBy: string;
  requestedByRole: string;
  instituteId: string | null;
  basis: string | null;
  /** When the PERSON asked — compliance clocks run from here, not createdAt. */
  receivedAt: string;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  exportGeneratedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const COL = 'subjectRequests';

// ── Mutations ─────────────────────────────────────────────────────

export async function submitSubjectRequest(params: {
  type: SubjectRequestType;
  subjectRole: 'student' | 'faculty';
  subjectId: string;
  basis?: string;
  receivedAt?: string;
}): Promise<{ id: string }> {
  const call = httpsCallable<typeof params, { ok: true; id: string }>(
    functions,
    'submitSubjectRequest',
  );
  const res = await call(params);
  return { id: res.data.id };
}

export async function decideSubjectRequest(params: {
  requestId: string;
  outcome: 'fulfilled' | 'refused';
  decision?: string;
  exportGenerated?: boolean;
}): Promise<void> {
  const call = httpsCallable<typeof params, { ok: true }>(
    functions,
    'decideSubjectRequest',
  );
  await call(params);
}

// ── Reads ─────────────────────────────────────────────────────────

function newestFirst(list: SubjectRequest[]): SubjectRequest[] {
  // Sorted by when the PERSON asked, not when the row was created — the
  // oldest unanswered request is the most urgent one.
  return list.sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''));
}

/** All requests visible to the caller. Institute-scoped when given an id. */
export async function getSubjectRequests(instituteId?: string): Promise<SubjectRequest[]> {
  const constraints = instituteId ? [where('instituteId', '==', instituteId)] : [];
  const snap = await getDocs(query(collection(db, COL), ...constraints));
  return newestFirst(snap.docs.map((d) => d.data() as SubjectRequest));
}

export async function getOpenSubjectRequestCount(instituteId?: string): Promise<number> {
  const constraints = [where('status', '==', 'open')];
  if (instituteId) constraints.push(where('instituteId', '==', instituteId));
  const snap = await getDocs(query(collection(db, COL), ...constraints));
  return snap.size;
}

// ── Presentation ──────────────────────────────────────────────────

export function typeLabel(t: SubjectRequestType): string {
  return t === 'access' ? 'Access' : 'Erasure';
}

export function statusLabel(s: SubjectRequestStatus): string {
  switch (s) {
    case 'open':      return 'Open';
    case 'fulfilled': return 'Fulfilled';
    case 'refused':   return 'Refused';
    case 'erased':    return 'Erased';
    default:          return s;
  }
}

/**
 * Whole days since the person asked.
 *
 * Surfaced prominently because of the split-controller arrangement: an
 * institute carries the legal deadline but depends on the Web Owner to
 * execute erasure, so request age is the Web Owner's obligation made visible.
 */
export function daysOpen(req: SubjectRequest, now: Date = new Date()): number | null {
  const t = Date.parse(req.receivedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export function ageLabel(req: SubjectRequest): string {
  const d = daysOpen(req);
  if (d === null) return 'date unknown';
  if (d === 0) return 'today';
  return `${d} day${d === 1 ? '' : 's'} ago`;
}