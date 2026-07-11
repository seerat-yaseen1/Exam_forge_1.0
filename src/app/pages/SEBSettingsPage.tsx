/**
 * SEBSettingsPage — Phase 3 (Stage 4), webOwner only.
 *
 * Manages the platform-wide Safe Exam Browser Config Keys stored at
 * platformSettings/seb. The Config Key is the SHA-256 checksum of a .seb
 * config's settings (shown in the SEB Config Tool). It does NOT include the
 * SEB version, so one key covers Windows/macOS and all SEB builds — which is
 * why STRATUM verifies the Config Key rather than the Browser Exam Key.
 *
 * `configKeys` is an ARRAY by design: rotating a .seb config needs an overlap
 * window where the old and new keys are both accepted (add new → distribute
 * new .seb → remove old).
 *
 * AUTHORITY NOTE (Batch 1 honesty): enforcement in /api/seb-verify currently
 * reads the SEB_CONFIG_KEYS env on Vercel. Until Batch 2 makes this document
 * the authoritative source (service-account read with env fallback), any
 * change made here MUST be mirrored into that env var. The banner below says
 * exactly that so future-you cannot be misled by this page.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { motion } from 'motion/react';
import {
  Shield, Loader2, AlertTriangle, Plus, Trash2, Eye, EyeOff,
  CheckCircle2, ArrowRight, KeyRound,
} from 'lucide-react';
import {
  getSEBSettings,
  setSEBSettings,
  type SEBPlatformSettings,
} from '../../lib/assessmentService';

const HEX64 = /^[0-9a-f]{64}$/;

function maskKey(key: string): string {
  return `${key.slice(0, 8)}…${key.slice(-8)}`;
}

export function SEBSettingsPage() {
  const navigate = useNavigate();

  const [settings, setSettings] = useState<SEBPlatformSettings | null>(null);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [loadError, setLoadError] = useState('');

  const [newKey, setNewKey]       = useState('');
  const [inputError, setInputError] = useState('');
  const [revealed, setRevealed]   = useState<Set<string>>(new Set());
  // Two-click removal: first click arms, second click removes.
  const [armedRemove, setArmedRemove] = useState<string | null>(null);

  useEffect(() => {
    getSEBSettings()
      .then(setSettings)
      .catch((e) => setLoadError(e.message || 'Failed to load SEB settings.'))
      .finally(() => setLoading(false));
  }, []);

  const persist = useCallback(async (keys: string[]) => {
    setSaving(true);
    try {
      await setSEBSettings(keys);
      // Re-read so updatedAt reflects the server write.
      const fresh = await getSEBSettings();
      setSettings(fresh);
    } finally {
      setSaving(false);
    }
  }, []);

  const handleAdd = useCallback(async () => {
    const cleaned = newKey.trim().toLowerCase();
    if (!HEX64.test(cleaned)) {
      setInputError('A Config Key is exactly 64 hexadecimal characters (copy it from the SEB Config Tool).');
      return;
    }
    if (settings?.configKeys.includes(cleaned)) {
      setInputError('This key is already in the list.');
      return;
    }
    setInputError('');
    await persist([...(settings?.configKeys ?? []), cleaned]);
    setNewKey('');
  }, [newKey, settings, persist]);

  const handleRemove = useCallback(async (key: string) => {
    if (armedRemove !== key) {
      setArmedRemove(key);
      return;
    }
    setArmedRemove(null);
    await persist((settings?.configKeys ?? []).filter((k) => k !== key));
  }, [armedRemove, settings, persist]);

  const toggleReveal = useCallback((key: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="px-8 py-10"
      style={{ maxWidth: 800, margin: '0 auto' }}
    >
      {/* Header */}
      <div className="mb-8" style={{ borderBottom: '1px solid #E3E1DB', paddingBottom: 20 }}>
        <div className="flex items-center gap-2 mb-2">
          <Shield size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />
          <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>
            PLATFORM SECURITY
          </p>
        </div>
        <h1 className="text-2xl font-light mb-1" style={{ color: '#0C0C0B', letterSpacing: '0.01em' }}>
          Safe Exam Browser
        </h1>
        <p className="text-xs" style={{ color: '#9A9891', lineHeight: 1.6 }}>
          Config Keys accepted by SEB verification. A key is the checksum of a .seb
          config's settings — it identifies exactly one unmodified configuration.
        </p>
      </div>

      {/* Authority note — Stage 4 (Batch 2): this document IS the source of
          truth; SEB_CONFIG_KEYS on Vercel is only an emergency fallback. */}
      <div className="flex items-start gap-3 px-4 py-3 mb-6"
        style={{ background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2 }}>
        <CheckCircle2 size={13} strokeWidth={1.5} style={{ color: '#1E7B3C', flexShrink: 0, marginTop: 1 }} />
        <p className="text-xs" style={{ color: '#1E7B3C', lineHeight: 1.6 }}>
          <strong>This page is authoritative.</strong> Verification reads these keys
          directly (cached briefly — changes are live within ~2 minutes, no redeploy).
          The SEB_CONFIG_KEYS environment variable on Vercel now serves only as an
          emergency fallback if this document is unreachable — keep one known-good key
          in it. Per-exam key overrides, when set in the assessment builder, take
          precedence over this list for that exam.
        </p>
      </div>

      {loading && (
        <div className="flex flex-col items-center py-24">
          <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
          <p className="text-xs mt-4" style={{ color: '#C4C3BD' }}>Loading SEB settings…</p>
        </div>
      )}

      {!loading && loadError && (
        <div className="flex items-center gap-3 px-4 py-3"
          style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
          <AlertTriangle size={13} strokeWidth={1.5} style={{ color: '#9B2828' }} />
          <p className="text-xs" style={{ color: '#9B2828' }}>{loadError}</p>
        </div>
      )}

      {!loading && !loadError && settings && (
        <>
          {/* Key list */}
          <div className="mb-8">
            <p className="text-xs mb-3" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>
              ACTIVE CONFIG KEYS ({settings.configKeys.length})
            </p>

            {settings.configKeys.length === 0 && (
              <div className="px-4 py-6 text-center"
                style={{ background: '#FAFAF8', border: '1px dashed #E3E1DB', borderRadius: 2 }}>
                <p className="text-xs" style={{ color: '#9A9891' }}>
                  No Config Keys yet. Add the key shown in the SEB Config Tool for your
                  exam configuration.
                </p>
              </div>
            )}

            <div className="space-y-2">
              {settings.configKeys.map((key) => (
                <div key={key} className="flex items-center justify-between gap-3 px-4 py-3"
                  style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                  <div className="flex items-center gap-3 min-w-0">
                    <KeyRound size={12} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
                    <p className="text-xs truncate" style={{ color: '#0C0C0B', fontFamily: 'ui-monospace, monospace' }}>
                      {revealed.has(key) ? key : maskKey(key)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => toggleReveal(key)}
                      className="p-1.5"
                      style={{ color: '#9A9891', cursor: 'pointer', background: 'none', border: 'none' }}
                      aria-label={revealed.has(key) ? 'Hide key' : 'Reveal key'}
                    >
                      {revealed.has(key) ? <EyeOff size={13} strokeWidth={1.5} /> : <Eye size={13} strokeWidth={1.5} />}
                    </button>
                    <button
                      onClick={() => handleRemove(key)}
                      disabled={saving}
                      className="flex items-center gap-1.5 text-xs px-3 py-1.5"
                      style={{
                        color: armedRemove === key ? '#FFFFFF' : '#9B2828',
                        background: armedRemove === key ? '#9B2828' : '#FFFFFF',
                        border: '1px solid #F2CECE',
                        borderRadius: 2,
                        cursor: saving ? 'wait' : 'pointer',
                      }}
                    >
                      <Trash2 size={11} strokeWidth={1.5} />
                      {armedRemove === key ? 'Confirm remove' : 'Remove'}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {settings.updatedAt && (
              <p className="text-xs mt-2" style={{ color: '#C4C3BD' }}>
                Last updated {new Date(settings.updatedAt).toLocaleString('en-GB', {
                  day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
                })}
              </p>
            )}
          </div>

          {/* Add key */}
          <div className="mb-8">
            <p className="text-xs mb-3" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>
              ADD A CONFIG KEY
            </p>
            <div className="px-4 py-4"
              style={{ background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2 }}>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newKey}
                  onChange={(e) => { setNewKey(e.target.value); setInputError(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
                  placeholder="64-character Config Key from the SEB Config Tool"
                  spellCheck={false}
                  className="flex-1 text-xs px-3 py-2"
                  style={{
                    border: `1px solid ${inputError ? '#F2CECE' : '#E3E1DB'}`,
                    borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B',
                    fontFamily: 'ui-monospace, monospace', outline: 'none',
                  }}
                />
                <button
                  onClick={handleAdd}
                  disabled={saving || !newKey.trim()}
                  className="flex items-center gap-1.5 text-xs px-4 py-2 flex-shrink-0"
                  style={{
                    background: saving || !newKey.trim() ? '#C8C7C2' : '#0C0C0B',
                    color: '#FFFFFF', borderRadius: 2,
                    cursor: saving || !newKey.trim() ? 'not-allowed' : 'pointer',
                  }}
                >
                  {saving ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} strokeWidth={1.5} />}
                  Add key
                </button>
              </div>
              {inputError && (
                <p className="text-xs mt-2" style={{ color: '#9B2828' }}>{inputError}</p>
              )}
              <p className="text-xs mt-2" style={{ color: '#9A9891', lineHeight: 1.5 }}>
                SEB Config Tool → Exam tab → "Use Browser &amp; Config Keys" → copy the
                <strong> Config Key</strong> (not the Browser Exam Key).
              </p>
            </div>
          </div>

          {/* Rotation checklist */}
          <div className="mb-8">
            <p className="text-xs mb-3" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>
              ROTATING A CONFIGURATION
            </p>
            <div className="px-4 py-4"
              style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 2 }}>
              <p className="text-xs mb-3" style={{ color: '#4A4A45', lineHeight: 1.7 }}>
                Any edit to the .seb file (including setting the quit URL) produces a new
                Config Key. Rotate with an overlap so no student is locked out mid-transition:
                first add the new key here (both keys are now accepted), mirror the change
                into the Vercel env, distribute the new .seb file to students, and only then
                remove the old key. Between high-stake sittings, rotating the config is what
                invalidates any key that may have leaked from a previous sitting.
              </p>
              <div className="flex items-center gap-2">
                <CheckCircle2 size={12} strokeWidth={1.5} style={{ color: '#1E7B3C' }} />
                <p className="text-xs" style={{ color: '#6B6B66' }}>
                  Multiple keys valid at once is by design — it is the overlap window.
                </p>
              </div>
            </div>
          </div>

          {/* Diagnostics link */}
          <button
            onClick={() => navigate('/dashboard/seb-diagnostics')}
            className="flex items-center gap-2 text-xs px-4 py-2"
            style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, background: '#FFFFFF', cursor: 'pointer' }}
          >
            Run SEB diagnostics
            <ArrowRight size={11} strokeWidth={1.5} />
          </button>
        </>
      )}
    </motion.div>
  );
}