/**
 * ImageUploader — uploads an image file to Firebase Storage and
 * returns the public download URL via onUpload.
 *
 * Shows a drag-over zone → progress bar → thumbnail with remove button.
 * Accepts JPEG, PNG, GIF, WebP. Max 5 MB.
 *
 * EVERY constant below mirrors storage.rules `match /question-images/`.
 * They are a contract, not defaults: the rules are the enforcement and this
 * file only exists to fail early with a readable message. Audit 2026-07-26
 * B-01 was four separate drifts between the two (path, size, type, help
 * text), the first of which denied 100% of uploads. If you change a limit
 * here, change it there in the same batch.
 */

import React, { useRef, useState, useCallback } from 'react';
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';
import { storage } from '../../../lib/firebase';
import { ImageIcon, X, Loader2, Upload } from 'lucide-react';

// storage.rules: request.resource.size < 5 * 1024 * 1024
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
// storage.rules: contentType.matches('image/(png|jpe?g|gif|webp)')
// SVG dropped (external review #4): scriptable format, and the storage rules
// reject it server-side. Existing uploaded SVGs keep rendering (rules gate
// writes, not reads).
// image/jpg is included deliberately — the rules regex is `jpe?g`, so it
// accepts both spellings, and some systems label JPEGs that way. Leaving it
// out would refuse a file the server would have taken.
const ALLOWED_TYPES = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
] as const;
const ACCEPT        = ALLOWED_TYPES.join(',');
const TYPE_LABEL    = 'JPEG · PNG · GIF · WebP';
const SIZE_LABEL    = '5 MB';

function randomPath(file: File): string {
  const ext = file.name.split('.').pop() ?? 'jpg';
  const rand = Math.random().toString(36).slice(2, 9);
  // MUST stay under question-images/ — storage.rules grants write to
  // exactly this prefix (plus seb-configs/), and everything else falls to
  // the deny-all catch-all at the bottom of the rules file.
  return `question-images/${Date.now()}-${rand}.${ext}`;
}

export interface ImageUploaderProps {
  /** Current image URL (controlled). Pass undefined when empty. */
  value?: string;
  /** Called with the Storage download URL after upload, or undefined on removal. */
  onChange: (url: string | undefined) => void;
  /** Small label shown inside the drop zone. Default: "Attach image" */
  label?: string;
}

export function ImageUploader({ value, onChange, label = 'Attach image' }: ImageUploaderProps) {
  const inputRef     = useRef<HTMLInputElement>(null);
  const [progress,   setProgress]   = useState<number | null>(null);
  const [error,      setError]      = useState<string | null>(null);
  const [dragOver,   setDragOver]   = useState(false);
  const [storagePath, setStoragePath] = useState<string | null>(null);

  const upload = useCallback(async (file: File) => {
    setError(null);
    // Not startsWith('image/'): that admits image/svg+xml, which the rules
    // reject. The `accept` attribute only filters the file PICKER — a
    // drag-and-drop bypasses it entirely, so this is the real gate.
    if (!(ALLOWED_TYPES as readonly string[]).includes(file.type)) {
      setError(`Only ${TYPE_LABEL} files are accepted.`);
      return;
    }
    // >= not >: the rule is `size < 5 * 1024 * 1024`, so a file of EXACTLY
    // 5 MB is denied server-side. Using > here would let that one size
    // through the client and fail late — the same client/rules drift this
    // whole file is documented against.
    if (file.size >= MAX_BYTES) {
      setError(`File must be under ${SIZE_LABEL}.`);
      return;
    }

    const path    = randomPath(file);
    const storRef = ref(storage, path);
    const task    = uploadBytesResumable(storRef, file);

    setProgress(0);
    setStoragePath(path);

    task.on(
      'state_changed',
      (snap) => setProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
      (err)  => { setError(err.message); setProgress(null); },
      async () => {
        const url = await getDownloadURL(storRef);
        onChange(url);
        setProgress(null);
      }
    );
  }, [onChange]);

  const handleFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    upload(files[0]);
  }, [upload]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const remove = async () => {
    if (storagePath) {
      try { await deleteObject(ref(storage, storagePath)); } catch { /* already gone */ }
      setStoragePath(null);
    }
    onChange(undefined);
  };

  // ── Thumbnail state ────────────────────────────────────────────────
  if (value) {
    return (
      <div
        className="relative inline-block"
        style={{ maxWidth: '100%' }}
      >
        <img
          src={value}
          alt="Attached"
          className="max-h-48 max-w-full object-contain"
          style={{ border: '1px solid var(--ef-border)', borderRadius: 3, display: 'block' }}
        />
        <button
          type="button"
          onClick={remove}
          title="Remove image"
          className="absolute top-2 right-2 flex items-center justify-center transition-opacity hover:opacity-80"
          style={{
            width: 22, height: 22, borderRadius: '50%',
            background: 'var(--ef-ink)', color: 'var(--ef-surface)',
          }}
        >
          <X size={11} strokeWidth={2} />
        </button>
      </div>
    );
  }

  // ── Upload in-progress ─────────────────────────────────────────────
  if (progress !== null) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 py-4 px-4"
        style={{ border: '1px dashed var(--ef-border)', borderRadius: 3, background: 'var(--ef-canvas-raised)' }}
      >
        <Loader2 size={16} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
        <div className="w-full" style={{ maxWidth: 140 }}>
          <div style={{ height: 3, background: 'var(--ef-border)', borderRadius: 2, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${progress}%`,
                background: 'var(--ef-ink)',
                borderRadius: 2,
                transition: 'width 0.2s ease',
              }}
            />
          </div>
        </div>
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{progress}%</p>
      </div>
    );
  }

  // ── Drop zone ──────────────────────────────────────────────────────
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className="flex items-center gap-2.5 px-3 py-2.5 transition-all cursor-pointer"
        style={{
          border: `1px dashed ${dragOver ? 'var(--ef-ink)' : '#D1CFCA'}`,
          borderRadius: 3,
          background: dragOver ? 'var(--ef-canvas)' : 'var(--ef-canvas-raised)',
          outline: 'none',
        }}
      >
        {dragOver
          ? <Upload size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
          : <ImageIcon size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
        }
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
          {dragOver ? 'Drop to upload' : label}
        </span>
        <span className="text-xs ml-auto" style={{ color: 'var(--ef-text-muted)' }}>
          {TYPE_LABEL} &lt;{SIZE_LABEL}
        </span>
      </div>

      {error && (
        <p className="text-xs mt-1.5" style={{ color: 'var(--ef-danger)' }}>{error}</p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}