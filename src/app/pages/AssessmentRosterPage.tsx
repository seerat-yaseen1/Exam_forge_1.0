/**
 * AssessmentRosterPage — Web Owner portal
 * No permission gate (Web Owner always has full access).
 * Passes invigId = 'webOwner' and instituteId = null (see all students).
 */

import { useParams, useNavigate } from 'react-router';
import { AssessmentRosterCore } from '../components/assignments/AssessmentRosterCore';

export function AssessmentRosterPage() {
  const { assessmentId } = useParams<{ assessmentId: string }>();
  const navigate = useNavigate();

  if (!assessmentId) return null;

  return (
    <AssessmentRosterCore
      assessmentId={assessmentId}
      invigId="webOwner"
      instituteId={null}
      onBack={() => navigate('/dashboard/assignments')}
    />
  );
}
