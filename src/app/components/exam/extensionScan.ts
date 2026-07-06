/**
 * extensionScan
 *
 * Shared browser-extension detection used by BOTH the continuous
 * ExtensionWatchdog (during an exam) and the pre-entry gate on the briefing
 * page (Phase 1c completion). Keeping the fingerprint list + scan logic in
 * one place means the entry gate and the in-exam monitor can never drift.
 *
 * A web page cannot disable extensions — it can only detect ones that inject
 * visible DOM. Silent extensions remain invisible; for real lockdown use Safe
 * Exam Browser (high-stake tier, Phase 3).
 */

export type Fingerprint = { key: string; selector: string; label: string };

// Conservative — only extensions that insert visible UI elements.
export const EXTENSION_FINGERPRINTS: Fingerprint[] = [
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

/**
 * One-shot synchronous scan. Returns the list of detected extension labels
 * (empty = clean). Used by the briefing entry gate. Bad selectors are ignored.
 */
export function scanForExtensions(): string[] {
  if (typeof document === 'undefined') return [];
  const found: string[] = [];
  for (const fp of EXTENSION_FINGERPRINTS) {
    try {
      if (document.querySelector(fp.selector)) found.push(fp.label);
    } catch {
      // Bad selector — ignore
    }
  }
  return found;
}

/**
 * Scan twice with a settle delay in between, because some extensions inject
 * their DOM a beat after page load. Resolves to the union of detected labels.
 * The entry gate uses this so a slow-injecting extension isn't missed by a
 * single instant-scan.
 */
export async function scanForExtensionsWithSettle(settleMs = 1500): Promise<string[]> {
  const first = scanForExtensions();
  await new Promise((r) => setTimeout(r, settleMs));
  const second = scanForExtensions();
  return Array.from(new Set([...first, ...second]));
}