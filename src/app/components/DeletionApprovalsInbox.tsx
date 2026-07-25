// ── Deletion approvals inbox (Feature #15, Phase 4) ───────────────
// One component for both hops. The viewer's role decides what it loads:
//
//   institute → requests raised by their faculty (they approve), AND their
//               own requests raised upward (read-only, awaiting Web Owner)
//   webOwner  → institute-raised requests awaiting them
//
// Approving EXECUTES the deletion server-side. The button says so plainly —
// "Approve & delete" — because an approver who thinks they are merely
// authorising something is an approver who will click too fast.

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Check, X, Inbox, AlertTriangle } from 'lucide-react';
import {
  getDeletionRequestsForInstitute,
  getDeletionRequestsForWebOwner,
  resolveDeletionRequest,
  requestStatusLabel,
  entityTypeLabel,
  type DeletionRequest,
} from '../../lib/deletionRequestService';
import { DeletionImpactPanel } from './DeletionImpactPanel';

type Props = {
  viewerRole: 'institute' | 'webOwner';
  /** Required for the institute view; ignored for webOwner. */
  instituteId?: string;
  onResolved?: () => void;
};

export function DeletionApprovalsInbox({ viewerRole, instituteId, onResolved }: Props) {
  const [requests, setRequests] = useState<DeletionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = viewerRole === 'webOwner'
        ? await getDeletionRequestsForWebOwner('pending')
        : await getDeletionRequestsForInstitute(instituteId ?? '');
      setRequests(list);
    } catch (err) {
      console.error('[deletion inbox] load failed', err);
      setError('Could not load requests.');
    } finally {
      setLoading(false);
    }
  }, [viewerRole, instituteId]);

  useEffect(() => { void load(); }, [load]);

  const act = async (req: DeletionRequest, decision: 'approve' | 'reject') => {
    setBusyId(req.id);
    setError('');
    try {
      await resolveDeletionRequest(req.id, decision, note.trim() || undefined);
      setNote('');
      setExpandedId(null);
      await load();
      onResolved?.();
    } catch (err) {
      console.error('[deletion inbox] resolve failed', err);
      setError((err as { message?: string })?.message || 'Could not resolve the request.');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs py-4" style={{ color: '#9A9891' }}>
        <Loader2 size={12} className="animate-spin" /> Loading requests…
      </div>
    );
  }

  const pending = requests.filter((r) => r.status === 'pending');
  // An institute admin sees two distinct things: what they must decide, and
  // what they are waiting on. Mixing them would make the actionable set
  // ambiguous at a glance.
  const mine = viewerRole === 'institute'
    ? pending.filter((r) => r.approverRole === 'webOwner')
    : [];
  const toDecide = pending.filter((r) => r.approverRole === viewerRole);
  const resolved = requests.filter((r) => r.status !== 'pending').slice(0, 10);

  return (
    <div>
      {error && (
        <div className="flex items-start gap-2 text-xs px-2.5 py-2 mb-3"
          style={{ background: '#FBF3F3', border: '1px solid #E8CFCF', borderRadius: 2, color: '#9B2828' }}>
          <AlertTriangle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
          <span>{error}</span>
        </div>
      )}

      {toDecide.length === 0 && mine.length === 0 && (
        <div className="flex items-center gap-2 text-xs py-4" style={{ color: '#B0AEA8' }}>
          <Inbox size={13} strokeWidth={1.5} /> No pending deletion requests.
        </div>
      )}

      {toDecide.length > 0 && (
        <>
          <p className="text-xs mb-2" style={{ color: '#0C0C0B', letterSpacing: '0.05em' }}>
            AWAITING YOUR DECISION ({toDecide.length})
          </p>
          {toDecide.map((r) => {
            const open = expandedId === r.id;
            const busy = busyId === r.id;
            return (
              <div key={r.id} className="px-3 py-3 mb-2"
                style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs" style={{ color: '#0C0C0B' }}>
                      Delete {entityTypeLabel(r.entityType).toLowerCase()}{' '}
                      <span style={{ color: '#6B6B66' }}>{r.entityLabel ?? r.entityId}</span>
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: '#9A9891' }}>
                      Requested by {r.requesterRole}
                      {r.reason ? ` — “${r.reason}”` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => { setExpandedId(open ? null : r.id); setNote(''); }}
                    className="text-xs px-2 py-1 flex-shrink-0"
                    style={{ border: '1px solid #E3E1DB', borderRadius: 2, color: '#6B6862', background: '#FFFFFF' }}
                  >
                    {open ? 'Close' : 'Review'}
                  </button>
                </div>

                {open && (
                  <div className="mt-3 flex flex-col gap-2">
                    {/* The approver sees the same live counts the requester
                        would have seen — the decision needs the consequences,
                        not just the request text. */}
                    <DeletionImpactPanel entityType={r.entityType} entityId={r.entityId} />

                    <input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Note (optional) — recorded in the audit trail"
                      disabled={busy}
                      className="text-xs px-2 py-1.5 w-full"
                      style={{ border: '1px solid #E3E1DB', borderRadius: 2, color: '#0C0C0B', background: '#FFFFFF' }}
                    />

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => act(r, 'approve')}
                        disabled={busy}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5"
                        style={{ background: '#9B2828', color: '#FFFFFF', borderRadius: 2, cursor: busy ? 'not-allowed' : 'pointer' }}
                      >
                        {busy ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} strokeWidth={2} />}
                        Approve &amp; delete
                      </button>
                      <button
                        onClick={() => act(r, 'reject')}
                        disabled={busy}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5"
                        style={{ border: '1px solid #E3E1DB', borderRadius: 2, color: '#6B6862', background: '#FFFFFF', cursor: busy ? 'not-allowed' : 'pointer' }}
                      >
                        <X size={10} strokeWidth={2} /> Reject
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {mine.length > 0 && (
        <>
          <p className="text-xs mb-2 mt-4" style={{ color: '#0C0C0B', letterSpacing: '0.05em' }}>
            AWAITING THE WEB OWNER ({mine.length})
          </p>
          {mine.map((r) => (
            <div key={r.id} className="px-3 py-2.5 mb-2 flex items-center justify-between gap-3"
              style={{ background: '#F4F3F0', border: '1px dashed #DAD8D2', borderRadius: 2 }}>
              <p className="text-xs" style={{ color: '#7A7873' }}>
                Delete {entityTypeLabel(r.entityType).toLowerCase()}{' '}
                <span style={{ color: '#6B6B66' }}>{r.entityLabel ?? r.entityId}</span>
              </p>
              <span className="text-xs px-2 py-0.5 flex-shrink-0"
                style={{ border: '1px solid #E3E1DB', borderRadius: 2, color: '#B0AEA8', background: '#FFFFFF' }}>
                Pending
              </span>
            </div>
          ))}
        </>
      )}

      {resolved.length > 0 && (
        <>
          <p className="text-xs mb-2 mt-4" style={{ color: '#9A9891', letterSpacing: '0.05em' }}>
            RECENTLY RESOLVED
          </p>
          {resolved.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3 py-1.5">
              <span className="text-xs" style={{ color: '#9A9891' }}>
                {entityTypeLabel(r.entityType)} {r.entityLabel ?? r.entityId}
              </span>
              <span className="text-xs" style={{
                color: r.status === 'approved' ? '#9B2828' : '#B0AEA8',
              }}>
                {requestStatusLabel(r.status)}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}