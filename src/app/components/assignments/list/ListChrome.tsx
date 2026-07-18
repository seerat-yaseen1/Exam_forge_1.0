/**
 * list/ListChrome — small presentational pieces of the assignments list:
 * status chip, stat pill, skeleton row, filter bar, empty state, meta item.
 * (Batch F1a: extracted verbatim from AssignmentsPage.tsx.)
 */
import React from 'react';
import { Plus, X, Search } from 'lucide-react';
import { type Student } from '../../../../lib/firebaseService';
import { statusColor, type Assessment, type AssessmentStatus } from '../../../../lib/assessmentService';

export function StatusBadgeChip({ status }: { status: AssessmentStatus }) {
  const { bg, text, border } = statusColor(status);
  return (
    <span
      className="text-xs px-2 py-0.5 capitalize select-none"
      style={{ background: bg, color: text, border: `1px solid ${border}`, borderRadius: 2 }}
    >
      {status}
    </span>
  );
}

// ── Stat pill ─────────────────────────────────────────────────────

export function StatPill({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 md:gap-3 px-3 py-3 md:px-5 md:py-4"
      style={{ border: '1px solid #E3E1DB', borderRadius: 3, background: '#FFFFFF' }}>
      <div className="flex items-center justify-center flex-shrink-0"
        style={{ width: 26, height: 26, borderRadius: 2, background: '#F7F6F3', border: '1px solid #EEECEA' }}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs truncate" style={{ color: '#9A9891' }}>{label}</p>
        <p className="text-sm mt-0.5" style={{ color: '#0C0C0B' }}>{value}</p>
      </div>
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className="flex items-center gap-4 px-5 py-4" style={{ borderBottom: '1px solid #F0EFEB' }}>
      <div className="h-4 w-10 rounded" style={{ background: '#EEECEA' }} />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 rounded" style={{ width: '60%', background: '#EEECEA' }} />
        <div className="h-2.5 rounded" style={{ width: '30%', background: '#F3F2EF' }} />
      </div>
      <div className="h-4 w-28 rounded" style={{ background: '#F3F2EF' }} />
    </div>
  );
}

// ── Filter bar ────────────────────────────────────────────────────

export const STATUS_FILTERS = [
  { label: 'All', value: '' },
  { label: 'Draft', value: 'draft' },
  { label: 'Active', value: 'active' },
  { label: 'Closed', value: 'closed' },
];

export function FilterBar({ search, setSearch, statusFilter, setStatusFilter }: {
  search: string; setSearch: (v: string) => void;
  statusFilter: string; setStatusFilter: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4" style={{ borderBottom: '1px solid #F0EFEB' }}>
      <div className="flex items-center gap-2 px-3 py-2"
        style={{ background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2 }}>
        <Search size={13} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, subject, description…"
          className="flex-1 text-xs outline-none"
          style={{ background: 'transparent', color: '#0C0C0B', fontSize: 13 }} />
        {search && (
          <button onClick={() => setSearch('')} className="hover:opacity-60 transition-opacity">
            <X size={12} strokeWidth={1.5} style={{ color: '#9A9891' }} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {STATUS_FILTERS.map((f) => {
          const colors = f.value ? statusColor(f.value as AssessmentStatus) : null;
          const isActive = statusFilter === f.value;
          return (
            <button key={f.value} onClick={() => setStatusFilter(f.value)}
              className="text-xs px-2.5 py-1 transition-all"
              style={{
                borderRadius: 2,
                border: isActive ? `1px solid ${colors?.border ?? '#0C0C0B'}` : '1px solid #E3E1DB',
                background: isActive ? (colors?.bg ?? '#0C0C0B') : '#FAFAF8',
                color: isActive ? (colors?.text ?? '#FFFFFF') : '#6B6B66',
              }}>
              {f.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Assessment row ────────────────────────────────────────────────

export function EmptyState({ filtered, onAdd }: { filtered: boolean; onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16" style={{ color: '#C4C3BD' }}>
      <div style={{ width: 1, height: 32, background: 'linear-gradient(to bottom, transparent, #DDDBD5)', marginBottom: 16 }} />
      <p className="text-xs" style={{ letterSpacing: '0.1em' }}>{filtered ? 'NO ASSESSMENTS MATCH' : 'NO ASSESSMENTS YET'}</p>
      {!filtered && (
        <button onClick={onAdd} className="mt-4 flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity hover:opacity-70"
          style={{ border: '1px solid #E3E1DB', borderRadius: 2, color: '#9A9891', background: '#FFFFFF' }}>
          <Plus size={12} strokeWidth={1.5} /> Create first assessment
        </button>
      )}
      <div style={{ width: 1, height: 32, background: 'linear-gradient(to top, transparent, #DDDBD5)', marginTop: 16 }} />
    </div>
  );
}

// ── Delete modal ──────────────────────────────────────────────────

// ── Duplicate modal ───────────────────────────────────────────────
// Lets the author choose what carries over. Student-specific data (attempts,
// responses, results, reports, activity logs) is NEVER copied — it lives in
// other collections keyed by assessmentId, so the new copy simply has none.

export function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs mb-0.5" style={{ color: '#9A9891' }}>{label}</p>
      <div className="text-xs">{children}</div>
    </div>
  );
}