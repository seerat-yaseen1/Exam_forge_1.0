import { Outlet } from 'react-router';
import { AuthProvider } from './context/AuthContext';
import { PlatformSettingsProvider } from './context/PlatformSettingsContext';

export function Root() {
  return (
    // M4: branding sits ABOVE every auth context, because it is a property of
    // the platform rather than of whoever is signed in. This element is the
    // parent of all four role trees (see routes.tsx), so one provider here
    // reaches the web owner, institute, faculty and student surfaces alike —
    // and none of them has to import another role's auth context to render
    // the product's own name.
    <PlatformSettingsProvider>
      <AuthProvider>
        <Outlet />
      </AuthProvider>
    </PlatformSettingsProvider>
  );
}
