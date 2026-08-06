// ══════════════════════════════════════════════════════════════════
// ALLOCATION PANEL CORE — Phase D2 (plans/ALLOCATION_UI_PLAN.md §2)
// The whole "By Hierarchy" allocation surface: institute → node type
// (with live counts) → node chips + picker → live resolved preview.
// Shared-core discipline: mounted only from the webOwner builder's
// Step 3 in v1; the institute/faculty mirror later is a mount + scope.
//
// Draft state is OWNED BY THE CALLER (lifted) so it survives wizard
// step navigation — this component is deliberately stateless about
// the selection itself.
// ══════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Pencil, Plus, X } from 'lucide-react';
import {
  ALLOCATION_NODE_TYPE_LABELS,
  ALLOCATION_SELECTABLE_TYPES,
  emptyAllocationDraft,
  listInstitutesForAllocation,
  loadHierarchyBundle,
  nodeRowsOfType,
  nodeTypeCounts,
  previewAllocation,
  type AllocationDraft,
  type AllocationNodeType,
  type HierarchyBundle,
  type ResolvePreviewResponse,
} from '../../../../lib/allocationService';
import type { Institute } from '../../../../lib/firebaseService';
import { NodePickerModal } from './NodePickerModal';
import { AllocationPreview } from './AllocationPreview';

const INK = 'var(--ef-ink)', MUTED = 'var(--ef-text-muted)', FAINT = 'var(--ef-text-muted)', LINE = 'var(--ef-border)', PAPER = 'var(--ef-surface)';

const selectStyle: React.CSSProperties = {
  width: '100%', border: `1px solid ${LINE}`, borderRadius: 2,
  background: PAPER, color: INK, fontSize: 13, padding: '9px 12px', outline: 'none',
};

type Props = {
  draft: AllocationDraft;
  setDraft: (d: AllocationDraft) => void;
  /** Present in edit mode (assessment already exists). Absent in create mode —
      preview runs against a placeholder id, commit happens post-save. */
  assessmentId?: string;
  /** Current committed allocation version (0 if none). */
  version?: number;
};

export function AllocationPanelCore({ draft, setDraft, assessmentId, version = 0 }: Props) {
  const [institutes, setInstitutes] = useState<Institute[]>([]);
  const [loadingInstitutes, setLoadingInstitutes] = useState(true);

  const [bundle, setBundle] = useState<HierarchyBundle | null>(null);
  const [loadingBundle, setLoadingBundle] = useState(false);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [preview, setPreview] = useState<ResolvePreviewResponse | null>(null);
  const [resolving, setResolving] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Institutes ───────────────────────────────────────────────────
  useEffect(() => {
    listInstitutesForAllocation()
      .then(setInstitutes)
      .finally(() => setLoadingInstitutes(false));
  }, []);

  // ── Hierarchy bundle for the chosen institute ────────────────────
  useEffect(() => {
    if (!draft.instituteId) { setBundle(null); return; }
    let cancelled = false;
    setLoadingBundle(true);
    loadHierarchyBundle(draft.instituteId)
      .then((b) => { if (!cancelled) setBundle(b); })
      .finally(() => { if (!cancelled) setLoadingBundle(false); });
    return () => { cancelled = true; };
  }, [draft.instituteId]);

  const typeCounts = useMemo(() => (bundle ? nodeTypeCounts(bundle) : null), [bundle]);

  const rows = useMemo(
    () => (bundle && draft.nodeType && draft.nodeType !== 'institute'
      ? nodeRowsOfType(bundle, draft.nodeType)
      : []),
    [bundle, draft.nodeType],
  );

  const selectedRows = useMemo(
    () => rows.filter((r) => draft.nodeIds.includes(r.id)),
    [rows, draft.nodeIds],
  );

  // node id → display name, for the preview's per-node breakdown (server
  // returns counts keyed by nodeId; names live in the loaded rows).
  const nodeNameOf = useMemo(() => {
    const m = new Map<string, string>();
    rows.forEach((r) => m.set(r.id, r.name));
    if (draft.nodeType === 'institute') m.set(draft.instituteId, draft.instituteName);
    return m;
  }, [rows, draft.nodeType, draft.instituteId, draft.instituteName]);

  // ── Debounced server-side preview (resolveAllocation dry-run) ────
  // In create mode we don't yet have an assessment id; the dry-run only reads
  // hierarchy + mappings (never the assessment), so a stable placeholder id
  // gives an accurate count. The real commit happens after save with the real id.
  const previewAssessmentId = assessmentId ?? '__preview__';
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const ready = draft.nodeType &&
      (draft.nodeType === 'institute' || draft.nodeIds.length > 0);
    if (!ready) { setPreview(null); setResolving(false); setPreviewError(null); return; }
    setResolving(true);
    setPreviewError(null);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await previewAllocation(
          previewAssessmentId,
          draft.nodeType as AllocationNodeType,
          draft.nodeIds,
          version,
        );
        setPreview(res);
      } catch (e: any) {
        setPreview(null);
        setPreviewError(e?.message ?? 'Could not resolve this selection.');
      } finally {
        setResolving(false);
      }
    }, 600);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [previewAssessmentId, draft.nodeType, draft.nodeIds, version]);

  // ── Handlers ─────────────────────────────────────────────────────
  const chooseInstitute = (id: string) => {
    const inst = institutes.find((i) => i.id === id);
    setDraft({ ...emptyAllocationDraft(), instituteId: id, instituteName: inst?.name ?? id });
  };

  const chooseType = (t: AllocationNodeType | '') =>
    setDraft({ ...draft, nodeType: t, nodeIds: [] });

  const removeNode = (id: string) =>
    setDraft({ ...draft, nodeIds: draft.nodeIds.filter((n) => n !== id) });

  const typeLabel = draft.nodeType ? ALLOCATION_NODE_TYPE_LABELS[draft.nodeType] : '';

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="space-y-5">

      {/* 1 · Institute */}
      <div>
        <p className="text-xs mb-1.5" style={{ color: MUTED }}>Institute</p>
        {loadingInstitutes ? (
          <div className="flex items-center gap-2 text-xs py-2" style={{ color: MUTED }}>
            <Loader2 size={12} className="animate-spin" /> Loading institutes…
          </div>
        ) : (
          <select value={draft.instituteId} onChange={(e) => chooseInstitute(e.target.value)} style={selectStyle}>
            <option value="">Select an institute…</option>
            {institutes.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        )}
      </div>

      {/* 2 · Node type (with live counts) */}
      {draft.instituteId && (
        <div>
          <p className="text-xs mb-1.5" style={{ color: MUTED }}>Target level</p>
          {loadingBundle ? (
            <div className="flex items-center gap-2 text-xs py-2" style={{ color: MUTED }}>
              <Loader2 size={12} className="animate-spin" /> Loading hierarchy…
            </div>
          ) : (
            <>
              <select value={draft.nodeType} onChange={(e) => chooseType(e.target.value as AllocationNodeType | '')} style={selectStyle}>
                <option value="">Select what to target…</option>
                {ALLOCATION_SELECTABLE_TYPES.map((t) => {
                  const n = t === 'institute' ? null : typeCounts?.[t] ?? 0;
                  const disabled = t !== 'institute' && (n ?? 0) === 0;
                  return (
                    <option key={t} value={t} disabled={disabled}>
                      {t === 'institute'
                        ? 'Entire institute — every student'
                        : `${ALLOCATION_NODE_TYPE_LABELS[t]}s — ${n}`}
                    </option>
                  );
                })}
              </select>
              <p className="text-xs mt-1.5" style={{ color: FAINT }}>
                Students with no academic mapping are only reachable via “Entire institute”.
              </p>
            </>
          )}
        </div>
      )}

      {/* 3 · Node selection (chips + picker) */}
      {draft.instituteId && bundle && draft.nodeType && draft.nodeType !== 'institute' && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs" style={{ color: MUTED }}>Selected {typeLabel.toLowerCase()}s</p>
            <button onClick={() => setPickerOpen(true)}
              className="flex items-center gap-1 text-xs transition-opacity hover:opacity-70"
              style={{ color: INK }}>
              {draft.nodeIds.length === 0
                ? <><Plus size={11} strokeWidth={2} /> Choose {typeLabel.toLowerCase()}s</>
                : <><Pencil size={11} strokeWidth={1.5} /> Edit selection</>}
            </button>
          </div>

          {selectedRows.length === 0 ? (
            <button onClick={() => setPickerOpen(true)}
              className="w-full text-xs py-6 transition-colors hover:bg-[var(--ef-canvas-raised)]"
              style={{ border: `1px dashed ${LINE}`, borderRadius: 3, color: MUTED }}>
              Choose who takes this exam
            </button>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {selectedRows.map((r) => (
                <span key={r.id} title={r.breadcrumb}
                  className="inline-flex items-center gap-1.5 text-xs px-2 py-1"
                  style={{ border: `1px solid ${LINE}`, borderRadius: 2, background: 'var(--ef-canvas-raised)', color: INK }}>
                  {r.name}
                  {r.breadcrumb && (
                    <span style={{ color: FAINT, maxWidth: 200 }} className="truncate">
                      {r.breadcrumb.split(' › ').slice(-2).join(' › ')}
                    </span>
                  )}
                  <button onClick={() => removeNode(r.id)} className="hover:opacity-60" style={{ color: MUTED }}>
                    <X size={10} strokeWidth={2} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 4 · Live preview (server dry-run) */}
      {previewError && (
        <div className="text-xs px-4 py-3" style={{ border: '1px solid var(--ef-danger-border)', background: 'var(--ef-danger-bg)', borderRadius: 3, color: 'var(--ef-danger)' }}>
          {previewError}
        </div>
      )}
      {(resolving || preview) && (
        <AllocationPreview
          loading={resolving}
          result={preview}
          nodeTypeLabel={typeLabel || 'node'}
          nodeNameOf={nodeNameOf}
          assessmentId={assessmentId}
        />
      )}

      {/* Picker */}
      {bundle && draft.nodeType && draft.nodeType !== 'institute' && (
        <NodePickerModal
          open={pickerOpen}
          nodeType={draft.nodeType}
          rows={rows}
          initialSelected={draft.nodeIds}
          onConfirm={(ids) => { setDraft({ ...draft, nodeIds: ids }); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}