import { Outlet } from 'react-router';
import { StudentAuthProvider, useStudentAuth } from '../../context/StudentAuthContext';
import { AppearanceProvider, useAuthUid } from '../../context/AppearanceContext';

/**
 * The appearance provider, given the student's identity.
 *
 * A separate component because it has to be INSIDE StudentAuthProvider to read
 * the session — and it only reads it for `legacyStudentId`, the id this
 * feature's first release stored preferences under. The theme itself is keyed
 * by the Firebase uid, like every other role's.
 *
 * When the legacy read is deleted (see loadLegacyStudentPreferences), this
 * component collapses back into a bare <AppearanceProvider accountId={uid}>
 * in StudentRoot, exactly like the other three.
 */
function StudentAppearance({ children }: { children: React.ReactNode }) {
  const uid = useAuthUid();
  const { session } = useStudentAuth();
  return (
    <AppearanceProvider accountId={uid} legacyStudentId={session?.studentId ?? null}>
      {children}
    </AppearanceProvider>
  );
}

/**
 * Root layout for all /student/* routes.
 *
 * Provides the StudentAuthContext to all child routes, and inside it the
 * appearance provider.
 *
 * This is also the boundary of the student console's theme. Every /student
 * route is below it, so the auth pages and the full-page exam takeovers are
 * themed along with the dashboard. The exam SHELL is exempt from within — see
 * `.ef-exam-scope` — because a candidate sitting a paper must see the
 * interface the invigilation rules were written against.
 */
export function StudentRoot() {
  return (
    <StudentAuthProvider>
      <StudentAppearance>
        <Outlet />
      </StudentAppearance>
    </StudentAuthProvider>
  );
}
