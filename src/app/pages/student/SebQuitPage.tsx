/**
 * SebQuitPage — Phase 3 (Stage 3)
 *
 * The landing target for closing Safe Exam Browser after an exam.
 *
 * HOW IT WORKS
 * SEB quits automatically when the browser navigates to the *quit URL*
 * configured in the .seb file (Config Tool → Exit sequence / quit link).
 * Set that quit URL to:
 *
 *     https://<your-deployment-domain>/seb-quit
 *
 * When configured, SEB closes the moment the "Close Safe Exam Browser"
 * button navigates here — this page is never actually seen. If the quit
 * URL is NOT configured (or points elsewhere), the student lands here and
 * gets manual instructions instead, so the flow degrades gracefully.
 *
 * IMPORTANT — CONFIG KEY ROTATION
 * Adding/changing the quit URL edits the .seb settings, which CHANGES the
 * Config Key. After editing the config: (1) note the new Config Key in the
 * Config Tool, (2) add it to platformSettings/seb alongside the old one
 * (and the SEB_CONFIG_KEYS env on Vercel), (3) distribute the new .seb,
 * (4) remove the old key after the transition window.
 *
 * No auth on purpose: by the time a student reaches this page the exam is
 * over, nothing sensitive is shown, and requiring a session would break the
 * quit navigation if the session had already been cleared.
 */

import { CheckCircle2 } from 'lucide-react';

export function SebQuitPage() {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-6"
      style={{ background: 'var(--ef-canvas)' }}
    >
      <div className="flex items-center justify-center mb-5"
        style={{ width: 52, height: 52, borderRadius: '50%',
          background: 'var(--ef-success-bg)', border: '1px solid var(--ef-success-border)' }}>
        <CheckCircle2 size={22} strokeWidth={1} style={{ color: 'var(--ef-success-strong)' }} />
      </div>
      <p className="text-xs mb-2" style={{ color: 'var(--ef-success-strong)', letterSpacing: '0.1em' }}>
        EXAM SESSION ENDED
      </p>
      <p className="text-sm mb-2 text-center" style={{ color: 'var(--ef-ink)', lineHeight: 1.7, maxWidth: 380 }}>
        You may now close Safe Exam Browser.
      </p>
      <p className="text-xs text-center" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6, maxWidth: 380 }}>
        If Safe Exam Browser did not close automatically, quit it from its
        toolbar / taskbar quit button, or press Ctrl+Q (Windows) / Cmd+Q (Mac).
        A quit password, if one was set by your institute, may be requested.
      </p>
    </div>
  );
}