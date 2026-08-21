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

  // Permission gate — redirect if the roster gate is closed
  if (!session?.canManageExamRosters) {
    return <Navigate to="/faculty/dashboard" replace />;
  }

  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const facultyId = session.facultyId;

  const load = () => {
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

  useEffect(load, [facultyId]);

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
