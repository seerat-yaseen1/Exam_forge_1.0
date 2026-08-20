/**
 * AppearanceContext — applies the student's chosen theme, and remembers it.
 *
 * ── WHERE THE THEME IS APPLIED, AND WHY THERE ─────────────────────
 * On `<html>`, as inline custom properties. Not on a wrapper div, because
 * several screens render OUTSIDE their dashboard layout (every auth page, the
 * exam briefing, the results takeover) and a wrapper would leave them
 * unthemed. Not as a stylesheet class either — inline properties are what let
 * `themes.ts` stay the single source of truth without a generated CSS file
 * that can fall out of step with it.
 *
 * ── ONE PROVIDER, FOUR CONSOLES ───────────────────────────────────
 * Web owner, institute admin, faculty and student each mount this in their own
 * Root. It knows about none of them: it is handed an account id and asked to
 * remember a preference against it. The identity comes from `useAuthUid`
 * below, which watches Firebase auth rather than any role's context — the one
 * fact all four have in common.
 *
 * ── WHAT IS DELIBERATELY EXEMPT ───────────────────────────────────
 * The exam shell. It re-declares the classic palette for its own subtree via
 * `.ef-exam-scope` (see palette.css), so a candidate sitting a paper sees the
 * interface the invigilation rules were written against, whatever theme their
 * account carries. That exemption lives in CSS rather than here on purpose: it
 * then holds for every future theme without this file needing to know which
 * routes are exams.
 *
 * ── THE ORDER PREFERENCES ARE TRUSTED IN ──────────────────────────
 *   1. localStorage, read synchronously during the first render.
 *   2. Firestore, once the session resolves — the account's own answer, which
 *      wins because it is what "the choice follows me to another device"
 *      means.
 *   3. The default.
 *
 * Step 1 exists to stop a flash. Firebase restores a session asynchronously,
 * so on every refresh the first paint happens before the account id is known;
 * `readLocalPreferences()` falls back to a key written without an owner
 * precisely so that paint is already correct.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../../lib/firebase';
import {
  DEFAULT_PREFERENCES,
  isPreferenceKey,
  loadLegacyStudentPreferences,
  loadPreferences,
  readLocalPreferences,
  samePreferences,
  savePreferences,
  writeLocalPreferences,
  type AppearancePreferences,
  type DensityPreference,
  type MotionPreference,
} from '../../lib/appearancePreferences';
import {
  resolveTheme,
  SYSTEM_CHOICE,
  THEMES,
  type Theme,
  type ThemeChoice,
} from '../../lib/themes';

interface AppearanceContextValue {
  /** What the student picked — may be `'system'`. */
  choice: ThemeChoice;
  /** What that resolves to right now. Never null. */
  theme: Theme;
  motion: MotionPreference;
  density: DensityPreference;
  /** True while the account's stored preferences are still being fetched. */
  syncing: boolean;
  setTheme: (choice: ThemeChoice) => void;
  setMotion: (motion: MotionPreference) => void;
  setDensity: (density: DensityPreference) => void;
  /** Restore every appearance preference to the platform default. */
  reset: () => void;
  /**
   * Paint a theme onto the page without saving it — used by the picker so a
   * hovered swatch shows the real thing. Pass null to go back to the saved one.
   */
  preview: (choice: ThemeChoice | null) => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

const DARK_QUERY = '(prefers-color-scheme: dark)';

function prefersDarkNow(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(DARK_QUERY).matches;
}

/**
 * Write a theme onto `<html>`.
 *
 * `data-ef-theme` carries the id so CSS can key off it (palette.css uses it to
 * decide whether the app owns the page background at all — without a theme
 * applied, the other three roles' surfaces must stay exactly as they were).
 * `colorScheme` is what makes native scrollbars, form controls and the
 * browser's own overscroll gutter follow a dark theme; forgetting it is the
 * usual reason a hand-rolled dark mode has a white scrollbar.
 */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const [prop, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(prop, value);
  }
  root.dataset.efTheme = theme.id;
  root.dataset.efMode = theme.mode;
  root.style.colorScheme = theme.mode;
}

function clearTheme(): void {
  const root = document.documentElement;
  // Every theme writes the same key set, so clearing one clears them all.
  for (const prop of Object.keys(THEMES.classic.tokens)) {
    root.style.removeProperty(prop);
  }
  delete root.dataset.efTheme;
  delete root.dataset.efMode;
  delete root.dataset.efMotion;
  delete root.dataset.efDensity;
  root.style.removeProperty('color-scheme');
}

/**
 * The Firebase uid of whoever is signed in, or null.
 *
 * Every console's Root calls this and hands the result to the provider. It
 * watches Firebase auth rather than any of the four role contexts, because the
 * uid is the only identifier all four principals share — see the note at the
 * top of lib/appearancePreferences.ts for why the preference document is keyed
 * by it.
 *
 * Starts from `auth.currentUser` rather than from null so a client-side
 * navigation between consoles does not drop the id for a frame and re-run the
 * provider's pull.
 */
export function useAuthUid(): string | null {
  const [uid, setUid] = useState<string | null>(() => auth.currentUser?.uid ?? null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => setUid(user?.uid ?? null));
    return unsub;
  }, []);

  return uid;
}

export function AppearanceProvider({
  accountId,
  legacyStudentId,
  children,
}: {
  /**
   * The Firebase auth uid of whoever is signed in, or null while that is still
   * resolving (and on the signed-out screens, which are themed from
   * localStorage alone).
   *
   * Passed IN rather than read from a context here, because this provider sits
   * under four different auth contexts — one per role — and importing any one
   * of them would tie the whole theme system to that role. Each Root knows its
   * own identity and hands it over.
   */
  accountId: string | null;
  /**
   * Students only, and only until the next release: the id their preferences
   * were stored under before this feature reached every role. See
   * `loadLegacyStudentPreferences`.
   */
  legacyStudentId?: string | null;
  children: React.ReactNode;
}) {
  // Synchronous first value: no flash, no effect needed to get the right
  // colours onto the first paint.
  const [prefs, setPrefs] = useState<AppearancePreferences>(
    () => readLocalPreferences(accountId) ?? DEFAULT_PREFERENCES,
  );
  const [previewChoice, setPreviewChoice] = useState<ThemeChoice | null>(null);
  const [systemDark, setSystemDark] = useState<boolean>(prefersDarkNow);
  const [syncing, setSyncing] = useState<boolean>(false);

  // Guards the one-time pull below, per account. A ref rather than state: it
  // must not cause a render, and it must survive the render that the pull's
  // own setPrefs triggers.
  const pulledFor = useRef<string | null>(null);

  const activeChoice = previewChoice ?? prefs.theme;
  const theme = useMemo(() => resolveTheme(activeChoice, systemDark), [activeChoice, systemDark]);

  // ── Apply ───────────────────────────────────────────────────────
  // Layout effect, not effect: this must run before the browser paints, or the
  // frame between them shows the previous theme.
  const firstApply = useRef(true);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    const root = document.documentElement;

    // Cross-fade the change — but never the first one. On load there is no
    // previous palette to fade FROM, and the class would only delay the first
    // paint's colours by 300ms.
    const shouldFade =
      !firstApply.current &&
      prefs.motion !== 'reduced' &&
      !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (shouldFade) {
      root.classList.add('ef-theming');
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      fadeTimer.current = setTimeout(() => root.classList.remove('ef-theming'), 320);
    }

    applyTheme(theme);
    firstApply.current = false;
  }, [theme, prefs.motion]);

  useEffect(
    () => () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      document.documentElement.classList.remove('ef-theming');
    },
    [],
  );

  useLayoutEffect(() => {
    document.documentElement.dataset.efMotion = prefs.motion;
    document.documentElement.dataset.efDensity = prefs.density;
  }, [prefs.motion, prefs.density]);

  // Leaving /student (signing out, or switching to another role's login) must
  // hand the page back exactly as it was found: the other three roles have no
  // theme system and their surfaces are the byte-identical palette.
  useEffect(() => clearTheme, []);

  // ── Follow the OS ───────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mql.addEventListener('change', onChange);
    setSystemDark(mql.matches);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  // ── Pull the account's stored preferences ───────────────────────
  useEffect(() => {
    if (!accountId || pulledFor.current === accountId) return;
    pulledFor.current = accountId;
    let cancelled = false;
    setSyncing(true);

    const resolve = async (): Promise<AppearancePreferences> => {
      const remote = await loadPreferences(accountId);
      // The account's answer wins over this device's. That is the whole
      // promise of storing it server-side, and the local copy is only ever a
      // cache of it.
      if (remote) return remote;

      // Nothing under the current key. A student may still have one under the
      // id this feature originally shipped with — read it once, and let the
      // write below move it forward.
      if (legacyStudentId) {
        const legacy = await loadLegacyStudentPreferences(legacyStudentId);
        if (legacy) return legacy;
      }

      // Genuinely new account, or the first run since this feature shipped:
      // adopt whatever this device was already using so the choice is not
      // silently lost on the next device.
      return readLocalPreferences(accountId) ?? DEFAULT_PREFERENCES;
    };

    resolve()
      .then((next) => {
        if (cancelled) return;
        setPrefs(next);
        writeLocalPreferences(accountId, next);
        // Only write back what is worth storing. Persisting the defaults would
        // create a document for every account that never opened the picker.
        if (!samePreferences(next, DEFAULT_PREFERENCES)) void savePreferences(accountId, next);
      })
      .finally(() => {
        if (!cancelled) setSyncing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accountId, legacyStudentId]);

  // ── Cross-tab ───────────────────────────────────────────────────
  // Two tabs open on the same account should not disagree about the theme.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!isPreferenceKey(e.key, accountId)) return;
      const next = readLocalPreferences(accountId);
      if (next) setPrefs((prev) => (samePreferences(prev, next) ? prev : next));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [accountId]);

  // ── Commit ──────────────────────────────────────────────────────
  const commit = useCallback(
    (next: AppearancePreferences) => {
      setPrefs((prev) => (samePreferences(prev, next) ? prev : next));
      setPreviewChoice(null);
      writeLocalPreferences(accountId, next);
      if (accountId) void savePreferences(accountId, next);
    },
    [accountId],
  );

  /**
   * STABLE IDENTITY, and not as an optimisation.
   *
   * ThemeMenu clears any preview on unmount with `useEffect(() => () =>
   * preview(null), [preview])`, which is the only way to guarantee a hovered
   * theme does not outlive the menu however it is dismissed. While this
   * function was re-created inside the context memo, previewing a theme
   * changed `theme`, which rebuilt the memo, which changed this identity,
   * which re-ran that effect — and its cleanup immediately cancelled the
   * preview that had just started. Hovering appeared to do nothing at all.
   *
   * Caught in a browser. The Appearance page's own tiles were unaffected
   * (they have no such cleanup), which is exactly why its passing tests did
   * not notice.
   */
  const preview = useCallback((choice: ThemeChoice | null) => setPreviewChoice(choice), []);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      choice: prefs.theme,
      theme,
      motion: prefs.motion,
      density: prefs.density,
      syncing,
      setTheme: (choice) => commit({ ...prefs, theme: choice }),
      setMotion: (motion) => commit({ ...prefs, motion }),
      setDensity: (density) => commit({ ...prefs, density }),
      reset: () => commit({ ...DEFAULT_PREFERENCES }),
      preview,
    }),
    [prefs, theme, syncing, commit, preview],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

/**
 * The appearance the student chose.
 *
 * Throws outside the provider rather than returning a default: a component
 * that silently renders in the classic palette inside a themed account is a
 * bug that looks like a design decision.
 */
export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error('useAppearance must be used within AppearanceProvider');
  return ctx;
}

export { SYSTEM_CHOICE };
