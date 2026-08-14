/**
 * ExtensionWatchdog
 *
 * Best-effort detection of browser extensions that inject UI into the page
 * during an exam. A webpage cannot disable extensions, but it can detect
 * the most common ones (AI helpers, Grammarly, ad-blockers with UI, etc.)
 * by fingerprinting their injected DOM.
 *
 * Strategy:
 *   1. Snapshot known extension selectors at mount.
 *   2. Re-scan periodically + on every body-level mutation.
 *   3. Each newly-detected fingerprint fires one violation (deduped by key).
 *
 * TWO DETECTORS, TWO SEVERITIES. The named fingerprints fire
 * `extension_detected`, which ExamShell reports onward to the server and which
 * can FREEZE the attempt. The generic foreign-DOM check fires `foreign_dom`,
 * which nothing in the freeze path listens for — see the long note in
 * extensionScan.ts for why a heuristic must never reach a state that only a
 * human can leave.
 *
 * Limitations:
 *   - Silent extensions (no DOM injection at all) remain invisible to both.
 *   - The fingerprint list ages; the generic check is what covers the gap, at
 *     the cost of being unable to name what it finds.
 *   - For real lockdown, use Safe Exam Browser or a proctoring service.
 */

import { useEffect, useRef } from 'react';
import type { ViolationType } from '../../../lib/submissionService';
import {
  EXTENSION_FINGERPRINTS,
  scanForForeignDom,
  classifyForeignElement,
  FOREIGN_BASELINE_SETTLE_MS,
} from './extensionScan';
import {
  shadowedDocumentMembers,
  describeTampering,
  VISIBILITY_TAMPER_LABEL,
} from './apiIntegrity';

// Fingerprint list now lives in ./extensionScan so the pre-entry gate on the
// briefing page and this continuous monitor share one source of truth.
const FINGERPRINTS = EXTENSION_FINGERPRINTS;

/**
 * Mutations arrive in bursts — our own React renders produce them constantly,
 * and the observer below watches the whole body subtree. Coalescing a burst
 * into one scan is what keeps a per-mutation rescan affordable in a tab that
 * is also running an exam, a code editor and (on the proctored tiers) face
 * detection.
 */
const MUTATION_COALESCE_MS = 250;

/**
 * Ceiling on distinct foreign-DOM findings reported per sitting.
 *
 * The named path is self-bounding — it can report at most one violation per
 * fingerprint, and the list is short. The generic path has no such bound: it
 * keys on a descriptor, so anything injecting nodes under randomised ids
 * produces an unlimited stream of "new" findings, each one a Firestore write
 * and an entry in an attempt document with a hard size ceiling.
 *
 * Ten distinct foreign elements have already made the point a reviewer needs.
 * Past that the sitting is better served by silence than by a log that could
 * crowd out the violations it sits next to.
 */
const MAX_FOREIGN_REPORTS = 10;

/**
 * Ceiling on FREEZE-ELIGIBLE foreign findings per sitting.
 *
 * Much lower than the baseline cap, because these are not advisory. One is
 * enough to pause the sitting and bring a human in; the rest exist only so a
 * reviewer can see the shape of what happened.
 */
const MAX_APPEARED_REPORTS = 5;

interface ExtensionWatchdogProps {
  active: boolean;
  onViolation: (type: ViolationType, detail: string) => void;
  scanIntervalMs?: number;
}

export function ExtensionWatchdog({
  active,
  onViolation,
  scanIntervalMs = 4000,
}: ExtensionWatchdogProps) {
  const onViolationRef = useRef(onViolation);
  const activeRef      = useRef(active);
  const seenRef        = useRef<Set<string>>(new Set());
  const foreignReportsRef = useRef(0);
  const appearedReportsRef = useRef(0);

  /**
   * What was on the page when this sitting began.
   *
   * Captured ONCE and deliberately NOT re-captured when the watchdog
   * re-activates. `active` goes false behind modals and breaks, and re-taking
   * the baseline on the way back would launder anything installed while the
   * exam was paused — which is the most attractive moment to install it. The
   * dedupe set below is cleared on re-activation, as it always was, so the
   * same element is reported again; only its SEVERITY is remembered.
   */
  const baselineRef = useRef<Set<string> | null>(null);
  const baselineClosesAtRef = useRef(0);

  useEffect(() => { onViolationRef.current = onViolation; }, [onViolation]);
  useEffect(() => { activeRef.current      = active; },      [active]);

  useEffect(() => {
    if (!active) return;

    // Re-arm on (re)activation (Phase 1c): clear the dedupe set so an extension
    // that was cleared and then re-enabled during a break / reconnect is
    // detected again on resume. Without this, seenRef persists across the
    // active→inactive→active cycle and a re-added extension would be missed.
    seenRef.current.clear();
    foreignReportsRef.current = 0;
    appearedReportsRef.current = 0;

    // First activation only — see the note on baselineRef.
    if (baselineRef.current === null) {
      baselineRef.current = new Set();
      baselineClosesAtRef.current = Date.now() + FOREIGN_BASELINE_SETTLE_MS;
    }

    const scan = () => {
      if (!activeRef.current) return;

      // ── Named fingerprints — freeze-eligible ───────────────────
      for (const fp of FINGERPRINTS) {
        if (seenRef.current.has(fp.key)) continue;
        try {
          if (document.querySelector(fp.selector)) {
            seenRef.current.add(fp.key);
            onViolationRef.current('extension_detected', `${fp.label} extension detected`);
          }
        } catch {
          // Bad selector — ignore
        }
      }

      // ── Replaced visibility/focus APIs — freeze-eligible ───────
      //
      // Checked on every scan rather than once at mount, and that is the whole
      // reason it is here as well as on the briefing page: "Always Active
      // Window" and its clones are armed PER SITE by clicking the toolbar
      // icon. A student can pass the entry gate honestly and switch it on a
      // minute later, which is precisely when it is worth anything to them.
      //
      // Reported through `extension_detected`, so it reaches
      // reportExtensionCheck and can freeze the attempt on tiers that require
      // the extension check. That is the strongest response this codebase has,
      // and it is the right one here: unlike an unrecognised element, a
      // document that owns its own `hidden` property has no innocent
      // explanation, and what was disabled is the tab-switch and focus
      // detection the rest of the sitting is judged by.
      //
      // Deduped on a fixed key, so a spoof that stays in place for an hour is
      // one finding rather than one every four seconds.
      if (!seenRef.current.has('api-tamper')) {
        const members = shadowedDocumentMembers();
        if (members.length > 0) {
          seenRef.current.add('api-tamper');
          onViolationRef.current(
            'extension_detected',
            `${VISIBILITY_TAMPER_LABEL} (${describeTampering(members)})`,
          );
        }
      }

      // ── Generic foreign DOM — split by when it turned up ───────
      //
      // Deduped on the descriptor, so a node that survives the whole sitting
      // is reported once rather than every scan. The `foreign:` prefix keeps
      // the detectors' keys from colliding in one set.
      //
      // The severity split is the point: see classifyForeignElement. Anything
      // present when the sitting began is recorded and nothing more, exactly
      // as before. Anything that APPEARS afterwards is measured against a page
      // the entry gate verified as clean, which makes it the deliberate act it
      // looks like rather than the unknowable false positive the old blanket
      // rule had to assume.
      const baselineOpen = Date.now() < baselineClosesAtRef.current;
      for (const desc of scanForForeignDom()) {
        const severity = classifyForeignElement(desc, baselineRef.current!, baselineOpen);

        if (severity === 'baseline') {
          // Adopted, so the answer stays stable once the window closes — a
          // late-injecting node must not become "appeared" on the next tick
          // merely because the clock moved.
          baselineRef.current!.add(desc);
          if (foreignReportsRef.current >= MAX_FOREIGN_REPORTS) continue;
          const key = `foreign:${desc}`;
          if (seenRef.current.has(key)) continue;
          seenRef.current.add(key);
          foreignReportsRef.current += 1;
          onViolationRef.current('foreign_dom', `Unrecognised top-level element ${desc}`);
          continue;
        }

        // Freeze-eligible. Capped separately and far lower than the baseline
        // path: this reports through extension_detected, and the shell's own
        // extReportedRef already collapses repeats into one server call, so
        // the cap here only bounds what reaches the attempt document.
        if (appearedReportsRef.current >= MAX_APPEARED_REPORTS) continue;
        const key = `appeared:${desc}`;
        if (seenRef.current.has(key)) continue;
        seenRef.current.add(key);
        appearedReportsRef.current += 1;
        onViolationRef.current(
          'extension_detected',
          `${desc} appeared during the exam — not present when this sitting was admitted`,
        );
      }
    };

    // Initial pass + periodic rescans
    scan();
    const intervalId = window.setInterval(scan, scanIntervalMs);

    // React to body-level mutations (extensions usually inject after load),
    // coalesced so a render burst costs one scan rather than dozens.
    let coalesceId: number | undefined;
    const observer = new MutationObserver(() => {
      if (coalesceId !== undefined) return;
      coalesceId = window.setTimeout(() => {
        coalesceId = undefined;
        scan();
      }, MUTATION_COALESCE_MS);
    });
    observer.observe(document.body, {
      childList: true,
      subtree:   true,
      attributes: false,
    });

    return () => {
      window.clearInterval(intervalId);
      if (coalesceId !== undefined) window.clearTimeout(coalesceId);
      observer.disconnect();
    };
  }, [active, scanIntervalMs]);

  return null;
}