// ── ErasurePolicyPanel (Feature #15, Phase 7c) ────────────────────
// The two values that arm erasure. Web Owner only.
//
// Until both are set, every erasure attempt is refused server-side. That is
// deliberate: how long exam records must be kept, and whether deletion or
// anonymisation satisfies an erasure right, are legal answers rather than
// engineering ones. The system declines to guess and says so plainly instead
// of shipping a default that might be wrong in a destructive direction.
//
// The panel therefore reads as "not configured" rather than "disabled" — it
// is waiting for information, not switched off.

import { useState, useEffect } from 'react';
import { Loader2, Check, ShieldAlert, Info } from 'lucide-react';
import {
  getErasurePolicy,
  setErasurePolicy,
  policyIsConfigured,
  modeLabel,
  modeDescription,
  EMPTY_POLICY,
  type ErasurePolicy,
  type ErasureMode,
} from '../../lib/erasureService';

export function ErasurePolicyPanel({ webOwnerUid }: { webOwnerUid: string }) {
  const [policy, setPolicy] = useState<ErasurePolicy>(EMPTY_POLICY);
  const [years, setYears] = useState('');
  const [mode, setMode] = useState<ErasureMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getErasurePolicy()
      .then((p) => {
        if (cancelled) return;
        setPolicy(p);
        setYears(p.retentionYears === null ? '' : String(p.retentionYears));
        setMode(p.mode);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    const n = Number(years);
    if (years.trim() === '' || Number.isNaN(n) || n < 0) {
      setError('Enter the retention period in years (0 if none applies).');
      return;
    }
    if (!mode) {
      setError('Choose what erasure should do to exam records.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await setErasurePolicy(n, mode, webOwnerUid);
      setPolicy({
        retentionYears: n, mode,
        configuredBy: webOwnerUid, configuredAt: new Date().toISOString(),
      });
      setSaved(true);
    } catch (err) {
      setError((err as { message?: string })?.message || 'Could not save the policy.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs py-3" style={{ color: 'var(--ef-text-muted)' }}>
        <Loader2 size={12} className="animate-spin" /> Loading policy…
      </div>
    );
  }

  const configured = policyIsConfigured(policy);
  const pill = (on: boolean) => ({
    border: `1px solid ${on ? 'var(--ef-success-border-alt)' : 'var(--ef-border)'}`,
    borderRadius: 2,
    background: on ? 'var(--ef-success-bg-alt)' : 'var(--ef-surface)',
    color: on ? 'var(--ef-success)' : 'var(--ef-text-muted)',
    cursor: saving ? ('not-allowed' as const) : ('pointer' as const),
  });

  return (
    <div>
      {!configured && (
        <div className="flex items-start gap-2 text-xs px-2.5 py-2 mb-3"
          style={{ background: 'var(--ef-warning-bg)', border: '1px solid var(--ef-warning-border)', borderRadius: 2, color: 'var(--ef-warning-strong)' }}>
          <ShieldAlert size={12} style={{ marginTop: 1, flexShrink: 0 }} />
          <span>
            Erasure is not configured, so every erasure request will be refused.
            These two answers depend on your jurisdiction — the system will not
            guess at them.
          </span>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div>
          <label className="text-xs block mb-1" style={{ color: 'var(--ef-ink)' }}>
            Retention period for examination records
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              value={years}
              onChange={(e) => { setYears(e.target.value); setSaved(false); }}
              disabled={saving}
              placeholder="e.g. 5"
              className="text-xs px-2 py-1.5"
              style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', color: 'var(--ef-ink)', width: 90 }}
            />
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>years</span>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
            Erasure will be refused by default for anyone whose attempts fall
            inside this window. Enter 0 if no retention obligation applies.
          </p>
        </div>

        <div>
          <label className="text-xs block mb-1.5" style={{ color: 'var(--ef-ink)' }}>
            What erasure does to exam records
          </label>
          <div className="flex flex-col gap-1.5">
            {(['delete', 'anonymize'] as ErasureMode[]).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setSaved(false); }}
                disabled={saving}
                className="text-xs px-2.5 py-2 text-left"
                style={pill(mode === m)}
              >
                <span style={{ fontWeight: 500 }}>{modeLabel(m)}</span>
                <span className="block mt-0.5" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
                  {modeDescription(m)}
                </span>
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{error}</p>}

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 text-xs px-4 py-2"
            style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: saving ? 'not-allowed' : 'pointer' }}
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} strokeWidth={2} />}
            {configured ? 'Update policy' : 'Arm erasure'}
          </button>
          {saved && <span className="text-xs" style={{ color: 'var(--ef-success)' }}>Saved.</span>}
        </div>

        {configured && policy.configuredAt && (
          <p className="flex items-start gap-1.5 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
            <Info size={11} style={{ marginTop: 1, flexShrink: 0 }} />
            Configured {policy.configuredAt.slice(0, 10)}. Erasure requests can
            now be carried out, subject to the retention window above.
          </p>
        )}
      </div>
    </div>
  );
}