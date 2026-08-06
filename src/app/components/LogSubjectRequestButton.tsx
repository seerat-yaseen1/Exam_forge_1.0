// ── LogSubjectRequestButton (Feature #15, Phase 7b) ───────────────
// Logs that a person asked for their data, or asked to be erased.
//
// Records only. Nothing is fulfilled, refused or destroyed here — that
// happens in the inbox, where the decision and its reason are captured.
//
// WHY receivedAt IS ASKED FOR SEPARATELY
// Compliance clocks run from when the PERSON asked, not from when someone got
// round to logging it. A request that arrived by email a week ago is already
// a week old, and defaulting it to "now" would quietly reset a deadline that
// is genuinely part-spent.

import { useState } from 'react';
import { Loader2, FilePlus2, Check } from 'lucide-react';
import { submitSubjectRequest, type SubjectRequestType } from '../../lib/subjectRequestService';

type Props = {
  subjectRole: 'student' | 'faculty';
  subjectId: string;
  onLogged?: () => void;
};

export function LogSubjectRequestButton({ subjectRole, subjectId, onLogged }: Props) {
  const [openForm, setOpenForm] = useState(false);
  const [type, setType] = useState<SubjectRequestType>('access');
  const [basis, setBasis] = useState('');
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await submitSubjectRequest({
        type,
        subjectRole,
        subjectId,
        basis: basis.trim() || undefined,
        // Date-only input; anchor to start of day UTC so the age calculation
        // never reads as negative because of a timezone offset.
        receivedAt: new Date(`${receivedAt}T00:00:00.000Z`).toISOString(),
      });
      setDone(true);
      setOpenForm(false);
      setBasis('');
      onLogged?.();
    } catch (err) {
      setError((err as { message?: string })?.message || 'Could not log the request.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ef-success)' }}>
        <Check size={11} strokeWidth={2} /> Request logged.
      </span>
    );
  }

  if (!openForm) {
    return (
      <button
        onClick={() => setOpenForm(true)}
        className="flex items-center gap-1.5 text-xs px-2.5 py-1 self-start"
        style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', color: '#6B6862' }}
      >
        <FilePlus2 size={11} strokeWidth={1.5} /> Log a data request
      </button>
    );
  }

  const pill = (on: boolean) => ({
    border: `1px solid ${on ? 'var(--ef-success-border-alt)' : 'var(--ef-border)'}`,
    borderRadius: 2,
    background: on ? 'var(--ef-success-bg-alt)' : 'var(--ef-surface)',
    color: on ? 'var(--ef-success)' : 'var(--ef-text-muted)',
    cursor: busy ? ('not-allowed' as const) : ('pointer' as const),
  });

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2"
      style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)', minWidth: 64 }}>They asked</span>
        {(['access', 'erasure'] as SubjectRequestType[]).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            disabled={busy}
            className="text-xs px-2.5 py-1"
            style={pill(type === t)}
          >
            {t === 'access' ? 'For their data' : 'To be erased'}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)', minWidth: 64 }}>On</span>
        <input
          type="date"
          value={receivedAt}
          onChange={(e) => setReceivedAt(e.target.value)}
          disabled={busy}
          className="text-xs px-2 py-1"
          style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', color: 'var(--ef-ink)' }}
        />
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>when they asked, not today</span>
      </div>

      <input
        value={basis}
        onChange={(e) => setBasis(e.target.value)}
        placeholder="What they asked for, in their words (optional)"
        disabled={busy}
        className="text-xs px-2 py-1.5 w-full"
        style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', color: 'var(--ef-ink)' }}
      />

      {error && <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{error}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy}
          className="flex items-center gap-1.5 text-xs px-3 py-1"
          style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: busy ? 'not-allowed' : 'pointer' }}
        >
          {busy ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} strokeWidth={2} />}
          Log it
        </button>
        <button
          onClick={() => { setOpenForm(false); setError(''); }}
          disabled={busy}
          className="text-xs px-3 py-1"
          style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)', background: 'var(--ef-surface)' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}