// ══════════════════════════════════════════════════════════════════
// ALLOCATION PREVIEW — Phase C (plans/ALLOCATION_UI_PLAN.md §5)
// Renders the resolveAllocation(dryRun) response: headline count,
// per-node breakdown (zero-count flagged), blockers/warnings, delta,
// and an expandable resolved list paged from getAllocationPreviewPage.
// ══════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Search, Users } from 'lucide-react';
import {
  getAllocationPreviewPage,
  type AllocationMemberRow,
  type ResolvePreviewResponse,
} from '../../../../lib/allocationService';

const INK = '#0C0C0B', MUTED = '#9A9891', FAINT = '#C4C3BD', LINE = '#E3E1DB';

type Props = {
  loading: boolean;
  result: ResolvePreviewResponse | null;
  nodeTypeLabel: string;
  nodeNameOf: Map<string, string>;
  assessmentId?: string;
};

export function AllocationPreview({ loading, result, nodeTypeLabel, nodeNameOf, assessmentId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<AllocationMemberRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [search, setSearch] = useState('');

  const canPageList = Boolean(assessmentId);

  useEffect(() => {
    if (!expanded || !canPageList || rows.length > 0) return;
    setLoadingList(true);
    getAllocationPreviewPage(assessmentId!, { limit: 100 })
      .then((r) => { setRows(r.rows); setCursor(r.nextCursor); })
      .finally(() => setLoadingList(false));
  }, [expanded, canPageList, assessmentId, rows.length]);

  const loadMore = () => {
    if (!cursor || !assessmentId) return;
    setLoadingList(true);
    getAllocationPreviewPage(assessmentId, { limit: 100, cursor })
      .then((r) => { setRows((prev) => [...prev, ...r.rows]); setCursor(r.nextCursor); })
      .finally(() => setLoadingList(false));
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q));
  }, [rows, search]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-5 py-4 text-xs"
        style={{ border: `1px solid ${LINE}`, borderRadius: 3, background: '#FAFAF8', color: MUTED }}>
        <Loader2 size={12} className="animate-spin" /> Resolving on the server…
      </div>
    );
  }
  if (!result) return null;

  const blockers = result.commitBlockers ?? [];
  const nameFor = (id: string) => nodeNameOf.get(id) ?? id;

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 3, background: '#FFFFFF' }}>

      <div className="flex items-center gap-2.5 px-5 py-4" style={{ borderBottom: `1px solid ${LINE}` }}>
        <Users size={14} strokeWidth={1.5} style={{ color: MUTED }} />
        <p className="text-sm flex-1" style={{ color: INK }}>
          <strong>{result.resolvedCount.toLocaleString()}</strong> student{result.resolvedCount !== 1 ? 's' : ''} will be allocated
          <span style={{ color: MUTED }}> · {result.byNode.length} {nodeTypeLabel.toLowerCase()}{result.byNode.length !== 1 ? 's' : ''}</span>
        </p>
        {result.isLive && (
          <span className="text-xs px-2 py-0.5" style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2, color: '#9B2828' }}>
            LIVE
          </span>
        )}
      </div>

      {(blockers.length > 0 || result.warnings.length > 0 || result.errors.length > 0) && (
        <div className="px-5 py-3 space-y-1.5" style={{ borderBottom: `1px solid ${LINE}` }}>
          {result.errors.map((e, i) => (
            <p key={`e${i}`} className="flex items-start gap-1.5 text-xs" style={{ color: '#9B2828' }}>
              <AlertTriangle size={11} strokeWidth={1.5} className="mt-0.5 flex-shrink-0" /> {e}
            </p>
          ))}
          {blockers.map((b, i) => (
            <p key={`b${i}`} className="flex items-start gap-1.5 text-xs" style={{ color: '#9B2828' }}>
              <AlertTriangle size={11} strokeWidth={1.5} className="mt-0.5 flex-shrink-0" /> {b}
            </p>
          ))}
          {result.warnings.map((w, i) => (
            <p key={`w${i}`} className="flex items-start gap-1.5 text-xs" style={{ color: '#B0742A' }}>
              <AlertTriangle size={11} strokeWidth={1.5} className="mt-0.5 flex-shrink-0" /> {w}
            </p>
          ))}
        </div>
      )}

      <div className="px-5 py-3 space-y-1.5" style={{ borderBottom: `1px solid ${LINE}` }}>
        {result.byNode.map((n) => (
          <div key={n.nodeId} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0 truncate" style={{ color: INK }}>{nameFor(n.nodeId)}</span>
            <span className="flex-shrink-0" style={{ color: n.count === 0 ? '#B0742A' : MUTED }}>
              {n.count === 0 ? '0 students mapped' : n.count.toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      {(result.deltaCounts.added > 0 || result.deltaCounts.removed > 0) && (
        <div className="px-5 py-2 text-xs" style={{ borderBottom: `1px solid ${LINE}`, color: MUTED }}>
          Change since last save: <span style={{ color: '#2E7D32' }}>+{result.deltaCounts.added}</span>
          {result.deltaCounts.removed > 0 && <> · <span style={{ color: '#9B2828' }}>−{result.deltaCounts.removed}</span></>}
        </div>
      )}

      {canPageList ? (
        <>
          <button onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center gap-1.5 px-5 py-2.5 text-xs transition-colors hover:bg-[#FAFAF8]"
            style={{ color: MUTED }}>
            {expanded ? <ChevronDown size={12} strokeWidth={1.5} /> : <ChevronRight size={12} strokeWidth={1.5} />}
            View allocated students
          </button>
          {expanded && (
            <div style={{ borderTop: `1px solid ${LINE}` }}>
              <div className="flex items-center gap-2 px-5 py-2" style={{ borderBottom: `1px solid ${LINE}`, background: '#FAFAF8' }}>
                <Search size={11} strokeWidth={1.5} style={{ color: FAINT }} />
                <input value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search loaded rows…"
                  className="flex-1 text-xs py-1 outline-none bg-transparent" style={{ color: INK }} />
              </div>
              <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                {filtered.map((s) => (
                  <div key={s.docId} className="flex items-baseline justify-between gap-3 px-5 py-1.5 text-xs"
                    style={{ borderBottom: '1px solid #F1F0EC' }}>
                    <span className="min-w-0 truncate" style={{ color: INK }}>
                      {s.name} <span style={{ color: FAINT }}>· {s.email}</span>
                    </span>
                    <span className="flex-shrink-0 truncate" style={{ color: FAINT, maxWidth: 220 }}>
                      {s.source === 'manual' ? 'added manually' : `via ${s.viaNodeIds.map(nameFor).join(', ')}`}
                    </span>
                  </div>
                ))}
                {loadingList && (
                  <p className="flex items-center gap-2 text-xs px-5 py-3" style={{ color: MUTED }}>
                    <Loader2 size={11} className="animate-spin" /> Loading…
                  </p>
                )}
                {cursor && !loadingList && (
                  <button onClick={loadMore} className="text-xs px-5 py-2 hover:opacity-70" style={{ color: INK }}>
                    Load more
                  </button>
                )}
                {!loadingList && filtered.length === 0 && (
                  <p className="text-xs text-center py-6" style={{ color: MUTED }}>No members loaded yet.</p>
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="text-xs px-5 py-2.5" style={{ color: FAINT }}>
          The full student list becomes browsable after you save this assessment.
        </p>
      )}
    </div>
  );
}