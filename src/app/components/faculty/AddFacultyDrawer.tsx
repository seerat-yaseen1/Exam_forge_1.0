import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, X, Check, Loader2, AlertTriangle, UserCheck } from 'lucide-react';
import {
  generatePassword,
  getFacultyByEmail,
  getFaculty,
  type Faculty as FirebaseFaculty,
} from '../../../lib/firebaseService';
import { httpsCallable } from 'firebase/functions';
import { sendPasswordResetEmail } from 'firebase/auth';
import { auth, functions } from '../../../lib/firebase';

export interface Faculty {
  id: string;
  instituteId: string;
  name: string;
  email: string;
  role: 'Faculty';
  status: 'active' | 'disabled';
  firstLoginRequired: boolean;
  // Optional permission fields (mirrors lib/firebaseService Faculty). Present
  // so FacultyTab can read/gate per-faculty toggles and the Phase-2 question-
  // rights editor without re-casting.
  schoolsManagementEnabled?: boolean;
  canCreateStudents?: boolean;
  canManageExamRosters?: boolean;
  questionRights?: import('../../../lib/firebaseService').FacultyQuestionRights;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (faculty: Faculty, emailSent: boolean) => void;
  instituteId: string;
  instituteName: string;
}

const inputStyle: React.CSSProperties = {
  background: '#FAFAF8',
  border: '1px solid #E3E1DB',
  color: '#0C0C0B',
  borderRadius: 2,
  width: '100%',
  outline: 'none',
  fontSize: 13,
  padding: '9px 12px',
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <label className="block text-xs mb-1.5" style={{ color: '#4A4A45' }}>{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-xs" style={{ color: '#B0AEA8' }}>{hint}</p>}
    </div>
  );
}

const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = '#0C0C0B';
  e.target.style.background = '#FFFFFF';
};
const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = '#E3E1DB';
  e.target.style.background = '#FAFAF8';
};

export function AddFacultyDrawer({ open, onClose, onCreated, instituteId, instituteName }: Props) {
  const [name, setName]       = useState('');
  const [email, setEmail]     = useState('');
  const [status, setStatus]   = useState<'active' | 'disabled'>('active');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    if (!open) return;
    setName(''); setEmail(''); setStatus('active');
    setError(''); setSaving(false);
  }, [open]);

  const handleSubmit = async () => {
    if (!name.trim()) return setError('Faculty name is required.');
    if (!email.trim()) return setError('Faculty email is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError('Enter a valid email address.');

    setSaving(true); setError('');
    try {
      const normalizedEmail = email.toLowerCase().trim();

      const existing = await getFacultyByEmail(normalizedEmail);
      if (existing) {
        throw new Error('A faculty member with this email already exists.');
      }

      const tempPassword = generatePassword();
      const now = new Date().toISOString();

      const createAuthUser = httpsCallable<
        { role: 'faculty'; password: string; instituteId: string; profile: Record<string, unknown> },
        { ok: boolean; uid: string }
      >(functions, 'createAuthUser');

      const result = await createAuthUser({
        role: 'faculty',
        password: tempPassword,
        instituteId,
        profile: {
          email: normalizedEmail,
          name: name.trim(),
          instituteId,
          role: 'Faculty',
          status,
          firstLoginRequired: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const uid = result.data.uid;

      let emailSent = false;
      try {
        await sendPasswordResetEmail(auth, normalizedEmail);
        emailSent = true;
      } catch (mailErr) {
        console.warn('[AddFacultyDrawer] reset email failed:', mailErr);
      }

      const created = (await getFaculty(uid)) as FirebaseFaculty | null;
      if (!created) throw new Error('Faculty created but profile not found.');

      onCreated(created as Faculty, emailSent);
    } catch (e: any) {
      setError(e?.message || 'An unexpected error occurred.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="fac-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50"
            style={{ background: 'rgba(12,12,11,0.18)' }}
            onClick={onClose}
          />
          <motion.div
            key="fac-panel"
            initial={{ x: 48, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 48, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            className="fixed right-0 top-0 bottom-0 z-50 flex flex-col w-full sm:w-[400px] sm:max-w-full"
            style={{ background: '#FFFFFF', borderLeft: '1px solid #E3E1DB' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 sm:py-4 flex-shrink-0"
              style={{ borderBottom: '1px solid #E3E1DB' }}>
              <div>
                <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>ADD FACULTY</p>
                <p className="text-xs mt-0.5" style={{ color: '#C4C3BD' }}>Single member onboarding</p>
              </div>
              <button onClick={onClose} className="p-1 hover:opacity-60 transition-opacity" style={{ color: '#9A9891' }}>
                <X size={15} strokeWidth={1.5} />
              </button>
            </div>

            {/* Form */}
            <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">

              {/* Authority notice */}
              <div className="flex items-start gap-2.5 px-3 py-3 mb-6"
                style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderLeft: '2px solid #C4C3BD', borderRadius: 2 }}>
                <UserCheck size={12} strokeWidth={1.5} style={{ color: '#9A9891', marginTop: 1, flexShrink: 0 }} />
                <p className="text-xs" style={{ color: '#9A9891', lineHeight: 1.6 }}>
                  A password-setup link will be emailed directly to the faculty member. They set their own password before first login.
                </p>
              </div>

              <Field label="Faculty name" hint="Full name of the faculty member.">
                <input type="text" value={name} autoFocus
                  onChange={(e) => { setName(e.target.value); setError(''); }}
                  placeholder="e.g. Dr. Priya Sharma"
                  style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
              </Field>

              <Field label="Faculty email" hint="A password-setup link will be emailed to this address.">
                <input type="email" value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(''); }}
                  placeholder="e.g. priya.sharma@institute.edu"
                  style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
              </Field>

              {/* Role — fixed, non-editable */}
              <Field label="Role" hint="All accounts created here are Faculty accounts.">
                <div className="flex items-center gap-2 px-3 py-2.5"
                  style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                  <span className="text-xs px-2 py-0.5"
                    style={{ background: '#EEECEA', color: '#4A4A45', borderRadius: 2, letterSpacing: '0.04em' }}>
                    Faculty
                  </span>
                  <span className="text-xs ml-auto" style={{ color: '#C4C3BD', letterSpacing: '0.06em' }}>FIXED</span>
                </div>
              </Field>

              {/* Status */}
              <Field label="Initial status" hint="Status can be changed at any time after creation.">
                <div className="flex gap-2">
                  {(['active', 'disabled'] as const).map((s) => (
                    <button key={s} type="button" onClick={() => setStatus(s)}
                      className="flex-1 text-xs py-2.5 transition-all"
                      style={{
                        borderRadius: 2,
                        border: status === s ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
                        background: status === s ? '#0C0C0B' : '#FAFAF8',
                        color: status === s ? '#FFFFFF' : '#4A4A45',
                        letterSpacing: '0.04em',
                      }}>
                      {s === 'active' ? 'Active' : 'Disabled'}
                    </button>
                  ))}
                </div>
              </Field>
            </div>

            {/* Footer */}
            <div className="flex-shrink-0 px-4 sm:px-6 py-4" style={{ borderTop: '1px solid #E3E1DB' }}>
              <AnimatePresence>
                {error && (
                  <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                    className="flex items-start gap-2 mb-3 px-3 py-2.5"
                    style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
                    <AlertTriangle size={12} strokeWidth={1.5} style={{ color: '#9B2828', marginTop: 1, flexShrink: 0 }} />
                    <p className="text-xs" style={{ color: '#9B2828' }}>{error}</p>
                  </motion.div>
                )}
              </AnimatePresence>
              <div className="flex items-center gap-3">
                <button onClick={handleSubmit} disabled={saving}
                  className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
                  style={{
                    background: saving ? '#C8C7C2' : '#0C0C0B', color: '#FFFFFF',
                    borderRadius: 2, letterSpacing: '0.03em',
                    cursor: saving ? 'not-allowed' : 'pointer',
                  }}>
                  {saving ? <><Loader2 size={11} className="animate-spin" />Granting access…</>
                    : <><Check size={11} strokeWidth={2} />Grant access</>}
                </button>
                <button onClick={onClose} disabled={saving}
                  className="text-xs px-4 py-2.5 transition-colors"
                  style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = '#F7F6F3')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = '#FFFFFF')}>
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