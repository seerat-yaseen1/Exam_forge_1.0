/**
 * The tier policy for pasting into a code answer editor.
 *
 * This is the first client-side suite in the repository, and it starts here
 * deliberately: `codeEditorPasteAllowed` is the one function standing between
 * an honest candidate editing their own code and a violation counting toward
 * termination. It is pure, it is three lines, and until now nothing checked it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { CODE_EDITOR_ATTR, codeEditorPasteAllowed } from './IntegrityEngine';

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

// ══════════════════════════════════════════════════════════════════
// THE EXEMPTION'S BLAST RADIUS
// ══════════════════════════════════════════════════════════════════
//
// `insideCodeEditor` resolves the exemption with `closest()`, so it applies to
// everything inside ANY element carrying data-exam-code-editor. That is
// correct for one element and dangerous for two: put the attribute on a
// container and every future control inside it inherits a paste exemption
// nobody decided to grant. Lose it and the opposite happens — an ordinary
// keystroke in the editor fires a violation that counts toward termination.
//
// Neither failure is visible in a diff, and the attribute survived a layout
// change (the two-column coding split) that moved everything around it. So it
// is asserted rather than trusted: exactly one element, in the editor.

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('the code-editor paste exemption is applied exactly once', () => {
  const srcRoot = path.resolve(__dirname, '..', '..', '..');
  const files = tsxFiles(srcRoot).filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));

  it('only CodeAnswerEditor applies the attribute', () => {
    // The spread form `{...{ [CODE_EDITOR_ATTR]: 'true' }}` is how it is put on
    // an element. Anything else importing the constant is reading, not marking.
    const appliers = files.filter((f) => readFileSync(f, 'utf8').includes(`[${'CODE_EDITOR_ATTR'}]:`));
    expect(appliers.map((f) => path.basename(f))).toEqual(['CodeAnswerEditor.tsx']);
  });

  it('and applies it to exactly one element', () => {
    const src = readFileSync(path.join(__dirname, 'CodeAnswerEditor.tsx'), 'utf8');
    const applications = src.match(/\[CODE_EDITOR_ATTR\]:/g) ?? [];
    expect(applications).toHaveLength(1);
  });

  it('nobody hardcodes the attribute name past the constant', () => {
    // A literal would not show up in the two checks above and would widen the
    // exemption just as effectively.
    const offenders = files.filter((f) => {
      if (path.basename(f) === 'IntegrityEngine.tsx') return false;  // defines it
      return readFileSync(f, 'utf8').includes(`"${CODE_EDITOR_ATTR}"`)
          || readFileSync(f, 'utf8').includes(`'${CODE_EDITOR_ATTR}'`);
    });
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
  });
});
