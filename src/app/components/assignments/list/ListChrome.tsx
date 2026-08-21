/**
 * The small presentational pieces of the assessments list.
 *
 * Originally extracted verbatim from AssignmentsPage, which is why they each
 * carried their own hand-painted chip, search box and filter buttons. They
 * are now thin wrappers over the console primitives, so this list looks like
 * every other list in the product and gains their behaviour for free — the
 * clearable search, the keyboard-reachable filter group, the empty state that
 * offers a way out of a filter rather than just reporting one.
 */

import React from 'react';
import { Plus, ClipboardList } from 'lucide-react';
import { statusColor, type AssessmentStatus } from '../../../../lib/assessmentService';
import { Button, EmptyState as ConsoleEmptyState } from '../../console/ui';
import { FilterChips, SearchField, Toolbar } from '../../console/data';

export function StatusBadgeChip({ status }: { status: AssessmentStatus }) {
  const { bg, text, border } = statusColor(status);
  return (
    <span
      className="ef-chip ef-chip--sm capitalize"
      style={{ background: bg, color: text, borderColor: border }}
    >
      {status}
    </span>
  );
}

export function SkeletonRow() {
  return (
    <div
      className="flex items-center gap-4"
      style={{ padding: '15px var(--ef-pad-card)', borderBottom: '1px solid var(--ef-border-subtle)' }}
    >
      <span className="ef-skeleton" style={{ width: 56, height: 16, borderRadius: 999 }} />
      <span className="flex-1 flex flex-col gap-1.5">
        <span className="ef-skeleton" style={{ width: '58%', height: 11 }} />
        <span className="ef-skeleton" style={{ width: '30%', height: 10 }} />
      </span>
      <span className="ef-skeleton" style={{ width: 110, height: 11 }} />
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

export function FilterBar({
  search,
  setSearch,
  statusFilter,
  setStatusFilter,
  end,
}: {
  search: string;
  setSearch: (v: string) => void;
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  end?: React.ReactNode;
}) {
  return (
    <Toolbar end={end}>
      <SearchField
        value={search}
        onChange={setSearch}
        label="Search assessments"
        placeholder="Search a title, subject or description…"
      />
      <FilterChips
        label="Status"
        value={statusFilter}
        onChange={setStatusFilter}
        options={STATUS_FILTERS.map((f) => ({ value: f.value, label: f.label }))}
      />
    </Toolbar>
  );
}

export function EmptyState({ filtered, onAdd }: { filtered: boolean; onAdd: () => void }) {
  return filtered ? (
    <ConsoleEmptyState
      icon={<ClipboardList size={28} strokeWidth={1.1} />}
      title="Nothing matches"
      body="No assessment matches this search and filter."
    />
  ) : (
    <ConsoleEmptyState
      icon={<ClipboardList size={28} strokeWidth={1.1} />}
      title="No assessments yet"
      body="An assessment is a paper, plus who sits it and when. Build the first one — or start from an existing one once there is something to copy."
      action={
        <Button variant="primary" onClick={onAdd}>
          <Plus size={13} strokeWidth={1.9} />
          Create assessment
        </Button>
      }
    />
  );
}

export function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="ef-t-xs ef-muted" style={{ marginBottom: 2 }}>
        {label}
      </p>
      <div className="ef-t-xs">{children}</div>
    </div>
  );
}
