// ── Share questions modal (permission-model Phase 2B) ─────────────
// Faculty surface. Shares the selected questions with recipients INSIDE the
// caller's institute — peer faculty and/or the institute admin. The share
// RIGHT is enforced server-side by shareQuestionsAsRole; this modal only
// opens when the faculty holds that right (direct mode).

import { useEffect, useState } from 'react';
import { X, Loader2, Check, Share2, Users } from 'lucide-react';
import { getFacultyByInstitute, type Faculty } from '../../../lib/firebaseService';
import { shareQuestionsAsRole } from '../../../lib/questionBankService';
import { submitQuestionRequest } from '../../../lib/questionRequestService';

export function ShareQuestionsModal({
  instituteId,
  selfFacultyId,
  questionIds,
  questionStem,
  isRequest = false,
  onClose,
  onShared,
}: {
  instituteId: string;
  selfFacultyId: string;
  questionIds: string[];
  // For request mode, the single subject question's stem (inbox display).
  questionStem?: string;
  // When true, sharing is submitted as an approval request instead of
  // executing immediately.
  isRequest?: boolean;
  onClose: () => void;
  onShared: (count: number, wasRequest: boolean) => void;
}) {
  const [peers, setPeers] = useState<Faculty[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, { type: 'faculty' | 'institute' }>>({});
  const [shareAdmin, setShareAdmin] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    getFacultyByInstitute(instituteId)
      .then((list) => { if (alive) setPeers(list.filter((f) => f.id !== selfFacultyId && f.status === 'active')); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [instituteId, selfFacultyId]);

  const togglePeer = (id: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = { type: 'faculty' };
      return next;
    });
  };

  const recipientCount = Object.keys(selected).length + (shareAdmin ? 1 : 0);

  const submit = async () => {
    setError('');
    const recipients = [
      ...Object.keys(selected).map((id) => ({ id, type: 'faculty' as const })),
      ...(shareAdmin ? [{ id: instituteId, type: 'institute' as const }] : []),
    ];
    if (recipients.length === 0) { setError('Select at least one recipient.'); return; }
    setSaving(true);
    try {
      if (isRequest) {
        // Share requests carry a single subject question (the row's id).
        await submitQuestionRequest({
          type: 'share',
          questionId: questionIds[0],
          questionStem: questionStem ?? '',
          recipients,
          note: note.trim() || undefined,
        });
        onShared(recipients.length, true);
      } else {
        await shareQuestionsAsRole(questionIds, recipients, note.trim() || undefined);
        onShared(recipients.length, false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sharing failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(12,12,11,0.4)' }} onClick={onClose}>
      <div
        className="w-full max-w-md mx-4"
        style={{ background: '#FFFFFF', borderRadius: 4, border: '1px solid #E3E1DB', maxHeight: '80vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid #F0EFEB' }}>
          <div className="flex items-center gap-2">
            <Share2 size={14} strokeWidth={1.5} style={{ color: '#6B6B66' }} />
            <p className="text-sm" style={{ color: '#0C0C0B' }}>
              Share {questionIds.length} question{questionIds.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button onClick={onClose} className="p-1" style={{ color: '#9A9891' }}><X size={15} strokeWidth={1.5} /></button>
        </div>

        <div className="px-5 py-4">
          <p className="text-xs mb-3" style={{ color: '#9A9891' }}>
            Recipients inside your institute. Shared questions are read-only for them.
          </p>

          {/* Institute admin */}
          <button
            onClick={() => setShareAdmin((v) => !v)}
            className="w-full flex items-center justify-between gap-3 px-3 py-2.5 mb-2 transition-colors"
            style={{ border: `1px solid ${shareAdmin ? '#C6DECE' : '#E3E1DB'}`, borderRadius: 2, background: shareAdmin ? '#F0F7F2' : '#FFFFFF' }}
          >
            <div className="flex items-center gap-2">
              <Users size={13} strokeWidth={1.5} style={{ color: shareAdmin ? '#2A6B3A' : '#9A9891' }} />
              <span className="text-xs" style={{ color: '#0C0C0B' }}>Institute Admin</span>
            </div>
            {shareAdmin && <Check size={13} strokeWidth={2} style={{ color: '#2A6B3A' }} />}
          </button>

          {/* Peer faculty */}
          {loading ? (
            <div className="flex items-center gap-2 py-3 text-xs" style={{ color: '#9A9891' }}>
              <Loader2 size={12} className="animate-spin" /> Loading faculty…
            </div>
          ) : peers.length === 0 ? (
            <p className="text-xs py-2" style={{ color: '#B0AEA8' }}>No other faculty in your institute.</p>
          ) : (
            peers.map((f) => {
              const on = !!selected[f.id];
              return (
                <button
                  key={f.id}
                  onClick={() => togglePeer(f.id)}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2.5 mb-2 transition-colors"
                  style={{ border: `1px solid ${on ? '#C6DECE' : '#E3E1DB'}`, borderRadius: 2, background: on ? '#F0F7F2' : '#FFFFFF' }}
                >
                  <div className="min-w-0 text-left">
                    <p className="text-xs" style={{ color: '#0C0C0B' }}>{f.name}</p>
                    <p className="text-xs mt-0.5" style={{ color: '#9A9891' }}>{f.email}</p>
                  </div>
                  {on && <Check size={13} strokeWidth={2} style={{ color: '#2A6B3A', flexShrink: 0 }} />}
                </button>
              );
            })
          )}

          {/* Note */}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note (optional)"
            className="w-full text-xs px-3 py-2 mt-2"
            style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FAFAF8', color: '#0C0C0B', outline: 'none' }}
          />

          {error && <p className="text-xs mt-2" style={{ color: '#9B2828' }}>{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4" style={{ borderTop: '1px solid #F0EFEB' }}>
          <button onClick={onClose} disabled={saving} className="text-xs px-3 py-2" style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving || recipientCount === 0}
            className="flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity hover:opacity-80"
            style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, opacity: saving || recipientCount === 0 ? 0.5 : 1, cursor: saving || recipientCount === 0 ? 'not-allowed' : 'pointer' }}
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : <Share2 size={11} strokeWidth={2} />}
            {isRequest
              ? `Request share${recipientCount > 0 ? ` with ${recipientCount}` : ''}`
              : `Share${recipientCount > 0 ? ` with ${recipientCount}` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}