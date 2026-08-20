import { Outlet } from 'react-router';
import { FacultyAuthProvider } from '../../context/FacultyAuthContext';
import { AppearanceProvider, useAuthUid } from '../../context/AppearanceContext';

/**
 * Root layout for all /faculty/* routes.
 *
 * Provides the FacultyAuthContext to all child routes, and the appearance
 * provider that themes them.
 */
export function FacultyRoot() {
  const uid = useAuthUid();
  return (
    <FacultyAuthProvider>
      <AppearanceProvider accountId={uid}>
        <Outlet />
      </AppearanceProvider>
    </FacultyAuthProvider>
  );
}
