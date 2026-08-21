/**
 * The list of assessments you can open a live roster for.
 *
 * ── WHY IT IS SHARED ──────────────────────────────────────────────
 * The institute admin's page and the faculty member's page were the same
 * screen written twice: the same card with the same hover written as two
 * mouse handlers, the same search box, the same four filter buttons, the
 * same three loading and empty states. What differs is which assessments
 * they can see and whether each row can be opened — a query and a predicate,
 * both of which stay on the pages.
 *
 * ── WHAT THE CARD LEADS WITH ──────────────────────────────────────
 * Whether it is running. Someone on this page is almost always here because
 * an exam is happening now or is about to, so status comes first and the
 * dates read as a sentence — "runs 14 Sep to 21 Sep" — rather than as two
 * unlabelled icons. The bottom line says what pressing it will do, including
 * when it will do nothing: a draft has no roster to look at, and saying so
 * on the card is better than a card that quietly ignores a click.
 */

import React, { useMemo, useState } from 'react';
import { ChevronRight, ClipboardList, Layers, Lock, Users } from 'lucide-react';
import {
  statusColor,
  describeAssignment,
  type Assessment,
  type AssessmentStatus,
} from '../../../lib/assessmentService';
import { formatDayMonth } from '../../../lib/dateFormat';
import { Button, EmptyState } from '../console/ui';
import { FilterChips, SearchField, TableSkeleton, Toolbar } from '../console/data';

export type StatusFilter = AssessmentStatus | 'all';

const STATUS_LABEL: Record<AssessmentStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  closed: 'Closed',
};

/** Why this row cannot be opened, or null when it can. */
export type RosterBlock = string | null;

function Meta({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="ef-t-xs ef-muted inline-flex items-center gap-1.5">
      {icon}
      {children}
    </span>
  );
}

function AssessmentCard({
  assessment,
  onOpen,
  blocked,
}: {
  assessment: Assessment;
  onOpen: () => void;
  blocked: RosterBlock;
}) {
  const sc = statusColor(assessment.status);
  const sectionCount = assessment.sections?.length ?? 0;
  const questionCount = assessment.sections
    ? assessment.sections.reduce((n, sec) => n + sec.questions.length, 0)
    : assessment.questions.length;

  const window_ =
    assessment.startDate && assessment.endDate
      ? `Runs ${formatDayMonth(assessment.startDate)} – ${formatDayMonth(assessment.endDate)}`
      : assessment.startDate
        ? `Opens ${formatDayMonth(assessment.startDate)}`
        : assessment.endDate
          ? `Closes ${formatDayMonth(assessment.endDate)}`
          : 'No window set';

  const body = (
    <>
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="ef-t-md ef-ink block" style={{ fontWeight: 500 }}>
            {assessment.title}
          </span>
          {assessment.subject && <span className="ef-t-xs ef-muted block mt-0.5">{assessment.subject}</span>}
        </span>
        <span
          className="ef-chip ef-chip--sm flex-shrink-0"
          style={{ background: sc.bg, color: sc.text, borderColor: sc.border }}
        >
          {STATUS_LABEL[assessment.status]}
        </span>
      </span>

      <span className="flex items-center gap-x-4 gap-y-1.5 flex-wrap" style={{ marginTop: 12 }}>
        {sectionCount > 0 && (
          <Meta icon={<Layers size={12} strokeWidth={1.7} />}>
            {sectionCount} section{sectionCount === 1 ? '' : 's'}
          </Meta>
        )}
        {questionCount > 0 && (
          <Meta icon={<ClipboardList size={12} strokeWidth={1.7} />}>
            {questionCount} question{questionCount === 1 ? '' : 's'}
          </Meta>
        )}
        <Meta icon={<Users size={12} strokeWidth={1.7} />}>{describeAssignment(assessment)}</Meta>
      </span>

      <span
        className="flex items-center justify-between gap-3 flex-wrap"
        style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--ef-border-subtle)' }}
      >
        <span className="ef-t-xs ef-muted">{window_}</span>
        {blocked ? (
          <span className="ef-t-xs ef-muted inline-flex items-center gap-1.5">
            <Lock size={11} strokeWidth={1.7} />
            {blocked}
          </span>
        ) : (
          <span className="ef-t-xs inline-flex items-center gap-1" style={{ color: 'var(--ef-accent)' }}>
            View roster
            <ChevronRight size={12} strokeWidth={1.8} />
          </span>
        )}
      </span>
    </>
  );

  // A card that does nothing when pressed is not a button. Blocked rows stay
  // in the list — knowing the assessment exists is the point — but they lose
  // the cursor, the lift and the tab stop that promise something will happen.
  return blocked ? (
    <div className="ef-card flex flex-col" style={{ padding: 'var(--ef-pad-card)', opacity: 0.72 }}>
      {body}
    </div>
  ) : (
    <button
      type="button"
      onClick={onOpen}
      className="ef-card ef-card--interactive flex flex-col text-left w-full"
      style={{ padding: 'var(--ef-pad-card)' }}
    >
      {body}
    </button>
  );
}

export function RosterBrowser({
  assessments,
  loading,
  onOpen,
  blockedReason,
  statuses,
  initialStatus = 'all',
  emptyTitle,
  emptyBody,
}: {
  assessments: Assessment[];
  loading: boolean;
  onOpen: (a: Assessment) => void;
  /** Returns why a row cannot be opened, or null. */
  blockedReason: (a: Assessment) => RosterBlock;
  /** Which status filters this console offers. */
  statuses: StatusFilter[];
  initialStatus?: StatusFilter;
  emptyTitle: string;
  emptyBody: string;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>(initialStatus);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return assessments.filter((a) => {
      if (status !== 'all' && a.status !== status) return false;
      if (!q) return true;
      return a.title.toLowerCase().includes(q) || (a.subject ?? '').toLowerCase().includes(q);
    });
  }, [assessments, search, status]);

  const filtered = search.trim() !== '' || status !== initialStatus;

  return (
    <>
      <Toolbar>
        <SearchField
          value={search}
          onChange={setSearch}
          label="Search assessments"
          placeholder="Search by title or subject…"
        />
        <FilterChips
          label="Status"
          value={status}
          onChange={(s) => setStatus(s as StatusFilter)}
          options={statuses.map((s) => ({
            value: s,
            label: s === 'all' ? 'All' : STATUS_LABEL[s],
          }))}
        />
      </Toolbar>

      {loading ? (
        <TableSkeleton rows={4} columns={3} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<ClipboardList size={28} strokeWidth={1.1} />}
          title={filtered ? 'Nothing matches' : emptyTitle}
          body={filtered ? 'No assessment matches this search and filter.' : emptyBody}
          action={
            filtered ? (
              <Button
                onClick={() => {
                  setSearch('');
                  setStatus(initialStatus);
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="ef-card-grid">
          {visible.map((a) => (
            <AssessmentCard
              key={a.id}
              assessment={a}
              blocked={blockedReason(a)}
              onOpen={() => onOpen(a)}
            />
          ))}
        </div>
      )}
    </>
  );
}
