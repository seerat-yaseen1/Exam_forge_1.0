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

// ══════════════════════════════════════════════════════════════════
// THE APP'S OWN DOM IS NOT A FINDING
// ══════════════════════════════════════════════════════════════════
//
// Observed on a real briefing page: the "also on this page" list led with
// `<div#fire_app_check_[DEFAULT]>`. That is Firebase App Check's reCAPTCHA v3
// container, which this codebase creates in firebase.ts on every load, on
// every machine, with no extension installed.
//
// A detector that fires for every student is worse than one that fires for
// none — it is the noise a reviewer learns to scroll past, sitting in the same
// list as a genuine AI sidebar. It also blocks enforcement outright: anything
// acting on this list would act on everybody.

describe('scanForForeignDom — the app\'s own top-level nodes', () => {
  beforeEach(resetDom);

  it('ignores the Firebase App Check container', () => {
    const el = document.createElement('div');
    el.id = 'fire_app_check_[DEFAULT]';
    document.body.appendChild(el);
    expect(scanForForeignDom()).toEqual([]);
  });

  it('ignores App Check containers for a non-default Firebase app', () => {
    // The id is named for the app instance, so the bracketed suffix is not
    // ours to promise. Prefix-matched for exactly that reason.
    const el = document.createElement('div');
    el.id = 'fire_app_check_[SECONDARY]';
    document.body.appendChild(el);
    expect(scanForForeignDom()).toEqual([]);
  });

  it('ignores the reCAPTCHA badge, which carries no id', () => {
    const badge = document.createElement('div');
    badge.className = 'grecaptcha-badge';
    document.body.appendChild(badge);

    // …and the bare wrapper, identified only by the iframe inside it.
    const wrapper = document.createElement('div');
    const frame = document.createElement('iframe');
    frame.setAttribute('src', 'https://www.google.com/recaptcha/api2/anchor');
    wrapper.appendChild(frame);
    document.body.appendChild(wrapper);

    expect(scanForForeignDom()).toEqual([]);
  });

  it('still catches a real extension sitting beside the app\'s own nodes', () => {
    // The allowlist must narrow the report, not disable it. This is the exact
    // shape of the observed page: App Check plus a genuine injected sidebar.
    const appCheck = document.createElement('div');
    appCheck.id = 'fire_app_check_[DEFAULT]';
    document.body.appendChild(appCheck);

    const sidebar = document.createElement('plasmo-csui');
    sidebar.id = 'qaiSidebarShadowHostEl';
    document.body.appendChild(sidebar);

    const found = scanForForeignDom();
    expect(found).toEqual(['<plasmo-csui#qaiSidebarShadowHostEl>']);
  });
});

// ══════════════════════════════════════════════════════════════════
// THE IN-PAGE SIDEBAR, WHICH NOTHING ELSE CAN SEE
// ══════════════════════════════════════════════════════════════════
//
// A Chrome side panel steals width from the viewport and is caught by the
// geometry poll in IntegrityEngine. A content-script sidebar does not: it
// mounts INSIDE the exam document, so innerWidth and outerWidth are both
// unchanged, fullscreen is not dropped, focus never leaves and no blur fires.
// Every geometry and focus detector is blind to it by construction.
//
// Its DOM is the one thing it cannot hide, which is why these belong in the
// NAMED list — the named path is the one that blocks entry and is
// freeze-eligible. As `foreign` they were reported and nothing acted.

describe('in-page AI sidebars are named, not merely foreign', () => {
  beforeEach(resetDom);

  it('names a Plasmo-mounted content-script UI', () => {
    document.body.appendChild(document.createElement('plasmo-csui'));
    expect(scanForExtensions()).toContain('Plasmo-based extension (AI sidebar)');
  });

  // The four hosts observed on a live briefing page. Enumerated rather than
  // sampled because each is a different capability of the same extension, and
  // a selector that happened to match only the sidebar would leave the answer
  // engine — the part that matters — undetected on a page where the sidebar
  // was closed.
  const QUESTION_AI_HOSTS = [
    'qaiSidebarShadowHostEl',
    'qaiWebPageCopilotShadowHostEl',
    'qaiUnderlineWordShadowHostEl',
    'qaiChromeosQuestionnaireShadowHostEl',
  ];

  it.each(QUESTION_AI_HOSTS)('names Question AI by its %s host', (hostId) => {
    const el = document.createElement('plasmo-csui');
    el.id = hostId;
    document.body.appendChild(el);
    expect(scanForExtensions()).toContain('Question AI');
  });

  it('does not call Question AI something else', () => {
    // This label reaches an examiner deciding about a person. An earlier
    // revision guessed "QuillBot" from the `qai` prefix, which would have put
    // a paraphraser's name on a record about an answer engine.
    const el = document.createElement('plasmo-csui');
    el.id = 'qaiSidebarShadowHostEl';
    document.body.appendChild(el);
    const found = scanForExtensions();
    expect(found).toContain('Question AI');
    expect(found.join(' ')).not.toMatch(/quillbot/i);
  });

  const WORDTUNE_ELEMENTS = [
    'wordtune-app-toolbar',
    'wordtune-spices-nudge',
    'wordtune-read-toolbar',
    'wordtune-cards',
  ];

  it.each(WORDTUNE_ELEMENTS)('names Wordtune by its <%s>', (tag) => {
    document.body.appendChild(document.createElement(tag));
    expect(scanForExtensions()).toContain('Wordtune');
  });

  it('finds them wherever they mount, not only at the top level', () => {
    // scanForExtensions is a document-wide querySelector, so an extension that
    // injects into a container inside the app is still named — unlike the
    // foreign check, which deliberately only reads top-level children.
    const root = document.getElementById('root')!;
    root.innerHTML = '<div class="exam-shell"><plasmo-csui></plasmo-csui></div>';
    expect(scanForExtensions()).toContain('Plasmo-based extension (AI sidebar)');
  });

  it('does not name an id that merely starts with the same three letters', () => {
    // `[id^="qai"]` alone would be a three-character prefix. Both ends are
    // anchored so an unrelated id cannot lock a student out of an exam.
    const el = document.createElement('div');
    el.id = 'qaidTotals';
    document.getElementById('root')!.appendChild(el);
    expect(scanForExtensions()).not.toContain('Question AI');
  });

  it('leaves a clean page clean', () => {
    expect(scanForExtensions()).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
// THE RE-ENTRY GATE
// ══════════════════════════════════════════════════════════════════
//
// The briefing refuses entry on any injected DOM, but `/shell` is a separate
// route in routes.tsx with no guard — so every refusal was one address bar
// away from being skipped, and an ordinary refresh walked through it without
// the student meaning to.
//
// Structural, like the freeze-separation cases above: what matters is that the
// shell applies the SAME rule as the briefing and does not turn a recoverable
// gate into a punishment. Both are one careless edit from disappearing, and
// neither is visible in a unit test of a pure function.

describe('the shell re-checks extensions on re-entry', () => {
  const shell = readFileSync(
    path.resolve(__dirname, '..', '..', 'pages', 'student', 'ExamShell.tsx'), 'utf8',
  );

  it('runs a scan in the shell, not only on the briefing page', () => {
    expect(shell).toContain('scanForExtensionsWithSettle');
  });

  it('applies the same gate rule as the briefing rather than its own', () => {
    // Both call sites import one function. A second copy of "what counts as
    // blocking" is how the two surfaces drift into disagreeing.
    expect(shell).toContain('extensionGateBlocks');
  });

  it('is gated on the tier flag, so it cannot block a practice exam', () => {
    expect(shell).toContain("assessment?.requireExtensionCheck !== true");
  });

  it('gates without firing a violation of its own', () => {
    // The watchdog is already running and reports what it sees. Firing again
    // from the re-entry effect would double-count one extension — and on a
    // warning type that is a third of a termination for a single reload.
    const effect = shell.slice(
      shell.indexOf('Re-entry extension gate'),
      shell.indexOf('const handleRecheckExtensions'),
    );
    expect(effect.length).toBeGreaterThan(0);
    expect(effect).not.toContain('handleViolation');
    expect(effect).not.toContain('logViolation');
    expect(effect).not.toContain('reportExtensionCheck');
  });

  it('never displaces a terminal overlay', () => {
    // A student being terminated, or in a session conflict, must not have that
    // replaced by a recoverable "disable your extensions" prompt.
    const effect = shell.slice(
      shell.indexOf('Re-entry extension gate'),
      shell.indexOf('const handleRecheckExtensions'),
    );
    expect(effect).toContain('setOverlay((current)');
    expect(effect).toContain("current.kind === 'fullscreen_required'");
  });
});
