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
import { EXTENSION_FINGERPRINTS, scanForForeignDom } from './extensionScan';

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

      // ── Generic foreign DOM — recorded only ────────────────────
      // Deduped on the descriptor, so a node that survives the whole sitting
      // is reported once rather than every scan. The `foreign:` prefix keeps
      // the two detectors' keys from colliding in one set.
      for (const desc of scanForForeignDom()) {
        if (foreignReportsRef.current >= MAX_FOREIGN_REPORTS) break;
        const key = `foreign:${desc}`;
        if (seenRef.current.has(key)) continue;
        seenRef.current.add(key);
        foreignReportsRef.current += 1;
        onViolationRef.current('foreign_dom', `Unrecognised top-level element ${desc}`);
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