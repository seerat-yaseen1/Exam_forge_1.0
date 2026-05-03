import { Outlet } from 'react-router';
import { StudentAuthProvider } from '../../context/StudentAuthContext';

/**
 * Root layout for all /student/* routes.
 * Provides the StudentAuthContext to all child routes.
 */
export function StudentRoot() {
  return (
    <StudentAuthProvider>
      <Outlet />
    </StudentAuthProvider>
  );
}
