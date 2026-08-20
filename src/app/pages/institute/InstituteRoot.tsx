import { Outlet } from 'react-router';
import { InstituteAuthProvider } from '../../context/InstituteAuthContext';
import { AppearanceProvider, useAuthUid } from '../../context/AppearanceContext';

/**
 * Root layout for all /institute/* routes.
 *
 * Provides the InstituteAuthContext to all child routes, and the appearance
 * provider that themes them. The provider takes the Firebase uid rather than
 * the institute id: a theme belongs to the PERSON signed in, and two admins
 * sharing one institute do not share a preference.
 */
export function InstituteRoot() {
  const uid = useAuthUid();
  return (
    <InstituteAuthProvider>
      <AppearanceProvider accountId={uid}>
        <Outlet />
      </AppearanceProvider>
    </InstituteAuthProvider>
  );
}
