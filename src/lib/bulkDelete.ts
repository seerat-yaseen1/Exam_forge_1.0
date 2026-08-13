/**
 * BULK DELETE — an orchestration layer, and nothing else
 *
 * This module runs the EXISTING single-record deletion flow over a list of
 * records. It holds no policy of its own, and that is the whole design:
 *
 *   • it calls the same `deleteAuthUser` callable the single-row delete calls,
 *     with the same arguments;
 *   • it falls back to the same `submitDeletionRequest` on the same error code;
 *   • it never passes an argument the single-row flow would not have passed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, AND WHY
 *
 * `confirmLiveOwnership` is never sent. In the single-row faculty flow that
 * flag is a two-click checkpoint (FacultyTab.handleDelete): the first attempt
 * throws FACULTY_OWNS_LIVE_ASSESSMENTS, the UI shows the count, and the admin
 * confirms with a second click on the same button. Sending `true` from a batch
 * would turn a deliberate human checkpoint into an automatic override for
 * every record at once — which is precisely the safeguard being bypassed. So
 * those records are REPORTED AND SKIPPED, and the admin handles them one at a
 * time through the flow that already exists.
 *
 * `successorId` is never sent either. It is already optional on the callable
 * (`successorId?: string` → `pendingSuccessorId: successorId ?? null`), so
 * omitting it is byte-identical to a single delete where the admin left the
 * successor picker empty. No shared heir, no per-row picker, no new succession
 * semantics — the existing rules are untouched.
 *
 * A record this layer cannot process safely stays subject to the same
 * single-record flow, with its safeguards intact.
 */

import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';
import { isRequiresApproval, submitDeletionRequest } from './deletionRequestService';

export type BulkDeleteRole = 'student' | 'faculty';

/** One record to act on. The label is captured for the result list. */
export type BulkDeleteTarget = { id: string; label: string };

/**
 * What happened to one record.
 *
 *   deleted          — the call succeeded; the record is soft-deleted exactly
 *                      as a single delete would have left it.
 *   requested        — the caller holds the right in REQUEST mode, so an
 *                      approval request was filed instead. Not a failure.
 *   needs_individual — a safeguard in the single-record flow stopped it, and
 *                      clearing that safeguard requires a human decision this
 *                      layer must not make on their behalf.
 *   failed           — anything else, carrying the server's own message.
 */
export type BulkDeleteOutcome =
  | { status: 'deleted' }
  | { status: 'requested' }
  | { status: 'needs_individual'; reason: string; liveAssessments: number }
  | { status: 'failed'; message: string };

export type BulkDeleteResult = BulkDeleteTarget & { outcome: BulkDeleteOutcome };

/**
 * Read a failed delete attempt.
 *
 * Split out as a pure function so the branch that decides "skip this record"
 * versus "file a request" versus "report a failure" can be tested without a
 * Firebase mock — it is the part of this module where a mistake would be
 * invisible and would matter.
 *
 * Branches on error CODES, never on prose, for the same reason the single-row
 * handlers do: copy changes must not silently reroute a deletion.
 */
export function classifyDeleteError(err: unknown):
  | { kind: 'live_ownership'; count: number }
  | { kind: 'requires_approval' }
  | { kind: 'other'; message: string } {
  const message = (err as { message?: string })?.message ?? '';

  // Checked FIRST. A faculty member can both own live assessments and sit
  // behind an approval requirement; the live-exam checkpoint is the one that
  // must win, because filing a request would queue a deletion whose safeguard
  // has not been cleared.
  const live = /FACULTY_OWNS_LIVE_ASSESSMENTS:(\d+)/.exec(message);
  if (live) return { kind: 'live_ownership', count: Number(live[1]) };

  if (isRequiresApproval(err)) return { kind: 'requires_approval' };

  return {
    kind: 'other',
    // Strip the Firebase callable prefix so the result list reads as a reason
    // rather than as a stack trace.
    message: message.replace(/^.*?:\s*/, '') || 'Deletion failed.',
  };
}

/** Counts for the summary line. */
export function summariseResults(results: BulkDeleteResult[]): {
  deleted: number; requested: number; needsIndividual: number; failed: number;
} {
  let deleted = 0, requested = 0, needsIndividual = 0, failed = 0;
  for (const r of results) {
    if (r.outcome.status === 'deleted') deleted++;
    else if (r.outcome.status === 'requested') requested++;
    else if (r.outcome.status === 'needs_individual') needsIndividual++;
    else failed++;
  }
  return { deleted, requested, needsIndividual, failed };
}

/** Ids that actually left the list, so the caller can prune its own state. */
export function removedIds(results: BulkDeleteResult[]): string[] {
  return results.filter((r) => r.outcome.status === 'deleted').map((r) => r.id);
}

/**
 * Run the existing deletion flow over each target, in order.
 *
 * SEQUENTIAL ON PURPOSE. Each record is an Auth write plus a profile write
 * plus an audit row, and the single-row flow has always been one call at a
 * time; firing a hundred in parallel would be a different load profile against
 * the same callable, on the one operation where a rate-limit failure is
 * indistinguishable from a refusal. It also keeps the progress count honest.
 *
 * Never throws. Every record produces a result, including the ones that
 * failed, because the returned list IS the record of what happened — a bulk
 * run that throws halfway leaves the operator with no idea which records went.
 */
export async function runBulkDelete(params: {
  role: BulkDeleteRole;
  targets: BulkDeleteTarget[];
  /** Called after each record settles, for progress and live results. */
  onResult?: (result: BulkDeleteResult, done: number, total: number) => void;
  /** Checked BETWEEN records. A cancel never interrupts one mid-flight. */
  shouldStop?: () => boolean;
}): Promise<BulkDeleteResult[]> {
  const { role, targets, onResult, shouldStop } = params;

  // Identical shape to the single-row handlers in StudentTab and FacultyTab.
  const deleteAuthUser = httpsCallable<
    { role: BulkDeleteRole; uid: string },
    { ok: boolean }
  >(functions, 'deleteAuthUser');

  const results: BulkDeleteResult[] = [];

  for (const target of targets) {
    if (shouldStop?.()) break;

    let outcome: BulkDeleteOutcome;
    try {
      // No successorId. No confirmLiveOwnership. See the header.
      await deleteAuthUser({ role, uid: target.id });
      outcome = { status: 'deleted' };
    } catch (err) {
      const classified = classifyDeleteError(err);

      if (classified.kind === 'live_ownership') {
        outcome = {
          status: 'needs_individual',
          reason: 'Owns a live assessment — delete individually to confirm.',
          liveAssessments: classified.count,
        };
      } else if (classified.kind === 'requires_approval') {
        // The same fallback the single-row handlers perform, for the same
        // reason: holding the right in request mode is not a failure.
        try {
          await submitDeletionRequest(role, target.id);
          outcome = { status: 'requested' };
        } catch (subErr) {
          outcome = {
            status: 'failed',
            message: (subErr as { message?: string })?.message
              ?? 'Could not submit the approval request.',
          };
        }
      } else {
        outcome = { status: 'failed', message: classified.message };
      }
    }

    const result: BulkDeleteResult = { ...target, outcome };
    results.push(result);
    onResult?.(result, results.length, targets.length);
  }

  return results;
}
