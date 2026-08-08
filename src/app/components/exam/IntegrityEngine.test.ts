/**
 * The tier policy for pasting into a code answer editor.
 *
 * This is the first client-side suite in the repository, and it starts here
 * deliberately: `codeEditorPasteAllowed` is the one function standing between
 * an honest candidate editing their own code and a violation counting toward
 * termination. It is pure, it is three lines, and until now nothing checked it.
 */

import { describe, it, expect } from 'vitest';
import { codeEditorPasteAllowed } from './IntegrityEngine';

describe('codeEditorPasteAllowed', () => {
  it('allows paste in practice, silently', () => {
    expect(codeEditorPasteAllowed('mock')).toBe(true);
  });

  it('blocks paste in a proctored exam', () => {
    expect(codeEditorPasteAllowed('normal')).toBe(false);
  });

  it('blocks paste at high stake, and LOCKS it', () => {
    expect(codeEditorPasteAllowed('high_stake')).toBe(false);
    // The lock is the point. Camera, mobile and extension-check are all locked
    // at this tier; an override that could switch paste back on would make it
    // the one deterrent an authority could quietly disable.
    expect(codeEditorPasteAllowed('high_stake', true)).toBe(false);
  });

  it('honours an override at the tiers where the setting is not locked', () => {
    expect(codeEditorPasteAllowed('normal', true)).toBe(true);
    expect(codeEditorPasteAllowed('mock', false)).toBe(false);
  });

  it('treats an unknown or missing tier as proctored, not as practice', () => {
    // A legacy attempt predating securityTier, or a value from a newer writer.
    // The safe default is the strict one: a paper that cannot state its tier
    // must not be handed the permissive branch.
    expect(codeEditorPasteAllowed(undefined)).toBe(false);
    expect(codeEditorPasteAllowed('something_new' as never)).toBe(false);
  });
});
