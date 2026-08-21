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
import { reviewAudienceAllows } from '../../../lib/visibility';
import {
  getQuestionsByIdsForReview,
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
  open:      { bg: 'var(--ef-warning-bg)', border: 'var(--ef-warning-border)', text: 'var(--ef-warning)' },
  reviewed:  { bg: 'var(--ef-canvas)', border: 'var(--ef-border)', text: 'var(--ef-text-subtle)' },
  dismissed: { bg: 'var(--ef-canvas)', border: 'var(--ef-border)', text: 'var(--ef-text-muted)' },
  fixed:     { bg: 'var(--ef-success-bg)', border: 'var(--ef-success-border)', text: 'var(--ef-success-strong)' },
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
  /** Required for institute/faculty reviewers — scopes report + attempt
   *  queries so the security rules can prove access. null for webOwner. */
  instituteId?: string | null;
}

export function AssessmentReportsPanel({ assessmentId, reviewerId, reviewerRole, instituteId }: Props) {
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
        listReportsByAssessment(assessmentId, instituteId),
      ]);
      setAssessment(a);
      setReports(list);
      const qids = [...new Set(list.map((r) => r.questionId))];
      if (qids.length > 0) {
        // Review path: keys come from the getAnswerKeysForReview callable
        // (assessment-scoped) so institute/faculty reviewers can see the
        // recorded correct answer even on webOwner-owned questions, which
        // the owner-scoped questionAnswers rules deny to direct reads.
        const qs = await getQuestionsByIdsForReview(assessmentId, qids);
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
        <Loader2 size={16} strokeWidth={1} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
      </div>
    );
  }
  if (errorMsg) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2">
        <AlertTriangle size={16} strokeWidth={1} style={{ color: 'var(--ef-danger)' }} />
        <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{errorMsg}</p>
      </div>
    );
  }

  // ── Access guard (N5 final form) ───────────────────────────────
  // A triage queue you can't see the questions of can't be actioned, so for
  // reviewers who don't own this assessment and whose audience isn't in
  // allowReviewTo, the panel explains itself instead of rendering a list of
  // undiagnosable flags. The roster hides its Reports tab on the same
  // condition; this covers the standalone inbox surfaces. Reports still
  // reach the exam owner's own inbox regardless.
  if (assessment) {
    const ownsIt =
      reviewerRole === 'web_owner'
        ? true
        : reviewerRole === 'institute'
          ? assessment.ownerType === 'institute' && assessment.ownerId === instituteId
          : assessment.ownerType === 'faculty'   && assessment.ownerId === reviewerId;
    const mayReview = ownsIt
      || reviewAudienceAllows(assessment, reviewerRole === 'institute' ? 'institute' : 'faculty');
    if (!mayReview) {
      return (
        <div className="px-4 py-8 text-center">
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.7 }}>
            Question reports on this exam are handled by its owner.
            <br />
            Your role doesn't have question-review access here — the exam
            owner controls this in the assessment's visibility settings.
          </p>
        </div>
      );
    }
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
                background: isActive ? 'var(--ef-ink)' : 'transparent',
                color: isActive ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
                border: isActive ? '1px solid var(--ef-ink)' : '1px solid var(--ef-border)',
              }}>
              {tab === 'all' ? 'All' : STATUS_LABEL[tab]}
              <span style={{
                background: isActive ? 'rgba(255,255,255,0.2)' : 'var(--ef-border-subtle)',
                color: isActive ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
                borderRadius: 2, padding: '0 4px', fontSize: 12,
              }}>{count}</span>
            </button>
          );
        })}
        <button onClick={load} className="ml-auto flex items-center gap-1.5 text-xs px-3 py-1.5"
          style={{ color: 'var(--ef-text-muted)', cursor: 'pointer' }}>
          <RefreshCw size={11} strokeWidth={1.5} /> Refresh
        </button>
      </div>

      {grouped.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3"
          style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}>
          <Flag size={20} strokeWidth={1} style={{ color: 'var(--ef-text-muted)' }} />
          <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
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
    <div style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}>
      {/* Header */}
      <div className="flex items-start gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
        <Flag size={13} strokeWidth={1.5} style={{ color: 'var(--ef-warning)', marginTop: 2 }} />
        <div className="flex-1 min-w-0">
          <p className="text-xs" style={{ color: 'var(--ef-ink)', lineHeight: 1.6 }}>
            {group.question
              ? group.question.stem.slice(0, 140) + (group.question.stem.length > 140 ? '…' : '')
              : <span style={{ color: 'var(--ef-text-muted)' }}>Question not found (deleted?)</span>}
          </p>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
              {group.reports.length} report{group.reports.length !== 1 ? 's' : ''}
            </span>
            {Object.entries(reasonCounts).map(([reason, count]) => (
              <span key={reason} className="text-xs px-2 py-0.5"
                style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)' }}>
                {REASON_LABEL[reason as ReportReason]} · {count}
              </span>
            ))}
          </div>
        </div>
        <button onClick={() => setExpanded((e) => !e)}
          className="text-xs flex items-center gap-1"
          style={{ color: 'var(--ef-text-muted)', cursor: 'pointer' }}>
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
            <div className="mt-2 pt-3" style={{ borderTop: '1px solid var(--ef-border-subtle)' }}>
              <button
                onClick={() => setResolveOpen((o) => !o)}
                className="text-xs px-3 py-1.5"
                style={{
                  background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: 'pointer',
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
      style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border-subtle)', borderRadius: 2 }}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs" style={{ color: 'var(--ef-ink)' }}>{report.studentName}</span>
          <span className="text-xs px-1.5 py-0.5"
            style={{ background: sc.bg, border: `1px solid ${sc.border}`, color: sc.text, borderRadius: 2 }}>
            {STATUS_LABEL[report.status]}
          </span>
          <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>·</span>
          <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{REASON_LABEL[report.reason]}</span>
          <span className="text-xs ml-auto" style={{ color: 'var(--ef-text-muted)' }}>
            {new Date(report.createdAt).toLocaleString()}
          </span>
        </div>
        {report.note && (
          <p className="text-xs mt-1.5" style={{ color: 'var(--ef-text-subtle)', lineHeight: 1.6 }}>
            "{report.note}"
          </p>
        )}
        {report.resolution && (
          <p className="text-xs mt-1.5" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
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
            style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2, cursor: 'pointer' }}>
            <CheckCircle2 size={11} strokeWidth={1.5} className="inline" /> Reviewed
          </button>
          <button onClick={dismiss} disabled={busy}
            className="text-xs px-2 py-1"
            style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-danger)', borderRadius: 2, cursor: 'pointer' }}>
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
        // Server-authoritative: the regradeAttempts Cloud Function reads the
        // CURRENT answer keys itself (the reviewer is expected to have edited
        // the question doc before this step) and re-scores every finished
        // attempt with the exact same code as gradeAttempt. No client-side
        // answer-key fetch — those reads are owner-scoped by the rules.
        const updated = await regradeAssessmentAttempts({
          assessmentId: assessment.id,
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
      style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border-subtle)', borderRadius: 2 }}>
      <p className="text-xs mb-2" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>
        RESOLUTION ACTION
      </p>
      <div className="flex flex-col gap-1.5 mb-3">
        {([
          ['no_change',             'No change — student was incorrect'],
          ['question_edited',       'Question text edited (no key change)'],
          ['answer_key_changed',    'Answer key changed — regrade all attempts'],
          ['question_invalidated',  'Invalidate question — award full marks to all'],
        ] as Array<[ResolutionAction, string]>).map(([val, label]) => (
          <label key={val} className="flex items-center gap-2 text-xs" style={{ color: 'var(--ef-ink)', cursor: 'pointer' }}>
            <input type="radio" name="action" checked={action === val}
              onChange={() => setAction(val)} />
            {label}
          </label>
        ))}
      </div>

      <p className="text-xs mb-1.5" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>
        NOTE TO STUDENT (optional)
      </p>
      <textarea
        value={note} onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Visible to the student on the results page…"
        className="w-full outline-none text-xs"
        style={{
          background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 2,
          padding: '8px 10px', color: 'var(--ef-ink)', fontFamily: 'inherit',
        }}
      />

      {willRegrade && (
        <p className="text-xs mt-2" style={{ color: 'var(--ef-warning)', lineHeight: 1.5 }}>
          Heads up: this will recompute scores for every finished attempt on this assessment.
          Make sure the question doc has the correct answer key first.
        </p>
      )}
      {statusMsg && (
        <p className="text-xs mt-2" style={{ color: 'var(--ef-text-subtle)' }}>{statusMsg}</p>
      )}

      <div className="flex items-center gap-2 mt-3">
        <button onClick={submit} disabled={busy}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5"
          style={{
            background: busy ? 'var(--ef-track)' : 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}>
          {busy && <Loader2 size={11} className="animate-spin" />}
          Resolve {reports.length} report{reports.length !== 1 ? 's' : ''}
        </button>
        <button onClick={onCancel} disabled={busy}
          className="text-xs px-3 py-1.5"
          style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}