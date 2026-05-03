/**
 * ImageUploader — uploads an image file to Firebase Storage and
 * returns the public download URL via onUpload.
 *
 * Shows a drag-over zone → progress bar → thumbnail with remove button.
 * Accepts JPEG, PNG, GIF, WebP, SVG. Max 8 MB.
 */

import React, { useRef, useState, useCallback } from 'react';
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';
import { storage } from '../../../lib/firebase';
import { ImageIcon, X, Loader2, Upload } from 'lucide-react';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const ACCEPT    = 'image/jpeg,image/png,image/gif,image/webp,image/svg+xml';

function randomPath(file: File): string {
  const ext = file.name.split('.').pop() ?? 'jpg';
  const rand = Math.random().toString(36).slice(2, 9);
  return `question-media/${Date.now()}-${rand}.${ext}`;
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
    if (!file.type.startsWith('image/')) {
      setError('Only image files are accepted.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('File must be under 8 MB.');
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
          style={{ border: '1px solid #E3E1DB', borderRadius: 3, display: 'block' }}
        />
        <button
          type="button"
          onClick={remove}
          title="Remove image"
          className="absolute top-2 right-2 flex items-center justify-center transition-opacity hover:opacity-80"
          style={{
            width: 22, height: 22, borderRadius: '50%',
            background: '#0C0C0B', color: '#FFFFFF',
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
        style={{ border: '1px dashed #E3E1DB', borderRadius: 3, background: '#FAFAF8' }}
      >
        <Loader2 size={16} className="animate-spin" style={{ color: '#9A9891' }} />
        <div className="w-full" style={{ maxWidth: 140 }}>
          <div style={{ height: 3, background: '#E3E1DB', borderRadius: 2, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${progress}%`,
                background: '#0C0C0B',
                borderRadius: 2,
                transition: 'width 0.2s ease',
              }}
            />
          </div>
        </div>
        <p className="text-xs" style={{ color: '#9A9891' }}>{progress}%</p>
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
          border: `1px dashed ${dragOver ? '#0C0C0B' : '#D1CFCA'}`,
          borderRadius: 3,
          background: dragOver ? '#F7F6F3' : '#FAFAF8',
          outline: 'none',
        }}
      >
        {dragOver
          ? <Upload size={13} strokeWidth={1.5} style={{ color: '#9A9891', flexShrink: 0 }} />
          : <ImageIcon size={13} strokeWidth={1.5} style={{ color: '#B0AEA8', flexShrink: 0 }} />
        }
        <span className="text-xs" style={{ color: '#9A9891' }}>
          {dragOver ? 'Drop to upload' : label}
        </span>
        <span className="text-xs ml-auto" style={{ color: '#C4C3BD' }}>
          JPEG · PNG · GIF · WebP · SVG &lt;8 MB
        </span>
      </div>

      {error && (
        <p className="text-xs mt-1.5" style={{ color: '#9B2828' }}>{error}</p>
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
