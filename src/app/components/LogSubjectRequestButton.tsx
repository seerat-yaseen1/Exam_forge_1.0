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
      <span className="flex items-center gap-1.5 text-xs" style={{ color: '#2A6B3A' }}>
        <Check size={11} strokeWidth={2} /> Request logged.
      </span>
    );
  }

  if (!openForm) {
    return (
      <button
        onClick={() => setOpenForm(true)}
        className="flex items-center gap-1.5 text-xs px-2.5 py-1 self-start"
        style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', color: '#6B6862' }}
      >
        <FilePlus2 size={11} strokeWidth={1.5} /> Log a data request
      </button>
    );
  }

  const pill = (on: boolean) => ({
    border: `1px solid ${on ? '#C6DECE' : '#E3E1DB'}`,
    borderRadius: 2,
    background: on ? '#F0F7F2' : '#FFFFFF',
    color: on ? '#2A6B3A' : '#9A9891',
    cursor: busy ? ('not-allowed' as const) : ('pointer' as const),
  });

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2"
      style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs" style={{ color: '#B0AEA8', minWidth: 64 }}>They asked</span>
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
        <span className="text-xs" style={{ color: '#B0AEA8', minWidth: 64 }}>On</span>
        <input
          type="date"
          value={receivedAt}
          onChange={(e) => setReceivedAt(e.target.value)}
          disabled={busy}
          className="text-xs px-2 py-1"
          style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B' }}
        />
        <span className="text-xs" style={{ color: '#C4C3BD' }}>when they asked, not today</span>
      </div>

      <input
        value={basis}
        onChange={(e) => setBasis(e.target.value)}
        placeholder="What they asked for, in their words (optional)"
        disabled={busy}
        className="text-xs px-2 py-1.5 w-full"
        style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B' }}
      />

      {error && <p className="text-xs" style={{ color: '#9B2828' }}>{error}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy}
          className="flex items-center gap-1.5 text-xs px-3 py-1"
          style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, cursor: busy ? 'not-allowed' : 'pointer' }}
        >
          {busy ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} strokeWidth={2} />}
          Log it
        </button>
        <button
          onClick={() => { setOpenForm(false); setError(''); }}
          disabled={busy}
          className="text-xs px-3 py-1"
          style={{ border: '1px solid #E3E1DB', borderRadius: 2, color: '#9A9891', background: '#FFFFFF' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}