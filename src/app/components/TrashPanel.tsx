// ── Trash panel (Feature #15, Phase 6a) ───────────────────────────
// Soft-deleted accounts, with restore and — for the Web Owner — permanent
// deletion. This is the surface that makes bug (b) actually closed: deletion
// stopped being irreversible, and this is where the reversal lives.
//
// Restore is the PROMINENT action; permanent deletion is deliberately the
// quieter one behind a second confirmation. The whole point of the retention
// window is that the recoverable path should be the easy one.

import { useState, useEffect, useCallback } from 'react';
import { Loader2, RotateCcw, Trash2, AlertTriangle, Inbox } from 'lucide-react';
import {
  getAllTrashed,
  restoreEntity,
  purgeEntity,
  roleLabel,
  retentionLabel,
  type TrashedRecord,
} from '../../lib/lifecycleService';

type Props = {
  /** Omit for the Web Owner (sees everything); pass to scope to one tenant. */
  instituteId?: string;
  /** Only the Web Owner may permanently delete. */
  canPurge?: boolean;
};

export function TrashPanel({ instituteId, canPurge = false }: Props) {
  const [records, setRecords] = useState<TrashedRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRecords(await getAllTrashed(instituteId));
    } catch (err) {
      console.error('[trash] load failed', err);
      setError('Could not load deleted records.');
    } finally {
      setLoading(false);
    }
  }, [instituteId]);

  useEffect(() => { void load(); }, [load]);

  const doRestore = async (rec: TrashedRecord) => {
    setBusyId(rec.id);
    setError('');
    try {
      await restoreEntity(rec.role, rec.id);
      await load();
    } catch (err) {
      setError((err as { message?: string })?.message || 'Could not restore.');
    } finally {
      setBusyId(null);
    }
  };

  const doPurge = async (rec: TrashedRecord) => {
    setBusyId(rec.id);
    setError('');
    try {
      await purgeEntity(rec.role, rec.id);
      setConfirmPurgeId(null);
      await load();
    } catch (err) {
      setError((err as { message?: string })?.message || 'Could not permanently delete.');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs py-4" style={{ color: '#9A9891' }}>
        <Loader2 size={12} className="animate-spin" /> Loading deleted records…
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div className="flex items-start gap-2 text-xs px-2.5 py-2 mb-3"
          style={{ background: '#FBF3F3', border: '1px solid #E8CFCF', borderRadius: 2, color: '#9B2828' }}>
          <AlertTriangle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
          <span>{error}</span>
        </div>
      )}

      {records.length === 0 ? (
        <div className="flex items-center gap-2 text-xs py-4" style={{ color: '#B0AEA8' }}>
          <Inbox size={13} strokeWidth={1.5} /> Nothing deleted.
        </div>
      ) : (
        records.map((rec) => {
          const busy = busyId === rec.id;
          const confirming = confirmPurgeId === rec.id;
          return (
            <div key={`${rec.role}:${rec.id}`} className="px-3 py-2.5 mb-2"
              style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs" style={{ color: '#0C0C0B' }}>
                    <span style={{ color: '#9A9891' }}>{roleLabel(rec.role)} · </span>
                    {rec.name ?? rec.email ?? rec.id}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: '#9A9891' }}>
                    {retentionLabel(rec)}
                    {rec.deletedByRole ? ` · removed by ${rec.deletedByRole}` : ''}
                  </p>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => doRestore(rec)}
                    disabled={busy}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1"
                    style={{
                      border: '1px solid #C6DECE', borderRadius: 2,
                      background: '#F0F7F2', color: '#2A6B3A',
                      cursor: busy ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {busy ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} strokeWidth={2} />}
                    Restore
                  </button>

                  {canPurge && !confirming && (
                    <button
                      onClick={() => setConfirmPurgeId(rec.id)}
                      disabled={busy}
                      title="Permanently delete — cannot be undone"
                      className="p-1.5"
                      style={{ color: '#C4C3BD', cursor: busy ? 'not-allowed' : 'pointer' }}
                    >
                      <Trash2 size={12} strokeWidth={1.5} />
                    </button>
                  )}
                </div>
              </div>

              {confirming && (
                <div className="mt-2 px-2.5 py-2"
                  style={{ background: '#FBF3F3', border: '1px solid #E8CFCF', borderRadius: 2 }}>
                  <p className="text-xs mb-2" style={{ color: '#9B2828' }}>
                    {rec.role === 'institute'
                      ? 'This destroys the institute and everything belonging to it — faculty, students, content and attempts. It cannot be undone.'
                      : 'This removes the record permanently. It cannot be undone.'}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => doPurge(rec)}
                      disabled={busy}
                      className="flex items-center gap-1.5 text-xs px-3 py-1"
                      style={{ background: '#9B2828', color: '#FFFFFF', borderRadius: 2, cursor: busy ? 'not-allowed' : 'pointer' }}
                    >
                      {busy ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} strokeWidth={2} />}
                      Delete permanently
                    </button>
                    <button
                      onClick={() => setConfirmPurgeId(null)}
                      disabled={busy}
                      className="text-xs px-3 py-1"
                      style={{ border: '1px solid #E3E1DB', borderRadius: 2, color: '#6B6862', background: '#FFFFFF' }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}