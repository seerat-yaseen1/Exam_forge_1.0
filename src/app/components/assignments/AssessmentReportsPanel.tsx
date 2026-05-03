/**
 * AssessmentReportsPanel
 *
 * Reviewer surface for student-flagged question reports on a single
 * assessment. Embedded inside AssessmentRosterCore as a "Reports" view
 * and used standalone in top-level Reports inbox pages.
 *
 * Reviewer actions:
 *   - dismiss        → no_change   (status: dismissed)
 *   - mark reviewed  → no_change   (status: reviewed)
 *   - resolve fixed  → choose action: question_edited / answer_key_changed / question_invalidated
 *                       and optionally trigger a regrade
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Flag, AlertTriangle, CheckCircle2, XCircle, Loader2, ChevronDown, RefreshCw,
} from 'lucide-react';
import {
  listReportsByAssessment,
  resolveReport,
  type QuestionReport,
  type ReportStatus,
  type ReportReason,
  type ResolutionAction,
} from '../../../lib/questionReportService';
import {
  getAssessment,
  type Assessment,
} from '../../../lib/assessmentService';
import {
  getQuestionsByIds,
  type Question,
} from '../../../lib/questionBankService';
import { regradeAssessmentAttempts } from '../../../lib/submissionService';

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
  open:      { bg: '#FEF9EC', border: '#F5DFA0', text: '#92680A' },
  reviewed:  { bg: '#F7F6F3', border: '#E3E1DB', text: '#4A4A45' },
  dismissed: { bg: '#F7F6F3', border: '#E3E1DB', text: '#9A9891' },
  fixed:     { bg: '#EAF6EE', border: '#B5D9C0', text: '#1E7B3C' },
};

type Grouped = {
  questionId: string;
  question: Question | null;
  reports: QuestionReport[];
};

interface Props {
  assessmentId: string;
  reviewerId: string;
  reviewerRole: 'web_owner' | 'institute' | 'faculty';
}

export function AssessmentReportsPanel({ assessmentId, reviewerId, reviewerRole }: Props) {
  const [loading, setLoading]       = useState(true);
  const [errorMsg, setErrorMsg]     = useState('');
  const [reports, setReports]       = useState<QuestionReport[]>([]);
  const [questionMap, setQuestionMap] = useState<Map<string, Question>>(new Map());
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [filter, setFilter]         = useState<ReportStatus | 'all'>('open');

  const load = async () => {
    setLoading(true);
    try {
      const [a, list] = await Promise.all([
        getAssessment(assessmentId),
        listReportsByAssessment(assessmentId),
      ]);
      setAssessment(a);
      setReports(list);
      const qids = [...new Set(list.map((r) => r.questionId))];
      if (qids.length > 0) {
        const qs = await getQuestionsByIds(qids);
        setQuestionMap(new Map(qs.map((q) => [q.id, q])));
      } else {
        setQuestionMap(new Map());
      }
    } catch (e: any) {
      setErrorMsg(e.message || 'Failed to load reports.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [assessmentId]);

  const filtered = useMemo(
    () => filter === 'all' ? reports : reports.filter((r) => r.status === filter),
    [reports, filter]
  );

  const grouped: Grouped[] = useMemo(() => {
    const map = new Map<string, QuestionReport[]>();
    for (const r of filtered) {
      const arr = map.get(r.questionId) ?? [];
      arr.push(r);
      map.set(r.questionId, arr);
    }
    return [...map.entries()].map(([questionId, rs]) => ({
      questionId,
      question: questionMap.get(questionId) ?? null,
      reports: rs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    }));
  }, [filtered, questionMap]);

  const counts = useMemo(() => ({
    all:       reports.length,
    open:      reports.filter((r) => r.status === 'open').length,
    reviewed:  reports.filter((r) => r.status === 'reviewed').length,
    fixed:     reports.filter((r) => r.status === 'fixed').length,
    dismissed: reports.filter((r) => r.status === 'dismissed').length,
  }), [reports]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={16} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
      </div>
    );
  }
  if (errorMsg) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2">
        <AlertTriangle size={16} strokeWidth={1} style={{ color: '#9B2828' }} />
        <p className="text-xs" style={{ color: '#9B2828' }}>{errorMsg}</p>
      </div>
    );
  }

  return (
    <div>
      {/* Filter tabs */}
      <div className="flex items-center gap-1 mb-4">
        {(['open', 'reviewed', 'fixed', 'dismissed', 'all'] as const).map((tab) => {
          const isActive = filter === tab;
          const count = tab === 'all' ? counts.all : counts[tab];
          return (
            <button key={tab} onClick={() => setFilter(tab)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5"
              style={{
                borderRadius: 2, cursor: 'pointer',
                background: isActive ? '#0C0C0B' : 'transparent',
                color: isActive ? '#FFFFFF' : '#9A9891',
                border: isActive ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
              }}>
              {tab === 'all' ? 'All' : STATUS_LABEL[tab]}
              <span style={{
                background: isActive ? 'rgba(255,255,255,0.2)' : '#F0EFEB',
                color: isActive ? '#FFFFFF' : '#9A9891',
                borderRadius: 2, padding: '0 4px', fontSize: 10,
              }}>{count}</span>
            </button>
          );
        })}
        <button onClick={load} className="ml-auto flex items-center gap-1.5 text-xs px-3 py-1.5"
          style={{ color: '#9A9891', cursor: 'pointer' }}>
          <RefreshCw size={11} strokeWidth={1.5} /> Refresh
        </button>
      </div>

      {grouped.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3"
          style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}>
          <Flag size={20} strokeWidth={1} style={{ color: '#C4C3BD' }} />
          <p className="text-xs" style={{ color: '#C4C3BD' }}>
            No reports {filter !== 'all' ? `with status "${STATUS_LABEL[filter]}"` : 'on this assessment'}.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {grouped.map((g) => (
            <ReportGroupCard
              key={g.questionId}
              group={g}
              assessment={assessment}
              reviewerId={reviewerId}
              reviewerRole={reviewerRole}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Per-question card ────────────────────────────────────────────

function ReportGroupCard({
  group, assessment, reviewerId, reviewerRole, onChanged,
}: {
  group: Grouped;
  assessment: Assessment | null;
  reviewerId: string;
  reviewerRole: 'web_owner' | 'institute' | 'faculty';
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [resolveOpen, setResolveOpen] = useState(false);

  const reasonCounts = group.reports.reduce<Record<ReportReason, number>>((acc, r) => {
    acc[r.reason] = (acc[r.reason] ?? 0) + 1;
    return acc;
  }, {} as Record<ReportReason, number>);

  return (
    <div style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}>
      {/* Header */}
      <div className="flex items-start gap-3 px-4 py-3" style={{ borderBottom: '1px solid #F0EFEB' }}>
        <Flag size={13} strokeWidth={1.5} style={{ color: '#92680A', marginTop: 2 }} />
        <div className="flex-1 min-w-0">
          <p className="text-xs" style={{ color: '#0C0C0B', lineHeight: 1.6 }}>
            {group.question
              ? group.question.stem.slice(0, 140) + (group.question.stem.length > 140 ? '…' : '')
              : <span style={{ color: '#9A9891' }}>Question not found (deleted?)</span>}
          </p>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className="text-xs" style={{ color: '#9A9891' }}>
              {group.reports.length} report{group.reports.length !== 1 ? 's' : ''}
            </span>
            {Object.entries(reasonCounts).map(([reason, count]) => (
              <span key={reason} className="text-xs px-2 py-0.5"
                style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2, color: '#6B6B66' }}>
                {REASON_LABEL[reason as ReportReason]} · {count}
              </span>
            ))}
          </div>
        </div>
        <button onClick={() => setExpanded((e) => !e)}
          className="text-xs flex items-center gap-1"
          style={{ color: '#9A9891', cursor: 'pointer' }}>
          {expanded ? 'Hide' : 'Show'} details
          <ChevronDown size={11} strokeWidth={1.5}
            style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }} />
        </button>
      </div>

      {/* Body */}
      {expanded && (
        <div className="px-4 py-3 flex flex-col gap-2">
          {group.reports.map((r) => (
            <ReportRow
              key={r.id}
              report={r}
              reviewerId={reviewerId}
              reviewerRole={reviewerRole}
              onChanged={onChanged}
            />
          ))}

          {/* Bulk resolve (regrade) */}
          {assessment && group.question && (
            <div className="mt-2 pt-3" style={{ borderTop: '1px solid #F0EFEB' }}>
              <button
                onClick={() => setResolveOpen((o) => !o)}
                className="text-xs px-3 py-1.5"
                style={{
                  background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, cursor: 'pointer',
                }}
              >
                Resolve all {group.reports.filter((r) => r.status === 'open').length} open report(s)…
              </button>
              {resolveOpen && (
                <ResolveAllForm
                  reports={group.reports.filter((r) => r.status === 'open')}
                  assessment={assessment}
                  questionId={group.questionId}
                  reviewerId={reviewerId}
                  reviewerRole={reviewerRole}
                  onDone={() => { setResolveOpen(false); onChanged(); }}
                  onCancel={() => setResolveOpen(false)}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Single report row ────────────────────────────────────────────

function ReportRow({
  report, reviewerId, reviewerRole, onChanged,
}: {
  report: QuestionReport;
  reviewerId: string;
  reviewerRole: 'web_owner' | 'institute' | 'faculty';
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const sc = STATUS_COLOR[report.status];

  const dismiss = async () => {
    setBusy(true);
    try {
      await resolveReport({
        reportId: report.id,
        status: 'dismissed',
        resolution: {
          action: 'no_change',
          resolvedBy: reviewerId,
          resolvedByRole: reviewerRole,
          resolvedAt: new Date().toISOString(),
          note: 'Reviewer dismissed this report.',
        },
      });
      onChanged();
    } finally { setBusy(false); }
  };

  const markReviewed = async () => {
    setBusy(true);
    try {
      await resolveReport({
        reportId: report.id,
        status: 'reviewed',
        resolution: {
          action: 'no_change',
          resolvedBy: reviewerId,
          resolvedByRole: reviewerRole,
          resolvedAt: new Date().toISOString(),
        },
      });
      onChanged();
    } finally { setBusy(false); }
  };

  return (
    <div className="flex items-start gap-3 px-3 py-2.5"
      style={{ background: '#FAFAF8', border: '1px solid #F0EFEB', borderRadius: 2 }}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs" style={{ color: '#0C0C0B' }}>{report.studentName}</span>
          <span className="text-xs px-1.5 py-0.5"
            style={{ background: sc.bg, border: `1px solid ${sc.border}`, color: sc.text, borderRadius: 2 }}>
            {STATUS_LABEL[report.status]}
          </span>
          <span className="text-xs" style={{ color: '#9A9891' }}>·</span>
          <span className="text-xs" style={{ color: '#6B6B66' }}>{REASON_LABEL[report.reason]}</span>
          <span className="text-xs ml-auto" style={{ color: '#C4C3BD' }}>
            {new Date(report.createdAt).toLocaleString()}
          </span>
        </div>
        {report.note && (
          <p className="text-xs mt-1.5" style={{ color: '#4A4A45', lineHeight: 1.6 }}>
            "{report.note}"
          </p>
        )}
        {report.resolution && (
          <p className="text-xs mt-1.5" style={{ color: '#9A9891', lineHeight: 1.5 }}>
            Resolved by {report.resolution.resolvedByRole.replace('_', ' ')} ·{' '}
            {report.resolution.action.replace(/_/g, ' ')}
            {report.resolution.regradeApplied ? ' (regraded)' : ''}
          </p>
        )}
      </div>
      {report.status === 'open' && (
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={markReviewed} disabled={busy}
            className="text-xs px-2 py-1"
            style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, cursor: 'pointer' }}>
            <CheckCircle2 size={11} strokeWidth={1.5} className="inline" /> Reviewed
          </button>
          <button onClick={dismiss} disabled={busy}
            className="text-xs px-2 py-1"
            style={{ border: '1px solid #E3E1DB', color: '#9B2828', borderRadius: 2, cursor: 'pointer' }}>
            <XCircle size={11} strokeWidth={1.5} className="inline" /> Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// ── Resolve-all form (with optional regrade) ─────────────────────

function ResolveAllForm({
  reports, assessment, questionId, reviewerId, reviewerRole, onDone, onCancel,
}: {
  reports: QuestionReport[];
  assessment: Assessment;
  questionId: string;
  reviewerId: string;
  reviewerRole: 'web_owner' | 'institute' | 'faculty';
  onDone: () => void;
  onCancel: () => void;
}) {
  const [action, setAction] = useState<ResolutionAction>('answer_key_changed');
  const [note, setNote]     = useState('');
  const [busy, setBusy]     = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const willRegrade = action === 'answer_key_changed' || action === 'question_invalidated';

  const submit = async () => {
    setBusy(true);
    setStatusMsg('');
    try {
      // 1. If regrading, run regrade FIRST so the report shows the
      //    accurate "regradeApplied" flag once written.
      let regradeApplied = false;
      if (willRegrade) {
        setStatusMsg('Regrading attempts…');
        // Reload current questions for this assessment so we use the
        // latest answer-key state (the reviewer is expected to have
        // edited the question doc separately before this step).
        const allQids = [...new Set(
          (assessment.sections ?? []).flatMap((s) => s.questions.map((q) => q.questionId))
        )];
        const qs = await getQuestionsByIds(allQids);
        const updated = await regradeAssessmentAttempts({
          assessment,
          questions: qs,
          invalidatedQuestionIds: action === 'question_invalidated' ? [questionId] : [],
        });
        regradeApplied = true;
        setStatusMsg(`Regraded ${updated} attempt${updated !== 1 ? 's' : ''}.`);
      }

      // 2. Mark every open report on this question as fixed.
      const ts = new Date().toISOString();
      await Promise.all(reports.map((r) => resolveReport({
        reportId: r.id,
        status: 'fixed',
        resolution: {
          action,
          regradeApplied,
          resolvedBy: reviewerId,
          resolvedByRole: reviewerRole,
          resolvedAt: ts,
          note: note.trim() || undefined,
        },
      })));

      onDone();
    } catch (e: any) {
      setStatusMsg(e.message || 'Failed to resolve.');
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 px-3 py-3"
      style={{ background: '#FAFAF8', border: '1px solid #F0EFEB', borderRadius: 2 }}>
      <p className="text-xs mb-2" style={{ color: '#9A9891', letterSpacing: '0.06em' }}>
        RESOLUTION ACTION
      </p>
      <div className="flex flex-col gap-1.5 mb-3">
        {([
          ['no_change',             'No change — student was incorrect'],
          ['question_edited',       'Question text edited (no key change)'],
          ['answer_key_changed',    'Answer key changed — regrade all attempts'],
          ['question_invalidated',  'Invalidate question — award full marks to all'],
        ] as Array<[ResolutionAction, string]>).map(([val, label]) => (
          <label key={val} className="flex items-center gap-2 text-xs" style={{ color: '#0C0C0B', cursor: 'pointer' }}>
            <input type="radio" name="action" checked={action === val}
              onChange={() => setAction(val)} />
            {label}
          </label>
        ))}
      </div>

      <p className="text-xs mb-1.5" style={{ color: '#9A9891', letterSpacing: '0.06em' }}>
        NOTE TO STUDENT (optional)
      </p>
      <textarea
        value={note} onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Visible to the student on the results page…"
        className="w-full outline-none text-xs"
        style={{
          background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 2,
          padding: '8px 10px', color: '#0C0C0B', fontFamily: 'inherit',
        }}
      />

      {willRegrade && (
        <p className="text-xs mt-2" style={{ color: '#92680A', lineHeight: 1.5 }}>
          Heads up: this will recompute scores for every finished attempt on this assessment.
          Make sure the question doc has the correct answer key first.
        </p>
      )}
      {statusMsg && (
        <p className="text-xs mt-2" style={{ color: '#4A4A45' }}>{statusMsg}</p>
      )}

      <div className="flex items-center gap-2 mt-3">
        <button onClick={submit} disabled={busy}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5"
          style={{
            background: busy ? '#C8C7C2' : '#0C0C0B', color: '#FFFFFF', borderRadius: 2,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}>
          {busy && <Loader2 size={11} className="animate-spin" />}
          Resolve {reports.length} report{reports.length !== 1 ? 's' : ''}
        </button>
        <button onClick={onCancel} disabled={busy}
          className="text-xs px-3 py-1.5"
          style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
