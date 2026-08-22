/**
 * A faculty member's own assessments, and the live roster for each.
 *
 * The list is RosterBrowser, shared with the institute console. What is
 * faculty about this page is that drafts are included — they are yours, and
 * seeing the one you have not finished is the point — and that a draft has no
 * roster to open. The card says so rather than ignoring the press.
 */

import { useState, useEffect } from 'react';
import { useNavigate, Navigate } from 'react-router';
import { ClipboardList, FileText } from 'lucide-react';
import { useFacultyAuth } from '../../context/FacultyAuthContext';
import { getAssessmentsByOwner, type Assessment } from '../../../lib/assessmentService';
import { RosterBrowser } from '../../components/assignments/RosterBrowser';
import { ErrorBanner, PageHeader, PageShell, StatRow, StatTile } from '../../components/console/ui';

export function FacultyAssignmentsPage() {
  const navigate = useNavigate();
  const { session } = useFacultyAuth();

  // ── EVERY HOOK RUNS BEFORE THE PERMISSION GATE ──────────────────
  //
  // The gate used to sit here, above these hooks, and return <Navigate/>
  // early. That is a hook-order violation and it had a real failure mode:
  // `session` is null while the auth context resolves, so the first render
  // took the early return and called two hooks, and the render after the
  // session arrived fell through to call six. React compares the counts and
  // throws "Rendered more hooks than during the previous render", taking the
  // page down instead of redirecting.
  //
  // It survived because the redirect usually unmounts the component before
  // the session lands — a race, not a design. The gate now sits below every
  // hook, which is the only arrangement where the count cannot change.
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Optional now, because these run before the gate has had its say.
  const facultyId = session?.facultyId ?? '';
  const canManageExamRosters = session?.canManageExamRosters ?? false;

  const load = () => {
    // No identity yet, or no business being here — either way there is
    // nothing to fetch. Not an error state: the gate below decides what the
    // person actually sees.
    if (!facultyId || !canManageExamRosters) return;
    setLoading(true);
    setError('');
    getAssessmentsByOwner('faculty', facultyId)
      .then((list) => {
        const live = list.filter((a) => !a.isDeleted);
        live.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setAssessments(live);
      })
      .catch((e) => setError(e?.message ?? 'Could not load your assessments.'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [facultyId, canManageExamRosters]);

  // Permission gate — redirect if the roster gate is closed.
  if (!canManageExamRosters) {
    return <Navigate to="/faculty/dashboard" replace />;
  }

  const active = assessments.filter((a) => a.status === 'active').length;
  const drafts = assessments.filter((a) => a.status === 'draft').length;

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Faculty
          </>
        }
        title="My assessments"
        subtitle="Everything you have built. Open a published one to watch it live — who has started, who has handed in, and who needs a session released."
      />

      {error && (
        <div className="mb-5">
          <ErrorBanner message={error} onRetry={load} />
        </div>
      )}

      <div style={{ marginBottom: 26 }}>
        <StatRow>
          <StatTile
            label="Running now"
            value={loading ? '—' : active}
            icon={<ClipboardList size={13} strokeWidth={1.7} />}
            tone={active > 0 ? 'success' : undefined}
            sub={active > 0 ? 'open to students' : 'nothing live'}
            hint="Published and inside its window. These are the ones with a roster worth watching."
          />
          <StatTile
            label="Drafts"
            value={loading ? '—' : drafts}
            icon={<FileText size={13} strokeWidth={1.7} />}
            tone={drafts > 0 ? 'warning' : undefined}
            sub={drafts > 0 ? 'not published' : 'none waiting'}
            hint="Nobody can sit a draft. It stays invisible to students until you publish it."
          />
          <StatTile
            label="All assessments"
            value={loading ? '—' : assessments.length}
            icon={<ClipboardList size={13} strokeWidth={1.7} />}
            sub="you have written"
            hint="Everything you own that has not been deleted."
          />
        </StatRow>
      </div>

      <RosterBrowser
        assessments={assessments}
        loading={loading}
        statuses={['all', 'active', 'draft', 'closed']}
        initialStatus="all"
        onOpen={(a) => navigate(`/faculty/assignments/${a.id}/roster`)}
        blockedReason={(a) => (a.status === 'draft' ? 'Draft — publish it to get a roster' : null)}
        emptyTitle="No assessments yet"
        emptyBody="An assessment is a paper plus who sits it and when. Once you have built one, its live roster appears here."
      />
    </PageShell>
  );
}
