// ── SubjectRequestsInbox (Feature #15, Phase 7b) ──────────────────
// Access and erasure requests, with their decisions.
//
// Records decisions. Destroys nothing.
//
// TWO DELIBERATE CHOICES
//   • Refusal is presented as an equal outcome, not a hidden escape hatch. If
//     retention obligations mean most erasure requests are lawfully refused,
//     the interface should make refusing-with-a-reason as ordinary as
//     fulfilling — and the reason box is required, because a refusal without
//     one is indistinguishable from ignoring the request.
//   • Request AGE leads. Under the split-controller arrangement the institute
//     carries the legal deadline while the Web Owner executes erasure, so the
//     clock is the Web Owner's obligation made visible.

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Check, X, Inbox, AlertTriangle, Clock } from 'lucide-react';
import {
  getSubjectRequests,
  decideSubjectRequest,
  typeLabel,
  statusLabel,
  ageLabel,
  type SubjectRequest,
} from '../../lib/subjectRequestService';
import { SubjectDataPanel } from './SubjectDataPanel';
import {
  executeErasure, isPolicyNotConfigured, retentionBlockDate, isRetentionUnknown,
} from '../../lib/erasureService';

type Props = {
  /** Omit for the Web Owner (all tenants); pass to scope to one institute. */
  instituteId?: string;
  /** Web Owner only — enables the erasure execution control. */
  canErase?: boolean;
  onChanged?: () => void;
};

export function SubjectRequestsInbox({ instituteId, canErase = false, onChanged }: Props) {
  const [requests, setRequests] = useState<SubjectRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  // Feature #15 Phase 7c — erasure execution state.
  const [confirmName, setConfirmName] = useState('');
  const [retentionBlock, setRetentionBlock] = useState<string | null>(null);
  const [override, setOverride] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRequests(await getSubjectRequests(instituteId));
    } catch (err) {
      console.error('[subject requests] load failed', err);
      setError('Could not load requests.');
    } finally {
      setLoading(false);
    }
  }, [instituteId]);

  useEffect(() => { void load(); }, [load]);

  const erase = async (req: SubjectRequest) => {
    setBusyId(req.id);
    setError('');
    try {
      await executeErasure({
        requestId: req.id,
        confirmName: confirmName.trim(),
        acknowledgeRetentionOverride: override || undefined,
        decision: reason.trim() || undefined,
      });
      setConfirmName(''); setReason(''); setOverride(false);
      setRetentionBlock(null); setOpenId(null);
      await load();
      onChanged?.();
    } catch (err) {
      // Branch on the server's error CODES rather than prose, so copy changes
      // never break the flow.
      if (isPolicyNotConfigured(err)) {
        setError('Erasure is not configured. Set the retention policy first.');
      } else if (isRetentionUnknown(err)) {
        setRetentionBlock('unknown');
        setError('Could not determine whether records are inside the retention window.');
      } else {
        const blockedUntil = retentionBlockDate(err);
        if (blockedUntil) {
          setRetentionBlock(blockedUntil);
          setError('This person has exam records inside the retention window.');
        } else {
          setError((err as { message?: string })?.message || 'Could not carry out the erasure.');
        }
      }
    } finally {
      setBusyId(null);
    }
  };

  const decide = async (req: SubjectRequest, outcome: 'fulfilled' | 'refused') => {
    if (outcome === 'refused' && !reason.trim()) {
      setError('A refusal must record a reason.');
      return;
    }
    setBusyId(req.id);
    setError('');
    try {
      await decideSubjectRequest({
        requestId: req.id,
        outcome,
        decision: reason.trim() || undefined,
        exportGenerated: outcome === 'fulfilled' && req.type === 'access',
      });
      setReason('');
      setOpenId(null);
      await load();
      onChanged?.();
    } catch (err) {
      setError((err as { message?: string })?.message || 'Could not record the decision.');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs py-4" style={{ color: 'var(--ef-text-muted)' }}>
        <Loader2 size={12} className="animate-spin" /> Loading requests…
      </div>
    );
  }

  const open = requests.filter((r) => r.status === 'open');
  const closed = requests.filter((r) => r.status !== 'open').slice(0, 10);

  return (
    <div>
      {error && (
        <div className="flex items-start gap-2 text-xs px-2.5 py-2 mb-3"
          style={{ background: '#FBF3F3', border: '1px solid #E8CFCF', borderRadius: 2, color: 'var(--ef-danger)' }}>
          <AlertTriangle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
          <span>{error}</span>
        </div>
      )}

      {open.length === 0 && closed.length === 0 && (
        <div className="flex items-center gap-2 text-xs py-4" style={{ color: 'var(--ef-text-muted)' }}>
          <Inbox size={13} strokeWidth={1.5} /> No access or erasure requests.
        </div>
      )}

      {open.map((r) => {
        const expanded = openId === r.id;
        const busy = busyId === r.id;
        return (
          <div key={r.id} className="px-3 py-3 mb-2"
            style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>
                  {typeLabel(r.type)} request —{' '}
                  <span style={{ color: 'var(--ef-text-muted)' }}>{r.subjectLabel ?? r.subjectId}</span>
                </p>
                <p className="text-xs mt-0.5 flex items-center gap-1" style={{ color: 'var(--ef-text-muted)' }}>
                  <Clock size={10} strokeWidth={1.5} />
                  Asked {ageLabel(r)}
                  {r.basis ? ` · “${r.basis}”` : ''}
                </p>
              </div>
              <button
                onClick={() => { setOpenId(expanded ? null : r.id); setReason(''); setError(''); }}
                className="text-xs px-2 py-1 flex-shrink-0"
                style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: '#6B6862', background: 'var(--ef-surface)' }}
              >
                {expanded ? 'Close' : 'Review'}
              </button>
            </div>

            {expanded && (
              <div className="mt-3 flex flex-col gap-2">
                {/* The decision needs the facts. For an access request this is
                    also how the export gets produced. */}
                <SubjectDataPanel
                  role={r.subjectRole}
                  uid={r.subjectId}
                  displayName={r.subjectLabel}
                />

                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={r.type === 'erasure'
                    ? 'Reason — e.g. records retained under statutory obligation until <date>'
                    : 'Note (optional for fulfilment, required to refuse)'}
                  disabled={busy}
                  rows={2}
                  className="text-xs px-2 py-1.5 w-full"
                  style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-ink)', background: 'var(--ef-surface)', resize: 'vertical' }}
                />

                <div className="flex items-center gap-2 flex-wrap">
                  {r.type === 'access' && (
                    <button
                      onClick={() => decide(r, 'fulfilled')}
                      disabled={busy}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5"
                      style={{ background: 'var(--ef-success)', color: 'var(--ef-surface)', borderRadius: 2, cursor: busy ? 'not-allowed' : 'pointer' }}
                    >
                      {busy ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} strokeWidth={2} />}
                      Mark fulfilled
                    </button>
                  )}
                  <button
                    onClick={() => decide(r, 'refused')}
                    disabled={busy}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5"
                    style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: '#6B6862', background: 'var(--ef-surface)', cursor: busy ? 'not-allowed' : 'pointer' }}
                  >
                    <X size={10} strokeWidth={2} /> Refuse with reason
                  </button>
                </div>

                {r.type === 'erasure' && canErase && (
                  <div className="flex flex-col gap-2 px-2.5 py-2"
                    style={{ background: '#FBF3F3', border: '1px solid #E8CFCF', borderRadius: 2 }}>
                    <p className="text-xs" style={{ color: 'var(--ef-danger)', lineHeight: 1.5 }}>
                      Erasure is permanent and bypasses the retention window —
                      there is no restore. Type the person&apos;s name to confirm.
                    </p>
                    <input
                      value={confirmName}
                      onChange={(e) => setConfirmName(e.target.value)}
                      placeholder={r.subjectLabel ?? 'Full name'}
                      disabled={busy}
                      className="text-xs px-2 py-1.5 w-full"
                      style={{ border: '1px solid #E8CFCF', borderRadius: 2, background: 'var(--ef-surface)', color: 'var(--ef-ink)' }}
                    />
                    {retentionBlock && (
                      <label className="flex items-start gap-1.5 text-xs" style={{ color: '#7A5B12' }}>
                        <input
                          type="checkbox"
                          checked={override}
                          onChange={(e) => setOverride(e.target.checked)}
                          disabled={busy}
                          style={{ marginTop: 2 }}
                        />
                        <span>
                          {retentionBlock === 'unknown'
                            ? 'Retention status could not be determined. Proceed anyway — recorded in the decision.'
                            : `Records exist inside the retention window (latest ${retentionBlock.slice(0, 10)}). Proceed anyway — recorded in the decision.`}
                        </span>
                      </label>
                    )}
                    <button
                      onClick={() => erase(r)}
                      disabled={busy || !confirmName.trim() || (!!retentionBlock && !override)}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5 self-start"
                      style={{
                        background: 'var(--ef-danger)', color: 'var(--ef-surface)', borderRadius: 2,
                        opacity: (!confirmName.trim() || (!!retentionBlock && !override)) ? 0.5 : 1,
                        cursor: busy ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {busy ? <Loader2 size={10} className="animate-spin" /> : <X size={10} strokeWidth={2} />}
                      Erase permanently
                    </button>
                  </div>
                )}
                {r.type === 'erasure' && !canErase && (
                  <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
                    Erasure is carried out by the Web Owner. Leave this open for
                    them, or refuse it with a reason.
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}

      {closed.length > 0 && (
        <>
          <p className="text-xs mb-2 mt-4" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.05em' }}>
            DECIDED
          </p>
          {closed.map((r) => (
            <div key={r.id} className="px-3 py-2 mb-1.5"
              style={{ background: '#F4F3F0', border: '1px solid #EDEBE5', borderRadius: 2 }}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs" style={{ color: '#7A7873' }}>
                  {typeLabel(r.type)} — {r.subjectLabel ?? r.subjectId}
                </span>
                <span className="text-xs flex-shrink-0"
                  style={{ color: r.status === 'refused' ? '#7A5B12' : '#3F6B3F' }}>
                  {statusLabel(r.status)}
                </span>
              </div>
              {r.decision && (
                <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>{r.decision}</p>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}