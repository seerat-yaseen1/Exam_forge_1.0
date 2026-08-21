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

import { useState, useEffect, useCallback, useRef } from 'react';
import { formatDateTime } from '../../lib/dateFormat';
import {
  Plus, Trash2, Eye, EyeOff, CheckCircle2, KeyRound, Upload, FileDown, Loader2,
} from 'lucide-react';
import {
  Button, Card, EmptyState, ErrorBanner, LoadingBlock, PageHeader, PageShell,
  SectionHeading,
} from '../components/console/ui';
import {
  getSEBSettings,
  setSEBSettings,
  getSEBPublicInfo,
  uploadPlatformSebFile,
  removePlatformSebFile,
  type SEBPlatformSettings,
  type SEBPublicInfo,
} from '../../lib/assessmentService';

const HEX64 = /^[0-9a-f]{64}$/;

function maskKey(key: string): string {
  return `${key.slice(0, 8)}…${key.slice(-8)}`;
}

export function SEBSettingsPage() {

  const [settings, setSettings] = useState<SEBPlatformSettings | null>(null);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [loadError, setLoadError] = useState('');

  // ── Platform .seb file (Stage 4b) ────────────────────────────────
  const [fileInfo, setFileInfo]       = useState<SEBPublicInfo>({});
  const [fileBusy, setFileBusy]       = useState(false);
  const [fileError, setFileError]     = useState('');
  const [armedFileRemove, setArmedFileRemove] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
    getSEBPublicInfo().then(setFileInfo).catch(() => {});
  }, []);

  const handleFileChosen = useCallback(async (file: File | null) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.seb')) {
      setFileError('Choose the .seb file saved by the SEB Config Tool.');
      return;
    }
    setFileError('');
    setFileBusy(true);
    try {
      setFileInfo(await uploadPlatformSebFile(file));
    } catch (e) {
      setFileError((e as { message?: string })?.message || 'Upload failed.');
    } finally {
      setFileBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, []);

  const handleFileRemove = useCallback(async () => {
    if (!armedFileRemove) { setArmedFileRemove(true); return; }
    setArmedFileRemove(false);
    setFileBusy(true);
    try {
      await removePlatformSebFile();
      setFileInfo({});
    } finally {
      setFileBusy(false);
    }
  }, [armedFileRemove]);

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
    <PageShell narrow>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Platform security
          </>
        }
        title="Safe Exam Browser"
        subtitle="The Config Keys SEB verification accepts. A key is the checksum of one .seb config's settings — it identifies exactly one unmodified configuration, on any SEB build or operating system."
      />

      {/* Authority note — Stage 4 (Batch 2): this document IS the source of
          truth; SEB_CONFIG_KEYS on Vercel is only an emergency fallback. */}
      <div
        className="flex items-start gap-3"
        style={{
          padding: '12px 14px',
          marginBottom: 26,
          background: 'var(--ef-success-bg)',
          border: '1px solid var(--ef-success-border)',
          borderRadius: 'var(--ef-radius-sm)',
        }}
      >
        <CheckCircle2 size={15} strokeWidth={1.7} style={{ color: 'var(--ef-success)', flexShrink: 0, marginTop: 1 }} />
        <div>
          <p className="ef-t-sm ef-ink" style={{ fontWeight: 500 }}>
            This page is authoritative
          </p>
          <p className="ef-t-xs ef-muted" style={{ marginTop: 3, lineHeight: 'var(--ef-leading-relaxed)' }}>
            Verification reads these keys directly — changes are live within about two
            minutes, with no redeploy. The SEB_CONFIG_KEYS environment variable on Vercel
            is now only an emergency fallback if this document is unreachable, so keep one
            known-good key in it. A per-exam override set in the assessment builder takes
            precedence over this list for that exam.
          </p>
        </div>
      </div>

      {loading && <LoadingBlock label="Loading SEB settings…" rows={2} />}

      {!loading && loadError && <ErrorBanner message={loadError} />}

      {!loading && !loadError && settings && (
        <div className="flex flex-col" style={{ gap: 30 }}>
          <section>
            <SectionHeading
              label="Active config keys"
              count={settings.configKeys.length}
              description={
                settings.updatedAt ? `Last changed ${formatDateTime(settings.updatedAt)}.` : undefined
              }
            />

            {settings.configKeys.length === 0 ? (
              <EmptyState
                icon={<KeyRound size={28} strokeWidth={1.1} />}
                title="No keys yet"
                body="Until there is at least one key here, SEB verification has nothing to check against. Add the Config Key shown in the SEB Config Tool for your exam configuration."
              />
            ) : (
              <Card padded={false}>
                {settings.configKeys.map((key) => (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-3"
                    style={{ padding: '12px var(--ef-pad-card)', borderBottom: '1px solid var(--ef-border-subtle)' }}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <KeyRound size={14} strokeWidth={1.7} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
                      <p
                        className="ef-t-sm ef-ink truncate"
                        style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: '0.02em' }}
                      >
                        {revealed.has(key) ? key : maskKey(key)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        type="button"
                        className="ef-icon-btn"
                        onClick={() => toggleReveal(key)}
                        aria-label={revealed.has(key) ? 'Hide this key' : 'Show this key in full'}
                        title={revealed.has(key) ? 'Hide' : 'Show in full'}
                      >
                        {revealed.has(key) ? <EyeOff size={15} strokeWidth={1.7} /> : <Eye size={15} strokeWidth={1.7} />}
                      </button>
                      {/* Two presses to remove. A key removed by accident locks
                          every student out of every SEB exam until it is put
                          back, and the second press is cheaper than that. */}
                      <Button
                        size="sm"
                        variant={armedRemove === key ? 'danger' : 'secondary'}
                        onClick={() => handleRemove(key)}
                        disabled={saving}
                      >
                        <Trash2 size={12} strokeWidth={1.7} />
                        {armedRemove === key ? 'Confirm' : 'Remove'}
                      </Button>
                    </div>
                  </div>
                ))}
              </Card>
            )}
          </section>

          <section>
            <SectionHeading
              label="Add a config key"
              description={'SEB Config Tool → Exam tab → "Use Browser & Config Keys" → copy the Config Key, not the Browser Exam Key.'}
            />
            <Card>
              <div className="flex items-end gap-2 flex-wrap">
                <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                  <input
                    type="text"
                    className="ef-input"
                    value={newKey}
                    onChange={(e) => { setNewKey(e.target.value); setInputError(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
                    placeholder="64 hexadecimal characters"
                    aria-label="Config key"
                    spellCheck={false}
                    style={{
                      fontFamily: 'ui-monospace, monospace',
                      borderColor: inputError ? 'var(--ef-danger-border)' : undefined,
                    }}
                  />
                </div>
                <Button
                  variant="primary"
                  onClick={handleAdd}
                  disabled={saving || !newKey.trim()}
                  loading={saving}
                >
                  {!saving && <Plus size={13} strokeWidth={1.9} />}
                  Add key
                </Button>
              </div>
              {inputError && (
                <p className="ef-t-sm" role="alert" style={{ color: 'var(--ef-danger)', marginTop: 10 }}>
                  {inputError}
                </p>
              )}
            </Card>
          </section>

          <section>
            <SectionHeading
              label="Platform .seb file"
              description="The file students download from the briefing gate. Every SEB exam using the platform keys offers it automatically."
            />
            <Card>
              {fileInfo.configFileUrl ? (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <FileDown size={15} strokeWidth={1.7} style={{ color: 'var(--ef-success)', flexShrink: 0 }} />
                    <div className="min-w-0">
                      <a href={fileInfo.configFileUrl} className="ef-t-sm ef-ink truncate block">
                        {fileInfo.fileName || 'platform.seb'}
                      </a>
                      {fileInfo.updatedAt && (
                        <p className="ef-t-xs ef-muted">Uploaded {formatDateTime(fileInfo.updatedAt)}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Button size="sm" onClick={() => fileInputRef.current?.click()} loading={fileBusy}>
                      {!fileBusy && <Upload size={12} strokeWidth={1.7} />}
                      Replace
                    </Button>
                    <Button
                      size="sm"
                      variant={armedFileRemove ? 'danger' : 'secondary'}
                      onClick={handleFileRemove}
                      disabled={fileBusy}
                    >
                      {armedFileRemove ? 'Confirm remove' : 'Remove'}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <p className="ef-t-sm ef-muted" style={{ flex: '1 1 240px', lineHeight: 'var(--ef-leading-relaxed)' }}>
                    No platform file yet. Upload the one the Config Tool saved, and students
                    will be offered it on the briefing gate.
                  </p>
                  <Button variant="primary" onClick={() => fileInputRef.current?.click()} loading={fileBusy}>
                    {!fileBusy && <Upload size={13} strokeWidth={1.7} />}
                    Upload .seb
                  </Button>
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                accept=".seb"
                className="hidden"
                onChange={(e) => handleFileChosen(e.target.files?.[0] ?? null)}
              />

              {fileError && (
                <p className="ef-t-sm" role="alert" style={{ color: 'var(--ef-danger)', marginTop: 10 }}>
                  {fileError}
                </p>
              )}

              <p className="ef-t-xs ef-muted" style={{ marginTop: 14, lineHeight: 'var(--ef-leading-relaxed)' }}>
                Rotating? Upload the new file and add its Config Key in the same sitting. The
                file and the key have to describe the same configuration, or students get a
                file that verification will reject.
              </p>
            </Card>
          </section>

          <section>
            <SectionHeading label="Rotating a configuration" />
            <Card variant="inset">
              <p className="ef-t-sm ef-muted" style={{ lineHeight: 'var(--ef-leading-relaxed)' }}>
                Any edit to the .seb file — including setting the quit URL — produces a new
                Config Key. Rotate with an overlap so nobody is locked out mid-transition:
                add the new key here first, so both are accepted; distribute the new file;
                and only then remove the old key. Between high-stakes sittings, rotating the
                config is what invalidates a key that may have leaked from an earlier one.
              </p>
              <p className="ef-t-xs ef-muted inline-flex items-center gap-2" style={{ marginTop: 12 }}>
                <CheckCircle2 size={13} strokeWidth={1.7} style={{ color: 'var(--ef-success)' }} />
                Several keys valid at once is by design. That is the overlap window.
              </p>
            </Card>
          </section>
        </div>
      )}
    </PageShell>
  );
}
