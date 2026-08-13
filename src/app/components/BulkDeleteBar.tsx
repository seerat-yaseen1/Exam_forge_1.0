/**
 * BulkDeleteBar — selection toolbar, confirmation, and the result list.
 *
 * Shared by StudentTab and FacultyTab because the two need exactly the same
 * thing, and a second copy would be the place the two drift apart.
 *
 * This component orchestrates; it decides nothing about deletion. The rules,
 * the permissions, the retention window, the audit trail and every safeguard
 * live where they already lived — the bar calls runBulkDelete, which calls the
 * same callable the single-row delete calls. See the header of
 * src/lib/bulkDelete.ts for what is deliberately not sent.
 *
 * THE RESULT LIST IS THE DELIVERABLE, NOT THE PROGRESS BAR. A bulk action over
 * records that each carry their own safeguards will not produce one uniform
 * outcome, and pretending otherwise is how an admin comes away believing 40
 * records went when 6 are waiting on an approver and 2 were never touched. So
 * the list stays on screen until dismissed, grouped by what happened.
 */

import { useCallback, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  AlertTriangle, CheckCircle2, Clock, Loader2, ShieldAlert, Trash2, X, XCircle,
} from 'lucide-react';
import {
  runBulkDelete,
  summariseResults,
  removedIds,
  type BulkDeleteResult,
  type BulkDeleteRole,
  type BulkDeleteTarget,
} from '../../lib/bulkDelete';

type Props = {
  role: BulkDeleteRole;
  /** The selected records, already resolved to ids by the caller. */
  targets: BulkDeleteTarget[];
  /** Clear the caller's selection. */
  onClear: () => void;
  /** Ids that were actually deleted, so the caller can prune its table. */
  onDeleted: (ids: string[]) => void;
  /** Re-sync after a run, since requests and failures leave rows in place. */
  onFinished: () => void;
};

const NOUN: Record<BulkDeleteRole, [string, string]> = {
  student: ['student', 'students'],
  faculty: ['faculty member', 'faculty members'],
};

function plural(role: BulkDeleteRole, n: number): string {
  const [one, many] = NOUN[role];
  return `${n} ${n === 1 ? one : many}`;
}

export function BulkDeleteBar({ role, targets, onClear, onDeleted, onFinished }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning]       = useState(false);
  const [progress, setProgress]     = useState({ done: 0, total: 0 });
  const [results, setResults]       = useState<BulkDeleteResult[] | null>(null);

  // A ref, not state: the runner reads this between records and must see the
  // current value, not the one captured when the run started.
  const cancelRef = useRef(false);

  const run = useCallback(async () => {
    cancelRef.current = false;
    setConfirming(false);
    setRunning(true);
    setResults(null);
    setProgress({ done: 0, total: targets.length });

    const final = await runBulkDelete({
      role,
      targets,
      shouldStop: () => cancelRef.current,
      onResult: (_result, done, total) => setProgress({ done, total }),
    });

    setResults(final);
    setRunning(false);
    onDeleted(removedIds(final));
    onClear();
    onFinished();
  }, [role, targets, onDeleted, onClear, onFinished]);

  // ── The result list ─────────────────────────────────────────────
  if (results) {
    const s = summariseResults(results);
    const problems = results.filter(
      (r) => r.outcome.status === 'needs_individual' || r.outcome.status === 'failed',
    );

    return (
      <motion.div
        initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
        className="mb-4 px-4 py-3.5"
        style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 2 }}
      >
        <div className="flex items-start justify-between gap-3 mb-2.5">
          <p className="text-xs" style={{ color: 'var(--ef-ink)', letterSpacing: '0.06em' }}>
            DELETION COMPLETE
          </p>
          <button onClick={() => setResults(null)} style={{ color: 'var(--ef-text-muted)' }}>
            <X size={12} strokeWidth={1.5} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-1">
          {s.deleted > 0 && (
            <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ef-success)' }}>
              <CheckCircle2 size={11} strokeWidth={1.5} />{plural(role, s.deleted)} deleted
            </span>
          )}
          {s.requested > 0 && (
            <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ef-warning)' }}>
              <Clock size={11} strokeWidth={1.5} />{plural(role, s.requested)} sent for approval
            </span>
          )}
          {s.needsIndividual > 0 && (
            <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ef-warning)' }}>
              <ShieldAlert size={11} strokeWidth={1.5} />{s.needsIndividual} need individual confirmation
            </span>
          )}
          {s.failed > 0 && (
            <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ef-danger)' }}>
              <XCircle size={11} strokeWidth={1.5} />{s.failed} failed
            </span>
          )}
        </div>

        {/* Per-record detail for anything that did not simply delete. The ones
            that worked need no line each; the ones that did not are the whole
            reason this list exists. */}
        {problems.length > 0 && (
          <div className="flex flex-col gap-1.5 mt-2.5 pt-2.5"
            style={{ borderTop: '1px solid var(--ef-border-subtle)', maxHeight: '30vh', overflowY: 'auto' }}>
            {problems.map((r) => (
              <div key={r.id} className="flex items-baseline gap-2 text-xs">
                <span style={{ color: 'var(--ef-ink)', minWidth: 0 }} className="truncate">{r.label}</span>
                <span style={{
                  color: r.outcome.status === 'failed' ? 'var(--ef-danger)' : 'var(--ef-warning)',
                }}>
                  {r.outcome.status === 'needs_individual'
                    ? r.outcome.reason
                    : r.outcome.status === 'failed'
                    ? r.outcome.message
                    : ''}
                </span>
              </div>
            ))}
          </div>
        )}

        {s.requested > 0 && (
          <p className="text-xs mt-2.5" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
            Requests go to your approver. Nothing has been removed for those records yet.
          </p>
        )}
      </motion.div>
    );
  }

  // ── Running ─────────────────────────────────────────────────────
  if (running) {
    return (
      <div className="flex items-center gap-3 mb-4 px-4 py-3"
        style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
        <Loader2 size={12} strokeWidth={1.5} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
        <p className="text-xs flex-1" style={{ color: 'var(--ef-ink)' }}>
          Processing {progress.done} of {progress.total}…
        </p>
        <button
          onClick={() => { cancelRef.current = true; }}
          className="text-xs px-2.5 py-1"
          style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-subtle)', background: 'var(--ef-surface)' }}>
          Stop
        </button>
      </div>
    );
  }

  if (targets.length === 0) return null;

  // ── Confirmation ────────────────────────────────────────────────
  if (confirming) {
    return (
      <motion.div
        initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
        className="mb-4 px-4 py-3.5"
        style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}
      >
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', flexShrink: 0, marginTop: 1 }} />
          <div className="flex-1 min-w-0">
            <p className="text-xs" style={{ color: 'var(--ef-danger)', lineHeight: 1.6 }}>
              Delete {plural(role, targets.length)}? Each is removed through the same
              flow as a single deletion — recoverable from Trash during the
              retention window, and their exam records are preserved.
            </p>
            {/* Named plainly, because it is the difference between this and a
                loop that forces everything through: a record whose own
                safeguard stops it is reported, not overridden. */}
            <p className="text-xs mt-1.5" style={{ color: 'var(--ef-danger)', opacity: 0.85, lineHeight: 1.6 }}>
              Records that need an approval or an individual confirmation are
              listed afterwards rather than forced through.
            </p>

            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={() => void run()}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5"
                style={{ background: 'var(--ef-danger)', color: 'var(--ef-surface)', borderRadius: 2 }}>
                <Trash2 size={11} strokeWidth={1.5} />
                Delete {plural(role, targets.length)}
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="text-xs px-3 py-1.5"
                style={{ border: '1px solid var(--ef-danger-border)', borderRadius: 2, color: 'var(--ef-danger)', background: 'transparent' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    );
  }

  // ── Selection toolbar ───────────────────────────────────────────
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
        className="flex items-center gap-3 mb-4 px-4 py-2.5"
        style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2 }}
      >
        <p className="text-xs flex-1" style={{ color: 'var(--ef-ink)' }}>
          {plural(role, targets.length)} selected
        </p>
        <button
          onClick={onClear}
          className="text-xs px-2.5 py-1"
          style={{ color: 'var(--ef-text-muted)' }}>
          Clear
        </button>
        <button
          onClick={() => setConfirming(true)}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5"
          style={{ border: '1px solid var(--ef-danger-border)', borderRadius: 2, color: 'var(--ef-danger)', background: 'var(--ef-surface)' }}>
          <Trash2 size={11} strokeWidth={1.5} />Delete selected
        </button>
      </motion.div>
    </AnimatePresence>
  );
}
