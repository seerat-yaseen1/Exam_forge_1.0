import { Outlet } from 'react-router';
import { AppearanceProvider, useAuthUid } from '../context/AppearanceContext';

/**
 * Root layout for the Web Owner's routes.
 *
 * The other three consoles already had a Root of their own, each holding its
 * auth provider; the web owner's routes were flat children of the app Root
 * because `AuthProvider` sits up there anyway (it is above all four trees, so
 * that any role can read the platform's own branding).
 *
 * This exists so the appearance provider has somewhere to go that covers the
 * web owner's screens and NOTHING else. Mounting it in the app Root instead
 * would wrap the institute, faculty and student trees too — each of which
 * mounts its own — and two providers writing the same tokens onto <html> is a
 * race with no winner worth having.
 */
export function WebOwnerRoot() {
  const uid = useAuthUid();
  return (
    <AppearanceProvider accountId={uid}>
      <Outlet />
    </AppearanceProvider>
  );
}
