import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import {
  Building2, Plus, Pencil, Trash2, PauseCircle, PlayCircle,
  Loader2, X, Check, AlertTriangle, Mail, MailX, RefreshCw,
  CalendarDays, Eye, EyeOff, ShieldAlert, ChevronRight, RotateCcw,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  getAllInstitutes,
  getInstitute,
  updateInstitute,
  deleteInstitute,
  generateInstituteCode,
  generatePassword,
  computeActiveUntil,
  type Institute,
} from '../../lib/firebaseService';
import { httpsCallable } from 'firebase/functions';
import { sendPasswordResetEmail } from 'firebase/auth';
import { auth, functions } from '../../lib/firebase';
import { DeletionImpactPanel } from '../components/DeletionImpactPanel';
import { DeletionApprovalsInbox } from '../components/DeletionApprovalsInbox';
import { TrashPanel } from '../components/TrashPanel';
import { daysUntilExpiry, NO_EXPIRY_LABEL } from '../../lib/instituteValidity';
import { SubjectRequestsInbox } from '../components/SubjectRequestsInbox';
import { ErasurePolicyPanel } from '../components/ErasurePolicyPanel';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatSyncAge(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function validityLabel(v: Institute): string {
  const days = daysUntilExpiry(v.activeUntil);
  // Checked FIRST. Without it, an institute with no expiry produced NaN,
  // fell past every branch below, and rendered "Invalid Date".
  if (days === null) return NO_EXPIRY_LABEL;
  if (days < 0) return 'Expired';
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  if (days <= 14) return `${days}d left`;
  return formatDate(v.activeUntil);
}

function validityColor(v: Institute): string {
  const days = daysUntilExpiry(v.activeUntil);
  // No expiry is not an alarm state — it reads as ordinary, like a far-off
  // date. It happened to land here already, since every NaN comparison is
  // false; now it does so on purpose.
  if (days === null) return 'var(--ef-text-muted)';
  if (days < 0) return 'var(--ef-danger)';
  if (days <= 7) return 'var(--ef-warning-strong)';
  return 'var(--ef-text-muted)';
}

// ── Shared input style ────────────────────────────────────────────────────────

const inputBase: React.CSSProperties = {
  background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)',
  color: 'var(--ef-ink)', borderRadius: 2, width: '100%',
  outline: 'none', fontSize: 13, padding: '9px 12px',
};

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <label className="block text-xs mb-1.5" style={{ color: 'var(--ef-text-subtle)' }}>{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-xs" style={{ color: 'var(--ef-text-muted)' }}>{hint}</p>}
    </div>
  );
}

function focusStyle(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.target.style.borderColor = 'var(--ef-ink)';
  e.target.style.background = 'var(--ef-surface)';
}
function blurStyle(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
  e.target.style.borderColor = 'var(--ef-border)';
  e.target.style.background = 'var(--ef-canvas-raised)';
}

// ── Validity picker ───────────────────────────────────────────────────────────

function ValidityFields({
  validityType, setValidityType, activeUntil, setActiveUntil,
}: {
  validityType: 'monthly' | 'yearly' | 'custom';
  setValidityType: (v: 'monthly' | 'yearly' | 'custom') => void;
  activeUntil: string;
  setActiveUntil: (v: string) => void;
}) {
  return (
    <Field label="Institute validity" hint={
      validityType === 'monthly' ? 'Access expires 1 month from today.'
      : validityType === 'yearly' ? 'Access expires 1 year from today.'
      : 'Set a specific expiry date.'
    }>
      <div className="flex gap-2 mb-2">
        {(['monthly', 'yearly', 'custom'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setValidityType(t)}
            className="flex-1 text-xs py-2 transition-all"
            style={{
              borderRadius: 2,
              border: validityType === t ? '1px solid var(--ef-ink)' : '1px solid var(--ef-border)',
              background: validityType === t ? 'var(--ef-ink)' : 'var(--ef-canvas-raised)',
              color: validityType === t ? 'var(--ef-surface)' : 'var(--ef-text-subtle)',
              letterSpacing: '0.04em',
            }}
          >
            {t === 'monthly' ? 'Monthly' : t === 'yearly' ? 'Yearly' : 'Custom'}
          </button>
        ))}
      </div>
      {validityType === 'custom' && (
        <input
          type="date"
          value={activeUntil}
          min={new Date().toISOString().split('T')[0]}
          onChange={(e) => setActiveUntil(e.target.value)}
          style={inputBase}
          onFocus={focusStyle}
          onBlur={blurStyle}
        />
      )}
    </Field>
  );
}

// ── Institute Drawer ──────────────────────────────────────────────────────────

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  onSaved: (institute: Institute, emailSent?: boolean) => void;
  editing: Institute | null;
}

function InstituteDrawer({ open, onClose, onSaved, editing }: DrawerProps) {
  const isEdit = !!editing;

  const [name, setName]               = useState('');
  const [adminName, setAdminName]     = useState('');
  const [adminEmail, setAdminEmail]   = useState('');
  const [validityType, setValidityType] = useState<'monthly' | 'yearly' | 'custom'>('monthly');
  const [activeUntil, setActiveUntil] = useState('');
  const [saving, setSaving]           = useState(false);
  const [formError, setFormError]     = useState('');

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setAdminName(editing.adminName);
      setAdminEmail(editing.adminEmail);
      setValidityType(editing.validityType ?? 'monthly');
      setActiveUntil(editing.activeUntil ?? '');
    } else {
      setName(''); setAdminName(''); setAdminEmail('');
      setValidityType('monthly'); setActiveUntil('');
    }
    setFormError(''); setSaving(false);
  }, [open, editing]);

  const handleSubmit = async () => {
    if (!name.trim())       return setFormError('Institute name is required.');
    if (!adminName.trim())  return setFormError('Admin name is required.');
    if (!adminEmail.trim()) return setFormError('Admin email is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail))
      return setFormError('Enter a valid email address.');
    if (validityType === 'custom' && !activeUntil)
      return setFormError('Please select a custom Active Until date.');

    setSaving(true); setFormError('');
    try {
      const now = new Date().toISOString();
      const computedActiveUntil = computeActiveUntil(validityType, activeUntil);

      if (isEdit) {
        // Update existing institute
        await updateInstitute(editing!.id, {
          name: name.trim(),
          adminName: adminName.trim(),
          adminEmail: adminEmail.toLowerCase().trim(),
          validityType,
          activeUntil: computedActiveUntil,
          updatedAt: now,
        });
        const updated = await getInstitute(editing!.id);
        if (updated) onSaved(updated, false);
      } else {
        // Create new institute via Cloud Function (Firebase Auth user + profile doc).
        // Then trigger Firebase's own password-reset email so the admin sets
        // their own password — we never email a plaintext temporary password.
        const code            = generateInstituteCode();
        const tempPassword    = generatePassword();   // random; user resets via email
        const normalizedEmail = adminEmail.toLowerCase().trim();

        const createAuthUser = httpsCallable<
          { role: 'institute'; password: string; profile: Record<string, unknown> },
          { ok: boolean; uid: string }
        >(functions, 'createAuthUser');

        const result = await createAuthUser({
          role: 'institute',
          password: tempPassword,
          profile: {
            email: normalizedEmail,
            name: adminName.trim(),
            code,
            adminName: adminName.trim(),
            adminEmail: normalizedEmail,
            status: 'active',
            validityType,
            activeUntil: computedActiveUntil,
            firstLoginRequired: false,  // admin sets pwd via reset link
          },
        });

        const uid = result.data.uid;

        // Trigger Firebase-delivered password-reset email.
        let emailSent = false;
        try {
          await sendPasswordResetEmail(auth, normalizedEmail);
          emailSent = true;
        } catch (e) {
          console.warn('[InstituteDrawer] reset email failed:', e);
        }

        const created = await getInstitute(uid);
        if (created) onSaved(created, emailSent);
      }
    } catch (e: any) {
      setFormError(e.message || 'An unexpected error occurred.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="drawer-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50"
            style={{ background: 'rgba(12,12,11,0.18)' }}
            onClick={onClose}
          />
          <motion.div
            key="drawer-panel"
            initial={{ x: 48, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 48, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            className="fixed right-0 top-0 bottom-0 z-50 flex flex-col w-full sm:w-[420px] sm:max-w-full"
            style={{ background: 'var(--ef-surface)', borderLeft: '1px solid var(--ef-border)' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 sm:py-4 flex-shrink-0"
              style={{ borderBottom: '1px solid var(--ef-border)' }}>
              <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
                {isEdit ? 'EDIT INSTITUTE' : 'NEW INSTITUTE'}
              </p>
              <button onClick={onClose} className="p-1 transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}>
                <X size={15} strokeWidth={1.5} />
              </button>
            </div>

            {/* Form */}
            <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">

              {/* Institute Name */}
              <Field label="Institute name" hint="Full legal or operational name of the institution.">
                <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Massachusetts Institute of Technology"
                  style={inputBase} onFocus={focusStyle} onBlur={blurStyle} />
              </Field>

              {/* Institute ID — read-only on edit, auto on create */}
              {isEdit && (
                <Field label="Institute ID" hint="Auto-generated · 6 characters · Cannot be changed.">
                  <div className="flex items-center gap-2 px-3 py-2.5"
                    style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 14, letterSpacing: '0.16em', color: 'var(--ef-ink)', fontWeight: 600 }}>
                      {editing!.code}
                    </span>
                    <span className="ml-auto text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>IMMUTABLE</span>
                  </div>
                </Field>
              )}

              {!isEdit && (
                <div className="mb-5 flex items-start gap-2 px-3 py-2.5"
                  style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                  <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--ef-text-muted)', marginTop: 5, flexShrink: 0 }} />
                  <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                    A unique 6-character Institute ID will be generated automatically upon creation.
                  </p>
                </div>
              )}

              <div style={{ borderTop: '1px solid var(--ef-border-subtle)', margin: '4px 0 20px' }} />

              {/* Admin Name */}
              <Field label="Institute admin name" hint="This person will administer the institute portal.">
                <input type="text" value={adminName} onChange={(e) => setAdminName(e.target.value)}
                  placeholder="e.g. Dr. Sarah Chen"
                  style={inputBase} onFocus={focusStyle} onBlur={blurStyle} />
              </Field>

              {/* Admin Email */}
              <Field label="Institute admin email"
                hint="A password-setup link will be emailed to this address.">
                <input type="email" value={adminEmail}
                  onChange={(e) => { setAdminEmail(e.target.value); setFormError(''); }}
                  placeholder="e.g. admin@institute.edu"
                  style={inputBase} onFocus={focusStyle} onBlur={blurStyle} />
              </Field>

              <div style={{ borderTop: '1px solid var(--ef-border-subtle)', margin: '4px 0 20px' }} />

              {/* Validity */}
              <ValidityFields
                validityType={validityType} setValidityType={setValidityType}
                activeUntil={activeUntil} setActiveUntil={setActiveUntil}
              />
            </div>

            {/* Footer */}
            <div className="flex-shrink-0 px-4 sm:px-6 py-4" style={{ borderTop: '1px solid var(--ef-border)' }}>
              <AnimatePresence>
                {formError && (
                  <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                    className="flex items-start gap-2 mb-3 px-3 py-2.5"
                    style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
                    <AlertTriangle size={12} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', marginTop: 1, flexShrink: 0 }} />
                    <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{formError}</p>
                  </motion.div>
                )}
              </AnimatePresence>
              <div className="flex items-center gap-3">
                <button onClick={handleSubmit} disabled={saving}
                  className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
                  style={{
                    background: saving ? 'var(--ef-track)' : 'var(--ef-ink)', color: 'var(--ef-surface)',
                    borderRadius: 2, letterSpacing: '0.03em',
                    cursor: saving ? 'not-allowed' : 'pointer',
                  }}>
                  {saving ? <><Loader2 size={11} className="animate-spin" />Saving…</>
                    : isEdit ? <><Check size={11} strokeWidth={2} />Save changes</>
                    : <><Plus size={11} strokeWidth={2} />Create institute</>}
                </button>
                <button onClick={onClose} disabled={saving}
                  className="text-xs px-4 py-2.5 transition-colors"
                  style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas)')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--ef-surface)')}>
                  Cancel
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ── Extend Validity Modal ─────────────────────────────────────────────────────

function ExtendValidityModal({
  institute, onClose, onExtended,
}: {
  institute: Institute;
  onClose: () => void;
  onExtended: (updated: Institute) => void;
}) {
  const [validityType, setValidityType] = useState<'monthly' | 'yearly' | 'custom'>(
    institute.validityType ?? 'monthly'
  );
  const [activeUntil, setActiveUntil] = useState(institute.activeUntil ?? '');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');

  const handleExtend = async () => {
    if (validityType === 'custom' && !activeUntil) {
      return setError('Please select a date.');
    }
    setSaving(true); setError('');
    try {
      const computedActiveUntil = computeActiveUntil(validityType, activeUntil);
      await updateInstitute(institute.id, {
        validityType,
        activeUntil: computedActiveUntil,
        updatedAt: new Date().toISOString(),
      });
      const updated = await getInstitute(institute.id);
      if (updated) onExtended(updated);
    } catch (e: any) {
      setError(e.message || 'Failed to extend validity.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-60 flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.28)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-sm"
        style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid var(--ef-border)' }}>
          <div>
            <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>EXTEND VALIDITY</p>
            <p className="text-sm mt-0.5" style={{ color: 'var(--ef-ink)' }}>{institute.name}</p>
          </div>
          <button onClick={onClose} className="p-1 hover:opacity-60 transition-opacity" style={{ color: 'var(--ef-text-muted)' }}>
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        <div className="px-5 py-5">
          <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)' }}>
            Current expiry: <span style={{ color: 'var(--ef-ink)' }}>{formatDate(institute.activeUntil)}</span>
          </p>
          <ValidityFields
            validityType={validityType} setValidityType={setValidityType}
            activeUntil={activeUntil} setActiveUntil={setActiveUntil}
          />
          {error && (
            <p className="text-xs mt-2 mb-1" style={{ color: 'var(--ef-danger)' }}>{error}</p>
          )}
        </div>
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderTop: '1px solid var(--ef-border)' }}>
          <button onClick={handleExtend} disabled={saving}
            className="flex items-center gap-1.5 text-xs px-4 py-2.5"
            style={{
              background: saving ? 'var(--ef-track)' : 'var(--ef-ink)', color: 'var(--ef-surface)',
              borderRadius: 2, cursor: saving ? 'not-allowed' : 'pointer',
            }}>
            {saving ? <><Loader2 size={11} className="animate-spin" />Saving…</> : <><CalendarDays size={11} />Apply</>}
          </button>
          <button onClick={onClose} disabled={saving}
            className="text-xs px-4 py-2.5"
            style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Skeleton row ──────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <tr style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
      {[36, 28, 16, 20, 0].map((w, i) => (
        <td key={i} className="px-5 py-4">
          {w > 0 && <div className="h-3 rounded mb-1.5" style={{ width: `${w * 4}px`, background: '#EEECEA', animation: 'pulse 1.5s ease-in-out infinite' }} />}
          {i < 2 && <div className="h-2.5 w-24 rounded" style={{ background: '#F3F2EF', animation: 'pulse 1.5s ease-in-out infinite' }} />}
        </td>
      ))}
    </tr>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function UserManagementPage() {
  const { verifyPassword, user } = useAuth();
  const navigate = useNavigate();

  const [institutes, setInstitutes] = useState<Institute[]>([]);
  const [loading, setLoading]       = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [syncDisplay, setSyncDisplay] = useState('');

  // Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing]       = useState<Institute | null>(null);

  // Delete (per-row) — requires Web Owner password
  const [deletingId, setDeletingId]           = useState<string | null>(null);
  const [deletePassword, setDeletePassword]   = useState('');
  const [deletePassVisible, setDeletePassVisible] = useState(false);
  const [deletePassError, setDeletePassError] = useState('');
  const [deleteLoading, setDeleteLoading]     = useState(false);
  const deleteInputRef                        = useRef<HTMLInputElement>(null);

  // Status toggle per-row
  const [statusLoadingId, setStatusLoadingId] = useState<string | null>(null);

  // Resend credentials per-row
  const [resendingId, setResendingId] = useState<string | null>(null);

  // Extend validity modal
  const [extendingInstitute, setExtendingInstitute] = useState<Institute | null>(null);

  // Email notice toast
  const [emailNotice, setEmailNotice] = useState<{
    ok: boolean; to: string; error?: string; message?: string;
  } | null>(null);

  // ── Fetch ──────────────────────────────────────────────────────────

  const fetchInstitutes = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await getAllInstitutes();
      setInstitutes(data);
      setLastSynced(new Date());
      setFetchError('');
    } catch (e: any) {
      console.error('Failed to fetch institutes:', e);
      if (!silent) setFetchError(e.message || 'Failed to load institutes.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInstitutes();
    const poll = setInterval(() => fetchInstitutes(true), 5000);
    return () => clearInterval(poll);
  }, [fetchInstitutes]);

  useEffect(() => {
    if (!lastSynced) return;
    setSyncDisplay(formatSyncAge(lastSynced));
    const tick = setInterval(() => setSyncDisplay(formatSyncAge(lastSynced)), 1000);
    return () => clearInterval(tick);
  }, [lastSynced]);

  // Focus delete password input when delete panel opens
  useEffect(() => {
    if (deletingId) {
      setDeletePassword(''); setDeletePassError(''); setDeletePassVisible(false);
      setTimeout(() => deleteInputRef.current?.focus(), 60);
    }
  }, [deletingId]);

  // ── Handlers ───────────────────────────────────────────────────────

  const openCreate = () => { setEditing(null); setDrawerOpen(true); };
  const openEdit   = (i: Institute) => { setEditing(i); setDrawerOpen(true); };

  const handleSaved = (institute: Institute, emailSent?: boolean) => {
    setInstitutes((prev) => {
      const exists = prev.find((i) => i.id === institute.id);
      if (exists) return prev.map((i) => (i.id === institute.id ? institute : i));
      return [institute, ...prev];
    });
    setDrawerOpen(false);
    setEditing(null);
    setLastSynced(new Date());
    if (emailSent !== undefined) {
      setEmailNotice({
        ok: emailSent,
        to: institute.adminEmail,
        message: emailSent ? `Welcome email sent to ${institute.adminEmail}` : 'Email not sent (not implemented)',
      });
      setTimeout(() => setEmailNotice(null), 6000);
    }
  };

  const handleToggleStatus = async (id: string) => {
    setStatusLoadingId(id);
    try {
      const current = await getInstitute(id);
      if (!current) throw new Error('Institute not found');
      
      const newStatus = current.status === 'active' ? 'disabled' : 'active';
      await updateInstitute(id, {
        status: newStatus,
        updatedAt: new Date().toISOString(),
      });
      
      const updated = await getInstitute(id);
      if (updated) {
        setInstitutes((prev) => prev.map((i) => (i.id === id ? updated : i)));
        setLastSynced(new Date());
      }
    } catch (e: any) {
      console.error('Toggle status failed:', e);
    } finally {
      setStatusLoadingId(null);
    }
  };

  const handleResendCredentials = async (id: string) => {
    setResendingId(id);
    const inst = institutes.find((i) => i.id === id);
    const email = (inst?.adminEmail ?? '').toLowerCase().trim();
    try {
      if (!email) throw new Error('Institute has no admin email on file.');
      await sendPasswordResetEmail(auth, email);
      setEmailNotice({
        ok: true,
        to: email,
        message: `Password-setup link sent to ${email}.`,
      });
      setTimeout(() => setEmailNotice(null), 6000);
    } catch (e: any) {
      setEmailNotice({ ok: false, to: email, error: e?.message ?? 'Failed to send email.' });
      setTimeout(() => setEmailNotice(null), 8000);
    } finally {
      setResendingId(null);
    }
  };

  const handleDeleteAttempt = async () => {
    if (!deletePassword) { setDeletePassError('Enter your password to confirm.'); return; }
    const isValid = await verifyPassword(deletePassword);
    if (!isValid) {
      setDeletePassError('Incorrect password.');
      setDeletePassword('');
      deleteInputRef.current?.focus();
      return;
    }
    handleDeleteConfirm();
  };

  const handleDeleteConfirm = async () => {
    if (!deletingId) return;
    setDeleteLoading(true);
    try {
      const deleteAuthUser = httpsCallable<
        { role: string; uid: string; deleteAttemptsOnWebOwnerAssessments?: string[] },
        { ok: boolean }
      >(
        functions,
        'deleteAuthUser'
      );
      // Soft delete. deleteAttemptsOnWebOwnerAssessments is deliberately NOT
      // sent: this path destroys nothing, so there is no attempt data to
      // decide about yet. That choice is made at permanent-delete time.
      await deleteAuthUser({ role: 'institute', uid: deletingId });
      setInstitutes((prev) => prev.filter((i) => i.id !== deletingId));
      setDeletingId(null);
      setLastSynced(new Date());
    } catch (e: any) {
      console.error('Delete failed:', e);
      setDeletePassError(e.message || 'Deletion failed.');
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleExtended = (updated: Institute) => {
    setInstitutes((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    setExtendingInstitute(null);
    setLastSynced(new Date());
  };

  // ── Stats ──────────────────────────────────────────────────────────

  const totalCount    = institutes.length;
  const activeCount   = institutes.filter((i) => i.status === 'active').length;
  const disabledCount = institutes.filter((i) => i.status === 'disabled').length;

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="px-4 py-6 md:px-8 md:py-10"
        style={{ maxWidth: 1120, margin: '0 auto' }}
      >
        {/* ── Page header ── */}
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between mb-6"
          style={{ borderBottom: '1px solid var(--ef-border)', paddingBottom: 20 }}>
          <div>
            <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>WEB OWNER</p>
            <h1 className="text-base" style={{ color: 'var(--ef-ink)' }}>User Management</h1>
            <p className="text-xs mt-1" style={{ color: 'var(--ef-text-muted)' }}>
              Institute Control — create, control, disable, and remove.
            </p>
          </div>

          <div className="flex items-center gap-4 flex-wrap md:mt-1">
            {/* Live indicator */}
            <div className="flex items-center gap-1.5 select-none">
              <div className="relative w-2 h-2 flex items-center justify-center">
                <span className="absolute inline-flex w-2 h-2 rounded-full opacity-60"
                  style={{ background: 'var(--ef-success)', animation: 'ping 1.8s cubic-bezier(0,0,0.2,1) infinite' }} />
                <span className="relative inline-flex w-1.5 h-1.5 rounded-full" style={{ background: 'var(--ef-success)' }} />
              </div>
              <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                Live{syncDisplay && <span style={{ color: 'var(--ef-text-muted)' }}> · {syncDisplay}</span>}
              </span>
            </div>

            {/* New institute */}
            <button onClick={openCreate}
              className="flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity"
              style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, letterSpacing: '0.03em' }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.opacity = '0.85')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.opacity = '1')}>
              <Plus size={12} strokeWidth={2} />New Institute
            </button>
          </div>
        </div>

        {/* ── Stats ── */}
        <AnimatePresence>
          {!loading && totalCount > 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="flex items-center gap-4 flex-wrap mb-5">
              <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                {totalCount} {totalCount === 1 ? 'institute' : 'institutes'}
              </span>
              <span style={{ color: 'var(--ef-border)' }}>·</span>
              <span className="text-xs" style={{ color: 'var(--ef-success)' }}>{activeCount} active</span>
              {disabledCount > 0 && (
                <>
                  <span style={{ color: 'var(--ef-border)' }}>·</span>
                  <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{disabledCount} disabled</span>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Email notice ── */}
        <AnimatePresence>
          {emailNotice && (
            <motion.div
              initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-start gap-2.5 px-4 py-3 mb-4"
              style={{
                background: emailNotice.ok ? 'var(--ef-success-bg-alt)' : 'var(--ef-danger-bg)',
                border: `1px solid ${emailNotice.ok ? 'var(--ef-success-border-alt)' : 'var(--ef-danger-border)'}`,
                borderRadius: 2,
              }}>
              {emailNotice.ok
                ? <Mail size={13} strokeWidth={1.5} style={{ color: 'var(--ef-success)', marginTop: 1, flexShrink: 0 }} />
                : <MailX size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', marginTop: 1, flexShrink: 0 }} />}
              <div>
                <p className="text-xs" style={{ color: emailNotice.ok ? 'var(--ef-success)' : 'var(--ef-danger)' }}>
                  {emailNotice.message ?? (emailNotice.ok ? `Email sent to ${emailNotice.to}` : `Email failed for ${emailNotice.to}`)}
                </p>
                {!emailNotice.ok && emailNotice.error && (
                  <p className="text-xs mt-0.5" style={{ color: '#B06060' }}>{emailNotice.error}</p>
                )}
              </div>
              <button onClick={() => setEmailNotice(null)} className="ml-auto" style={{ color: 'var(--ef-text-muted)' }}>
                <X size={12} strokeWidth={1.5} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Fetch error ── */}
        <AnimatePresence>
          {fetchError && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="flex items-center gap-2 px-4 py-3 mb-6"
              style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
              <AlertTriangle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />
              <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{fetchError}</p>
              <button onClick={() => fetchInstitutes()} className="ml-auto text-xs"
                style={{ color: 'var(--ef-danger)', textDecoration: 'underline' }}>Retry</button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Deletion requests raised by institutes (Feature #15 Phase 4b) ──
             Placed ABOVE the institutes table on purpose: these are decisions
             waiting on the Web Owner, and a queue below a long table is a
             queue nobody reads. The inbox renders nothing when empty, so it
             costs no space in the normal case. */}
        <div className="mb-5">
          <DeletionApprovalsInbox viewerRole="webOwner" />
        </div>

        {/* Feature #15 Phase 7b — access & erasure requests. Sits beside the
            deletion inbox because both are "things awaiting a decision", and
            an admin should have one place to look. */}
        <div className="mb-5">
          <SubjectRequestsInbox canErase />
        </div>

        {/* Feature #15 Phase 7c — the two values that arm erasure. Until both
            are set the server refuses every erasure, which is deliberate:
            they are legal answers, not engineering ones. */}
        {user?.uid && (
          <div className="mb-5 px-3 py-3"
            style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}>
            <p className="text-xs mb-2" style={{ color: 'var(--ef-ink)', letterSpacing: '0.06em' }}>
              ERASURE POLICY
            </p>
            <ErasurePolicyPanel webOwnerUid={user.uid} />
          </div>
        )}

        {/* ── Deleted institutes ────────────────────────────────────
            This panel used to list EVERY deleted record on the platform —
            institutes, faculty and students from every tenant together, in an
            unlabelled list sitting above the institutes table. Deleted people
            now live inside the institute they belonged to (User Management →
            institute → Users → Trash), which is where someone asking "who did
            we remove from this institute" actually looks.

            WHAT IS LEFT HERE, AND WHY IT IS NOT ALSO MOVED: a deleted
            INSTITUTE has no institute to sit inside. This is the only surface
            that can restore one or purge one — including choosing which
            webOwner-assessment attempts go with it (InstitutePurgePanel).
            Removing it outright would have quietly deleted the ability to
            restore a tenant, which is a policy change wearing a navigation
            change's clothes. Same component, same callables, narrower scope. */}
        <div className="mb-5 px-3 py-3"
          style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}>
          <p className="text-xs mb-1" style={{ color: 'var(--ef-ink)', letterSpacing: '0.06em' }}>
            DELETED INSTITUTES
          </p>
          <p className="text-xs mb-2.5" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
            Deleted faculty and students are managed inside their own institute,
            under Users → Trash.
          </p>
          <TrashPanel canPurge roles={['institute']} />
        </div>

        {/* ── Table ── */}
        <div style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3, overflow: 'hidden' }}>
          <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--ef-border)', background: 'var(--ef-canvas-raised)' }}>
                {['INSTITUTE', 'ADMINISTRATOR', 'STATUS', 'VALID UNTIL', ''].map((col, i) => (
                  <th key={i} className="text-left px-5 py-3 text-xs"
                    style={{
                      color: 'var(--ef-text-muted)', letterSpacing: '0.08em', fontWeight: 400,
                      width: i === 0 ? '26%' : i === 1 ? '28%' : i === 2 ? '12%' : i === 3 ? '16%' : '18%',
                    }}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {loading && <><SkeletonRow /><SkeletonRow /><SkeletonRow /></>}

              {!loading && institutes.length === 0 && !fetchError && (
                <tr>
                  <td colSpan={5}>
                    <div className="flex flex-col items-center py-16">
                      <Building2 size={30} strokeWidth={1} style={{ color: 'var(--ef-border-muted)' }} />
                      <p className="text-xs mt-4" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>
                        No institutes registered
                      </p>
                      <p className="text-xs mt-1" style={{ color: 'var(--ef-border-muted)' }}>Create one to begin.</p>
                      <button onClick={openCreate}
                        className="flex items-center gap-1.5 text-xs px-4 py-2 mt-6"
                        style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2, background: 'var(--ef-surface)' }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-ink)')}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-border)')}>
                        <Plus size={11} strokeWidth={2} />New Institute
                      </button>
                    </div>
                  </td>
                </tr>
              )}

              {!loading && institutes.map((institute) => {
                const isConfirmingDelete = deletingId === institute.id;
                const isStatusToggling  = statusLoadingId === institute.id;
                const isResending       = resendingId === institute.id;

                return (
                  <motion.tr key={institute.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    style={{
                      borderBottom: '1px solid var(--ef-border-subtle)',
                      background: isConfirmingDelete ? 'var(--ef-danger-bg)' : 'transparent',
                      transition: 'background 0.18s',
                    }}>

                    {/* Institute name + code */}
                    <td className="px-5 py-3.5">
                      <button
                        onClick={() => navigate(`/dashboard/user-management/${institute.id}`)}
                        className="group flex items-start gap-1 text-left"
                      >
                        <div>
                          <p className="text-sm group-hover:underline"
                            style={{ color: 'var(--ef-ink)', lineHeight: 1.4, textUnderlineOffset: 3 }}>
                            {institute.name}
                          </p>
                          <p className="text-xs mt-0.5"
                            style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.12em', fontFamily: 'monospace' }}>
                            {institute.code}
                          </p>
                        </div>
                        <ChevronRight size={12} strokeWidth={1.5}
                          className="opacity-0 group-hover:opacity-100 transition-opacity mt-0.5 flex-shrink-0"
                          style={{ color: 'var(--ef-text-muted)' }} />
                      </button>
                    </td>

                    {/* Administrator */}
                    <td className="px-5 py-3.5">
                      <p className="text-xs" style={{ color: '#2C2C2A' }}>{institute.adminName}</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>{institute.adminEmail}</p>
                    </td>

                    {/* Status badge */}
                    <td className="px-5 py-3.5">
                      <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5"
                        style={institute.status === 'active'
                          ? { background: 'var(--ef-success-bg-alt)', color: 'var(--ef-success)', border: '1px solid var(--ef-success-border-alt)', borderRadius: 2 }
                          : { background: '#F5F5F3', color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                        <span style={{
                          width: 5, height: 5, borderRadius: '50%', flexShrink: 0, display: 'inline-block',
                          background: institute.status === 'active' ? 'var(--ef-success)' : 'var(--ef-text-muted)',
                        }} />
                        {institute.status === 'active' ? 'Active' : 'Disabled'}
                      </span>
                    </td>

                    {/* Valid until */}
                    <td className="px-5 py-3.5">
                      <p className="text-xs" style={{ color: validityColor(institute), fontVariantNumeric: 'tabular-nums' }}>
                        {validityLabel(institute)}
                      </p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.04em' }}>
                        {institute.validityType?.toUpperCase()}
                      </p>
                    </td>

                    {/* Actions */}
                    <td className="px-5 py-3.5">
                      {isConfirmingDelete ? (
                        /* ── Delete with password confirmation ── */
                        <div className="flex flex-col gap-2" style={{ minWidth: 280 }}>
                          {/* Feature #15 Phase 1 — institute deletion has the
                              widest blast radius on the platform, so the counts
                              sit ABOVE the password field: they should inform
                              whether to type it at all, not appear after the
                              decision is already made. */}
                          <DeletionImpactPanel entityType="institute" entityId={institute.id} />
                          {/* Feature #15 — this dialog SOFT-deletes. Nothing
                              below cascades: faculty, students, assessments and
                              attempts all stay put, and the institute is
                              restorable from the trash for 180 days. The
                              per-assessment keep/delete choice lives on the
                              PERMANENT delete confirmation instead, because
                              that is the only place it takes effect. */}
                          <div className="flex items-start gap-2 mt-2 px-2.5 py-2"
                            style={{ background: '#F2F6F2', border: '1px solid #D3E0D3', borderRadius: 2 }}>
                            <RotateCcw size={12} strokeWidth={1.5} style={{ marginTop: 1, flexShrink: 0, color: '#3F6B3F' }} />
                            <span className="text-xs" style={{ color: '#3F6B3F' }}>
                              Recoverable for 180 days. Access is blocked immediately;
                              nothing is destroyed until you permanently delete it from
                              the trash below.
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <ShieldAlert size={11} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', flexShrink: 0 }} />
                            <span className="text-xs" style={{ color: 'var(--ef-danger)', letterSpacing: '0.04em' }}>
                              Enter your password to delete
                            </span>
                          </div>
                          <div className="relative">
                            <input
                              ref={deleteInputRef}
                              type={deletePassVisible ? 'text' : 'password'}
                              value={deletePassword}
                              onChange={(e) => { setDeletePassword(e.target.value); setDeletePassError(''); }}
                              onKeyDown={(e) => { if (e.key === 'Enter') handleDeleteAttempt(); if (e.key === 'Escape') setDeletingId(null); }}
                              placeholder="Web Owner password"
                              className="w-full text-xs pr-7"
                              style={{ ...inputBase, padding: '7px 28px 7px 10px', fontSize: 12 }}
                            />
                            <button
                              type="button"
                              onClick={() => setDeletePassVisible((v) => !v)}
                              className="absolute right-2 top-1/2 -translate-y-1/2"
                              style={{ color: 'var(--ef-text-muted)' }}>
                              {deletePassVisible ? <EyeOff size={12} strokeWidth={1.5} /> : <Eye size={12} strokeWidth={1.5} />}
                            </button>
                          </div>
                          {deletePassError && (
                            <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{deletePassError}</p>
                          )}
                          <div className="flex items-center gap-2">
                            <button onClick={handleDeleteAttempt} disabled={deleteLoading}
                              className="flex items-center gap-1 text-xs px-2.5 py-1.5"
                              style={{ background: 'var(--ef-danger)', color: 'var(--ef-surface)', borderRadius: 2, cursor: deleteLoading ? 'not-allowed' : 'pointer' }}>
                              {deleteLoading ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} strokeWidth={1.5} />}
                              {deleteLoading ? 'Deleting…' : 'Delete'}
                            </button>
                            <button onClick={() => { setDeletingId(null); setDeletePassError(''); }} disabled={deleteLoading}
                              className="text-xs px-2.5 py-1.5"
                              style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        /* ── Normal action icons ── */
                        <div className="flex items-center justify-end gap-0.5">

                          {/* Edit */}
                          <ActionButton title="Edit institute" onClick={() => openEdit(institute)}>
                            <Pencil size={13} strokeWidth={1.5} />
                          </ActionButton>

                          {/* Enable / Disable */}
                          <ActionButton
                            title={institute.status === 'active' ? 'Disable institute' : 'Enable institute'}
                            onClick={() => handleToggleStatus(institute.id)}
                            disabled={isStatusToggling}>
                            {isStatusToggling
                              ? <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />
                              : institute.status === 'active'
                              ? <PauseCircle size={13} strokeWidth={1.5} />
                              : <PlayCircle size={13} strokeWidth={1.5} />}
                          </ActionButton>

                          {/* Extend validity */}
                          <ActionButton title="Extend validity" onClick={() => setExtendingInstitute(institute)}>
                            <CalendarDays size={13} strokeWidth={1.5} />
                          </ActionButton>

                          {/* Resend credentials */}
                          <ActionButton
                            title="Resend login credentials"
                            onClick={() => handleResendCredentials(institute.id)}
                            disabled={isResending}>
                            {isResending
                              ? <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />
                              : <RefreshCw size={13} strokeWidth={1.5} />}
                          </ActionButton>

                          {/* Delete */}
                          <ActionButton title="Delete institute" onClick={() => setDeletingId(institute.id)} danger>
                            <Trash2 size={13} strokeWidth={1.5} />
                          </ActionButton>

                        </div>
                      )}
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>

        {!loading && institutes.length > 0 && (
          <p className="text-xs mt-4" style={{ color: 'var(--ef-text-muted)' }}>
            Data refreshes automatically every 5 seconds.
          </p>
        )}
      </motion.div>

      {/* ── Drawer ── */}
      <InstituteDrawer
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setEditing(null); }}
        onSaved={handleSaved}
        editing={editing}
      />

      {/* ── Extend validity modal ── */}
      <AnimatePresence>
        {extendingInstitute && (
          <ExtendValidityModal
            institute={extendingInstitute}
            onClose={() => setExtendingInstitute(null)}
            onExtended={handleExtended}
          />
        )}
      </AnimatePresence>
    </>
  );
}

// ── Reusable action button ─────────────────────────────────────────────────────

function ActionButton({
  children, title, onClick, disabled = false, danger = false,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="p-2 rounded transition-all"
      style={{ color: 'var(--ef-text-muted)', cursor: disabled ? 'not-allowed' : 'pointer' }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLElement).style.color = danger ? 'var(--ef-danger)' : 'var(--ef-ink)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)';
      }}
    >
      {children}
    </button>
  );
}