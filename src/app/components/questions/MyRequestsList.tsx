// ── My question requests (permission-model Phase 3) ───────────────
// Faculty-side view of their own submitted requests and each one's status.
// Read-only; the admin resolves them in the institute approvals inbox.

import { useEffect, useState } from 'react';
import { Loader2, Clock, Check, X } from 'lucide-react';
import {
  getRequestsForFaculty,
  type QuestionRequest,
  type QuestionRequestStatus,
} from '../../../lib/questionRequestService';

const TYPE_LABEL: Record<QuestionRequest['type'], string> = {
  create: 'Create', edit: 'Edit', delete: 'Delete', share: 'Share',
};

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

export function MyRequestsList({ facultyId }: { facultyId: string }) {
  const [rows, setRows] = useState<QuestionRequest[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    getRequestsForFaculty(facultyId)
      .then((r) => { if (alive) setRows(r); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [facultyId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-5 py-8 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
        <Loader2 size={13} className="animate-spin" /> Loading your requests…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
        NO REQUESTS YET
      </div>
    );
  }

  return (
    <div>
      {rows.map((r) => (
        <div key={r.id} className="flex items-center gap-4 px-5 py-3.5" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
          <span className="text-xs px-2 py-0.5 flex-shrink-0" style={{ background: 'var(--ef-border-subtle)', color: 'var(--ef-text-muted)', borderRadius: 2 }}>
            {TYPE_LABEL[r.type]}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-xs truncate" style={{ color: 'var(--ef-ink)' }}>
              {r.questionStem || <em style={{ color: 'var(--ef-text-muted)' }}>New question</em>}
            </p>
            {r.reviewNote && (
              <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>Note: {r.reviewNote}</p>
            )}
          </div>
          <StatusChip status={r.status} />
        </div>
      ))}
    </div>
  );
}