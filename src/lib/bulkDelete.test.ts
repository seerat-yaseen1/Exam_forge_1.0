/**
 * The classification behind bulk deletion.
 *
 * `classifyDeleteError` decides, for every record that did not delete, whether
 * to skip it, file an approval request, or report a failure. A mistake there is
 * invisible in the UI and consequential in both directions: mis-reading the
 * live-exam checkpoint as an ordinary failure hides a safeguard, and mis-reading
 * it as "requires approval" would queue a deletion whose safeguard was never
 * cleared. Hence tests on the branch itself rather than on the screen.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyDeleteError,
  summariseResults,
  removedIds,
  type BulkDeleteResult,
} from './bulkDelete';

const err = (message: string) => new Error(message);

describe('classifyDeleteError', () => {
  it('reads the faculty live-exam checkpoint, with its count', () => {
    const c = classifyDeleteError(err('FACULTY_OWNS_LIVE_ASSESSMENTS:3'));
    expect(c).toEqual({ kind: 'live_ownership', count: 3 });
  });

  it('finds the checkpoint inside a wrapped callable message', () => {
    // Firebase prefixes callable errors; the code still has to be found.
    const c = classifyDeleteError(err('failed-precondition: FACULTY_OWNS_LIVE_ASSESSMENTS:12'));
    expect(c).toEqual({ kind: 'live_ownership', count: 12 });
  });

  it('reads request mode as its own outcome, not as a failure', () => {
    expect(classifyDeleteError(err('DELETION_REQUIRES_APPROVAL')))
      .toEqual({ kind: 'requires_approval' });
  });

  it('prefers the live-exam checkpoint over the approval branch', () => {
    // Both can be true of one faculty member. Filing an approval request would
    // queue a deletion whose live-exam safeguard nobody has cleared, so the
    // checkpoint has to win.
    const c = classifyDeleteError(
      err('FACULTY_OWNS_LIVE_ASSESSMENTS:1 DELETION_REQUIRES_APPROVAL'),
    );
    expect(c).toEqual({ kind: 'live_ownership', count: 1 });
  });

  it('treats anything else as a failure, carrying the reason', () => {
    const c = classifyDeleteError(err('permission-denied: Insufficient permissions.'));
    expect(c).toEqual({ kind: 'other', message: 'Insufficient permissions.' });
  });

  it('never produces an empty reason', () => {
    expect(classifyDeleteError(err(''))).toEqual({ kind: 'other', message: 'Deletion failed.' });
    expect(classifyDeleteError(undefined)).toEqual({ kind: 'other', message: 'Deletion failed.' });
    expect(classifyDeleteError({})).toEqual({ kind: 'other', message: 'Deletion failed.' });
  });

  it('does not mistake a similar-looking message for the checkpoint', () => {
    const c = classifyDeleteError(err('faculty owns live assessments'));
    expect(c.kind).toBe('other');
  });
});

describe('summariseResults', () => {
  const results: BulkDeleteResult[] = [
    { id: 'a', label: 'A', outcome: { status: 'deleted' } },
    { id: 'b', label: 'B', outcome: { status: 'deleted' } },
    { id: 'c', label: 'C', outcome: { status: 'requested' } },
    { id: 'd', label: 'D', outcome: { status: 'needs_individual', reason: 'x', liveAssessments: 2 } },
    { id: 'e', label: 'E', outcome: { status: 'failed', message: 'nope' } },
  ];

  it('counts each outcome separately', () => {
    expect(summariseResults(results)).toEqual({
      deleted: 2, requested: 1, needsIndividual: 1, failed: 1,
    });
  });

  it('counts nothing for an empty run', () => {
    expect(summariseResults([])).toEqual({
      deleted: 0, requested: 0, needsIndividual: 0, failed: 0,
    });
  });

  it('keeps requested separate from deleted', () => {
    // A filed request has removed nothing yet. Folding it into "deleted" would
    // tell an admin the work is done when it is waiting on an approver.
    const s = summariseResults([{ id: 'c', label: 'C', outcome: { status: 'requested' } }]);
    expect(s.deleted).toBe(0);
    expect(s.requested).toBe(1);
  });
});

describe('removedIds', () => {
  it('returns only the records that actually left', () => {
    const results: BulkDeleteResult[] = [
      { id: 'a', label: 'A', outcome: { status: 'deleted' } },
      { id: 'b', label: 'B', outcome: { status: 'requested' } },
      { id: 'c', label: 'C', outcome: { status: 'needs_individual', reason: 'x', liveAssessments: 1 } },
      { id: 'd', label: 'D', outcome: { status: 'failed', message: 'nope' } },
    ];
    // The caller prunes its list with this. Including anything but a real
    // deletion would vanish a record from the table that is still there.
    expect(removedIds(results)).toEqual(['a']);
  });
});
