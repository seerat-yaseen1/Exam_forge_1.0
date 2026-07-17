import { Suspense } from 'react';
import { RouterProvider } from 'react-router';
import { router } from './routes';
import { RouteFallback } from './components/RouteFallback';

/**
 * Suspense boundary for the lazily-loaded pages in routes.tsx
 * (Remediation plan Batch C / ext #18).
 *
 * It sits ABOVE RouterProvider rather than inside each layout because the
 * route tree has three kinds of page that are NOT inside a dashboard layout —
 * the auth pages (login / forgot / reset for all four roles), the full-page
 * exam takeover (briefing / shell), and /seb-quit. A per-layout boundary
 * would leave every one of those without one, and a suspending page with no
 * boundary above it throws. One boundary here covers every route.
 *
 * Trade-off, accepted: while a chunk loads, the fallback replaces the whole
 * screen including the dashboard chrome, rather than just the content pane.
 * That only happens on the first visit to each route (chunks cache), so the
 * cost is a brief flash once per page per session. If it ever grates, adding
 * a second <Suspense> around <Outlet /> inside the four dashboard layouts
 * makes the inner boundary win for dashboard routes and keeps the sidebar
 * painted — no change needed here, nested boundaries resolve innermost-first.
 */
export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <RouterProvider router={router} />
    </Suspense>
  );
}