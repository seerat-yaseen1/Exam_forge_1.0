import { Outlet } from 'react-router';
import { StudentAuthProvider } from '../../context/StudentAuthContext';
import { AppearanceProvider } from '../../context/AppearanceContext';

/**
 * Root layout for all /student/* routes.
 *
 * Provides the StudentAuthContext to all child routes, and inside it the
 * appearance provider — inside, because a student's theme is a property of
 * their account and the provider needs the session to know whose preferences
 * to load.
 *
 * This is also the boundary of the theme. Every /student route is below it, so
 * the auth pages and the full-page exam takeovers are themed along with the
 * dashboard; nothing outside /student is, which is what keeps the other three
 * role consoles rendering from the untouched literals in palette.css. The exam
 * shell is exempt from within — see `.ef-exam-scope`.
 */
export function StudentRoot() {
  return (
    <StudentAuthProvider>
      <AppearanceProvider>
        <Outlet />
      </AppearanceProvider>
    </StudentAuthProvider>
  );
}
