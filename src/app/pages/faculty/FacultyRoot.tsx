import { Outlet } from 'react-router';
import { FacultyAuthProvider } from '../../context/FacultyAuthContext';

/**
 * Root layout for all /faculty/* routes.
 * Provides the FacultyAuthContext to all child routes.
 */
export function FacultyRoot() {
  return (
    <FacultyAuthProvider>
      <Outlet />
    </FacultyAuthProvider>
  );
}
