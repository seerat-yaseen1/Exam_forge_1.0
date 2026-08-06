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

const INK = 'var(--ef-ink)', MUTED = 'var(--ef-text-muted)', FAINT = 'var(--ef-text-muted)', LINE = 'var(--ef-border)';

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

  // Node id → display name. Defined before the hooks below that use it.
  const nameFor = (id: string) => nodeNameOf.get(id) ?? id;

  // Committed member docs only exist AFTER a save. Before that, the dry-run's
  // sampleStudents is the only view of who resolved — render that instead of an
  // empty list, so a non-zero count never sits above "no students".
  useEffect(() => {
    if (!expanded || !canPageList || rows.length > 0) return;
    setLoadingList(true);
    getAllocationPreviewPage(assessmentId!, { limit: 100 })
      .then((r) => { setRows(r.rows); setCursor(r.nextCursor); })
      .finally(() => setLoadingList(false));
  }, [expanded, canPageList, assessmentId, rows.length]);

  // Reset the committed cache when the selection changes — otherwise stale rows
  // from a previous node choice linger behind a fresh count.
  useEffect(() => {
    setRows([]); setCursor(null);
  }, [result?.resolvedCount, result?.byNode?.length]);

  const loadMore = () => {
    if (!cursor || !assessmentId) return;
    setLoadingList(true);
    getAllocationPreviewPage(assessmentId, { limit: 100, cursor })
      .then((r) => { setRows((prev) => [...prev, ...r.rows]); setCursor(r.nextCursor); })
      .finally(() => setLoadingList(false));
  };

  // One row shape for both sources: committed member docs (post-save, paged and
  // authoritative) or the dry-run sample (pre-save, capped at 50 by the server).
  type DisplayRow = {
    key: string; name: string; email: string; via: string; pending: boolean;
  };
  const committedRows: DisplayRow[] = useMemo(
    () => rows.map((r) => ({
      key: r.docId,
      name: r.name,
      email: r.email,
      via: r.source === 'manual' ? 'added manually' : `via ${r.viaNodeIds.map(nameFor).join(', ')}`,
      pending: false,
    })),
    [rows, nodeNameOf],
  );
  const sampleRows: DisplayRow[] = useMemo(
    () => (result?.sampleStudents ?? []).map((s) => ({
      key: `sample_${s.id}`,
      name: s.name,
      email: s.email,
      via: 'will be added on save',
      pending: true,
    })),
    [result],
  );
  // Committed rows win once loaded; otherwise show what the dry-run resolved.
  const displayRows = committedRows.length > 0 ? committedRows : sampleRows;
  const showingPending = committedRows.length === 0 && sampleRows.length > 0;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return displayRows;
    return displayRows.filter((r) => r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q));
  }, [displayRows, search]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-5 py-4 text-xs"
        style={{ border: `1px solid ${LINE}`, borderRadius: 3, background: 'var(--ef-canvas-raised)', color: MUTED }}>
        <Loader2 size={12} className="animate-spin" /> Resolving on the server…
      </div>
    );
  }
  if (!result) return null;

  const blockers = result.commitBlockers ?? [];

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 3, background: 'var(--ef-surface)' }}>

      <div className="flex items-center gap-2.5 px-5 py-4" style={{ borderBottom: `1px solid ${LINE}` }}>
        <Users size={14} strokeWidth={1.5} style={{ color: MUTED }} />
        <p className="text-sm flex-1" style={{ color: INK }}>
          <strong>{result.resolvedCount.toLocaleString()}</strong> student{result.resolvedCount !== 1 ? 's' : ''} will be allocated
          <span style={{ color: MUTED }}> · {result.byNode.length} {nodeTypeLabel.toLowerCase()}{result.byNode.length !== 1 ? 's' : ''}</span>
        </p>
        {result.isLive && (
          <span className="text-xs px-2 py-0.5" style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2, color: 'var(--ef-danger)' }}>
            LIVE
          </span>
        )}
      </div>

      {(blockers.length > 0 || result.warnings.length > 0 || result.errors.length > 0) && (
        <div className="px-5 py-3 space-y-1.5" style={{ borderBottom: `1px solid ${LINE}` }}>
          {result.errors.map((e, i) => (
            <p key={`e${i}`} className="flex items-start gap-1.5 text-xs" style={{ color: 'var(--ef-danger)' }}>
              <AlertTriangle size={11} strokeWidth={1.5} className="mt-0.5 flex-shrink-0" /> {e}
            </p>
          ))}
          {blockers.map((b, i) => (
            <p key={`b${i}`} className="flex items-start gap-1.5 text-xs" style={{ color: 'var(--ef-danger)' }}>
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
          {result.deltaCounts.removed > 0 && <> · <span style={{ color: 'var(--ef-danger)' }}>−{result.deltaCounts.removed}</span></>}
        </div>
      )}

      {canPageList ? (
        <>
          <button onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center gap-1.5 px-5 py-2.5 text-xs transition-colors hover:bg-[var(--ef-canvas-raised)]"
            style={{ color: MUTED }}>
            {expanded ? <ChevronDown size={12} strokeWidth={1.5} /> : <ChevronRight size={12} strokeWidth={1.5} />}
            {showingPending ? 'View students to be allocated' : 'View allocated students'}
          </button>
          {expanded && (
            <div style={{ borderTop: `1px solid ${LINE}` }}>
              {/* Pre-save notice: these resolved on the server but aren't committed yet. */}
              {showingPending && (
                <p className="text-xs px-5 py-2" style={{ background: 'var(--ef-canvas-raised)', borderBottom: `1px solid ${LINE}`, color: MUTED }}>
                  Not saved yet — these students will be allocated when you save.
                  {result.resolvedCount > sampleRows.length && (
                    <> Showing the first {sampleRows.length} of {result.resolvedCount.toLocaleString()}.</>
                  )}
                </p>
              )}
              <div className="flex items-center gap-2 px-5 py-2" style={{ borderBottom: `1px solid ${LINE}`, background: 'var(--ef-canvas-raised)' }}>
                <Search size={11} strokeWidth={1.5} style={{ color: FAINT }} />
                <input value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search loaded rows…"
                  className="flex-1 text-xs py-1 outline-none bg-transparent" style={{ color: INK }} />
              </div>
              <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                {filtered.map((s) => (
                  <div key={s.key} className="flex items-baseline justify-between gap-3 px-5 py-1.5 text-xs"
                    style={{ borderBottom: '1px solid #F1F0EC' }}>
                    <span className="min-w-0 truncate" style={{ color: INK }}>
                      {s.name} <span style={{ color: FAINT }}>· {s.email}</span>
                    </span>
                    <span className="flex-shrink-0 truncate" style={{ color: FAINT, maxWidth: 220 }}>
                      {s.via}
                    </span>
                  </div>
                ))}
                {loadingList && (
                  <p className="flex items-center gap-2 text-xs px-5 py-3" style={{ color: MUTED }}>
                    <Loader2 size={11} className="animate-spin" /> Loading…
                  </p>
                )}
                {cursor && !loadingList && !showingPending && (
                  <button onClick={loadMore} className="text-xs px-5 py-2 hover:opacity-70" style={{ color: INK }}>
                    Load more
                  </button>
                )}
                {!loadingList && filtered.length === 0 && (
                  <p className="text-xs text-center py-6" style={{ color: MUTED }}>
                    {search.trim()
                      ? 'No students match that search.'
                      : result.resolvedCount > 0
                        ? 'Save this assessment to allocate these students.'
                        : 'This selection resolves to no students.'}
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        /* Create mode (no assessment id yet) — the dry-run sample still shows. */
        <>
          <button onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center gap-1.5 px-5 py-2.5 text-xs transition-colors hover:bg-[var(--ef-canvas-raised)]"
            style={{ color: MUTED }}>
            {expanded ? <ChevronDown size={12} strokeWidth={1.5} /> : <ChevronRight size={12} strokeWidth={1.5} />}
            View students to be allocated
          </button>
          {expanded && (
            <div style={{ borderTop: `1px solid ${LINE}` }}>
              <p className="text-xs px-5 py-2" style={{ background: 'var(--ef-canvas-raised)', borderBottom: `1px solid ${LINE}`, color: MUTED }}>
                Not saved yet — these students will be allocated when you save.
                {result.resolvedCount > sampleRows.length && (
                  <> Showing the first {sampleRows.length} of {result.resolvedCount.toLocaleString()}.</>
                )}
              </p>
              <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                {sampleRows.map((s) => (
                  <div key={s.key} className="flex items-baseline justify-between gap-3 px-5 py-1.5 text-xs"
                    style={{ borderBottom: '1px solid #F1F0EC' }}>
                    <span className="min-w-0 truncate" style={{ color: INK }}>
                      {s.name} <span style={{ color: FAINT }}>· {s.email}</span>
                    </span>
                  </div>
                ))}
                {sampleRows.length === 0 && (
                  <p className="text-xs text-center py-6" style={{ color: MUTED }}>
                    {result.resolvedCount > 0
                      ? 'Resolved students will be listed here.'
                      : 'This selection resolves to no students.'}
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}