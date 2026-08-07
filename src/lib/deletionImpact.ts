// ── Deletion impact — dependency counts for confirmation dialogs ──
// (Feature #15, Phase 1. Thin client over the getDeletionImpact callable.)
//
// WHY THE COUNTS COME FROM THE SERVER
// Counting client-side would mean fetching every dependent document to length
// them — an institute with 1,200 students and 48,000 attempts would need tens
// of thousands of reads to render one dialog. The callable uses Firestore
// count() aggregations, which return a single number per collection without
// transferring the documents.
//
// It also solves a permissions problem: a faculty member may be permitted to
// delete a student without being permitted to read every collection that
// student appears in. The server counts what the caller cannot see.
//
// THE null CONTRACT — READ THIS BEFORE RENDERING A COUNT
// A count is `number | null`. null means "could not be determined", NOT zero.
// Rendering null as 0 would tell someone their deletion is harmless when it
// may not be, which is the exact failure the dialog exists to prevent. Use
// formatCount() rather than interpolating the raw value.

import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

export type ImpactEntityType = 'institute' | 'faculty' | 'student' | 'assessment';

export type DeletionImpact = {
  entityType: ImpactEntityType;
  entityId: string;
  /** Name/title captured server-side, for dialog copy. */
  label: string | null;
  instituteId: string | null;
  /** Collection → count. null for any count that could not be computed. */
  counts: Record<string, number | null>;
  /**
   * Keys within `counts` that will be PRESERVED, not destroyed. The locked
   * guarantee is that account deletion never touches attempts or reports;
   * listing them beside faculty and students without saying so would read as
   * "all of this will be destroyed" — the opposite of the truth.
   */
  preserved: string[];
};

/**
 * Fetch the dependency counts for an entity. Read-only and side-effect free;
 * safe to call on every dialog open.
 *
 * Throws if the caller isn't permitted to inspect the entity, so callers
 * should render a neutral fallback rather than assuming zero impact.
 */
export async function getDeletionImpact(
  entityType: ImpactEntityType,
  entityId: string,
): Promise<DeletionImpact> {
  const call = httpsCallable<
    { entityType: ImpactEntityType; entityId: string },
    { ok: true } & DeletionImpact
  >(functions, 'getDeletionImpact');
  const res = await call({ entityType, entityId });
  const d = res.data;
  return {
    entityType: d.entityType,
    entityId: d.entityId,
    label: d.label ?? null,
    instituteId: d.instituteId ?? null,
    counts: d.counts ?? {},
    preserved: d.preserved ?? [],
  };
}

// ── Presentation helpers ──────────────────────────────────────────

const LABELS: Record<string, string> = {
  faculty:       'Faculty',
  students:      'Students',
  assessments:   'Assessments',
  attempts:      'Exam attempts',
  reports:       'Question reports',
  schools:       'Schools',
  programs:      'Programs',
  courses:       'Courses',
  questions:     'Questions',
  questionGroups: 'Grouped sets',
  questionBanks: 'Question banks',
  mappings:      'Academic mappings',
  memberships:   'Exam allocations',
  members:       'Allocated students',
};

export function impactLabel(key: string): string {
  return LABELS[key] ?? key;
}

/**
 * Render a count for display. null becomes "unknown" — never "0".
 * See the null contract in the header.
 */
export function formatCount(n: number | null): string {
  if (n === null || n === undefined) return 'unknown';
  return n.toLocaleString();
}

/**
 * Rows worth showing, largest first. Zero-count rows are dropped (they add
 * noise), but null rows are KEPT — "unknown" is information the person needs
 * in order to judge the risk.
 */
export function impactRows(
  impact: DeletionImpact | null,
): Array<{ key: string; label: string; count: number | null; preserved: boolean }> {
  if (!impact) return [];
  return Object.entries(impact.counts)
    .filter(([, n]) => n === null || n > 0)
    .sort((a, b) => (b[1] ?? Number.MAX_SAFE_INTEGER) - (a[1] ?? Number.MAX_SAFE_INTEGER))
    .map(([key, count]) => ({
      key,
      label: impactLabel(key),
      count,
      preserved: impact.preserved.includes(key),
    }));
}

/**
 * Does this entity have enough dependents that Archive should be recommended
 * over deletion?
 *
 * Preserved rows do not count toward the total: attempts survive account
 * deletion, so 40,000 of them are not an argument against removing the
 * account. Counting them would make the recommendation fire on almost every
 * student and train people to dismiss it.
 *
 * An unknown (null) count DOES trigger the recommendation — if we cannot
 * establish that a deletion is safe, the reversible option is the one to
 * suggest.
 */
export function shouldRecommendArchive(impact: DeletionImpact | null): boolean {
  if (!impact) return false;
  for (const [key, n] of Object.entries(impact.counts)) {
    if (impact.preserved.includes(key)) continue;
    if (n === null) return true;
    if (n > 0) return true;
  }
  return false;
}

/** One-line summary for compact confirmation UI. */
export function summarizeImpact(impact: DeletionImpact | null): string {
  const rows = impactRows(impact).filter((r) => !r.preserved);
  if (rows.length === 0) return 'No dependent records found.';
  return rows
    .slice(0, 3)
    .map((r) => `${formatCount(r.count)} ${r.label.toLowerCase()}`)
    .join(', ');
}