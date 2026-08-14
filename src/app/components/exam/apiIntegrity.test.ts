/**
 * Detecting a page whose visibility and focus APIs have been replaced.
 *
 * The extensions this exists for describe their own method plainly: overwrite
 * `document.visibilityState` and `document.hidden`, suppress `visibilitychange`
 * and `blur`. That is an exact list of the inputs to `tab_switch` and
 * `focus_loss` — two of the three warning types that drive termination — so a
 * tool doing this does not dodge one detector, it disables most of the system
 * while everything left reports a clean sitting.
 *
 * Two properties are load-bearing and both are tested here: it must fire on
 * the shadowing these tools perform, and it must be SILENT on an ordinary
 * document. The second matters more — this finding is freeze-eligible, and a
 * freeze needs a human to clear.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  shadowedDocumentMembers,
  detectApiTampering,
  describeTampering,
  VISIBILITY_TAMPER_LABEL,
  PROTOTYPE_ONLY_DOCUMENT_MEMBERS,
} from './apiIntegrity';

/** Members shadowed by a test, removed afterwards. */
const installed: string[] = [];

function shadow(name: string, value: unknown) {
  Object.defineProperty(document, name, {
    value, configurable: true, writable: true,
  });
  installed.push(name);
}

function shadowGetter(name: string, get: () => unknown) {
  Object.defineProperty(document, name, { get, configurable: true });
  installed.push(name);
}

afterEach(() => {
  while (installed.length) {
    delete (document as unknown as Record<string, unknown>)[installed.pop()!];
  }
});

describe('shadowedDocumentMembers — the quiet case', () => {
  it('says nothing about an untouched document', () => {
    // The property the freeze path depends on. `hidden`, `visibilityState` and
    // `hasFocus` live on Document.prototype in every browser and in jsdom, so
    // an instance that owns none of them is the normal state — which is what
    // makes this check precise rather than heuristic.
    expect(shadowedDocumentMembers()).toEqual([]);
    expect(detectApiTampering()).toEqual([]);
  });

  it('is unmoved by ordinary page activity', () => {
    // Adding listeners and reading the real properties is what the exam itself
    // does all sitting long. None of it installs an own property.
    const noop = () => {};
    document.addEventListener('visibilitychange', noop);
    void document.hidden;
    void document.visibilityState;
    void document.hasFocus();
    expect(shadowedDocumentMembers()).toEqual([]);
    document.removeEventListener('visibilitychange', noop);
  });
});

describe('shadowedDocumentMembers — the spoof', () => {
  it('catches document.hidden replaced with a constant getter', () => {
    // Exactly what "Always Active Window" installs: hidden reports false
    // forever, so tab_switch never fires however often the student leaves.
    shadowGetter('hidden', () => false);
    expect(shadowedDocumentMembers()).toContain('hidden');
    expect(detectApiTampering()).toEqual([VISIBILITY_TAMPER_LABEL]);
  });

  it('catches visibilityState pinned to visible', () => {
    shadowGetter('visibilityState', () => 'visible');
    expect(shadowedDocumentMembers()).toContain('visibilityState');
  });

  it('catches the vendor-prefixed variants', () => {
    // Listed because the extensions list them. Older code paths read
    // webkitHidden, so a tool spoofing only the modern name would still be
    // caught here, and vice versa.
    shadowGetter('webkitHidden', () => false);
    shadowGetter('mozHidden', () => false);
    const found = shadowedDocumentMembers();
    expect(found).toContain('webkitHidden');
    expect(found).toContain('mozHidden');
  });

  it('catches hasFocus forced to true', () => {
    // The focus half. With this in place the window never admits to losing
    // focus, and IntegrityEngine's focus_state_mismatch — which compares the
    // blur EVENT against hasFocus() — is blinded too, because both of its
    // inputs now agree on a lie.
    shadow('hasFocus', () => true);
    expect(shadowedDocumentMembers()).toContain('hasFocus');
  });

  it('catches a swallowed listener registration', () => {
    // The other way to kill visibilitychange: accept the registration and
    // never call it back.
    shadow('addEventListener', () => {});
    expect(shadowedDocumentMembers()).toContain('addEventListener');
  });

  it('catches onvisibilitychange assigned away', () => {
    shadow('onvisibilitychange', null);
    expect(shadowedDocumentMembers()).toContain('onvisibilitychange');
  });

  it('reports every altered member, not just the first', () => {
    // A reviewer reads this list. "hidden and visibilityState and hasFocus"
    // describes a deliberate, complete job; one name would understate it.
    shadowGetter('hidden', () => false);
    shadowGetter('visibilityState', () => 'visible');
    shadow('hasFocus', () => true);
    expect(shadowedDocumentMembers()).toEqual(
      expect.arrayContaining(['hidden', 'visibilityState', 'hasFocus']),
    );
  });

  it('reports one label however many members were touched', () => {
    // The label is the finding; the members are the evidence. Three labels for
    // one act of tampering would read as three extensions.
    shadowGetter('hidden', () => false);
    shadowGetter('visibilityState', () => 'visible');
    expect(detectApiTampering()).toEqual([VISIBILITY_TAMPER_LABEL]);
  });

  it('survives a member whose getter throws', () => {
    // Abnormal in itself, but a detector must never be the thing that breaks
    // an exam.
    shadowGetter('hidden', () => { throw new Error('nope'); });
    expect(() => shadowedDocumentMembers()).not.toThrow();
  });
});

describe('describeTampering', () => {
  it('names the members for the violation detail', () => {
    expect(describeTampering(['hidden', 'hasFocus']))
      .toBe('document.hidden, document.hasFocus replaced on this page');
  });

  it('stays inside the stored-detail budget', () => {
    const long = describeTampering(Array(200).fill('visibilityState'));
    expect(long.length).toBeLessThanOrEqual(500);
  });
});

describe('the watched member list', () => {
  it('covers everything the known spoofers advertise', () => {
    // Taken from the extension's own description: visibilityState, hidden,
    // mozHidden, webkitHidden, and the visibilitychange/blur events.
    for (const member of [
      'hidden', 'visibilityState', 'webkitHidden', 'mozHidden',
      'hasFocus', 'onvisibilitychange', 'addEventListener',
    ]) {
      expect(PROTOTYPE_ONLY_DOCUMENT_MEMBERS).toContain(member);
    }
  });

  it('does not watch anything a page may legitimately own', () => {
    // The precision guarantee. Every name here must be prototype-only on a
    // real document — if one were an ordinary own property, this check would
    // freeze every student on every sitting.
    for (const name of PROTOTYPE_ONLY_DOCUMENT_MEMBERS) {
      expect(
        Object.getOwnPropertyDescriptor(document, name),
        `document owns ${name} natively — it must not be watched`,
      ).toBeUndefined();
    }
  });
});
