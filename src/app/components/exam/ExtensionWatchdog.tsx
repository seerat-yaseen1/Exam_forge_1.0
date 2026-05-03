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

// ── Known extension fingerprints ─────────────────────────────────
// Each entry: { key (unique id), selector (CSS), label (for the violation log) }
// Conservative — only extensions that insert visible UI elements.

type Fingerprint = { key: string; selector: string; label: string };

const FINGERPRINTS: Fingerprint[] = [
  // Grammarly — injects custom elements at body level
  { key: 'grammarly',  selector: 'grammarly-desktop-integration, grammarly-extension, [data-grammarly-shadow-root]', label: 'Grammarly' },
  { key: 'gr-button',  selector: 'gr-textarea-button, [data-gramm]', label: 'Grammarly button' },

  // AI sidebar / assistant extensions
  { key: 'monica',     selector: '#monica-extension-root, [class*="monica-"]', label: 'Monica AI' },
  { key: 'sider',      selector: '#sider-extension-root, [class^="sider-"]', label: 'Sider AI' },
  { key: 'maxai',      selector: '#maxai-floating-action-button, [class*="maxai-"]', label: 'MaxAI' },
  { key: 'glasp',      selector: '[class*="glasp-"], #glasp-extension-root', label: 'Glasp' },
  { key: 'webchatgpt', selector: '#webchatgpt, [class*="webchatgpt-"]', label: 'WebChatGPT' },
  { key: 'merlin',     selector: '#merlin-extension-root, [class*="merlin-"]', label: 'Merlin' },
  { key: 'harpa',      selector: '#harpa-ui, [class*="harpa-"]', label: 'HARPA AI' },
  { key: 'compose-ai', selector: '[class*="compose-ai-"]', label: 'Compose AI' },

  // Translation / language helpers
  { key: 'languagetool', selector: '[class*="lt-marker-"], [class*="languagetool-"]', label: 'LanguageTool' },

  // Note / clipping
  { key: 'notion-clipper', selector: '#notion-web-clipper', label: 'Notion Web Clipper' },
  { key: 'evernote',       selector: '#evernoteFloater, [class*="evernote-"]', label: 'Evernote' },

  // Password / autofill (visible UI variants)
  { key: 'lastpass',       selector: 'div[data-lastpass-icon-root], #__lpform_root', label: 'LastPass' },
  { key: 'dashlane',       selector: 'div[data-dashlane-rid], div[data-dashlane-classification]', label: 'Dashlane' },

  // Generic markers — extensions often append <div id="*-extension-root"> or use shadow DOM
  { key: 'extension-root', selector: '[id$="-extension-root"], [id^="chrome-extension-"]', label: 'Generic extension root' },
];

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
