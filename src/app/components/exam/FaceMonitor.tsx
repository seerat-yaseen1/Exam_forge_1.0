/**
 * FaceMonitor
 *
 * Streams the student's webcam into a small PiP display and periodically
 * runs face detection to catch:
 *   - Face absent   (0 faces for > ABSENT_THRESHOLD_SECS continuous seconds)
 *   - Multi-person  (≥ 2 faces detected at once)
 *
 * Face detection uses face-api.js, bundled from npm (no CDN) with the
 * TinyFaceDetector model weights self-hosted from /models. Loading from our
 * own origin means blocking a third-party CDN cannot silently disable
 * detection. If the models fail to load, the webcam PiP still shows but
 * violations are not logged — handled gracefully with a "detection
 * unavailable" indicator.
 *
 * If `enabled` is false (student declined camera at briefing) this component
 * renders nothing.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Camera, CameraOff, AlertCircle } from 'lucide-react';
import * as faceapi from 'face-api.js';
import type { ViolationType } from '../../../lib/submissionService';

// ── Constants ─────────────────────────────────────────────────────

const DETECTION_INTERVAL_MS   = 3000;   // run inference every 3 s
const ABSENT_THRESHOLD_SECS   = 10;     // 10 continuous seconds of 0 faces → violation
const ABSENT_RELOG_SECS       = 60;     // re-log face absence every 60 s of continuous absence
// Self-hosted TinyFaceDetector weights, served from public/models at /models.
// (Was a jsdelivr CDN URL — moved to our origin so a blocked CDN can't kill
// detection. The two weight files live in public/models/.)
const MODEL_URL               = '/models';

// Module-level guard so the (small) model is only loaded once per page.
let modelsLoaded = false;

// ── Types ─────────────────────────────────────────────────────────

type DetectionState = 'loading' | 'ready' | 'unavailable' | 'denied' | 'error';

interface FaceMonitorProps {
  enabled: boolean;                                         // false → camera declined
  active: boolean;                                          // false → pause detection
  onViolation: (type: ViolationType, detail?: string) => void;
  // Optional: notified whenever detection state changes, so the exam shell
  // can gate question render on 'ready' for camera-required tiers
  // (load-then-render — no unmonitored window at the start).
  onStateChange?: (state: DetectionState) => void;
}

// ── Load the self-hosted TinyFaceDetector model ───────────────────
// face-api.js is bundled from npm (imported above); only the weights need
// fetching, and they come from our own origin (/models). Loaded once.

async function loadFaceModels(): Promise<typeof faceapi> {
  if (!modelsLoaded) {
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    modelsLoaded = true;
  }
  return faceapi;
}

// ── Component ─────────────────────────────────────────────────────

export function FaceMonitor({ enabled, active, onViolation, onStateChange }: FaceMonitorProps) {
  const videoRef    = useRef<HTMLVideoElement>(null);
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const faceApiRef  = useRef<any>(null);

  const [detectionState, setDetectionState] = useState<DetectionState>('loading');

  // Notify the parent whenever detection state changes (for load-then-render).
  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => { onStateChangeRef.current = onStateChange; }, [onStateChange]);
  useEffect(() => { onStateChangeRef.current?.(detectionState); }, [detectionState]);

  // Face-absence tracking
  const noFaceStartRef      = useRef<number | null>(null);
  const lastAbsentLogRef    = useRef<number>(0);
  const activeRef           = useRef(active);
  const onViolationRef      = useRef(onViolation);

  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { onViolationRef.current = onViolation; }, [onViolation]);

  // ── Initialise camera + face-api ─────────────────────────────

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const init = async () => {
      // 1. Request camera permission
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 240, facingMode: 'user' },
          audio: false,
        });
      } catch {
        if (!cancelled) setDetectionState('denied');
        return;
      }

      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }

      // 2. Load face-api models (bundled lib + self-hosted weights)
      try {
        const api = await loadFaceModels();
        faceApiRef.current = api;
        if (!cancelled) setDetectionState('ready');
      } catch {
        // Camera works but detection unavailable
        faceApiRef.current = null;
        if (!cancelled) setDetectionState('unavailable');
      }
    };

    init().catch(() => {
      if (!cancelled) setDetectionState('error');
    });

    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [enabled]);

  // ── Detection loop ────────────────────────────────────────────

  const runDetection = useCallback(async () => {
    const faceapi = faceApiRef.current;
    const video   = videoRef.current;
    const canvas  = canvasRef.current;
    if (!faceapi || !video || !canvas || !activeRef.current) return;
    if (video.readyState < 2) return; // video not ready yet

    try {
      const detections = await faceapi.detectAllFaces(
        video,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 })
      );

      const faceCount = detections.length;
      const now = Date.now();

      if (faceCount === 0) {
        // Start absence timer
        if (noFaceStartRef.current === null) noFaceStartRef.current = now;

        const absentMs = now - noFaceStartRef.current;
        const absentSecs = absentMs / 1000;

        if (absentSecs >= ABSENT_THRESHOLD_SECS) {
          // Log once at threshold, then re-log every ABSENT_RELOG_SECS
          const sinceLastLog = now - lastAbsentLogRef.current;
          if (sinceLastLog > ABSENT_RELOG_SECS * 1000 || lastAbsentLogRef.current === 0) {
            lastAbsentLogRef.current = now;
            onViolationRef.current('face_absent', `No face detected for ${Math.floor(absentSecs)}s`);
          }
        }
      } else {
        // Face(s) present — reset absence timer
        noFaceStartRef.current = null;
        lastAbsentLogRef.current = 0;

        if (faceCount >= 2) {
          onViolationRef.current('multi_person', `${faceCount} faces detected`);
        }
      }
    } catch {
      // Silently swallow detection errors (transient frame issues)
    }
  }, []);

  useEffect(() => {
    if (!enabled || detectionState !== 'ready') return;
    const interval = setInterval(runDetection, DETECTION_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled, detectionState, runDetection]);

  // ── Nothing to render if camera disabled ──────────────────────

  if (!enabled) return null;

  // ── Status indicator ──────────────────────────────────────────

  const statusDot =
    detectionState === 'ready'        ? { color: '#1E7B3C', label: 'Camera active' }  :
    detectionState === 'unavailable'  ? { color: '#92680A', label: 'Detection unavailable' } :
    detectionState === 'denied'       ? { color: '#9B2828', label: 'Camera denied' }   :
    detectionState === 'error'        ? { color: '#9B2828', label: 'Camera error' }    :
                                        { color: '#C4C3BD', label: 'Initialising…' };

  return (
    <div
      style={{
        background: '#0C0C0B',
        borderRadius: 3,
        overflow: 'hidden',
        border: '1px solid #2C2C2A',
        flexShrink: 0,
      }}
    >
      {/* Video PiP */}
      <div style={{ position: 'relative', width: '100%', paddingTop: '75%' /* 4:3 */ }}>
        <video
          ref={videoRef}
          muted
          playsInline
          style={{
            position: 'absolute', inset: 0,
            width: '100%', height: '100%',
            objectFit: 'cover',
            transform: 'scaleX(-1)', // mirror so student sees themselves naturally
            display: detectionState === 'denied' || detectionState === 'error' ? 'none' : 'block',
          }}
        />
        {/* Hidden canvas for inference */}
        <canvas ref={canvasRef} style={{ display: 'none' }} />

        {/* Placeholder when camera unavailable */}
        {(detectionState === 'denied' || detectionState === 'error') && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center"
            style={{ background: '#1A1A18' }}
          >
            <CameraOff size={20} strokeWidth={1} style={{ color: '#6B6B66' }} />
          </div>
        )}
      </div>

      {/* Status bar */}
      <div
        className="flex items-center gap-1.5 px-2 py-1.5"
        style={{ borderTop: '1px solid #2C2C2A' }}
      >
        <div
          style={{
            width: 5, height: 5, borderRadius: '50%',
            background: statusDot.color, flexShrink: 0,
            animation: detectionState === 'ready' ? 'pulse 2s ease-in-out infinite' : 'none',
          }}
        />
        <p style={{ fontSize: 9, color: '#6B6B66', letterSpacing: '0.04em', lineHeight: 1 }}>
          {statusDot.label}
        </p>
      </div>
    </div>
  );
}