import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsMobile, MOBILE_BREAKPOINT_PX } from './useIsMobile';

function mockMatchMedia(initialMatches: boolean) {
  const listeners: Array<(e: { matches: boolean }) => void> = [];
  const mql = {
    matches: initialMatches,
    addEventListener: vi.fn((_event: string, cb: (e: { matches: boolean }) => void) => {
      listeners.push(cb);
    }),
    removeEventListener: vi.fn(),
  };
  window.matchMedia = vi.fn().mockReturnValue(mql);
  return {
    mql,
    fire(matches: boolean) {
      mql.matches = matches;
      listeners.forEach((cb) => cb({ matches }));
    },
  };
}

describe('useIsMobile', () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: originalInnerWidth });
  });

  it('reports mobile when the viewport is narrower than the breakpoint', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: MOBILE_BREAKPOINT_PX - 100 });
    mockMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('reports desktop when the viewport is at or above the breakpoint', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: MOBILE_BREAKPOINT_PX + 100 });
    mockMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('updates when the media query change event fires', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: MOBILE_BREAKPOINT_PX + 100 });
    const { fire } = mockMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => {
      fire(true);
    });
    expect(result.current).toBe(true);
  });
});
