/**
 * Extension detection, and the line between its two severities.
 *
 * The generic foreign-DOM check exists because the fingerprint list only ever
 * sees extensions somebody thought to add. But its false positives are
 * unknowable by construction — that is what "generic" means — and a named
 * match feeds a server-side FREEZE that, since D-30, only a human can clear.
 *
 * So the suite has two jobs. The detector cases check it finds injected nodes
 * without flagging the page's own markup; the separation cases check the
 * heuristic can never reach the freeze path, which is a structural property
 * that would otherwise be one careless edit away from disappearing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  scanForExtensions,
  scanForForeignDom,
  scanForExtensionsWithSettle,
} from './extensionScan';

/** The page as the app itself renders it: one root, one module script. */
function resetDom() {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  const script = document.createElement('script');
  script.type = 'module';
  document.body.appendChild(script);
  return root;
}

describe('scanForForeignDom — what it ignores', () => {
  beforeEach(resetDom);

  it('says nothing about the app rendering normally', () => {
    expect(scanForForeignDom()).toEqual([]);
  });

  it('says nothing about a deep app tree', () => {
    // The whole exam lives inside #root. If the check walked the document
    // instead of the top level, every modal and editor would be foreign.
    const root = document.getElementById('root')!;
    root.innerHTML = `
      <div class="exam-shell"><section><article>
        <custom-thing data-x="1"><span>question</span></custom-thing>
      </article></section></div>`;
    expect(scanForForeignDom()).toEqual([]);
  });

  it('says nothing about style, script and link tags at the top level', () => {
    for (const tag of ['style', 'script', 'link', 'template', 'noscript']) {
      document.body.appendChild(document.createElement(tag));
    }
    expect(scanForForeignDom()).toEqual([]);
  });

  it('says nothing about an iframe the exam itself renders', () => {
    // Scheme-matched, not shape-matched: an ordinary iframe inside the app is
    // the app's business.
    const root = document.getElementById('root')!;
    const frame = document.createElement('iframe');
    frame.setAttribute('src', 'https://example.test/embed');
    root.appendChild(frame);
    expect(scanForForeignDom()).toEqual([]);
  });
});

describe('scanForForeignDom — what it catches', () => {
  beforeEach(resetDom);

  it('catches a custom element appended beside the root', () => {
    document.body.appendChild(document.createElement('grammarly-desktop-integration'));
    expect(scanForForeignDom()).toEqual(['<grammarly-desktop-integration>']);
  });

  it('catches a plain div an extension appended, and names it by id', () => {
    const injected = document.createElement('div');
    injected.id = 'some-new-assistant-2027';
    document.body.appendChild(injected);
    expect(scanForForeignDom()).toEqual(['<div#some-new-assistant-2027>']);
  });

  it('falls back to the first class when there is no id', () => {
    const injected = document.createElement('div');
    injected.className = 'zz-overlay zz-theme-dark';
    document.body.appendChild(injected);
    expect(scanForForeignDom()).toEqual(['<div.zz-overlay>']);
  });

  it('catches an extension-scheme iframe wherever it sits', () => {
    // This one CAN live inside our tree, injected into a container the
    // extension found, so it is the one document-wide query.
    const root = document.getElementById('root')!;
    const frame = document.createElement('iframe');
    frame.setAttribute('src', 'chrome-extension://abcdefghijklmnop/panel.html');
    root.appendChild(frame);
    expect(scanForForeignDom()).toEqual(['<iframe abcdefghijklmnop>']);
  });

  it('catches the other browsers\' extension schemes too', () => {
    const root = document.getElementById('root')!;
    for (const src of [
      'moz-extension://aaa/panel.html',
      'safari-web-extension://bbb/panel.html',
    ]) {
      const f = document.createElement('iframe');
      f.setAttribute('src', src);
      root.appendChild(f);
    }
    expect(scanForForeignDom()).toHaveLength(2);
  });

  it('catches something an extension never named at all', () => {
    // The whole point: this fires on things no fingerprint list anticipated.
    document.body.appendChild(document.createElement('x-unheard-of-2031'));
    expect(scanForForeignDom()).toEqual(['<x-unheard-of-2031>']);
    // …and the named list, correctly, has nothing to say about it.
    expect(scanForExtensions()).toEqual([]);
  });

  it('reports each distinct node once', () => {
    document.body.appendChild(document.createElement('x-one'));
    document.body.appendChild(document.createElement('x-one'));
    document.body.appendChild(document.createElement('x-two'));
    expect(scanForForeignDom().sort()).toEqual(['<x-one>', '<x-two>']);
  });

  it('bounds the descriptor so a hostile attribute cannot bloat the record', () => {
    // The descriptor ends up inside a violation detail, and the attempt
    // document has a hard size ceiling.
    const injected = document.createElement('div');
    injected.id = 'x'.repeat(5000);
    document.body.appendChild(injected);
    const [desc] = scanForForeignDom();
    expect(desc.length).toBeLessThanOrEqual(80);
  });
});

describe('scanForExtensionsWithSettle', () => {
  beforeEach(resetDom);

  it('splits its findings by how far they can be trusted', async () => {
    document.body.appendChild(document.createElement('grammarly-desktop-integration'));
    const injected = document.createElement('div');
    injected.id = 'unknown-thing';
    document.body.appendChild(injected);

    const result = await scanForExtensionsWithSettle(0);
    expect(result.named).toContain('Grammarly');
    expect(result.foreign).toContain('<div#unknown-thing>');
    // The named element is foreign DOM too. That is fine and deliberate — the
    // two lists answer different questions, and the gate reads only one.
  });

  it('catches an extension that injects after the first pass', async () => {
    const scan = scanForExtensionsWithSettle(20);
    document.body.appendChild(document.createElement('x-late-arrival'));
    const result = await scan;
    expect(result.foreign).toContain('<x-late-arrival>');
  });

  it('reports both lists empty on a clean page', async () => {
    const result = await scanForExtensionsWithSettle(0);
    expect(result).toEqual({ named: [], foreign: [] });
  });
});

// ══════════════════════════════════════════════════════════════════
// THE HEURISTIC MUST NOT REACH THE FREEZE PATH
// ══════════════════════════════════════════════════════════════════
//
// reportExtensionCheck freezes the attempt server-side on tiers requiring the
// extension check, and a freeze has no automatic exit. ExamShell routes to it
// from the `extension_detected` branch of handleViolation, so the guarantee
// that a heuristic cannot freeze a live sitting rests entirely on
// `foreign_dom` being a different type that nothing in that path matches.
//
// That is invisible in a diff — someone widening the branch to "any extension
// signal" would look like a tidy-up. Asserted at the source, because there is
// no unit under here to call.

describe('the generic detector stays out of the freeze pipeline', () => {
  const shell = readFileSync(
    path.resolve(__dirname, '..', '..', 'pages', 'student', 'ExamShell.tsx'), 'utf8',
  );

  it('ExamShell reports extension checks from exactly one violation type', () => {
    const guards = shell.match(/type === '(\w+)'\s*&&\s*!extReportedRef/g) ?? [];
    expect(guards).toHaveLength(1);
    expect(guards[0]).toContain("'extension_detected'");
  });

  it('nothing hands foreign_dom to reportExtensionCheck', () => {
    // A foreign-DOM finding is recorded through logViolation like any other
    // violation and stops there.
    const callSites = shell.split('reportExtensionCheck(').slice(1);
    for (const after of callSites) {
      expect(after.slice(0, 200)).not.toContain('foreign_dom');
    }
  });

  it('the watchdog fires the two detectors as two different types', () => {
    const watchdog = readFileSync(path.resolve(__dirname, 'ExtensionWatchdog.tsx'), 'utf8');
    expect(watchdog).toContain("'extension_detected'");
    expect(watchdog).toContain("'foreign_dom'");
  });
});
