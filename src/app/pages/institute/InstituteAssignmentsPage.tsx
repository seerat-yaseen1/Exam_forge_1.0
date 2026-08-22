/**
 * The institute admin's view of live exams.
 *
 * Everything visible is RosterBrowser, shared with the faculty console. What
 * is institute about this page is the query — own assessments plus published
 * ones assigned to this institute or to everybody — and the fact that drafts
 * never appear here at all: a draft belongs to whoever is still writing it.
 */

import { useState, useEffect } from 'react';
import { useNavigate, Navigate } from 'react-router';
import { ClipboardList } from 'lucide-react';
import { useInstituteAuth } from '../../context/InstituteAuthContext';
import {
  getAssessmentsVisibleToInstitute,
  type Assessment,
} from '../../../lib/assessmentService';
import { RosterBrowser } from '../../components/assignments/RosterBrowser';
import { ErrorBanner, PageHeader, PageShell, StatRow, StatTile } from '../../components/console/ui';

export function InstituteAssignmentsPage() {
  const navigate = useNavigate();
  const { session } = useInstituteAuth();

  // Every hook runs before the permission gate — see the note on
  // FacultyAssignmentsPage for the crash this ordering prevents. Briefly: the
  // session is null while auth resolves, so a gate above these hooks changes
  // the hook COUNT between renders and React throws.
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const instituteId = session?.instituteId ?? '';
  const canAdminManageExamRosters = session?.canAdminManageExamRosters ?? false;

  const load = () => {
    if (!instituteId || !canAdminManageExamRosters) return;
    setLoading(true);
    setError('');
    getAssessmentsVisibleToInstitute(instituteId)
      .then((all) => {
        // Server queries already scope to: own assessments + published ones
        // assigned to this institute (or to all). Keep this view to published
        // items only — own drafts are edited elsewhere.
        const relevant = all.filter((a) => a.status !== 'draft');
        relevant.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setAssessments(relevant);
      })
      .catch((e) => setError(e?.message ?? 'Could not load your assessments.'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [instituteId, canAdminManageExamRosters]);

  // Permission gate — below every hook, deliberately.
  if (!canAdminManageExamRosters) {
    return <Navigate to="/institute/dashboard" replace />;
  }

  const active = assessments.filter((a) => a.status === 'active').length;

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Institute admin
          </>
        }
        title="Exam rosters"
        subtitle="Every assessment your students can sit. Open one to watch it live — who has started, who has handed in, and who needs a session released."
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
            hint="Assessments inside their window. These are the ones with a roster worth watching."
          />
          <StatTile
            label="Assigned to you"
            value={loading ? '—' : assessments.length}
            icon={<ClipboardList size={13} strokeWidth={1.7} />}
            sub="published, all time"
            hint="Everything published to this institute, whether it has run yet or not."
          />
        </StatRow>
      </div>

      <RosterBrowser
        assessments={assessments}
        loading={loading}
        statuses={['all', 'active', 'closed']}
        initialStatus="active"
        onOpen={(a) => navigate(`/institute/assignments/${a.id}/roster`)}
        blockedReason={() => null}
        emptyTitle="Nothing assigned yet"
        emptyBody="When the platform or one of your faculty publishes an assessment to this institute, it appears here with a live roster."
      />
    </PageShell>
  );
}
