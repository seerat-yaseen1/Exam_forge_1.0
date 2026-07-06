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
 * Limitations:
 *   - Silent extensions (no DOM injection) are invisible.
 *   - Fingerprint list ages quickly; extensions rename their elements.
 *   - For real lockdown, use Safe Exam Browser or a proctoring service.
 */

import { useEffect, useRef } from 'react';
import type { ViolationType } from '../../../lib/submissionService';
import { EXTENSION_FINGERPRINTS } from './extensionScan';

// Fingerprint list now lives in ./extensionScan so the pre-entry gate on the
// briefing page and this continuous monitor share one source of truth.
const FINGERPRINTS = EXTENSION_FINGERPRINTS;

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

  useEffect(() => { onViolationRef.current = onViolation; }, [onViolation]);
  useEffect(() => { activeRef.current      = active; },      [active]);

  useEffect(() => {
    if (!active) return;

    // Re-arm on (re)activation (Phase 1c): clear the dedupe set so an extension
    // that was cleared and then re-enabled during a break / reconnect is
    // detected again on resume. Without this, seenRef persists across the
    // active→inactive→active cycle and a re-added extension would be missed.
    seenRef.current.clear();

    const scan = () => {
      if (!activeRef.current) return;
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
    };

    // Initial pass + periodic rescans
    scan();
    const intervalId = window.setInterval(scan, scanIntervalMs);

    // React to body-level mutations (extensions usually inject after load)
    const observer = new MutationObserver(() => scan());
    observer.observe(document.body, {
      childList: true,
      subtree:   true,
      attributes: false,
    });

    return () => {
      window.clearInterval(intervalId);
      observer.disconnect();
    };
  }, [active, scanIntervalMs]);

  return null;
}