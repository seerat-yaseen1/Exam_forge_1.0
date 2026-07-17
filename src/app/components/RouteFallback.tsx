/**
 * RouteFallback — the Suspense fallback for lazily-loaded route chunks.
 *
 * Shown only while a page's JS chunk is in flight (Remediation plan Batch C /
 * ext #18), which in practice means the first visit to each route; the chunk
 * is cached from then on.
 *
 * Deliberately matches the existing in-app loading states (roster, exam
 * shell): same canvas, same spinner weight, same muted grey — so a chunk
 * fetch is visually indistinguishable from a data fetch and the app never
 * flashes an unstyled or differently-styled screen mid-navigation.
 */

import { Loader2 } from 'lucide-react';

export function RouteFallback() {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center"
      style={{ background: '#F7F6F3' }}
    >
      <Loader2 size={18} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
    </div>
  );
}