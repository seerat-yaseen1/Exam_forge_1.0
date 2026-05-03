/**
 * FacultyAssessmentRosterPage — Faculty portal
 * Gated by canManageExamRosters (both institute gate AND individual faculty gate).
 * invigId = facultyId, scoped to faculty's institute students.
 */

import { useParams, useNavigate, Navigate } from 'react-router';
import { useFacultyAuth } from '../../context/FacultyAuthContext';
import { AssessmentRosterCore } from '../../components/assignments/AssessmentRosterCore';

export function FacultyAssessmentRosterPage() {
  const { assessmentId } = useParams<{ assessmentId: string }>();
  const navigate = useNavigate();
  const { session } = useFacultyAuth();

  if (!session?.canManageExamRosters) {
    return <Navigate to="/faculty/dashboard" replace />;
  }

  if (!assessmentId) return null;

  return (
    <AssessmentRosterCore
      assessmentId={assessmentId}
      invigId={session.facultyId}
      instituteId={session.instituteId}
      reviewerRole="faculty"
      onBack={() => navigate('/faculty/assignments')}
    />
  );
}
