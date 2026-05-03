/**
 * InstituteAssessmentRosterPage — Institute Admin portal
 * Gated by canAdminManageExamRosters.
 * invigId = instituteId, scoped to institute's students.
 */

import { useParams, useNavigate, Navigate } from 'react-router';
import { useInstituteAuth } from '../../context/InstituteAuthContext';
import { AssessmentRosterCore } from '../../components/assignments/AssessmentRosterCore';

export function InstituteAssessmentRosterPage() {
  const { assessmentId } = useParams<{ assessmentId: string }>();
  const navigate = useNavigate();
  const { session } = useInstituteAuth();

  if (!session?.canAdminManageExamRosters) {
    return <Navigate to="/institute/dashboard" replace />;
  }

  if (!assessmentId) return null;

  return (
    <AssessmentRosterCore
      assessmentId={assessmentId}
      invigId={session.instituteId}
      instituteId={session.instituteId}
      reviewerRole="institute"
      onBack={() => navigate('/institute/assignments')}
    />
  );
}
