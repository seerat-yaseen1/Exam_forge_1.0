// ══════════════════════════════════════════════════════════════════
// ALLOCATION PREVIEW — Phase D2 (plans/ALLOCATION_UI_PLAN.md §5)
// The live answer to "who exactly gets this exam?": headline count,
// per-node breakdown (zero-count nodes flagged), and an expandable
// resolved list where every row answers "via which node".
// Counts come from the D2 client scaffold; the banner says so honestly.
// ══════════════════════════════════════════════════════════════════

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Search, Users } from 'lucide-react';
import type { AllocationPreviewResult } from '../../../../lib/allocationService';

const INK = '#0C0C0B', MUTED = '#9A9891', FAINT = '#C4C3BD', LINE = '#E3E1DB';

type Props = {
  loading: boolean;
  result: AllocationPreviewResult | null;
  nodeTypeLabel: string;
};

export function AllocationPreview({ loading, result, nodeTypeLabel }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');

  const filteredStudents = useMemo(() => {
    if (!result) return [];
    const q = search.trim().toLowerCase();
    if (!q) return result.students;
    return result.students.filter((s) =>
      s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q));
  }, [result, search]);

  const nodeNameOf = useMemo(() => {
    const m = new Map<string, string>();
    result?.byNode.forEach((n) => m.set(n.nodeId, n.name));
    return m;
  }, [result]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-5 py-4 text-xs"
        style={{ border: `1px solid ${LINE}`, borderRadius: 3, background: '#FAFAF8', color: MUTED }}>
        <Loader2 size={12} className="animate-spin" /> Resolving preview…
      </div>
    );
  }
  if (!result) return null;

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 3, background: '#FFFFFF' }}>

      {/* Headline */}
      <div className="flex items-center gap-2.5 px-5 py-4" style={{ borderBottom: `1px solid ${LINE}` }}>
        <Users size={14} strokeWidth={1.5} style={{ color: MUTED }} />
        <p className="text-sm flex-1" style={{ color: INK }}>
          <strong>{result.count.toLocaleString()}</strong> student{result.count !== 1 ? 's' : ''} will be allocated
          <span style={{ color: MUTED }}> · {result.byNode.length} {nodeTypeLabel.toLowerCase()}{result.byNode.length !== 1 ? 's' : ''}</span>
        </p>
        {result.count === 0 && (
          <span className="text-xs px-2 py-0.5" style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2, color: '#9B2828' }}>
            resolves to nobody
          </span>
        )}
      </div>

      {/* Per-node breakdown */}
      <div className="px-5 py-3 space-y-1.5" style={{ borderBottom: `1px solid ${LINE}` }}>
        {result.byNode.map((n) => (
          <div key={n.nodeId} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0 truncate" style={{ color: INK }}>
              {n.name}
              {n.breadcrumb && <span style={{ color: FAINT }}> · {n.breadcrumb}</span>}
            </span>
            <span className="flex-shrink-0" style={{ color: n.count === 0 ? '#B0742A' : MUTED }}>
              {n.count === 0 ? '0 students mapped' : n.count.toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      {/* Expandable resolved list */}
      <button onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-5 py-2.5 text-xs transition-colors hover:bg-[#FAFAF8]"
        style={{ color: MUTED }}>
        {expanded ? <ChevronDown size={12} strokeWidth={1.5} /> : <ChevronRight size={12} strokeWidth={1.5} />}
        View full list
      </button>

      {expanded && (
        <div style={{ borderTop: `1px solid ${LINE}` }}>
          <div className="flex items-center gap-2 px-5 py-2" style={{ borderBottom: `1px solid ${LINE}`, background: '#FAFAF8' }}>
            <Search size={11} strokeWidth={1.5} style={{ color: FAINT }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or email…"
              className="flex-1 text-xs py-1 outline-none bg-transparent" style={{ color: INK }} />
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {filteredStudents.slice(0, 500).map((s) => (
              <div key={s.id} className="flex items-baseline justify-between gap-3 px-5 py-1.5 text-xs"
                style={{ borderBottom: '1px solid #F1F0EC' }}>
                <span className="min-w-0 truncate" style={{ color: INK }}>
                  {s.name} <span style={{ color: FAINT }}>· {s.email}</span>
                </span>
                <span className="flex-shrink-0 truncate" style={{ color: FAINT, maxWidth: 220 }}>
                  via {s.viaNodeIds.map((id) => nodeNameOf.get(id) ?? id).join(', ')}
                </span>
              </div>
            ))}
            {filteredStudents.length > 500 && (
              <p className="text-xs px-5 py-2" style={{ color: MUTED }}>
                Showing first 500 of {filteredStudents.length.toLocaleString()} — refine the search to narrow.
              </p>
            )}
            {filteredStudents.length === 0 && (
              <p className="text-xs text-center py-6" style={{ color: MUTED }}>No matches.</p>
            )}
          </div>
        </div>
      )}

      {/* Honest scaffold banner — removed in Phase C when the server dry-run wires in */}
      <p className="text-xs px-5 py-2" style={{ borderTop: `1px solid ${LINE}`, color: FAINT, background: '#FAFAF8' }}>
        Preview computed locally from current mappings — the server-side resolver (and saving) lands with the backend phase.
      </p>
    </div>
  );
}