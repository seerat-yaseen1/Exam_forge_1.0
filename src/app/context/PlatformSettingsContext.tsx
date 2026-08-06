// ══════════════════════════════════════════════════════════════════
// PLATFORM SETTINGS — branding, and nothing else
// ══════════════════════════════════════════════════════════════════
//
// M4 (audit 2026-08-06). The platform name and logo lived on the WEB OWNER's
// AuthContext, which meant every surface that wanted to render the product's
// own name had to import the web owner's authentication context to get it.
// Seven files did: the four institute auth pages, and the student, faculty and
// institute dashboard layouts.
//
// Nothing leaked. All seven destructured `platformSettings` and never touched
// `user`, `login` or `logout`, so no identity crossed a role boundary and the
// claim that role isolation holds was true of the running code. What was not
// true was the shape: a student layout importing `useAuth` from the web
// owner's context reads as a boundary violation to anyone auditing imports,
// and the only thing preventing it from becoming one was that nobody had
// destructured one more field.
//
// Branding is not authentication. It is a property of the PLATFORM, identical
// for every viewer signed in or not, so it belongs in its own provider above
// all four auth contexts rather than inside the one that happens to have an
// editor for it.
//
// ── ON PERSISTENCE ────────────────────────────────────────────────
// This is in-memory state with a hardcoded default, exactly as it was on
// AuthContext — updatePlatformSettings mutates React state and nothing writes
// to Firestore, so a refresh restores 'STRATUM' and no logo. That is a
// pre-existing product gap, not something this extraction introduced, and
// wiring it to a settings document is a separate change with its own
// decisions (which collection, who may write it, what the rules say). Moving
// the gap without widening it is the whole scope here.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export interface PlatformSettings {
  name: string;
  logoUrl: string | null;
}

interface PlatformSettingsContextType {
  platformSettings: PlatformSettings;
  updatePlatformSettings: (settings: Partial<PlatformSettings>) => void;
}

const PlatformSettingsContext = createContext<PlatformSettingsContextType | null>(null);

const DEFAULT_SETTINGS: PlatformSettings = { name: 'STRATUM', logoUrl: null };

export function PlatformSettingsProvider({ children }: { children: ReactNode }) {
  const [platformSettings, setPlatformSettings] = useState<PlatformSettings>(DEFAULT_SETTINGS);

  const updatePlatformSettings = useCallback((settings: Partial<PlatformSettings>) => {
    setPlatformSettings((prev) => ({ ...prev, ...settings }));
  }, []);

  // Memoised so the four auth providers nested below this one do not re-render
  // their whole subtree — which on the student side is the exam shell —
  // every time an unrelated parent renders.
  const value = useMemo(
    () => ({ platformSettings, updatePlatformSettings }),
    [platformSettings, updatePlatformSettings],
  );

  return (
    <PlatformSettingsContext.Provider value={value}>
      {children}
    </PlatformSettingsContext.Provider>
  );
}

/**
 * Read the platform's branding. Safe from any role — that is the point.
 *
 * Throws rather than returning a default when the provider is missing: a
 * silent fallback would render 'STRATUM' on a page whose provider was
 * accidentally dropped, and nobody would notice until a customer asked why
 * their institute's branding had vanished.
 */
export function usePlatformSettings(): PlatformSettingsContextType {
  const ctx = useContext(PlatformSettingsContext);
  if (!ctx) {
    throw new Error('usePlatformSettings must be used within a PlatformSettingsProvider');
  }
  return ctx;
}
