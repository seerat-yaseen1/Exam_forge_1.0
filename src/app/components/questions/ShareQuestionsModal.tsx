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

  // Escape closes. The backdrop click did this for mouse users from the
  // start; keyboard users had only the header's close button, which meant
  // tabbing to it through the whole form.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    // Audit 2026-08-06: the backdrop was flagged as an onClick div without a
    // role. Giving it one would be wrong — a click-anywhere-to-dismiss
    // backdrop is decoration, and announcing it as a button offers screen
    // reader users a control that duplicates the close button already in the
    // header. The actual defect was that dismissal was MOUSE-ONLY: there was
    // no Escape handler, and nothing marked the panel as a dialog. Both are
    // fixed here; the backdrop keeps its click and stays unannounced
    // (aria-hidden is not used — it would hide the dialog nested inside it).
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(12,12,11,0.4)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md mx-4"
        style={{ background: 'var(--ef-surface)', borderRadius: 4, border: '1px solid var(--ef-border)', maxHeight: '80vh', overflow: 'auto' }}
        role="dialog"
        aria-modal="true"
        aria-label={`Share ${questionIds.length} question${questionIds.length !== 1 ? 's' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
          <div className="flex items-center gap-2">
            <Share2 size={14} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
            <p className="text-sm" style={{ color: 'var(--ef-ink)' }}>
              Share {questionIds.length} question{questionIds.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button onClick={onClose} className="p-1" style={{ color: 'var(--ef-text-muted)' }}><X size={15} strokeWidth={1.5} /></button>
        </div>

        <div className="px-5 py-4">
          <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)' }}>
            Recipients inside your institute. Shared questions are read-only for them.
          </p>

          {/* Institute admin */}
          <button
            onClick={() => setShareAdmin((v) => !v)}
            className="w-full flex items-center justify-between gap-3 px-3 py-2.5 mb-2 transition-colors"
            style={{ border: `1px solid ${shareAdmin ? 'var(--ef-success-border-alt)' : 'var(--ef-border)'}`, borderRadius: 2, background: shareAdmin ? 'var(--ef-success-bg-alt)' : 'var(--ef-surface)' }}
          >
            <div className="flex items-center gap-2">
              <Users size={13} strokeWidth={1.5} style={{ color: shareAdmin ? 'var(--ef-success)' : 'var(--ef-text-muted)' }} />
              <span className="text-xs" style={{ color: 'var(--ef-ink)' }}>Institute Admin</span>
            </div>
            {shareAdmin && <Check size={13} strokeWidth={2} style={{ color: 'var(--ef-success)' }} />}
          </button>

          {/* Peer faculty */}
          {loading ? (
            <div className="flex items-center gap-2 py-3 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
              <Loader2 size={12} className="animate-spin" /> Loading faculty…
            </div>
          ) : peers.length === 0 ? (
            <p className="text-xs py-2" style={{ color: 'var(--ef-text-muted)' }}>No other faculty in your institute.</p>
          ) : (
            peers.map((f) => {
              const on = !!selected[f.id];
              return (
                <button
                  key={f.id}
                  onClick={() => togglePeer(f.id)}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2.5 mb-2 transition-colors"
                  style={{ border: `1px solid ${on ? 'var(--ef-success-border-alt)' : 'var(--ef-border)'}`, borderRadius: 2, background: on ? 'var(--ef-success-bg-alt)' : 'var(--ef-surface)' }}
                >
                  <div className="min-w-0 text-left">
                    <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>{f.name}</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>{f.email}</p>
                  </div>
                  {on && <Check size={13} strokeWidth={2} style={{ color: 'var(--ef-success)', flexShrink: 0 }} />}
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
            style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-canvas-raised)', color: 'var(--ef-ink)', outline: 'none' }}
          />

          {error && <p className="text-xs mt-2" style={{ color: 'var(--ef-danger)' }}>{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4" style={{ borderTop: '1px solid var(--ef-border-subtle)' }}>
          <button onClick={onClose} disabled={saving} className="text-xs px-3 py-2" style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving || recipientCount === 0}
            className="flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity hover:opacity-80"
            style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, opacity: saving || recipientCount === 0 ? 0.5 : 1, cursor: saving || recipientCount === 0 ? 'not-allowed' : 'pointer' }}
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