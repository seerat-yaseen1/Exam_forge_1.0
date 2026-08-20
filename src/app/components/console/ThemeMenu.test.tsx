/**
 * The header's theme menu.
 *
 * Separate from StudentAppearancePage.test.tsx because the menu has a
 * behaviour the page does not: it clears any preview when it unmounts, so a
 * hovered theme cannot outlive a dismissal. That cleanup is also what broke
 * previewing entirely —
 *
 *   useEffect(() => () => preview(null), [preview])
 *
 * re-runs whenever `preview` changes identity, and `preview` was being rebuilt
 * inside the context memo, which a preview itself invalidates. Hovering
 * started a preview and the resulting re-render cancelled it in the same
 * commit. The page's tiles have no cleanup, so its tests passed throughout; the
 * bug was found by opening the menu in a browser.
 *
 * Both halves are asserted here: a hover previews, and every exit puts the
 * saved theme back.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { THEMES } from '../../../lib/themes';

vi.mock('../../../lib/appearancePreferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/appearancePreferences')>();
  return { ...actual, loadPreferences: async () => null, savePreferences: async () => true };
});
const { AppearanceProvider, useAppearance } = await import('../../context/AppearanceContext');
const { ThemeMenu } = await import('./ThemeMenu');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  localStorage.clear();
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
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

/** Renders the menu, plus a button that sets a saved theme to preview against. */
function Harness({ open }: { open: boolean }) {
  const { setTheme } = useAppearance();
  return (
    <>
      <button type="button" data-testid="pick-cognac" onClick={() => setTheme('cognac')}>
        pick
      </button>
      {open && <ThemeMenu onClose={() => {}} />}
    </>
  );
}

async function mount(open = true) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter>
        <AppearanceProvider accountId="stu_1">
          <Harness open={open} />
        </AppearanceProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return host!;
}

const canvas = () => document.documentElement.style.getPropertyValue('--ef-canvas');

function rowFor(el: HTMLElement, label: string): HTMLButtonElement {
  const match = [...el.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((b) =>
    b.textContent?.includes(label),
  );
  if (!match) throw new Error(`no menu row for "${label}"`);
  return match;
}

// ══════════════════════════════════════════════════════════════════

describe('ThemeMenu', () => {
  it('previews a theme on hover, and keeps it applied while the pointer is there', async () => {
    const el = await mount();
    expect(canvas()).toBe(THEMES.classic.tokens['--ef-canvas']);

    const row = rowFor(el, 'Onyx & Gold');
    act(() => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });

    // The regression: this used to snap straight back to classic within the
    // same commit.
    expect(canvas()).toBe(THEMES.onyx.tokens['--ef-canvas']);
  });

  it('puts the saved theme back when the pointer leaves', async () => {
    const el = await mount();
    act(() => { el.querySelector<HTMLButtonElement>('[data-testid="pick-cognac"]')!.click(); });
    expect(canvas()).toBe(THEMES.cognac.tokens['--ef-canvas']);

    const row = rowFor(el, 'Midnight');
    act(() => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(canvas()).toBe(THEMES.midnight.tokens['--ef-canvas']);

    act(() => {
      row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(canvas()).toBe(THEMES.cognac.tokens['--ef-canvas']);
  });

  it('previews for a keyboard user too, not only for a mouse', async () => {
    const el = await mount();
    const row = rowFor(el, 'Deep Emerald');
    act(() => { row.focus(); });
    expect(canvas()).toBe(THEMES.emerald.tokens['--ef-canvas']);
    act(() => { row.blur(); });
    expect(canvas()).toBe(THEMES.classic.tokens['--ef-canvas']);
  });

  it('never lets a preview outlive the menu', async () => {
    const el = await mount();
    act(() => { rowFor(el, 'Bordeaux').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(canvas()).toBe(THEMES.bordeaux.tokens['--ef-canvas']);

    // Dismissed with the pointer still over the row — an Escape, a route
    // change, an outside click all arrive here as an unmount.
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <AppearanceProvider accountId="stu_1">
            <Harness open={false} />
          </AppearanceProvider>
        </MemoryRouter>,
      );
    });

    expect(canvas()).toBe(THEMES.classic.tokens['--ef-canvas']);
  });

  it('commits the theme on click, and marks it as the current one', async () => {
    const el = await mount();
    act(() => { rowFor(el, 'Steel & Sapphire').click(); });

    expect(canvas()).toBe(THEMES.sapphire.tokens['--ef-canvas']);
    expect(JSON.parse(localStorage.getItem('ef.appearance.stu_1')!)).toMatchObject({ theme: 'sapphire' });
  });

  it('offers following the system alongside the palettes', async () => {
    const el = await mount();
    expect(el.textContent).toContain('Match system');
    expect(rowFor(el, 'Match system').getAttribute('aria-checked')).toBe('true');
  });
});
