import { useEffect, useState } from 'react';

/**
 * STRATUM responsive breakpoints (Tailwind defaults):
 *   phone   = <768px   (everything below `md:`)
 *   tablet  = ≥768px && <1024px  (`md:`)
 *   desktop = ≥1024px  (`lg:`)
 *
 * Prefer Tailwind classes (`md:hidden`, `md:flex`, etc.) for CSS-only branches.
 * Use this hook only when JS needs to know (e.g., switching a Sheet side from
 * "right" to "bottom" on phones, or rendering a different component tree).
 */
export const MOBILE_BREAKPOINT_PX = 768;

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < MOBILE_BREAKPOINT_PX;
  });

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}
