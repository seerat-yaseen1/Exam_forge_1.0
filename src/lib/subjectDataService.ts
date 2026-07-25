// ── Subject data (Feature #15, Phase 7a) ──────────────────────────
// Everything STRATUM holds about one person, for answering an access request.
//
// Read-only. Destroys nothing, requires no policy configuration, and is safe
// to call at any time. This is deliberately the first piece of Phase 7: the
// right of ACCESS precedes the right of erasure in essentially every regime,
// and it is the request far more likely to actually arrive.
//
// THE UNREADABLE CONTRACT
// A section's `records` is `null` when the collection could not be read —
// never an empty array. The two mean completely different things and the UI
// must not conflate them: this export gets handed to a person as a complete
// answer, so one that silently omits a collection is worse than none at all.

import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

export type SubjectRole = 'student' | 'faculty';

export type SubjectSection = {
  collection: string;
  /** null ⇒ could not be read. [] ⇒ genuinely none. */
  records: Record<string, unknown>[] | null;
  note?: string;
};

export type SubjectData = {
  generatedAt: string;
  generatedBy: string;
  generatedByRole: string;
  subject: {
    role: SubjectRole;
    uid: string;
    name: string | null;
    email: string | null;
    instituteId: string | null;
  };
  sections: SubjectSection[];
  /** Collections that could not be read. Non-empty ⇒ the export is partial. */
  unreadable: string[];
  note: string;
};

export async function getSubjectData(
  role: SubjectRole,
  uid: string,
): Promise<SubjectData> {
  const call = httpsCallable<{ role: SubjectRole; uid: string }, { ok: true } & SubjectData>(
    functions,
    'getSubjectData',
  );
  const res = await call({ role, uid });
  return res.data;
}

// ── Presentation ──────────────────────────────────────────────────

/** Total records across readable sections. Unreadable ones are excluded. */
export function totalRecords(data: SubjectData | null): number {
  if (!data) return 0;
  return data.sections.reduce((n, s) => n + (s.records?.length ?? 0), 0);
}

/** Sections holding at least one record, or which failed to read. */
export function meaningfulSections(data: SubjectData | null): SubjectSection[] {
  if (!data) return [];
  // Empty-but-readable sections are dropped as noise; unreadable ones are
  // KEPT, because "we could not check this" is information the reader needs.
  return data.sections.filter((s) => s.records === null || s.records.length > 0);
}

const COLLECTION_LABELS: Record<string, string> = {
  students: 'Profile',
  faculty: 'Profile',
  studentCredentials: 'Account state',
  facultyCredentials: 'Account state',
  attempts: 'Exam attempts',
  academicMappings: 'Academic placement',
  assessmentMembers: 'Exam allocations',
  questionReports: 'Reported questions',
  questions: 'Authored questions',
  questionBanks: 'Question banks',
  assessments: 'Assessments',
  questionShares: 'Shared content',
  deletionAudit: 'Lifecycle history',
  deletionRequests: 'Deletion requests',
};

export function collectionLabel(name: string): string {
  return COLLECTION_LABELS[name] ?? name;
}

/**
 * Build the downloadable export.
 *
 * Carries its own header — who it concerns, when it was produced, who produced
 * it, and whether it is partial. A JSON blob handed over without that context
 * is not an answer to an access request; it is a database dump.
 */
export function buildExportBlob(data: SubjectData): Blob {
  const payload = {
    _about: {
      description: 'Personal data held by STRATUM about the subject below.',
      subject: data.subject,
      generatedAt: data.generatedAt,
      generatedBy: `${data.generatedByRole} (${data.generatedBy})`,
      complete: data.unreadable.length === 0,
      unreadableCollections: data.unreadable,
      notes: [
        data.note,
        'Credentials and session tokens are deliberately excluded.',
        'Face detection during exams runs in the browser only; no images or '
          + 'biometric data are stored, so none appear here.',
      ],
    },
    data: Object.fromEntries(
      data.sections.map((s) => [
        s.collection,
        s.records === null ? { unreadable: true, note: s.note } : s.records,
      ]),
    ),
  };
  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
}

/** Filename for the export. Uses the uid, not the name — names collide. */
export function exportFilename(data: SubjectData): string {
  const date = data.generatedAt.slice(0, 10);
  return `stratum-subject-data-${data.subject.role}-${data.subject.uid}-${date}.json`;
}