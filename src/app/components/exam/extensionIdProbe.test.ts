/**
 * Detection by store ID.
 *
 * The property under test is not "does it find things" — it is the shape of
 * what a result MEANS. The probe is sound but not complete: a hit proves an
 * extension is installed, a miss proves nothing at all. Everything downstream
 * depends on that asymmetry being preserved, because the failure it guards
 * against is the worst kind a detector has — reporting safety it never checked.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { probeExtensionIds, PROBE_TARGETS, type ProbeTarget } from './extensionIdProbe';

/**
 * Stand in for the browser's answer to an extension-owned URL.
 *
 * jsdom never loads images, so `src` is intercepted and the matching handler
 * is fired asynchronously — the same shape the real browser produces, and
 * asynchronous on purpose so a test cannot pass by accident on a synchronous
 * resolution the real thing would never give.
 */
function mockImageLoader(shouldLoad: (url: string) => boolean) {
  class MockImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(url: string) {
      setTimeout(() => {
        if (shouldLoad(url)) this.onload?.();
        else this.onerror?.();
      }, 0);
    }
  }
  vi.stubGlobal('Image', MockImage);
}

const TARGET: ProbeTarget = { id: 'abc123', label: 'Test Extension', paths: ['icon.png'] };

afterEach(() => { vi.unstubAllGlobals(); });

describe('probeExtensionIds', () => {
  it('reports an extension whose resource loads', () => {
    mockImageLoader((url) => url.includes('abc123'));
    return expect(probeExtensionIds([TARGET])).resolves.toMatchObject({
      found: ['Test Extension'],
    });
  });

  it('reports nothing when no resource loads', async () => {
    mockImageLoader(() => false);
    await expect(probeExtensionIds([TARGET])).resolves.toEqual({
      found: [], blockedByCsp: false,
    });
  });

  it('needs only ONE path of several to answer', async () => {
    // Paths are the guessy part — they are not published anywhere
    // authoritative. Trying several and accepting any hit is what keeps a
    // stale path from turning a real detection into a miss.
    const multi: ProbeTarget = {
      id: 'xyz', label: 'Multi', paths: ['wrong.png', 'alsowrong.png', 'right.png'],
    };
    mockImageLoader((url) => url.endsWith('right.png'));
    await expect(probeExtensionIds([multi])).resolves.toMatchObject({ found: ['Multi'] });
  });

  it('names each extension once even if several paths hit', async () => {
    const multi: ProbeTarget = { id: 'xyz', label: 'Multi', paths: ['a.png', 'b.png'] };
    mockImageLoader(() => true);
    const { found } = await probeExtensionIds([multi]);
    expect(found).toEqual(['Multi']);
  });

  it('probes each target independently', async () => {
    const a: ProbeTarget = { id: 'aaa', label: 'A', paths: ['i.png'] };
    const b: ProbeTarget = { id: 'bbb', label: 'B', paths: ['i.png'] };
    mockImageLoader((url) => url.includes('bbb'));
    const { found } = await probeExtensionIds([a, b]);
    expect(found).toEqual(['B']);
  });

  it('gives up on a request that never settles', async () => {
    // A blocked or dropped request may fire no event at all. Without the
    // timeout this promise would hang, and it is awaited on the path a student
    // takes to enter an exam.
    vi.stubGlobal('Image', class { set src(_: string) { /* never answers */ } });
    await expect(probeExtensionIds([TARGET], 10)).resolves.toEqual({
      found: [], blockedByCsp: false,
    });
  });

  it('survives a browser with no Image constructor', async () => {
    vi.stubGlobal('Image', undefined);
    await expect(probeExtensionIds([TARGET], 10)).resolves.toEqual({
      found: [], blockedByCsp: false,
    });
  });

  // ── The CSP trap ───────────────────────────────────────────────
  //
  // The enforcing policy in vercel.json does not restrict img-src today, but
  // the Report-Only policy beside it does. Promoting it would make every probe
  // fail identically to "not installed" — a detector silently reporting
  // safety it never checked. The violation event is the only place the browser
  // distinguishes the two.
  it('distinguishes a blocked probe from an absent extension', async () => {
    mockImageLoader(() => false);
    const pending = probeExtensionIds([TARGET], 50);
    document.dispatchEvent(Object.assign(
      new Event('securitypolicyviolation'),
      { blockedURI: 'chrome-extension://abc123/icon.png' },
    ));
    const result = await pending;
    expect(result.found).toEqual([]);
    // Same empty `found` as a clean machine — and distinguishable only by this.
    expect(result.blockedByCsp).toBe(true);
  });

  it('ignores policy violations from unrelated URLs', async () => {
    mockImageLoader(() => false);
    const pending = probeExtensionIds([TARGET], 50);
    document.dispatchEvent(Object.assign(
      new Event('securitypolicyviolation'),
      { blockedURI: 'https://fonts.example.test/x.woff2' },
    ));
    await expect(pending).resolves.toMatchObject({ blockedByCsp: false });
  });

  it('stops listening once the sweep is done', async () => {
    mockImageLoader(() => false);
    await probeExtensionIds([TARGET], 10);
    // A violation arriving later belongs to some other part of the page.
    document.dispatchEvent(Object.assign(
      new Event('securitypolicyviolation'),
      { blockedURI: 'chrome-extension://abc123/icon.png' },
    ));
    await expect(probeExtensionIds([TARGET], 10))
      .resolves.toMatchObject({ blockedByCsp: false });
  });
});

describe('PROBE_TARGETS', () => {
  it('carries well-formed Chrome Web Store ids', () => {
    // A store id is 32 characters from a..p. A typo here is invisible at
    // runtime — the probe just never fires — so the shape is checked where it
    // can actually fail loudly.
    for (const t of PROBE_TARGETS) {
      expect(t.id, `${t.label} id`).toMatch(/^[a-p]{32}$/);
      expect(t.paths.length, `${t.label} paths`).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate ids', () => {
    const ids = PROBE_TARGETS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers the two extensions observed live', () => {
    const labels = PROBE_TARGETS.map((t) => t.label);
    expect(labels).toContain('Question AI');
    expect(labels).toContain('Wordtune');
  });
});
