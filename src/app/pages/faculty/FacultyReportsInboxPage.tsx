import { Navigate } from 'react-router';
import { useFacultyAuth } from '../../context/FacultyAuthContext';
import { ReportsInboxCore } from '../../components/assignments/ReportsInboxCore';

export function FacultyReportsInboxPage() {
  const { session } = useFacultyAuth();
  if (!session?.canManageExamRosters) {
    return <Navigate to="/faculty/dashboard" replace />;
  }
  return (
    <ReportsInboxCore
      scope={{ kind: 'faculty', facultyId: session.facultyId }}
      rosterPathFor={(id) => `/faculty/assignments/${id}/roster`}
    />
  );
}
