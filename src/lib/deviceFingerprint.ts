/**
 * deviceFingerprint
 *
 * A coarse description of the machine driving a sitting: GPU renderer, CPU
 * core count, memory class, platform. Four values, none of them identifying on
 * its own — this is not built to recognise a person, and it deliberately
 * collects nothing that would. What it is built to notice is a CHANGE.
 *
 * ── What the change means ─────────────────────────────────────────
 *
 * A browser session cannot move between machines. So a sitting that reports
 * one machine at the start and a different one later is not one student on one
 * computer: the attempt was resumed somewhere else, or something is answering
 * for the page. That is a stronger signal than any single client-side report,
 * because it is not an observation about behaviour that a student could
 * plausibly explain — it is two incompatible facts about the same sitting.
 *
 * It complements the session-conflict check rather than repeating it.
 * activeSessionId catches a SECOND session opening; this catches the same
 * attempt continuing on different hardware.
 *
 * ── What it cannot do ─────────────────────────────────────────────
 *
 * Everything here is client-reported, so a client that lies can report the
 * baseline forever, and one that runs the whole exam inside a VM reports the
 * VM consistently and drifts from nothing. This detects an HONEST client on
 * changed hardware. It is a detective signal for a reviewer, never an
 * enforcement mechanism, and SEB remains the only control that actually
 * reaches remote-desktop and virtualisation. Anything stronger claimed for it
 * would be a claim the browser cannot back.
 *
 * ── Where it runs ─────────────────────────────────────────────────
 *
 * It rides the heartbeat, and the heartbeat only runs on the proctored tiers,
 * so practice sittings are never fingerprinted at all. That is deliberate: a
 * rehearsal is not assessed, so there is nothing for the signal to protect.
 */

export type DeviceFingerprint = {
  /** WebGL renderer string. '' when WebGL is unavailable or masked. */
  gpu: string;
  /** navigator.hardwareConcurrency; 0 when the browser withholds it. */
  cores: number;
  /** navigator.deviceMemory in GB; 0 where unsupported (non-Chromium). */
  memory: number;
  /** navigator.platform; coarse, and bounded. */
  platform: string;
};

/** Every stored string is cut to this. These end up in an attempt document. */
const MAX_FIELD = 120;

const clip = (s: unknown): string =>
  (typeof s === 'string' ? s : '').trim().slice(0, MAX_FIELD);

/**
 * Read the GPU renderer.
 *
 * WEBGL_debug_renderer_info is the informative one, and browsers have been
 * progressively restricting it for exactly the fingerprinting reasons that
 * make it useful here. When it is missing the plain RENDERER string is used
 * instead — it is generic ('WebKit WebGL'), which makes it useless for telling
 * two machines apart but perfectly adequate for noticing that the answer
 * changed, which is all this is asked to do.
 *
 * Creating a WebGL context is not cheap, which is why the result is cached by
 * the caller rather than recomputed on every heartbeat.
 */
function readGpu(): string {
  if (typeof document === 'undefined') return '';
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return '';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = dbg
      ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    // Release the context rather than waiting for GC. A browser allows only a
    // handful of live WebGL contexts, and an exam page has its own uses for
    // them; leaking one per call would be a real cost for a detective signal.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return clip(raw);
  } catch {
    // A machine without WebGL, or a hardened browser, must still sit the exam.
    return '';
  } finally {
    canvas = null;
  }
}

function collect(): DeviceFingerprint {
  if (typeof navigator === 'undefined') {
    return { gpu: '', cores: 0, memory: 0, platform: '' };
  }
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    gpu: readGpu(),
    cores: Number(nav.hardwareConcurrency) || 0,
    memory: Number(nav.deviceMemory) || 0,
    platform: clip(nav.platform),
  };
}

let cached: DeviceFingerprint | null = null;

/**
 * The fingerprint for THIS page load, computed once.
 *
 * Caching is not only an optimisation — it is what makes the signal mean
 * something. Recomputing per heartbeat would let transient GPU conditions (a
 * context lost to a driver reset, a browser backgrounding the tab) read as
 * hardware changing underneath the student. The machine cannot change without
 * a new page load, so the value is fixed for the life of one.
 */
export function getDeviceFingerprint(): DeviceFingerprint {
  if (!cached) cached = collect();
  return cached;
}

/** Test seam. Never called by application code. */
export function __resetFingerprintCache() {
  cached = null;
}

/**
 * Which fields differ. Empty means the machine looks the same.
 *
 * A field that is EMPTY on one side and populated on the other is not counted
 * as drift. Browsers withhold these values situationally — a privacy setting
 * toggled mid-sitting, a WebGL context that failed to create once — and
 * "we could not read it this time" is an absence of evidence, not evidence of
 * a different machine. Only two populated values that disagree are drift.
 */
export function fingerprintDrift(
  baseline: Partial<DeviceFingerprint> | null | undefined,
  current: Partial<DeviceFingerprint> | null | undefined,
): string[] {
  if (!baseline || !current) return [];
  const drifted: string[] = [];

  const cmp = (field: keyof DeviceFingerprint) => {
    const a = baseline[field];
    const b = current[field];
    // Unknown on either side — see the note above.
    if (a === undefined || b === undefined) return;
    if (a === '' || b === '' || a === 0 || b === 0) return;
    if (a !== b) drifted.push(`${field}: ${String(a).slice(0, 40)} → ${String(b).slice(0, 40)}`);
  };

  cmp('gpu');
  cmp('cores');
  cmp('memory');
  cmp('platform');
  return drifted;
}
