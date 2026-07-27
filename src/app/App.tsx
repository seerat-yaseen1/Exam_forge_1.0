import { Suspense } from 'react';
import { RouterProvider } from 'react-router';
import { router } from './routes';
import { RouteFallback } from './components/RouteFallback';
import { ErrorBoundary } from './components/ErrorBoundary';

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
 *
 * ── ErrorBoundary placement (audit E-01) ──────────────────────────
 * ABOVE Suspense, deliberately. A lazy import() that fails to resolve — the
 * classic case being a stale cached chunk URL 404ing after a redeploy —
 * rejects rather than suspends, and React routes that to the nearest ERROR
 * boundary, not the Suspense one. Putting it outside means a post-deploy
 * chunk miss shows a reload prompt instead of a white screen; putting it
 * inside would leave exactly that case uncovered.
 *
 * This is the outermost net. Routes that need different recovery behaviour
 * wrap themselves — see the exam routes in routes.tsx, which must not offer
 * a way out of a locked-down sitting.
 */
export default function App() {
  return (
    <ErrorBoundary variant="app" label="root">
      <Suspense fallback={<RouteFallback />}>
        <RouterProvider router={router} />
      </Suspense>
    </ErrorBoundary>
  );
}