/**
 * The Appearance page, mounted.
 *
 * themes.test.ts proves the palettes are sound. This proves the wiring between
 * a student's click and the pixels, which is where a theme system actually
 * breaks:
 *
 *   • the tokens have to land on <html>, not on a React state nobody reads;
 *   • hovering must preview and leaving must put it back, or a student browsing
 *     the gallery silently changes their own settings;
 *   • the choice has to be written to the account, or it is a per-tab novelty;
 *   • `system` has to keep following the OS after it is chosen.
 *
 * Mounted into jsdom for the reason ResultsTab.test.tsx gives: the string
 * renderer warns on every useLayoutEffect it meets, and applying the theme IS
 * a layout effect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { THEMES } from '../../../lib/themes';
import { DEFAULT_PREFERENCES, type StudentPreferences } from '../../../lib/studentPreferences';

// ── Doubles ───────────────────────────────────────────────────────

const savePreferences = vi.fn(async () => true);
// Typed by its return so a test can hand back a stored preference set; the
// bare `async () => null` vitest infers otherwise pins it to `null` forever.
const loadPreferences = vi.fn<() => Promise<StudentPreferences | null>>(async () => null);

vi.mock('../../../lib/studentPreferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/studentPreferences')>();
  return {
    ...actual,
    loadPreferences: (...args: unknown[]) => loadPreferences(...(args as [])),
    savePreferences: (...args: unknown[]) => savePreferences(...(args as [])),
  };
});

// The auth context reaches Firebase on import. The provider only ever reads
// `session.studentId`, so a stub is the whole dependency.
vi.mock('../../context/StudentAuthContext', () => ({
  useStudentAuth: () => ({
    session: { studentId: 'stu_1', name: 'Priya M', email: 'p@x.edu' },
    loading: false,
  }),
}));

const { AppearanceProvider } = await import('../../context/AppearanceContext');
const { StudentAppearancePage } = await import('./StudentAppearancePage');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no matchMedia; the provider asks it whether the OS wants dark.
let systemPrefersDark = false;
const mqlListeners = new Set<(e: MediaQueryListEvent) => void>();

beforeEach(() => {
  systemPrefersDark = false;
  mqlListeners.clear();
  localStorage.clear();
  loadPreferences.mockResolvedValue(null);
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-color-scheme: dark') ? systemPrefersDark : false,
    media: query,
    onchange: null,
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => mqlListeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => mqlListeners.delete(cb),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

/**
 * Render, without waiting for the provider's fetch of the stored preferences.
 *
 * Only the test that asserts on the pre-fetch frame wants this; every other one
 * uses `mount`, which settles first. An unsettled promise resolving after a
 * test body has finished is what produces the "update was not wrapped in
 * act(...)" wall that makes a passing suite unreadable.
 */
function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter>
        <AppearanceProvider>
          <StudentAppearancePage />
        </AppearanceProvider>
      </MemoryRouter>,
    );
  });
  return host;
}

/** Render and let the preferences fetch settle. */
async function mount() {
  const el = render();
  await settle();
  return el;
}

/** Flush the microtask queue inside act, so React sees the resulting update. */
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const tokenOn = (prop: string) => document.documentElement.style.getPropertyValue(prop);

/** The gallery tile for a theme, found by its visible label. */
function tileFor(el: HTMLElement, label: string): HTMLButtonElement {
  const match = [...el.querySelectorAll<HTMLButtonElement>('button.ef-theme-tile')].find((b) =>
    b.textContent?.includes(label),
  );
  if (!match) throw new Error(`no tile labelled "${label}"`);
  return match;
}

// ══════════════════════════════════════════════════════════════════

describe('StudentAppearancePage', () => {
  it('offers every shipped theme, plus following the system', async () => {
    const el = await mount();
    const tiles = el.querySelectorAll('button.ef-theme-tile');
    // One per theme, and one more for "Match system".
    expect(tiles.length).toBe(Object.keys(THEMES).length + 1);
    expect(el.textContent).toContain('Match system');
    expect(el.textContent).toContain('Onyx & Gold');
  });

  it('paints the chosen theme onto <html> and remembers it against the account', async () => {
    const el = await mount();

    act(() => { tileFor(el, 'Onyx & Gold').click(); });

    expect(document.documentElement.dataset.efTheme).toBe('onyx');
    expect(document.documentElement.dataset.efMode).toBe('dark');
    // `color-scheme` is what makes the browser's own furniture — scrollbars,
    // form controls, the overscroll gutter — follow a dark theme.
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(tokenOn('--ef-canvas')).toBe(THEMES.onyx.tokens['--ef-canvas']);
    expect(tokenOn('--ef-accent')).toBe(THEMES.onyx.tokens['--ef-accent']);

    expect(savePreferences).toHaveBeenCalledWith('stu_1', expect.objectContaining({ theme: 'onyx' }));
    expect(JSON.parse(localStorage.getItem('ef.appearance.stu_1')!)).toMatchObject({ theme: 'onyx' });
  });

  it('previews on hover and puts back the saved theme on leave', async () => {
    const el = await mount();
    act(() => { tileFor(el, 'Cognac').click(); });
    savePreferences.mockClear();

    const midnight = tileFor(el, 'Midnight');
    act(() => { midnight.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    // React's synthetic mouseEnter is delivered via mouseout/mouseover pairs;
    // dispatch through the DOM so the component's own handler is what runs.
    expect(tokenOn('--ef-canvas')).toBe(THEMES.midnight.tokens['--ef-canvas']);

    act(() => {
      midnight.dispatchEvent(new MouseEvent('mouseout', {
        bubbles: true,
        relatedTarget: document.body,
      }));
    });
    expect(tokenOn('--ef-canvas')).toBe(THEMES.cognac.tokens['--ef-canvas']);

    // A preview must never be mistaken for a choice.
    expect(savePreferences).not.toHaveBeenCalled();
  });

  it('keeps following the OS while the choice is "system"', async () => {
    await mount();
    expect(document.documentElement.dataset.efTheme).toBe('classic');

    act(() => {
      systemPrefersDark = true;
      mqlListeners.forEach((cb) => cb({ matches: true } as MediaQueryListEvent));
    });

    expect(document.documentElement.dataset.efTheme).toBe('midnight');
  });

  it('stops following the OS once a theme is picked explicitly', async () => {
    const el = await mount();
    act(() => { tileFor(el, 'Cognac').click(); });

    act(() => {
      systemPrefersDark = true;
      mqlListeners.forEach((cb) => cb({ matches: true } as MediaQueryListEvent));
    });

    expect(document.documentElement.dataset.efTheme).toBe('cognac');
  });

  it('applies the account\'s stored theme over whatever this device was using', async () => {
    localStorage.setItem('ef.appearance.stu_1', JSON.stringify({
      theme: 'cognac', motion: 'system', density: 'comfortable',
    }));
    loadPreferences.mockResolvedValue({ theme: 'emerald', motion: 'reduced', density: 'compact' });

    render();
    // Before the fetch resolves, the local copy is what stops a flash.
    expect(document.documentElement.dataset.efTheme).toBe('cognac');

    await settle();

    // The account is the authority: that is what "follows you to another
    // device" means.
    expect(document.documentElement.dataset.efTheme).toBe('emerald');
    expect(document.documentElement.dataset.efMotion).toBe('reduced');
    expect(document.documentElement.dataset.efDensity).toBe('compact');
  });

  it('carries the comfort preferences as attributes CSS can key off', async () => {
    const el = await mount();
    const compact = [...el.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find(
      (b) => b.textContent === 'Compact',
    )!;
    act(() => { compact.click(); });

    expect(document.documentElement.dataset.efDensity).toBe('compact');
    expect(savePreferences).toHaveBeenCalledWith('stu_1', expect.objectContaining({ density: 'compact' }));
  });

  it('resets every preference at once, and only when there is something to reset', async () => {
    const el = await mount();
    const resetButton = () =>
      [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Reset'))!;

    // Nothing chosen yet — the control is inert rather than misleading.
    expect(resetButton().disabled).toBe(true);

    act(() => { tileFor(el, 'Bordeaux').click(); });
    expect(resetButton().disabled).toBe(false);

    act(() => { resetButton().click(); });
    expect(document.documentElement.dataset.efTheme).toBe('classic');
    expect(savePreferences).toHaveBeenLastCalledWith('stu_1', DEFAULT_PREFERENCES);
  });

  it('hands the page back unthemed when the student leaves /student', async () => {
    const el = await mount();
    act(() => { tileFor(el, 'Onyx & Gold').click(); });
    expect(tokenOn('--ef-canvas')).not.toBe('');

    act(() => root!.unmount());
    root = null;

    // The other three role consoles have no theme system; leaving one applied
    // would recolour them from a student's preference.
    expect(tokenOn('--ef-canvas')).toBe('');
    expect(document.documentElement.dataset.efTheme).toBeUndefined();
  });
});
