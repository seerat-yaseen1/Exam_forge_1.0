import { Navigate } from 'react-router';
import { useInstituteAuth } from '../../context/InstituteAuthContext';
import { ReportsInboxCore } from '../../components/assignments/ReportsInboxCore';

export function InstituteReportsInboxPage() {
  const { session } = useInstituteAuth();
  if (!session?.canAdminManageExamRosters) {
    return <Navigate to="/institute/dashboard" replace />;
  }
  return (
    <ReportsInboxCore
      scope={{ kind: 'institute', instituteId: session.instituteId }}
      rosterPathFor={(id) => `/institute/assignments/${id}/roster`}
    />
  );
}
