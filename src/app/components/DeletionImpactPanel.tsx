// ── DeletionImpactPanel ───────────────────────────────────────────
// (Feature #15, Phase 1. Shared by every destructive confirmation so the
// three call sites cannot drift apart in what they warn about.)
//
// DESIGN RULE FROM THE SPEC: "Delete should never be the path of least
// resistance." This panel exists to put real, live-counted consequences in
// front of the person BEFORE they confirm — not to decorate a dialog that was
// going to be confirmed anyway.
//
// Two things it deliberately does NOT do:
//   • It never renders an unknown count as 0. See the null contract in
//     deletionImpact.ts — telling someone a deletion is harmless when we
//     could not verify that is the failure this whole panel exists to avoid.
//   • It never blocks. It informs; the parent owns the decision. A panel that
//     silently disabled the confirm button would move policy into a
//     presentational component, where Phase 3's rights model cannot see it.

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import {
  getDeletionImpact,
  impactRows,
  formatCount,
  shouldRecommendArchive,
  type DeletionImpact,
  type ImpactEntityType,
} from '../../lib/deletionImpact';

type Props = {
  entityType: ImpactEntityType;
  entityId: string;
  /** Called once the impact resolves, so the parent can adapt its copy. */
  onResolved?: (impact: DeletionImpact | null) => void;
};

export function DeletionImpactPanel({ entityType, entityId, onResolved }: Props) {
  const [impact, setImpact] = useState<DeletionImpact | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);

    getDeletionImpact(entityType, entityId)
      .then((res) => {
        if (cancelled) return;
        setImpact(res);
        onResolved?.(res);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[impact] failed', err);
        setFailed(true);
        onResolved?.(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
    // onResolved intentionally excluded — parents commonly pass an inline
    // closure, which would re-run this effect (and re-query) every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, entityId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs" style={{ color: '#6B6B66' }}>
        <Loader2 size={11} className="animate-spin" />
        Checking what this affects…
      </div>
    );
  }

  // A failed impact check is surfaced, never swallowed. If we cannot say what
  // a deletion affects, the person should know that before proceeding rather
  // than see an empty panel and read it as "nothing will be affected".
  if (failed) {
    return (
      <div
        className="flex items-start gap-2 text-xs px-2.5 py-2"
        style={{ background: '#FDF6E7', border: '1px solid #E8D9B0', borderRadius: 2, color: '#7A5B12' }}
      >
        <AlertTriangle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
        <span>
          Could not determine what this affects. Proceed with caution — dependent
          records may exist.
        </span>
      </div>
    );
  }

  const rows = impactRows(impact);
  const destructive = rows.filter((r) => !r.preserved);
  const preserved = rows.filter((r) => r.preserved);
  const recommendArchive = shouldRecommendArchive(impact);

  if (rows.length === 0) {
    return (
      <div className="text-xs" style={{ color: '#6B6B66' }}>
        No dependent records found.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {destructive.length > 0 && (
        <div
          className="px-2.5 py-2"
          style={{ background: '#FBF3F3', border: '1px solid #E8CFCF', borderRadius: 2 }}
        >
          <p className="text-xs mb-1.5" style={{ color: '#9B2828', fontWeight: 500 }}>
            This will affect:
          </p>
          <div className="flex flex-col gap-0.5">
            {destructive.map((r) => (
              <div key={r.key} className="flex items-center justify-between text-xs">
                <span style={{ color: '#6B6862' }}>{r.label}</span>
                <span
                  style={{
                    color: r.count === null ? '#7A5B12' : '#3A3833',
                    fontWeight: 500,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatCount(r.count)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {preserved.length > 0 && (
        <div className="flex items-start gap-2 px-2.5 py-2"
          style={{ background: '#F2F6F2', border: '1px solid #D3E0D3', borderRadius: 2 }}>
          <ShieldCheck size={12} style={{ marginTop: 1, flexShrink: 0, color: '#3F6B3F' }} />
          <div className="text-xs" style={{ color: '#3F6B3F' }}>
            <span style={{ fontWeight: 500 }}>Kept as academic records: </span>
            {preserved.map((r, i) => (
              <span key={r.key}>
                {i > 0 && ', '}
                {formatCount(r.count)} {r.label.toLowerCase()}
              </span>
            ))}
            .
          </div>
        </div>
      )}

      {recommendArchive && (
        <div className="flex items-start gap-2 text-xs px-2.5 py-2"
          style={{ background: '#FDF6E7', border: '1px solid #E8D9B0', borderRadius: 2, color: '#7A5B12' }}>
          <AlertTriangle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
          <span>
            This account has dependent records. Disabling it instead blocks access
            immediately and is reversible.
          </span>
        </div>
      )}
    </div>
  );
}