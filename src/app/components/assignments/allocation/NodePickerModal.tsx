// ══════════════════════════════════════════════════════════════════
// NODE PICKER MODAL — Phase D2 (plans/ALLOCATION_UI_PLAN.md §3)
// Search-first selection: one search input (hierarchy-aware, tokenized),
// lazy cascading ancestor-filter chips, persistent "Selected" pin section,
// rows grouped by immediate parent, select-all over the visible rows,
// and the "target the parent instead" nudge (system plan D10).
// No tree widget, no drill navigation — by design.
// ══════════════════════════════════════════════════════════════════

import { useMemo, useState } from 'react';
import { X, Search, CheckSquare, Square, Info } from 'lucide-react';
import {
  ALLOCATION_NODE_TYPE_LABELS,
  ALLOCATION_TYPE_ORDER,
  LEVEL_ID_FIELD,
  type AllocationNodeRow,
  type AllocationNodeType,
} from '../../../../lib/allocationService';

type Props = {
  open: boolean;
  nodeType: AllocationNodeType;
  rows: AllocationNodeRow[];        // all nodes of nodeType in the chosen institute
  initialSelected: string[];
  onConfirm: (nodeIds: string[]) => void;
  onClose: () => void;
};

const INK = 'var(--ef-ink)', MUTED = 'var(--ef-text-muted)', FAINT = 'var(--ef-text-muted)', LINE = 'var(--ef-border)', PAPER = 'var(--ef-surface)', BG = 'var(--ef-canvas)';

export function NodePickerModal({ open, nodeType, rows, initialSelected, onConfirm, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({}); // ancestorField → nodeId
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected));
  const [nudgeDismissed, setNudgeDismissed] = useState(false);

  // Ancestor levels ABOVE the picked type — the only legal filters (never the picked type itself).
  // Ancestor levels ABOVE the picked type — the only legal filters (never the
  // picked type itself). B-2: `course` isn't in the spine, but a course still
  // hangs under a semester/year, so its filters are the spine above semester.
  const filterLevels = useMemo(() => {
    if (nodeType === 'course') {
      return ['school', 'academicLevel', 'program', 'academicSession', 'academicYear', 'semester'] as
        Exclude<AllocationNodeType, 'institute'>[];
    }
    const idx = ALLOCATION_TYPE_ORDER.indexOf(nodeType);
    if (idx < 0) return [] as Exclude<AllocationNodeType, 'institute'>[];
    return ALLOCATION_TYPE_ORDER.slice(1, idx) as Exclude<AllocationNodeType, 'institute'>[];
  }, [nodeType]);

  // Rows surviving the current filter chips (cascade base for each dropdown).
  const filteredByChips = useMemo(
    () => rows.filter((r) => filterLevels.every((lv) => {
      const f = filters[LEVEL_ID_FIELD[lv]];
      return !f || r.ancestors[LEVEL_ID_FIELD[lv]] === f;
    })),
    [rows, filters, filterLevels],
  );

  // Layer 1 — tokenized hierarchy-aware search: every token must hit name or a breadcrumb segment.
  const visible = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return filteredByChips;
    return filteredByChips.filter((r) => {
      const hay = `${r.breadcrumb} ${r.name}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [filteredByChips, query]);

  // Layer 2 — lazily rendered, cascading dropdowns: distinct ancestor values among
  // currently-chip-filtered rows, labeled by name, disambiguated by their own parent.
  const dropdowns = useMemo(() => {
    return filterLevels.map((lv) => {
      const field = LEVEL_ID_FIELD[lv];
      const counts = new Map<string, number>();
      filteredByChips.forEach((r) => {
        const id = r.ancestors[field];
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      });
      // Distinct value names, using each row's breadcrumb to keep duplicates tellable-apart.
      const nameFor = new Map<string, string>();
      filteredByChips.forEach((r) => {
        const id = r.ancestors[field];
        if (!id || nameFor.has(id)) return;
        const parts = r.breadcrumb.split(' › ');
        const pos = filterLevels.indexOf(lv);
        const label = parts[pos] ?? id;
        const parent = pos > 0 ? parts[pos - 1] : '';
        // Only suffix the parent when the same display name exists under two parents.
        nameFor.set(id, parent ? `${label} — ${parent}` : label);
      });
      const options = [...counts.entries()]
        .map(([id, n]) => ({ id, label: nameFor.get(id) ?? id, n }))
        .sort((a, b) => a.label.localeCompare(b.label));
      return { level: lv, field, options };
    }).filter((d) => d.options.length > 1 || filters[d.field]); // lazy: render only when it can narrow
  }, [filterLevels, filteredByChips, filters]);

  const visibleIds = useMemo(() => visible.map((r) => r.id), [visible]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleAllVisible = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
    else visibleIds.forEach((id) => next.add(id));
    return next;
  });

  // D10 nudge: every selected node shares one immediate parent → suggest targeting the parent.
  const nudge = useMemo(() => {
    if (nudgeDismissed || selected.size < 2) return null;
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    const parents = new Set([...selected].map((id) => rowsById.get(id)?.breadcrumb ?? '·'));
    if (parents.size !== 1) return null;
    const sample = rowsById.get([...selected][0]!);
    if (!sample?.parentName || sample.parentName === '—') return null;
    // Only meaningful when the selection covers EVERY sibling under that parent.
    const siblings = rows.filter((r) => r.breadcrumb === sample.breadcrumb);
    if (siblings.length !== selected.size) return null;
    return { parentName: sample.parentName };
  }, [selected, rows, nudgeDismissed]);

  // Rows grouped by immediate parent (sticky headers).
  const groups = useMemo(() => {
    const m = new Map<string, AllocationNodeRow[]>();
    visible.forEach((r) => {
      const key = r.breadcrumb || '—';
      const arr = m.get(key) ?? [];
      arr.push(r);
      m.set(key, arr);
    });
    return [...m.entries()];
  }, [visible]);

  const pinned = useMemo(
    () => rows.filter((r) => selected.has(r.id)),
    [rows, selected],
  );

  if (!open) return null;

  const typeLabel = ALLOCATION_NODE_TYPE_LABELS[nodeType];

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center px-6"
      style={{ background: 'rgba(12,12,11,0.45)' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="flex flex-col"
        style={{ background: PAPER, border: `1px solid ${LINE}`, borderRadius: 3, width: '100%', maxWidth: 760, maxHeight: '82vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 flex-shrink-0" style={{ borderBottom: `1px solid ${LINE}` }}>
          <div>
            <p className="text-sm" style={{ color: INK }}>Select {typeLabel}s</p>
            <p className="text-xs mt-0.5" style={{ color: MUTED }}>
              Search by anything in the path — e.g. “data struct sec a”, “year 2 cse”
            </p>
          </div>
          <button onClick={onClose} className="transition-opacity hover:opacity-60" style={{ color: MUTED }}>
            <X size={15} strokeWidth={1.5} />
          </button>
        </div>

        {/* Search + filter chips */}
        <div className="px-6 pt-4 pb-3 space-y-2.5 flex-shrink-0" style={{ borderBottom: `1px solid ${LINE}`, background: 'var(--ef-canvas-raised)' }}>
          <div className="flex items-center gap-2 px-3" style={{ border: `1px solid ${LINE}`, borderRadius: 2, background: PAPER }}>
            <Search size={12} strokeWidth={1.5} style={{ color: FAINT }} />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${typeLabel.toLowerCase()}s…`}
              className="flex-1 text-xs py-2.5 outline-none bg-transparent" style={{ color: INK }} />
            {query && (
              <button onClick={() => setQuery('')} style={{ color: FAINT }} className="hover:opacity-60">
                <X size={11} strokeWidth={1.5} />
              </button>
            )}
          </div>

          {dropdowns.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              {dropdowns.map((d) => (
                <select key={d.field} value={filters[d.field] ?? ''}
                  onChange={(e) => setFilters((f) => {
                    const next = { ...f };
                    if (e.target.value) next[d.field] = e.target.value; else delete next[d.field];
                    return next;
                  })}
                  className="text-xs px-2 py-1.5"
                  style={{
                    border: `1px solid ${filters[d.field] ? INK : LINE}`, borderRadius: 2,
                    background: PAPER, color: filters[d.field] ? INK : MUTED, maxWidth: 190,
                  }}>
                  <option value="">{ALLOCATION_NODE_TYPE_LABELS[d.level]} — all</option>
                  {d.options.map((o) => (
                    <option key={o.id} value={o.id}>{o.label} ({o.n})</option>
                  ))}
                </select>
              ))}
              {Object.keys(filters).length > 0 && (
                <button onClick={() => setFilters({})} className="text-xs hover:opacity-60" style={{ color: MUTED }}>
                  Clear filters
                </button>
              )}
            </div>
          )}
        </div>

        {/* D10 nudge */}
        {nudge && (
          <div className="flex items-center gap-2 px-6 py-2 text-xs flex-shrink-0"
            style={{ background: 'var(--ef-warning-bg)', borderBottom: `1px solid ${LINE}`, color: 'var(--ef-warning-strong)' }}>
            <Info size={12} strokeWidth={1.5} />
            <span className="flex-1">
              You’ve selected every {typeLabel.toLowerCase()} under <strong>{nudge.parentName}</strong>.
              Targeting <strong>{nudge.parentName}</strong> itself would also include ones created later.
            </span>
            <button onClick={() => setNudgeDismissed(true)} className="hover:opacity-60" style={{ color: 'var(--ef-warning-strong)' }}>
              <X size={11} strokeWidth={1.5} />
            </button>
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {/* Selected pin section — survives search/filter changes (Layer 3) */}
          {pinned.length > 0 && (
            <div>
              <div className="sticky top-0 px-6 py-1.5 text-xs z-10"
                style={{ background: BG, borderBottom: `1px solid ${LINE}`, color: MUTED, letterSpacing: '0.08em' }}>
                SELECTED — {pinned.length}
              </div>
              {pinned.map((r) => (
                <RowItem key={`pin-${r.id}`} row={r} checked onToggle={() => toggle(r.id)} query={query} />
              ))}
            </div>
          )}

          {/* Select-all over visible rows */}
          {visible.length > 0 && (
            <button onClick={toggleAllVisible}
              className="w-full flex items-center gap-2.5 px-6 py-2 text-xs transition-colors hover:bg-[var(--ef-canvas-raised)]"
              style={{ borderBottom: `1px solid ${LINE}`, color: MUTED }}>
              {allVisibleSelected
                ? <CheckSquare size={13} strokeWidth={1.5} style={{ color: INK }} />
                : <Square size={13} strokeWidth={1.5} />}
              Select all shown ({visible.length})
            </button>
          )}

          {groups.map(([crumb, groupRows]) => (
            <div key={crumb}>
              <div className="sticky top-0 px-6 py-1.5 text-xs z-10"
                style={{ background: 'var(--ef-canvas-raised)', borderBottom: `1px solid ${LINE}`, color: FAINT }}>
                {crumb}
              </div>
              {groupRows.map((r) => (
                <RowItem key={r.id} row={r} checked={selected.has(r.id)} onToggle={() => toggle(r.id)} query={query} />
              ))}
            </div>
          ))}

          {visible.length === 0 && (
            <p className="text-xs text-center py-10" style={{ color: MUTED }}>
              {rows.length === 0
                ? `No active ${typeLabel.toLowerCase()}s exist in this institute yet.`
                : 'Nothing matches the current search and filters.'}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 flex-shrink-0" style={{ borderTop: `1px solid ${LINE}`, background: 'var(--ef-canvas-raised)' }}>
          <p className="text-xs" style={{ color: MUTED }}>
            {selected.size} {typeLabel.toLowerCase()}{selected.size !== 1 ? 's' : ''} selected
          </p>
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="text-xs px-4 py-2 hover:opacity-70"
              style={{ border: `1px solid ${LINE}`, borderRadius: 2, color: INK, background: PAPER }}>
              Cancel
            </button>
            <button onClick={() => onConfirm([...selected])} disabled={selected.size === 0}
              className="text-xs px-4 py-2 transition-opacity hover:opacity-80"
              style={{
                background: selected.size > 0 ? INK : 'var(--ef-track)', color: 'var(--ef-surface)', borderRadius: 2,
                cursor: selected.size > 0 ? 'pointer' : 'not-allowed',
              }}>
              Use selection
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────────────

function RowItem({ row, checked, onToggle, query }: {
  row: AllocationNodeRow; checked: boolean; onToggle: () => void; query: string;
}) {
  return (
    <button onClick={onToggle}
      className="w-full flex items-center gap-2.5 px-6 py-2.5 text-left transition-colors hover:bg-[var(--ef-canvas-raised)]"
      style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
      {checked
        ? <CheckSquare size={13} strokeWidth={1.5} style={{ color: INK, flexShrink: 0 }} />
        : <Square size={13} strokeWidth={1.5} style={{ color: FAINT, flexShrink: 0 }} />}
      <span className="flex-1 min-w-0">
        <span className="text-xs block truncate" style={{ color: INK }}>
          <Highlight text={row.name} query={query} />
        </span>
        {row.breadcrumb && (
          <span className="text-xs block truncate" style={{ color: FAINT, fontSize: 10 }}>
            <Highlight text={row.breadcrumb} query={query} />
          </span>
        )}
      </span>
      <span className="text-xs flex-shrink-0" style={{ color: row.studentCount === 0 ? 'var(--ef-warning-strong)' : MUTED }}>
        {row.studentCount === 0 ? '0 students mapped' : `${row.studentCount}`}
      </span>
    </button>
  );
}

/** Highlights every search token where it matches — makes relevance self-evident. */
function Highlight({ text, query }: { text: string; query: string }) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return <>{text}</>;
  const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const parts = text.split(new RegExp(`(${pattern})`, 'ig'));
  return (
    <>
      {parts.map((p, i) =>
        tokens.includes(p.toLowerCase())
          ? <mark key={i} style={{ background: 'var(--ef-warning-bg)', color: 'inherit' }}>{p}</mark>
          : <span key={i}>{p}</span>)}
    </>
  );
}