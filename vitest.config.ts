/**
 * VITEST — client-side test configuration
 *
 * Deliberately SEPARATE from vite.config.ts rather than a `test` block inside
 * it. That file carries a note explaining that Figma Make regenerates parts of
 * the project on push, and test configuration is exactly the kind of thing that
 * would disappear quietly in a regeneration and take the suite's ability to
 * find its own tests with it. Vitest prefers this file when both exist.
 *
 * The alias mirrors vite.config.ts because the app imports through '@/...' and
 * a test that cannot resolve what the app resolves is testing something else.
 */

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // jsdom rather than node: most of what is worth testing on this side
    // eventually touches the DOM (clipboard targets, editor containers), and a
    // suite that has to be reconfigured the first time it does is a suite
    // people stop adding to.
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // node_modules is excluded by default; functions/ has its own headless
    // suites run by node and must not be picked up here.
    exclude: ['node_modules/**', 'functions/**', 'dist/**'],
    restoreMocks: true,
  },
});
