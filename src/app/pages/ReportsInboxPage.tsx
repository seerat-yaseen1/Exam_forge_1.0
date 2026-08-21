/**
 * Web Owner — global Reports inbox (every report in the system).
 */

import { ReportsInboxCore } from './../components/assignments/ReportsInboxCore';

export function ReportsInboxPage() {
  return (
    <ReportsInboxCore
      scope={{ kind: 'web_owner' }}
      role="Web owner"
      rosterPathFor={(id) => `/dashboard/assignments/${id}/roster`}
    />
  );
}
