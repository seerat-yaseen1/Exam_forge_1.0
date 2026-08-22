// ══════════════════════════════════════════════════════════════════
// ESLint — the checks tsc cannot make
// ══════════════════════════════════════════════════════════════════
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────
//
// `tsc --noEmit` runs in CI and catches type errors. It does not catch the
// class of bug that actually reaches students, because that class is not a
// type error:
//
//   • a `useEffect` that closes over a stale value because its dependency
//     array is wrong — the exam clock reading a `timeLeft` from three renders
//     ago is a correctly-typed program
//   • a hook called conditionally, which corrupts React's hook order
//   • a promise dropped on the floor, so a failed answer-write is silent
//
// None of these are reachable by the test suites either: 991 frontend tests
// exercise pure functions and rendered output, and a stale closure only bites
// in a real browser over real time. That gap is exactly the shape of this
// config.
//
// ── THE POSTURE: ERRORS ARE BUGS, WARNINGS ARE DEBT ───────────────
//
// This is a linter arriving late to a 113,000-line codebase that was written
// without one. A config that turned everything on at `error` would produce a
// number nobody acts on, and the honest response to it would be to disable
// the linter — so the rules are split by what a violation MEANS:
//
//   error  → this is a bug, or will become one. CI fails. There are none
//            outstanding; the tree is clean at this level today.
//   warn   → this is worth looking at, may be a false positive, and must not
//            block a deploy at 2am. Visible in `npm run lint`, ignored by CI.
//
// `--max-warnings` is deliberately NOT set. The day it is set is the day the
// warnings have been worked to zero, and that is a separate piece of work
// from installing the linter.
//
// ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────
//
// No formatting rules, no import ordering, no naming conventions. This
// codebase has a strong and consistent house style already, applied by
// people; a linter re-litigating it would produce a large diff that changes
// no behaviour and buries the rules above in noise.
//
// No type-aware linting (`projectService`). It is the obvious next step and
// it is where the best rules live (no-floating-promises with full type
// information, no-misused-promises), but it needs the whole program type-
// checked on every lint run. That belongs in a follow-up that can measure the
// cost against CI time, not smuggled in with the initial install.

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // ── Not ours to lint ────────────────────────────────────────────
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'functions/lib/**',          // build output
      'functions/node_modules/**',
      'public/models/**',          // vendored face-api weights
      'vendor/**',                 // vendored xlsx tarball contents
      'graphify-out/**',
      '.agents/**',
    ],
  },

  // ── Frontend: the exam client ───────────────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // ── The three that justify the whole file ───────────────────
      //
      // Calling a hook conditionally desynchronises React's hook order for
      // every subsequent render of that component. There is no benign case,
      // which is why this one is an error rather than a warning.
      'react-hooks/rules-of-hooks': 'error',
      //
      // A wrong dependency array is a stale closure. Warn, not error: this
      // rule has real false positives (a ref deliberately excluded, a setter
      // known stable), and several are load-bearing in the exam shell where
      // re-subscribing an interval on every tick would be the actual bug.
      // Each one wants reading, not a blanket fix.
      'react-hooks/exhaustive-deps': 'warn',
      //
      // `catch {}` on an answer submission is a lost answer that looks like a
      // saved one. Empty blocks elsewhere are usually deliberate, so `catch`
      // is the one shape called out.
      'no-empty': ['warn', { allowEmptyCatch: false }],

      // ── Typed-language adjustments ──────────────────────────────
      //
      // tsc already reports unused locals with better precision. Kept only
      // for the argument case, and configured to honour the leading-underscore
      // convention this codebase already uses for deliberate discards
      // (`const { password: _ignored, ...rest }`).
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      //
      // `any` is a real cost, but it is load-bearing at the Firestore
      // boundary where every field is genuinely unknown at compile time.
      // Warn so new ones are visible; do not fail a build over the existing
      // ones.
      '@typescript-eslint/no-explicit-any': 'warn',

      // ── Genuine footguns ────────────────────────────────────────
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'no-throw-literal': 'error',
      // `allowEmptyCase` is ON, and the reason is specific rather than a
      // blanket softening. ESLint already permits bare grouped labels
      // (`case 'a': case 'b': return x`) — but putting an explanatory COMMENT
      // between two of those labels makes it report a fallthrough, which is
      // precisely backwards: the version with the comment explaining WHY the
      // variants share a branch is the better code. Verified against the
      // rule, both shapes, before turning it on. A case that carries actual
      // STATEMENTS and then falls through is still an error, which is the
      // bug this rule exists to catch.
      'no-fallthrough': ['error', { allowEmptyCase: true }],
      // A `console.log` left in the exam client ships to every student's
      // browser. `warn` and `error` are how this codebase reports real
      // conditions, so those stay.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // ── Test files: the same rules, minus the ones tests break on ───
  {
    files: ['src/**/*.{test,spec}.{ts,tsx}', 'api/**/*.{test,spec}.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // A test's whole job is sometimes to pass the wrong shape in.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  // ── Cloud Functions: node, not browser ──────────────────────────
  {
    files: ['functions/src/**/*.ts', 'functions/scripts/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'no-throw-literal': 'error',
      // The functions log deliberately and at length — the startup lines for
      // App Check and the judge adapter are a documented feature.
      'no-console': 'off',
    },
  },

  // ── Vercel serverless handlers: plain JS, node globals ──────────
  {
    files: ['api/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'no-throw-literal': 'error',
      'no-console': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },

  // ── Build/config scripts at the repo root ───────────────────────
  {
    files: ['scripts/**/*.mjs', '*.config.{js,ts,mjs}', 'infra/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { 'no-console': 'off' },
  },
);
