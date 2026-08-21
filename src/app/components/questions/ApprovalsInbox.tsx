// ── Institute approvals inbox (permission-model Phase 3B) ─────────
// Institute-admin surface. Lists question requests faculty raised (for
// actions their grant only permits in request mode) and lets the admin
// approve or reject each. Approval EXECUTES the action server-side via
// resolveQuestionRequest — this component never mutates questions itself.

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, Check, X, Clock, RefreshCw, Inbox } from 'lucide-react';
import {
  getRequestsForInstitute,
  resolveQuestionRequest,
  type QuestionRequest,
  type QuestionRequestStatus,
} from '../../../lib/questionRequestService';

const TYPE_LABEL: Record<QuestionRequest['type'], string> = {
  create: 'Create', edit: 'Edit', delete: 'Delete', share: 'Share',
};

const FILTERS: { key: QuestionRequestStatus | 'all'; label: string }[] = [
  { key: 'pending',  label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all',      label: 'All' },
];

function StatusChip({ status }: { status: QuestionRequestStatus }) {
  const map = {
    pending:  { bg: 'var(--ef-warning-bg)', fg: 'var(--ef-warning-strong)', icon: <Clock size={11} strokeWidth={1.5} />, label: 'Pending' },
    approved: { bg: 'var(--ef-success-bg)', fg: 'var(--ef-success)', icon: <Check size={11} strokeWidth={2} />,   label: 'Approved' },
    rejected: { bg: 'var(--ef-danger-bg)', fg: 'var(--ef-danger)', icon: <X size={11} strokeWidth={2} />,        label: 'Rejected' },
  }[status];
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5" style={{ background: map.bg, color: map.fg, borderRadius: 2, fontSize: 12 }}>
      {map.icon} {map.label}
    </span>
  );
}

export function ApprovalsInbox({
  instituteId,
  onPendingCountChange,
}: {
  instituteId: string;
  // Reports the current pending count up so the tab badge stays in sync.
  onPendingCountChange?: (n: number) => void;
}) {
  const [rows, setRows] = useState<QuestionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<QuestionRequestStatus | 'all'>('pending');
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const all = await getRequestsForInstitute(instituteId);
      setRows(all);
      onPendingCountChange?.(all.filter((r) => r.status === 'pending').length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load requests.');
    } finally {
      setLoading(false);
    }
  }, [instituteId, onPendingCountChange]);

  useEffect(() => { load(); }, [load]);

  const act = async (id: string, decision: 'approve' | 'reject') => {
    setActingId(id);
    setError('');
    try {
      await resolveQuestionRequest(id, decision);
      // Reflect locally, then refresh the pending count.
      setRows((prev) => {
        const next = prev.map((r) =>
          r.id === id ? { ...r, status: (decision === 'approve' ? 'approved' : 'rejected') as QuestionRequestStatus } : r,
        );
        onPendingCountChange?.(next.filter((r) => r.status === 'pending').length);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setActingId(null);
    }
  };

  const visible = filter === 'all' ? rows : rows.filter((r) => r.status === filter);

  return (
    <div>
      {/* Filter row */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-1.5">
          {FILTERS.map((f) => {
            const on = filter === f.key;
            const count = f.key === 'all' ? rows.length : rows.filter((r) => r.status === f.key).length;
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className="text-xs px-2.5 py-1 transition-all select-none"
                style={{
                  border: `1px solid ${on ? 'var(--ef-success-border-alt)' : 'var(--ef-border)'}`,
                  borderRadius: 2,
                  background: on ? 'var(--ef-success-bg-alt)' : 'var(--ef-surface)',
                  color: on ? 'var(--ef-success)' : 'var(--ef-text-muted)',
                }}
              >
                {f.label}{count > 0 ? ` (${count})` : ''}
              </button>
            );
          })}
        </div>
        <button onClick={load} disabled={loading} className="flex items-center gap-1 text-xs px-2 py-1" style={{ color: 'var(--ef-text-muted)' }}>
          <RefreshCw size={11} strokeWidth={1.5} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {error && <p className="text-xs mb-3" style={{ color: 'var(--ef-danger)' }}>{error}</p>}

      {loading ? (
        <div className="flex items-center gap-2 py-10 justify-center text-xs" style={{ color: 'var(--ef-text-muted)' }}>
          <Loader2 size={14} className="animate-spin" /> Loading requests…
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12" style={{ color: 'var(--ef-text-muted)' }}>
          <Inbox size={20} strokeWidth={1.25} />
          <p className="text-xs" style={{ letterSpacing: '0.08em' }}>
            {filter === 'pending' ? 'NO PENDING REQUESTS' : 'NOTHING HERE'}
          </p>
        </div>
      ) : (
        visible.map((r) => (
          <motion.div
            key={r.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-4 px-4 py-3.5"
            style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}
          >
            <span className="text-xs px-2 py-0.5 flex-shrink-0" style={{ background: 'var(--ef-border-subtle)', color: 'var(--ef-text-muted)', borderRadius: 2 }}>
              {TYPE_LABEL[r.type]}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-xs truncate" style={{ color: 'var(--ef-ink)' }}>
                {r.questionStem || <em style={{ color: 'var(--ef-text-muted)' }}>New question</em>}
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>
                by {r.facultyName}
              </p>
            </div>

            {r.status === 'pending' ? (
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  onClick={() => act(r.id, 'approve')}
                  disabled={actingId === r.id}
                  className="flex items-center gap-1 text-xs px-2.5 py-1"
                  style={{ background: 'var(--ef-success)', color: 'var(--ef-surface)', borderRadius: 2, cursor: actingId === r.id ? 'not-allowed' : 'pointer', opacity: actingId === r.id ? 0.6 : 1 }}
                >
                  {actingId === r.id ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} strokeWidth={2} />} Approve
                </button>
                <button
                  onClick={() => act(r.id, 'reject')}
                  disabled={actingId === r.id}
                  className="flex items-center gap-1 text-xs px-2.5 py-1"
                  style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-danger)', borderRadius: 2, cursor: actingId === r.id ? 'not-allowed' : 'pointer' }}
                >
                  <X size={10} strokeWidth={2} /> Reject
                </button>
              </div>
            ) : (
              <div className="flex-shrink-0"><StatusChip status={r.status} /></div>
            )}
          </motion.div>
        ))
      )}
    </div>
  );
}