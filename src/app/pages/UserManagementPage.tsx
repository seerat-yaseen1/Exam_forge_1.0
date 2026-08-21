/**
 * Every institute on the platform, and the six things you can do to one.
 *
 * ── WHAT CHANGED, AND WHY ─────────────────────────────────────────
 * The old page was a 720px-minimum table with five 13px icon buttons at the
 * end of each row, four unrelated administrative panels stacked above it, and
 * a delete confirmation that unfolded INSIDE a table cell — an impact report,
 * a warning, a password field and two buttons, crammed into a column. On a
 * phone the whole thing scrolled sideways.
 *
 * Three decisions fixed most of it:
 *
 *   • The table is a DataTable, so on a phone each institute becomes a
 *     labelled card instead of a row you have to drag into view.
 *   • Deleting is a dialog, not a cell. It is the most destructive action on
 *     the platform and it now gets the whole screen's attention, with the
 *     blast radius above the password field rather than after it.
 *   • The two panels that are decisions (deletion requests, data requests)
 *     stay at the top where they interrupt. The two that are settings
 *     (erasure policy, deleted institutes) move into a closed disclosure at
 *     the bottom. Both used to be permanently expanded above the table, which
 *     is how a page teaches people to scroll past its own warnings.
 *
 * ── AND A SEARCH BOX ──────────────────────────────────────────────
 * There was none. A platform with forty institutes was forty rows to read
 * with your eyes, and the page's own detail links were the only way to
 * narrow anything.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import {
  Building2, Plus, Pencil, Trash2, PauseCircle, PlayCircle, Loader2, X, Mail, MailX,
  RefreshCw, CalendarDays, ShieldAlert, ChevronRight, RotateCcw, Settings2, Send,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  getAllInstitutes,
  getInstitute,
  updateInstitute,
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
import { SubjectRequestsInbox } from '../components/SubjectRequestsInbox';
import { ErasurePolicyPanel } from '../components/ErasurePolicyPanel';
import { daysUntilExpiry } from '../../lib/instituteValidity';
import { HEALTH_LABEL, HEALTH_TONE, expiryPhrase, healthOf } from '../../lib/fleetOverview';
import { formatClock, formatDate } from '../../lib/dateFormat';
import {
  Button, Chip, Disclosure, EmptyState, ErrorBanner, PageHeader, PageShell, SectionHeading,
} from '../components/console/ui';
import {
  Avatar, DataTable, RowMenu, SearchField, Segmented, Sheet, TableSkeleton, Toolbar,
  type Column,
} from '../components/console/data';
import { Field, PasswordField } from '../components/console/fields';

type ValidityType = 'monthly' | 'yearly' | 'custom';
type Filter = 'all' | 'active' | 'attention' | 'disabled';

const FILTER_LABEL: Record<Filter, string> = {
  all: 'All',
  active: 'Active',
  attention: 'Needs attention',
  disabled: 'Disabled',
};

/**
 * Does this institute match what has been typed?
 *
 * Name, admin name, admin email and code, because those are the four things
 * someone actually has in hand when they come looking: "the one Sarah runs",
 * "the one with code A3B7C2", "whoever mailed from @nitk.edu".
 */
function matches(institute: Institute, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [institute.name, institute.adminName, institute.adminEmail, institute.code]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(q));
}

// ══════════════════════════════════════════════════════════════════
// VALIDITY PICKER
// ══════════════════════════════════════════════════════════════════

const VALIDITY_HINT: Record<ValidityType, string> = {
  monthly: 'Access expires one month from today.',
  yearly: 'Access expires one year from today.',
  custom: 'Access expires on the date you choose.',
};

function ValidityFields({
  validityType,
  setValidityType,
  activeUntil,
  setActiveUntil,
}: {
  validityType: ValidityType;
  setValidityType: (v: ValidityType) => void;
  activeUntil: string;
  setActiveUntil: (v: string) => void;
}) {
  return (
    <div>
      <p className="ef-t-xs mb-2" style={{ color: 'var(--ef-text-subtle)' }}>
        Institute validity
      </p>
      <Segmented<ValidityType>
        label="Institute validity"
        value={validityType}
        onChange={setValidityType}
        options={[
          { value: 'monthly', label: 'Monthly' },
          { value: 'yearly', label: 'Yearly' },
          { value: 'custom', label: 'Custom' },
        ]}
      />
      <p className="ef-t-xs ef-muted" style={{ marginTop: 8 }}>
        {VALIDITY_HINT[validityType]}
      </p>
      {validityType === 'custom' && (
        <div style={{ marginTop: 12 }}>
          <Field
            label="Expires on"
            type="date"
            value={activeUntil}
            min={new Date().toISOString().split('T')[0]}
            onChange={(e) => setActiveUntil(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// CREATE / EDIT
// ══════════════════════════════════════════════════════════════════

function InstituteSheet({
  open,
  onClose,
  onSaved,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (institute: Institute, emailSent?: boolean) => void;
  editing: Institute | null;
}) {
  const isEdit = !!editing;

  const [name, setName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [validityType, setValidityType] = useState<ValidityType>('monthly');
  const [activeUntil, setActiveUntil] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setAdminName(editing.adminName);
      setAdminEmail(editing.adminEmail);
      setValidityType((editing.validityType as ValidityType) ?? 'monthly');
      setActiveUntil(editing.activeUntil ?? '');
    } else {
      setName('');
      setAdminName('');
      setAdminEmail('');
      setValidityType('monthly');
      setActiveUntil('');
    }
    setFormError('');
    setSaving(false);
  }, [open, editing]);

  const handleSubmit = async () => {
    if (!name.trim()) return setFormError('Institute name is required.');
    if (!adminName.trim()) return setFormError('Admin name is required.');
    if (!adminEmail.trim()) return setFormError('Admin email is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail))
      return setFormError('Enter a valid email address.');
    if (validityType === 'custom' && !activeUntil)
      return setFormError('Choose the date access should expire.');

    setSaving(true);
    setFormError('');
    try {
      const now = new Date().toISOString();
      const computedActiveUntil = computeActiveUntil(validityType, activeUntil);

      if (isEdit) {
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
        // Create via Cloud Function (Firebase Auth user + profile doc), then
        // trigger Firebase's own password-reset email so the admin sets their
        // own password — we never email a plaintext temporary password.
        const code = generateInstituteCode();
        const tempPassword = generatePassword(); // random; user resets via email
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
            firstLoginRequired: false, // admin sets pwd via reset link
          },
        });

        const uid = result.data.uid;

        let emailSent = false;
        try {
          await sendPasswordResetEmail(auth, normalizedEmail);
          emailSent = true;
        } catch (e) {
          console.warn('[InstituteSheet] reset email failed:', e);
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
    <Sheet
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit institute' : 'New institute'}
      description={
        isEdit
          ? 'Changes take effect immediately for everyone at this institute.'
          : 'The admin gets an email to set their own password. No password is ever sent in plain text.'
      }
      footer={
        <>
          <AnimatePresence>
            {formError && (
              <motion.p
                role="alert"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="ef-t-sm"
                style={{ color: 'var(--ef-danger)', marginBottom: 10 }}
              >
                {formError}
              </motion.p>
            )}
          </AnimatePresence>
          <div className="flex items-center gap-2.5">
            <Button variant="primary" size="lg" onClick={handleSubmit} loading={saving}>
              {!saving && (isEdit ? <Pencil size={13} strokeWidth={1.8} /> : <Plus size={13} strokeWidth={2} />)}
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create institute'}
            </Button>
            <Button size="lg" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col" style={{ gap: 18 }}>
        <Field
          label="Institute name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setFormError('');
          }}
          placeholder="e.g. Massachusetts Institute of Technology"
          hint="The full name, as it should appear to its own staff and students."
        />

        {isEdit ? (
          <Field
            label="Institute code"
            value={editing!.code}
            readOnly
            hint="Generated once, at creation. Staff and students type it to sign in, so it can never change."
            style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: '0.16em' }}
          />
        ) : (
          <p
            className="ef-t-xs ef-muted"
            style={{
              padding: '10px 12px',
              background: 'var(--ef-canvas-raised)',
              border: '1px solid var(--ef-border)',
              borderRadius: 'var(--ef-radius-sm)',
              lineHeight: 'var(--ef-leading-relaxed)',
            }}
          >
            A six-character institute code is generated on creation. Everyone here types it to
            sign in, so it is fixed from that moment on.
          </p>
        )}

        <hr className="ef-rule" />

        <Field
          label="Admin name"
          value={adminName}
          onChange={(e) => {
            setAdminName(e.target.value);
            setFormError('');
          }}
          placeholder="e.g. Dr. Sarah Chen"
          hint="The person who will run this institute's console."
        />

        <Field
          label="Admin email"
          type="email"
          value={adminEmail}
          onChange={(e) => {
            setAdminEmail(e.target.value);
            setFormError('');
          }}
          placeholder="e.g. admin@institute.edu"
          hint={isEdit ? 'Changing this does not move the account — it updates the address on file.' : 'The password-setup link goes here.'}
        />

        <hr className="ef-rule" />

        <ValidityFields
          validityType={validityType}
          setValidityType={setValidityType}
          activeUntil={activeUntil}
          setActiveUntil={setActiveUntil}
        />
      </div>
    </Sheet>
  );
}

// ══════════════════════════════════════════════════════════════════
// EXTEND VALIDITY
// ══════════════════════════════════════════════════════════════════

function ExtendValiditySheet({
  institute,
  onClose,
  onExtended,
}: {
  institute: Institute | null;
  onClose: () => void;
  onExtended: (updated: Institute) => void;
}) {
  const [validityType, setValidityType] = useState<ValidityType>('monthly');
  const [activeUntil, setActiveUntil] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!institute) return;
    setValidityType((institute.validityType as ValidityType) ?? 'monthly');
    setActiveUntil(institute.activeUntil ?? '');
    setError('');
    setSaving(false);
  }, [institute]);

  const handleExtend = async () => {
    if (!institute) return;
    if (validityType === 'custom' && !activeUntil) return setError('Choose a date.');
    setSaving(true);
    setError('');
    try {
      await updateInstitute(institute.id, {
        validityType,
        activeUntil: computeActiveUntil(validityType, activeUntil),
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

  const days = institute ? daysUntilExpiry(institute.activeUntil) : null;

  return (
    <Sheet
      open={!!institute}
      onClose={onClose}
      variant="centre"
      title="Extend access"
      description={institute?.name}
      footer={
        <div className="flex items-center gap-2.5">
          <Button variant="primary" size="lg" onClick={handleExtend} loading={saving}>
            {!saving && <CalendarDays size={13} strokeWidth={1.8} />}
            {saving ? 'Saving…' : 'Apply'}
          </Button>
          <Button size="lg" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="flex flex-col" style={{ gap: 16 }}>
        <div
          className="flex items-center gap-2.5"
          style={{
            padding: '10px 12px',
            background: 'var(--ef-canvas-raised)',
            border: '1px solid var(--ef-border)',
            borderRadius: 'var(--ef-radius-sm)',
          }}
        >
          <CalendarDays size={14} strokeWidth={1.7} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
          <p className="ef-t-sm ef-muted">
            {expiryPhrase(days)}
            {institute?.activeUntil && <span className="ef-ink"> · {formatDate(institute.activeUntil)}</span>}
          </p>
        </div>

        <ValidityFields
          validityType={validityType}
          setValidityType={setValidityType}
          activeUntil={activeUntil}
          setActiveUntil={setActiveUntil}
        />

        {error && (
          <p className="ef-t-sm" role="alert" style={{ color: 'var(--ef-danger)' }}>
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}

// ══════════════════════════════════════════════════════════════════
// DELETE
// ══════════════════════════════════════════════════════════════════

/**
 * The most destructive action on the platform, as a dialog.
 *
 * It used to unfold inside a table cell. The order of things here is the
 * point: what this affects, then that it is recoverable, then the password.
 * A confirmation that asks for the password first and explains the damage
 * afterwards is asking someone to commit before they have read anything.
 */
function DeleteInstituteSheet({
  institute,
  onClose,
  onDeleted,
  verifyPassword,
}: {
  institute: Institute | null;
  onClose: () => void;
  onDeleted: (id: string) => void;
  verifyPassword: (password: string) => Promise<boolean>;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPassword('');
    setError('');
    setBusy(false);
  }, [institute]);

  const submit = async () => {
    if (!institute) return;
    if (!password) return setError('Enter your password to confirm.');
    setBusy(true);
    setError('');
    try {
      if (!(await verifyPassword(password))) {
        setPassword('');
        setError('That password is not right.');
        return;
      }
      const deleteAuthUser = httpsCallable<
        { role: string; uid: string; deleteAttemptsOnWebOwnerAssessments?: string[] },
        { ok: boolean }
      >(functions, 'deleteAuthUser');
      // Soft delete. deleteAttemptsOnWebOwnerAssessments is deliberately NOT
      // sent: this path destroys nothing, so there is no attempt data to
      // decide about yet. That choice is made at permanent-delete time.
      await deleteAuthUser({ role: 'institute', uid: institute.id });
      onDeleted(institute.id);
    } catch (e: any) {
      setError(e.message || 'Deletion failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={!!institute}
      onClose={onClose}
      variant="centre"
      title="Delete this institute?"
      description={institute?.name}
      footer={
        <div className="flex items-center gap-2.5">
          <Button variant="danger" size="lg" onClick={submit} loading={busy}>
            {!busy && <Trash2 size={13} strokeWidth={1.8} />}
            {busy ? 'Deleting…' : 'Delete institute'}
          </Button>
          <Button size="lg" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      }
    >
      {institute && (
        <div className="flex flex-col" style={{ gap: 16 }}>
          {/* Feature #15 Phase 1 — institute deletion has the widest blast
              radius on the platform, so the counts sit ABOVE the password
              field: they should inform whether to type it at all, not appear
              after the decision is already made. */}
          <DeletionImpactPanel entityType="institute" entityId={institute.id} />

          {/* Feature #15 — this dialog SOFT-deletes. Nothing below cascades:
              faculty, students, assessments and attempts all stay put, and the
              institute is restorable for 180 days. The per-assessment
              keep/delete choice lives on the PERMANENT delete confirmation
              instead, because that is the only place it takes effect. */}
          <div
            className="flex items-start gap-2.5"
            style={{
              padding: '11px 13px',
              background: 'var(--ef-success-bg)',
              border: '1px solid var(--ef-success-border)',
              borderRadius: 'var(--ef-radius-sm)',
            }}
          >
            <RotateCcw size={14} strokeWidth={1.7} style={{ color: 'var(--ef-success)', flexShrink: 0, marginTop: 1 }} />
            <p className="ef-t-sm" style={{ color: 'var(--ef-success)', lineHeight: 'var(--ef-leading-relaxed)' }}>
              Recoverable for 180 days. Sign-in stops immediately, but nothing is destroyed until
              you permanently delete it from Deleted institutes.
            </p>
          </div>

          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <ShieldAlert size={13} strokeWidth={1.7} style={{ color: 'var(--ef-danger)' }} />
              <span className="ef-t-xs" style={{ color: 'var(--ef-danger)' }}>
                Confirm it is you
              </span>
            </div>
            <PasswordField
              label="Your password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              disabled={busy}
              placeholder="Web Owner password"
            />
          </div>

          {error && (
            <p className="ef-t-sm" role="alert" style={{ color: 'var(--ef-danger)' }}>
              {error}
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}

// ══════════════════════════════════════════════════════════════════
// PAGE
// ══════════════════════════════════════════════════════════════════

export function UserManagementPage() {
  const { verifyPassword, user } = useAuth();
  const navigate = useNavigate();

  const [institutes, setInstitutes] = useState<Institute[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [syncedAt, setSyncedAt] = useState<number | null>(null);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Institute | null>(null);
  const [extending, setExtending] = useState<Institute | null>(null);
  const [deleting, setDeleting] = useState<Institute | null>(null);

  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);

  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((ok: boolean, message: string) => {
    setNotice({ ok, message });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 7000);
  }, []);

  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  // ── Load ───────────────────────────────────────────────────────

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      setInstitutes(await getAllInstitutes());
      setSyncedAt(Date.now());
      setFetchError('');
    } catch (e: any) {
      console.error('Failed to fetch institutes:', e);
      setFetchError(e.message || 'Failed to load institutes.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── Row actions ────────────────────────────────────────────────

  const toggleStatus = async (institute: Institute) => {
    setStatusBusyId(institute.id);
    try {
      const current = await getInstitute(institute.id);
      if (!current) throw new Error('Institute not found');
      const next = current.status === 'active' ? 'disabled' : 'active';
      await updateInstitute(institute.id, { status: next, updatedAt: new Date().toISOString() });
      const updated = await getInstitute(institute.id);
      if (updated) {
        setInstitutes((prev) => prev.map((i) => (i.id === institute.id ? updated : i)));
        setSyncedAt(Date.now());
        say(true, next === 'active' ? `${updated.name} can sign in again.` : `${updated.name} can no longer sign in.`);
      }
    } catch (e: any) {
      say(false, e?.message ?? 'Could not change that institute’s status.');
    } finally {
      setStatusBusyId(null);
    }
  };

  const resendSetupLink = async (institute: Institute) => {
    setResendingId(institute.id);
    const email = (institute.adminEmail ?? '').toLowerCase().trim();
    try {
      if (!email) throw new Error('This institute has no admin email on file.');
      await sendPasswordResetEmail(auth, email);
      say(true, `Password-setup link sent to ${email}.`);
    } catch (e: any) {
      say(false, e?.message ?? `Could not email ${email || 'the admin'}.`);
    } finally {
      setResendingId(null);
    }
  };

  const onSaved = (institute: Institute, emailSent?: boolean) => {
    setInstitutes((prev) => {
      const exists = prev.some((i) => i.id === institute.id);
      return exists ? prev.map((i) => (i.id === institute.id ? institute : i)) : [institute, ...prev];
    });
    setSheetOpen(false);
    setEditing(null);
    setSyncedAt(Date.now());
    if (emailSent === true) say(true, `${institute.name} created. Setup link sent to ${institute.adminEmail}.`);
    else if (emailSent === false) say(false, `${institute.name} created, but the setup email did not send. Use “Resend setup link”.`);
  };

  // ── What is on screen ──────────────────────────────────────────

  const now = useMemo(() => Date.now(), [institutes]);

  const visible = useMemo(
    () =>
      institutes.filter((i) => {
        if (!matches(i, query)) return false;
        if (filter === 'all') return true;
        const health = healthOf(i, now);
        if (filter === 'disabled') return health === 'disabled';
        if (filter === 'active') return health !== 'disabled' && health !== 'expired';
        return health === 'expired' || health === 'lapsing';
      }),
    [institutes, query, filter, now],
  );

  const filtered = query.trim() !== '' || filter !== 'all';

  const columns: Column<Institute>[] = useMemo(
    () => [
      {
        key: 'institute',
        header: 'Institute',
        primary: true,
        // The name is the link, rather than the whole row: a row that is
        // itself a button cannot legally contain the three buttons at its
        // other end, and a screen reader announcing "button, button, button"
        // inside a button is how that shows up in practice.
        cell: (i) => (
          <button
            type="button"
            className="ef-row-link flex items-center gap-2.5 min-w-0 text-left"
            onClick={() => navigate(`/dashboard/user-management/${i.id}`)}
          >
            <Avatar name={i.name} size={32} muted />
            <span className="min-w-0">
              <span className="ef-t-sm ef-ink block truncate" style={{ fontWeight: 500 }}>
                {i.name}
              </span>
              <span
                className="ef-t-xs ef-muted block"
                style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: '0.12em' }}
              >
                {i.code}
              </span>
            </span>
            <ChevronRight
              size={14}
              strokeWidth={1.7}
              className="ef-row-link__chevron"
              style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }}
            />
          </button>
        ),
      },
      {
        key: 'admin',
        header: 'Administrator',
        cell: (i) => (
          <span className="min-w-0">
            <span className="ef-t-sm ef-ink block truncate">{i.adminName}</span>
            <span className="ef-t-xs ef-muted block truncate">{i.adminEmail}</span>
          </span>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        width: 130,
        cell: (i) => {
          const health = healthOf(i, now);
          return <Chip small tone={HEALTH_TONE[health]}>{HEALTH_LABEL[health]}</Chip>;
        },
      },
      {
        key: 'validity',
        header: 'Access',
        width: 194,
        cell: (i) => {
          const days = daysUntilExpiry(i.activeUntil, now);
          return (
            <span
              className="ef-t-xs ef-nums"
              title={i.activeUntil ? formatDate(i.activeUntil) : undefined}
              style={{ color: days !== null && days < 0 ? 'var(--ef-danger)' : 'var(--ef-text-muted)' }}
            >
              {expiryPhrase(days)}
            </span>
          );
        },
      },
      {
        key: 'actions',
        header: '',
        label: 'Actions',
        align: 'right',
        width: 132,
        cell: (i) => (
          <span className="flex items-center justify-end gap-0.5">
            <button
              type="button"
              className="ef-icon-btn"
              title="Edit institute"
              aria-label={`Edit ${i.name}`}
              onClick={(e) => {
                e.stopPropagation();
                setEditing(i);
                setSheetOpen(true);
              }}
            >
              <Pencil size={15} strokeWidth={1.7} />
            </button>
            <button
              type="button"
              className="ef-icon-btn"
              title={i.status === 'active' ? 'Disable institute' : 'Enable institute'}
              aria-label={`${i.status === 'active' ? 'Disable' : 'Enable'} ${i.name}`}
              disabled={statusBusyId === i.id}
              onClick={(e) => {
                e.stopPropagation();
                toggleStatus(i);
              }}
            >
              {statusBusyId === i.id ? (
                <Loader2 size={15} strokeWidth={1.7} className="animate-spin" />
              ) : i.status === 'active' ? (
                <PauseCircle size={15} strokeWidth={1.7} />
              ) : (
                <PlayCircle size={15} strokeWidth={1.7} />
              )}
            </button>
            <span onClick={(e) => e.stopPropagation()}>
              <RowMenu
                label={`More actions for ${i.name}`}
                actions={[
                  {
                    label: 'Extend access',
                    icon: <CalendarDays size={14} strokeWidth={1.7} />,
                    onSelect: () => setExtending(i),
                  },
                  {
                    label: resendingId === i.id ? 'Sending…' : 'Resend setup link',
                    icon: <Send size={14} strokeWidth={1.7} />,
                    disabled: resendingId === i.id,
                    onSelect: () => resendSetupLink(i),
                  },
                  {
                    label: 'Delete institute',
                    icon: <Trash2 size={14} strokeWidth={1.7} />,
                    tone: 'danger',
                    onSelect: () => setDeleting(i),
                  },
                ]}
              />
            </span>
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [now, statusBusyId, resendingId, navigate],
  );

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Web owner
          </>
        }
        title="Institutes"
        subtitle="Every tenant on the platform. Create one, extend its access, switch it off, or remove it."
        actions={
          <>
            <Button size="sm" onClick={() => load(true)} disabled={loading || refreshing}>
              <RefreshCw size={12} strokeWidth={1.7} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setEditing(null);
                setSheetOpen(true);
              }}
            >
              <Plus size={12} strokeWidth={1.9} />
              New institute
            </Button>
          </>
        }
      >
        {syncedAt && <span className="ef-t-2xs ef-muted">Updated {formatClock(new Date(syncedAt).toISOString())}</span>}
      </PageHeader>

      {/* A result, not a decision: it says what happened and goes away. */}
      <AnimatePresence>
        {notice && (
          <motion.div
            role="status"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="flex items-start gap-2.5 mb-5"
            style={{
              padding: '11px 13px',
              background: notice.ok ? 'var(--ef-success-bg)' : 'var(--ef-danger-bg)',
              border: `1px solid ${notice.ok ? 'var(--ef-success-border)' : 'var(--ef-danger-border)'}`,
              borderRadius: 'var(--ef-radius-sm)',
            }}
          >
            {notice.ok ? (
              <Mail size={14} strokeWidth={1.7} style={{ color: 'var(--ef-success)', flexShrink: 0, marginTop: 1 }} />
            ) : (
              <MailX size={14} strokeWidth={1.7} style={{ color: 'var(--ef-danger)', flexShrink: 0, marginTop: 1 }} />
            )}
            <p className="ef-t-sm flex-1" style={{ color: notice.ok ? 'var(--ef-success)' : 'var(--ef-danger)' }}>
              {notice.message}
            </p>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
              style={{ background: 'none', border: 0, color: 'var(--ef-text-muted)', cursor: 'pointer', lineHeight: 0 }}
            >
              <X size={13} strokeWidth={1.8} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {fetchError && (
        <div className="mb-5">
          <ErrorBanner message={fetchError} onRetry={() => load(true)} />
        </div>
      )}

      {/* Decisions waiting on the Web Owner. `hideWhenEmpty` makes each one
          occupy nothing at all in the normal case — no spinner, no "nothing
          pending" line — which is what earns them the top of the page in the
          abnormal one. */}
      <DeletionApprovalsInbox viewerRole="webOwner" hideWhenEmpty />
      <SubjectRequestsInbox canErase hideWhenEmpty />

      <Toolbar>
        <SearchField
          value={query}
          onChange={setQuery}
          label="Search institutes"
          placeholder="Search by name, code, or admin…"
        />
        <Segmented<Filter>
          label="Filter institutes"
          value={filter}
          onChange={setFilter}
          options={(['all', 'active', 'attention', 'disabled'] as Filter[]).map((f) => ({
            value: f,
            label: FILTER_LABEL[f],
          }))}
        />
      </Toolbar>

      {loading ? (
        <TableSkeleton rows={4} columns={5} />
      ) : (
        <DataTable
          columns={columns}
          rows={visible}
          rowKey={(i) => i.id}
          caption="Institutes on this platform"
          empty={
            filtered ? (
              <EmptyState
                icon={<Building2 size={28} strokeWidth={1.1} />}
                title="Nothing matches"
                body="No institute matches this search and filter. Clear them to see the full list."
                action={
                  <Button
                    onClick={() => {
                      setQuery('');
                      setFilter('all');
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<Building2 size={28} strokeWidth={1.1} />}
                title="No institutes yet"
                body="An institute is a tenant: its own admin, its own faculty, its own students. Create the first one and its admin gets an email to set their password."
                action={
                  <Button
                    variant="primary"
                    onClick={() => {
                      setEditing(null);
                      setSheetOpen(true);
                    }}
                  >
                    <Plus size={13} strokeWidth={1.9} />
                    New institute
                  </Button>
                }
              />
            )
          }
        />
      )}

      {!loading && visible.length > 0 && filtered && (
        <p className="ef-t-xs ef-muted" style={{ marginTop: 12 }}>
          Showing {visible.length} of {institutes.length}.
        </p>
      )}

      {/* ── Settings, not decisions ──────────────────────────────────
          Both of these used to be permanently expanded above the table.
          They are consulted rarely and they matter enormously when they
          are, which is exactly the case for closed-but-named: visible
          enough to be remembered, quiet enough to be scrolled past. */}
      <section style={{ marginTop: 34 }}>
        <SectionHeading label="Platform administration" />
        <div className="flex flex-col" style={{ gap: 'var(--ef-gap)' }}>
          {user?.uid && (
            <Disclosure
              label="Erasure policy"
              description="The two values that arm erasure. Until both are set, the server refuses every erasure request."
              icon={<Settings2 size={15} strokeWidth={1.7} />}
            >
              <ErasurePolicyPanel webOwnerUid={user.uid} />
            </Disclosure>
          )}

          {/* This panel used to list EVERY deleted record on the platform —
              institutes, faculty and students from every tenant together.
              Deleted people now live inside the institute they belonged to
              (open an institute → Users → Trash), which is where someone
              asking "who did we remove from this institute" actually looks.
              A deleted INSTITUTE has no institute to sit inside, so this is
              the only surface that can restore or purge one. */}
          <Disclosure
            label="Deleted institutes"
            description="Restore a removed institute, or purge it for good. Deleted faculty and students live inside their own institute, under Users → Trash."
            icon={<Trash2 size={15} strokeWidth={1.7} />}
          >
            <TrashPanel canPurge roles={['institute']} />
          </Disclosure>
        </div>
      </section>

      <InstituteSheet
        open={sheetOpen}
        onClose={() => {
          setSheetOpen(false);
          setEditing(null);
        }}
        onSaved={onSaved}
        editing={editing}
      />

      <ExtendValiditySheet
        institute={extending}
        onClose={() => setExtending(null)}
        onExtended={(updated) => {
          setInstitutes((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
          setExtending(null);
          setSyncedAt(Date.now());
          say(true, `${updated.name} now expires ${formatDate(updated.activeUntil)}.`);
        }}
      />

      <DeleteInstituteSheet
        institute={deleting}
        onClose={() => setDeleting(null)}
        verifyPassword={verifyPassword}
        onDeleted={(id) => {
          const gone = institutes.find((i) => i.id === id);
          setInstitutes((prev) => prev.filter((i) => i.id !== id));
          setDeleting(null);
          setSyncedAt(Date.now());
          say(true, `${gone?.name ?? 'Institute'} deleted. It can be restored for 180 days.`);
        }}
      />
    </PageShell>
  );
}
