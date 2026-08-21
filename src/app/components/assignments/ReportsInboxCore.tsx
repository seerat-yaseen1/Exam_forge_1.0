/**
 * ReportsInboxCore
 *
 * Cross-assessment reports inbox shared by Web Owner, Institute Admin,
 * and Faculty. Lists every report visible to the reviewer (scoped by
 * role) and lets them jump into the per-assessment Reports tab to
 * resolve them.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, ChevronRight, Flag } from 'lucide-react';
import {
  Card, EmptyState, ErrorBanner, LoadingBlock, PageHeader, PageShell, StatRow, StatTile,
} from '../console/ui';
import { FilterChips, Toolbar } from '../console/data';
import {
  listAllReports,
  listReportsByInstitute,
  listReportsByOwner,
  type QuestionReport,
  type ReportStatus,
  type ReportReason,
} from '../../../lib/questionReportService';

const REASON_LABEL: Record<ReportReason, string> = {
  wrong_answer: 'Wrong answer',
  typo:         'Typo',
  ambiguous:    'Ambiguous',
  other:        'Other',
};

const STATUS_LABEL: Record<ReportStatus, string> = {
  open:      'Open',
  reviewed:  'Reviewed',
  dismissed: 'Dismissed',
  fixed:     'Fixed',
};

const STATUS_COLOR: Record<ReportStatus, { bg: string; border: string; text: string }> = {
  open:      { bg: 'var(--ef-warning-bg)', border: 'var(--ef-warning-border)', text: 'var(--ef-warning)' },
  reviewed:  { bg: 'var(--ef-canvas)', border: 'var(--ef-border)', text: 'var(--ef-text-subtle)' },
  dismissed: { bg: 'var(--ef-canvas)', border: 'var(--ef-border)', text: 'var(--ef-text-muted)' },
  fixed:     { bg: 'var(--ef-success-bg)', border: 'var(--ef-success-border)', text: 'var(--ef-success-strong)' },
};

type Scope =
  | { kind: 'web_owner' }
  | { kind: 'institute'; instituteId: string }
  // instituteId required: the questionReports read rule scopes faculty by
  // instituteId, so the ownerId query must also carry it to be provable.
  | { kind: 'faculty'; facultyId: string; instituteId: string };

interface Props {
  scope: Scope;
  /** Build the URL to the per-assessment roster (Reports tab). */
  rosterPathFor: (assessmentId: string) => string;
  /** Which console this is, for the page eyebrow. */
  role: string;
}

export function ReportsInboxCore({ scope, rosterPathFor, role }: Props) {
  const [loading, setLoading]   = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [reports, setReports]   = useState<QuestionReport[]>([]);
  const [filter, setFilter]     = useState<ReportStatus | 'all'>('open');

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        let list: QuestionReport[] = [];
        if (scope.kind === 'web_owner')      list = await listAllReports();
        else if (scope.kind === 'institute') list = await listReportsByInstitute(scope.instituteId);
        else                                  list = await listReportsByOwner(scope.facultyId, scope.instituteId);
        setReports(list);
      } catch (e: any) {
        setErrorMsg(e.message || 'Failed to load reports.');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [scope.kind, (scope as any).instituteId, (scope as any).facultyId]);

  const counts = useMemo(() => ({
    all:       reports.length,
    open:      reports.filter((r) => r.status === 'open').length,
    reviewed:  reports.filter((r) => r.status === 'reviewed').length,
    fixed:     reports.filter((r) => r.status === 'fixed').length,
    dismissed: reports.filter((r) => r.status === 'dismissed').length,
  }), [reports]);

  const filtered = useMemo(
    () => filter === 'all' ? reports : reports.filter((r) => r.status === filter),
    [reports, filter]
  );

  // Group by assessment for the inbox view
  const byAssessment = useMemo(() => {
    const map = new Map<string, { title: string; reports: QuestionReport[] }>();
    for (const r of filtered) {
      const entry = map.get(r.assessmentId) ?? { title: r.assessmentTitle, reports: [] };
      entry.reports.push(r);
      map.set(r.assessmentId, entry);
    }
    return [...map.entries()]
      .map(([assessmentId, v]) => ({ assessmentId, ...v }))
      .sort((a, b) => b.reports.length - a.reports.length);
  }, [filtered]);

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            {role}
          </>
        }
        title="Reported questions"
        subtitle="Candidates flagging a question mid-exam. Grouped by the assessment they were sitting, because a question that is wrong is wrong for everyone in that room — and fixing it is one decision, not twelve."
      />

      {loading ? (
        <LoadingBlock label="Loading reports…" rows={3} />
      ) : errorMsg ? (
        <ErrorBanner message={errorMsg} />
      ) : (
        <>
          <div style={{ marginBottom: 26 }}>
            <StatRow>
              <StatTile
                label="Open"
                value={counts.open}
                icon={<Flag size={13} strokeWidth={1.7} />}
                tone={counts.open > 0 ? 'warning' : undefined}
                sub={counts.open > 0 ? 'awaiting a decision' : 'nothing waiting'}
                hint="Reports nobody has ruled on yet. These are the ones with a candidate on the other end."
              />
              <StatTile
                label="Fixed"
                value={counts.fixed}
                icon={<CheckCircle2 size={13} strokeWidth={1.7} />}
                sub="question corrected"
                hint="The report was right and the question was changed."
              />
              <StatTile
                label="Dismissed"
                value={counts.dismissed}
                sub="no change needed"
                hint="Reviewed and found not to be a problem."
              />
              <StatTile
                label="All reports"
                value={counts.all}
                sub="all time"
                hint="Everything visible to you, at any status."
              />
            </StatRow>
          </div>

          <Toolbar>
            <FilterChips
              label="Report status"
              value={filter}
              onChange={(f) => setFilter(f as ReportStatus | 'all')}
              options={(['open', 'reviewed', 'fixed', 'dismissed', 'all'] as const).map((tab) => ({
                value: tab,
                label: `${tab === 'all' ? 'All' : STATUS_LABEL[tab]} ${tab === 'all' ? counts.all : counts[tab]}`,
              }))}
            />
          </Toolbar>

          {byAssessment.length === 0 ? (
            <EmptyState
              icon={<Flag size={28} strokeWidth={1.1} />}
              title={filter === 'open' ? 'Nothing to rule on' : 'No reports here'}
              body={
                filter === 'all'
                  ? 'No candidate has flagged a question in anything visible to you.'
                  : `No report currently has the status "${STATUS_LABEL[filter as ReportStatus]}".`
              }
            />
          ) : (
            <Card padded={false}>
              {byAssessment.map((entry, idx) => {
                const reasonCounts = entry.reports.reduce<Record<ReportReason, number>>((acc, r) => {
                  acc[r.reason] = (acc[r.reason] ?? 0) + 1;
                  return acc;
                }, {} as Record<ReportReason, number>);
                const open = entry.reports.filter((r) => r.status === 'open').length;
                return (
                  <Link
                    key={entry.assessmentId}
                    to={rosterPathFor(entry.assessmentId)}
                    className="ef-report-row flex items-center gap-3"
                    style={{
                      padding: '14px var(--ef-pad-card)',
                      borderTop: idx === 0 ? 'none' : '1px solid var(--ef-border-subtle)',
                      textDecoration: 'none',
                    }}
                  >
                    <span className="flex-1 min-w-0">
                      <span className="ef-t-sm ef-ink block" style={{ fontWeight: 500 }}>
                        {entry.title}
                      </span>
                      <span className="flex items-center gap-1.5 flex-wrap" style={{ marginTop: 6 }}>
                        <span className="ef-t-xs ef-muted">
                          {entry.reports.length} report{entry.reports.length === 1 ? '' : 's'}
                        </span>
                        {Object.entries(reasonCounts).map(([reason, count]) => (
                          <span key={reason} className="ef-chip ef-chip--sm">
                            {REASON_LABEL[reason as ReportReason]} · {count}
                          </span>
                        ))}
                        {open > 0 && (
                          <span
                            className="ef-chip ef-chip--sm"
                            style={{
                              background: STATUS_COLOR.open.bg,
                              borderColor: STATUS_COLOR.open.border,
                              color: STATUS_COLOR.open.text,
                            }}
                          >
                            {open} open
                          </span>
                        )}
                      </span>
                    </span>
                    <ChevronRight size={16} strokeWidth={1.7} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
                  </Link>
                );
              })}
            </Card>
          )}
        </>
      )}
    </PageShell>
  );
}
