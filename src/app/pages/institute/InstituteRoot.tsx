import { Outlet } from 'react-router';
import { InstituteAuthProvider } from '../../context/InstituteAuthContext';

/**
 * Root layout for all /institute/* routes.
 * Provides the InstituteAuthContext to all child routes.
 */
export function InstituteRoot() {
  return (
    <InstituteAuthProvider>
      <Outlet />
    </InstituteAuthProvider>
  );
}
