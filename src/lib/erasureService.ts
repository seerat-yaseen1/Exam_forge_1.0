// ── Erasure policy & execution (Feature #15, Phase 7c) ────────────
//
// The two values that arm erasure:
//
//   retentionYears : how long examination records must be kept
//   mode           : 'delete' | 'anonymize'
//
// UNSET MEANS REFUSE. Until both are written, every erasure attempt is
// rejected server-side with ERASURE_POLICY_NOT_CONFIGURED. These are legal
// answers rather than engineering ones, so the code declines to guess — the
// same fail-closed posture as scheduledPurge's dry-run default.
//
// Once your jurisdiction's answers are known, setting them here turns the
// feature on. No code change, no deploy.

import { httpsCallable } from 'firebase/functions';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db, functions } from './firebase';

export type ErasureMode = 'delete' | 'anonymize';

export type ErasurePolicy = {
  retentionYears: number | null;
  mode: ErasureMode | null;
  configuredBy: string | null;
  configuredAt: string | null;
};

const POLICY_DOC = ['platformSettings', 'erasure'] as const;

export const EMPTY_POLICY: ErasurePolicy = {
  retentionYears: null,
  mode: null,
  configuredBy: null,
  configuredAt: null,
};

/** Server error codes, branched on rather than matched by prose. */
export const POLICY_NOT_CONFIGURED = 'ERASURE_POLICY_NOT_CONFIGURED';
export const RETENTION_WINDOW_ACTIVE = 'RETENTION_WINDOW_ACTIVE';
export const RETENTION_UNKNOWN = 'RETENTION_UNKNOWN';

export function isPolicyNotConfigured(err: unknown): boolean {
  return ((err as { message?: string })?.message ?? '').includes(POLICY_NOT_CONFIGURED);
}

/** Returns the blocking date when inside the window, or null if not this error. */
export function retentionBlockDate(err: unknown): string | null {
  const m = (err as { message?: string })?.message ?? '';
  const hit = new RegExp(`${RETENTION_WINDOW_ACTIVE}:(.+)$`).exec(m);
  return hit ? hit[1] : null;
}

export function isRetentionUnknown(err: unknown): boolean {
  return ((err as { message?: string })?.message ?? '').includes(RETENTION_UNKNOWN);
}

// ── Policy ────────────────────────────────────────────────────────

export async function getErasurePolicy(): Promise<ErasurePolicy> {
  try {
    const snap = await getDoc(doc(db, ...POLICY_DOC));
    if (!snap.exists()) return { ...EMPTY_POLICY };
    const d = snap.data() as Partial<ErasurePolicy>;
    return {
      retentionYears: typeof d.retentionYears === 'number' ? d.retentionYears : null,
      mode: d.mode === 'delete' || d.mode === 'anonymize' ? d.mode : null,
      configuredBy: d.configuredBy ?? null,
      configuredAt: d.configuredAt ?? null,
    };
  } catch (err) {
    // Unreadable ⇒ report unconfigured. The server independently refuses in
    // that state, so this only keeps the UI honest.
    console.error('[erasure policy] read failed', err);
    return { ...EMPTY_POLICY };
  }
}

export async function setErasurePolicy(
  retentionYears: number,
  mode: ErasureMode,
  uid: string,
): Promise<void> {
  await setDoc(doc(db, ...POLICY_DOC), {
    retentionYears,
    mode,
    configuredBy: uid,
    configuredAt: new Date().toISOString(),
  }, { merge: true });
}

export function policyIsConfigured(p: ErasurePolicy | null): boolean {
  return !!p && typeof p.retentionYears === 'number' && p.mode !== null;
}

// ── Execution ─────────────────────────────────────────────────────

export async function executeErasure(params: {
  requestId: string;
  confirmName: string;
  acknowledgeRetentionOverride?: boolean;
  decision?: string;
}): Promise<{ mode: ErasureMode; counts: Record<string, number> }> {
  const call = httpsCallable<
    typeof params,
    { ok: true; mode: ErasureMode; counts: Record<string, number> }
  >(functions, 'executeErasure');
  const res = await call(params);
  return { mode: res.data.mode, counts: res.data.counts ?? {} };
}

// ── Presentation ──────────────────────────────────────────────────

export function modeLabel(mode: ErasureMode): string {
  return mode === 'delete'
    ? 'Delete records outright'
    : 'Strip identity, keep statistics';
}

export function modeDescription(mode: ErasureMode): string {
  return mode === 'delete'
    ? 'Exam attempts are destroyed. The institute loses that academic record, '
      + 'and historical statistics will change.'
    : 'Exam attempts are kept as anonymous rows with the link to the person '
      + 'severed. Statistics survive; the person becomes unidentifiable.';
}