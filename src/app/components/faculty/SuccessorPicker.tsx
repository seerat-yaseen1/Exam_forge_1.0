// ── Successor picker (Feature #15, Phase 5a) ──────────────────────
// Shown in the faculty delete confirmation. Chooses who inherits the
// departing member's questions, banks and assessments.
//
// WHY IT DEFAULTS TO THE INSTITUTE ADMIN
// It is the one successor that always exists as long as the institute does,
// so it can never fail and needs nobody to choose anything. Putting a
// colleague first would make the safe outcome the one you have to opt into.
//
// WHY IT NEVER BLOCKS
// The picker is optional by design. An admin removing an account should not
// be forced to make a filing decision they may not be qualified to make —
// they can leave it on the default and the content lands somewhere real.
// Choosing a colleague is the better outcome when someone knows the right
// answer; the default is the safe one when they don't.
//
// The choice is re-validated SERVER-SIDE at execution time: a colleague
// picked today may be archived before an approval lands, and the server
// falls back to the institute admin rather than transferring to a dead
// account.

import { useState, useEffect } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { getFacultyByInstitute, type Faculty } from '../../../lib/firebaseService';

type Props = {
  instituteId: string;
  /** The faculty member being removed — never offered as their own successor. */
  excludeFacultyId: string;
  value: string | null;
  onChange: (successorId: string | null) => void;
  disabled?: boolean;
};

export function SuccessorPicker({
  instituteId,
  excludeFacultyId,
  value,
  onChange,
  disabled,
}: Props) {
  const [options, setOptions] = useState<Faculty[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getFacultyByInstitute(instituteId)
      .then((list) => {
        if (cancelled) return;
        // Only ACTIVE colleagues are offerable. Offering a disabled or
        // already-removed account would produce a choice the server is
        // guaranteed to reject and silently downgrade.
        setOptions(
          list.filter(
            (f) => f.id !== excludeFacultyId && f.status !== 'disabled',
          ),
        );
      })
      .catch((err) => {
        console.error('[successor] load failed', err);
        if (!cancelled) setOptions([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [instituteId, excludeFacultyId]);

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
        <Loader2 size={10} className="animate-spin" /> Loading colleagues…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
        <ArrowRight size={10} strokeWidth={1.5} />
        Their questions and assessments go to
      </label>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
        className="text-xs px-2 py-1.5 w-full"
        style={{
          border: '1px solid var(--ef-border)',
          borderRadius: 2,
          background: 'var(--ef-surface)',
          color: 'var(--ef-ink)',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <option value="">The institute administrator (default)</option>
        {options.map((f) => (
          <option key={f.id} value={f.id}>{f.name}</option>
        ))}
      </select>
      {options.length === 0 && (
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
          No other active faculty — the institute administrator will inherit.
        </span>
      )}
    </div>
  );
}