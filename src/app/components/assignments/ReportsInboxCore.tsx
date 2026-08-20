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
import { Flag, Loader2, AlertTriangle, ChevronRight } from 'lucide-react';
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
}

export function ReportsInboxCore({ scope, rosterPathFor }: Props) {
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={16} strokeWidth={1} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
      </div>
    );
  }
  if (errorMsg) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-2">
        <AlertTriangle size={16} strokeWidth={1} style={{ color: 'var(--ef-danger)' }} />
        <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{errorMsg}</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', width: '100%', padding: '24px' }}>
      <div className="flex items-center gap-3 mb-5">
        <Flag size={14} strokeWidth={1.5} style={{ color: 'var(--ef-ink)' }} />
        <p className="text-xs" style={{ color: 'var(--ef-ink)', letterSpacing: '0.08em' }}>QUESTION REPORTS</p>
        <span className="text-xs ml-auto" style={{ color: 'var(--ef-text-muted)' }}>
          {counts.open} open · {counts.fixed} fixed · {counts.dismissed} dismissed
        </span>
      </div>

      <div className="flex items-center gap-1 mb-4">
        {(['open', 'reviewed', 'fixed', 'dismissed', 'all'] as const).map((tab) => {
          const isActive = filter === tab;
          const count = tab === 'all' ? counts.all : counts[tab];
          return (
            <button key={tab} onClick={() => setFilter(tab)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5"
              style={{
                borderRadius: 2, cursor: 'pointer',
                background: isActive ? 'var(--ef-ink)' : 'transparent',
                color: isActive ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
                border: isActive ? '1px solid var(--ef-ink)' : '1px solid var(--ef-border)',
              }}>
              {tab === 'all' ? 'All' : STATUS_LABEL[tab]}
              <span style={{
                background: isActive ? 'rgba(255,255,255,0.2)' : 'var(--ef-border-subtle)',
                color: isActive ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
                borderRadius: 2, padding: '0 4px', fontSize: 10,
              }}>{count}</span>
            </button>
          );
        })}
      </div>

      {byAssessment.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3"
          style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}>
          <Flag size={20} strokeWidth={1} style={{ color: 'var(--ef-text-muted)' }} />
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
            No reports {filter !== 'all' ? `with status "${STATUS_LABEL[filter]}"` : 'visible to you'}.
          </p>
        </div>
      ) : (
        <div style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}>
          {byAssessment.map((entry, idx) => {
            const reasonCounts = entry.reports.reduce<Record<ReportReason, number>>((acc, r) => {
              acc[r.reason] = (acc[r.reason] ?? 0) + 1;
              return acc;
            }, {} as Record<ReportReason, number>);
            return (
              <Link key={entry.assessmentId} to={rosterPathFor(entry.assessmentId)}
                className="flex items-start gap-3 px-5 py-4"
                style={{
                  borderTop: idx === 0 ? 'none' : '1px solid var(--ef-border-subtle)',
                  textDecoration: 'none',
                }}>
                <div className="flex-1 min-w-0">
                  <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>{entry.title}</p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                      {entry.reports.length} report{entry.reports.length !== 1 ? 's' : ''}
                    </span>
                    {Object.entries(reasonCounts).map(([reason, count]) => (
                      <span key={reason} className="text-xs px-2 py-0.5"
                        style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)' }}>
                        {REASON_LABEL[reason as ReportReason]} · {count}
                      </span>
                    ))}
                    {entry.reports.some((r) => r.status === 'open') && (
                      <span className="text-xs px-2 py-0.5"
                        style={{
                          background: STATUS_COLOR.open.bg,
                          border: `1px solid ${STATUS_COLOR.open.border}`,
                          color: STATUS_COLOR.open.text,
                          borderRadius: 2,
                        }}>
                        {entry.reports.filter((r) => r.status === 'open').length} open
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', marginTop: 4 }} />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
