import { useState, useEffect, useRef, KeyboardEvent } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Check, Loader2, AlertTriangle, UserCheck, ChevronDown, ChevronUp } from 'lucide-react';
import {
  generatePassword,
  getStudentByEmail,
  getStudent,
  type Student as FirebaseStudent,
} from '../../../lib/firebaseService';
import { httpsCallable } from 'firebase/functions';
import { sendPasswordResetEmail } from 'firebase/auth';
import { auth, functions } from '../../../lib/firebase';

// ── Types ─────────────────────────────────────────────────────────

// Audit L4 (2026-08-04): this was a SECOND, near-identical declaration of the
// student shape whose only difference was `role: 'student'` where the canonical
// type says 'Student'. Because StudentTab holds its list in this type while
// firebaseService returns the other, the two were structurally incompatible and
// every hand-off needed a cast — casts that would have silently survived a real
// field divergence later. Re-exported as an alias so there is one shape, and
// the name stays importable for the components that already use it.
export type Student = FirebaseStudent;

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (student: Student, emailSent: boolean) => void;
  instituteId: string;
  instituteName: string;
}

// ── Sub-components ────────────────────────────────────────────────

const inputBase: React.CSSProperties = {
  background: '#FAFAF8', border: '1px solid #E3E1DB',
  color: '#0C0C0B', borderRadius: 2, width: '100%',
  outline: 'none', fontSize: 13, padding: '9px 12px',
};
const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = '#0C0C0B'; e.target.style.background = '#FFFFFF';
};
const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = '#E3E1DB'; e.target.style.background = '#FAFAF8';
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <label className="block text-xs mb-1.5" style={{ color: '#4A4A45' }}>{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-xs" style={{ color: '#6B6B66' }}>{hint}</p>}
    </div>
  );
}

// Tag input for multi-value optional fields
function TagInput({
  label, hint, tags, onChange,
}: { label: string; hint?: string; tags: string[]; onChange: (tags: string[]) => void }) {
  const [inputVal, setInputVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = (val: string) => {
    const v = val.trim();
    if (v && !tags.includes(v)) onChange([...tags, v]);
    setInputVal('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(inputVal); }
    if (e.key === 'Backspace' && !inputVal && tags.length > 0) onChange(tags.slice(0, -1));
  };

  const removeTag = (i: number) => onChange(tags.filter((_, idx) => idx !== i));

  return (
    <div className="mb-5">
      <label className="block text-xs mb-1.5" style={{ color: '#4A4A45' }}>
        {label}
        <span className="ml-1.5 text-xs" style={{ color: '#6B6B66', letterSpacing: '0.04em' }}>OPTIONAL</span>
      </label>
      <div
        className="flex flex-wrap gap-1.5 items-center min-h-9 px-2.5 py-2 cursor-text"
        style={{ background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2 }}
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map((t, i) => (
          <span key={i} className="inline-flex items-center gap-1 text-xs px-2 py-0.5"
            style={{ background: '#EEECEA', color: '#2C2C2A', borderRadius: 2 }}>
            {t}
            <button type="button" onClick={(e) => { e.stopPropagation(); removeTag(i); }}
              style={{ color: '#6B6B66', lineHeight: 1 }}>
              <X size={9} strokeWidth={2} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => { if (inputVal.trim()) addTag(inputVal); }}
          placeholder={tags.length === 0 ? 'Type and press Enter or comma' : ''}
          className="flex-1 min-w-20 outline-none text-xs"
          style={{ background: 'transparent', color: '#0C0C0B', border: 'none', padding: '1px 0' }}
        />
      </div>
      {hint && <p className="mt-1.5 text-xs" style={{ color: '#6B6B66' }}>{hint}</p>}
    </div>
  );
}

// ── Drawer ────────────────────────────────────────────────────────

export function AddStudentDrawer({ open, onClose, onCreated, instituteId, instituteName }: Props) {
  // Required fields
  const [name, setName]     = useState('');
  const [email, setEmail]   = useState('');
  const [status, setStatus] = useState<'active' | 'disabled'>('active');

  // Optional metadata
  const [group, setGroup]                   = useState<string[]>([]);
  const [section, setSection]               = useState<string[]>([]);
  const [specialisation, setSpecialisation] = useState<string[]>([]);
  const [program, setProgram]               = useState<string[]>([]);
  const [degreeLevel, setDegreeLevel]       = useState<string[]>([]);
  const [school, setSchool]                 = useState<string[]>([]);
  const [metaOpen, setMetaOpen]             = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  useEffect(() => {
    if (!open) return;
    setName(''); setEmail(''); setStatus('active');
    setGroup([]); setSection([]); setSpecialisation([]);
    setProgram([]); setDegreeLevel([]); setSchool([]);
    setMetaOpen(false); setError(''); setSaving(false);
  }, [open]);

  const handleSubmit = async () => {
    if (!name.trim()) return setError('Student name is required.');
    if (!email.trim()) return setError('Student email is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError('Enter a valid email address.');

    setSaving(true); setError('');
    try {
      const normalizedEmail = email.toLowerCase().trim();

      const existingStudent = await getStudentByEmail(normalizedEmail);
      if (existingStudent) throw new Error('A student with this email already exists.');

      const tempPassword = generatePassword();
      const now = new Date().toISOString();

      const profile: Record<string, unknown> = {
        email: normalizedEmail,
        name: name.trim(),
        instituteId,
        role: 'student',
        status,
        firstLoginRequired: false,
        createdAt: now,
        updatedAt: now,
      };
      if (group.length) profile.group = group;
      if (section.length) profile.section = section;
      if (specialisation.length) profile.specialisation = specialisation;
      if (program.length) profile.program = program;
      if (degreeLevel.length) profile.degreeLevel = degreeLevel;
      if (school.length) profile.school = school;

      const createAuthUser = httpsCallable<
        { role: 'student'; password: string; instituteId: string; profile: Record<string, unknown> },
        { ok: boolean; uid: string }
      >(functions, 'createAuthUser');

      const result = await createAuthUser({
        role: 'student',
        password: tempPassword,
        instituteId,
        profile,
      });

      let emailSent = false;
      try {
        await sendPasswordResetEmail(auth, normalizedEmail);
        emailSent = true;
      } catch (mailErr) {
        console.warn('[AddStudentDrawer] reset email failed:', mailErr);
      }

      const created = await getStudent(result.data.uid);
      if (!created) throw new Error('Student created but profile not found.');

      onCreated(created, emailSent);
    } catch (e: any) {
      setError(e?.message || 'An unexpected error occurred.');
    } finally {
      setSaving(false);
    }
  };

  const hasMetadata = group.length + section.length + specialisation.length +
    program.length + degreeLevel.length + school.length > 0;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="std-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50"
            style={{ background: 'rgba(12,12,11,0.18)' }}
            onClick={onClose}
          />
          <motion.div key="std-panel"
            initial={{ x: 48, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 48, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            className="fixed right-0 top-0 bottom-0 z-50 flex flex-col w-full sm:w-[420px] sm:max-w-full"
            style={{ background: '#FFFFFF', borderLeft: '1px solid #E3E1DB' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 sm:py-4 flex-shrink-0"
              style={{ borderBottom: '1px solid #E3E1DB' }}>
              <div>
                <p className="text-xs" style={{ color: '#6B6B66', letterSpacing: '0.1em' }}>ADD STUDENT</p>
                <p className="text-xs mt-0.5" style={{ color: '#6B6B66' }}>Single member onboarding</p>
              </div>
              <button onClick={onClose} className="p-1 hover:opacity-60 transition-opacity" style={{ color: '#6B6B66' }}>
                <X size={15} strokeWidth={1.5} />
              </button>
            </div>

            {/* Form */}
            <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">

              {/* Authority notice */}
              <div className="flex items-start gap-2.5 px-3 py-3 mb-6"
                style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderLeft: '2px solid #6B6B66', borderRadius: 2 }}>
                <UserCheck size={12} strokeWidth={1.5} style={{ color: '#6B6B66', marginTop: 1, flexShrink: 0 }} />
                <p className="text-xs" style={{ color: '#6B6B66', lineHeight: 1.6 }}>
                  A password-setup link will be emailed directly to the student. They set their own password before first login.
                </p>
              </div>

              {/* Required fields */}
              <Field label="Student name" hint="Full name of the student.">
                <input type="text" value={name} autoFocus
                  onChange={(e) => { setName(e.target.value); setError(''); }}
                  placeholder="e.g. Arjun Mehta"
                  style={inputBase} onFocus={onFocus} onBlur={onBlur} />
              </Field>

              <Field label="Student email" hint="A password-setup link will be emailed to this address.">
                <input type="email" value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(''); }}
                  placeholder="e.g. arjun.mehta@student.edu"
                  style={inputBase} onFocus={onFocus} onBlur={onBlur} />
              </Field>

              {/* Role — fixed */}
              <Field label="Role" hint="All accounts created here are Student accounts.">
                <div className="flex items-center gap-2 px-3 py-2.5"
                  style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                  <span className="text-xs px-2 py-0.5"
                    style={{ background: '#EEECEA', color: '#4A4A45', borderRadius: 2, letterSpacing: '0.04em' }}>
                    Student
                  </span>
                  <span className="text-xs ml-auto" style={{ color: '#6B6B66', letterSpacing: '0.06em' }}>FIXED</span>
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

              {/* Optional metadata accordion */}
              <div style={{ borderTop: '1px solid #F0EFEB', marginTop: 4, paddingTop: 16 }}>
                <button type="button"
                  onClick={() => setMetaOpen((v) => !v)}
                  className="flex items-center justify-between w-full text-left"
                  style={{ color: '#4A4A45' }}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs">Academic metadata</span>
                    {hasMetadata && (
                      <span className="text-xs px-1.5 py-0.5"
                        style={{ background: '#F0EFEB', color: '#6B6B66', borderRadius: 2 }}>
                        {group.length + section.length + specialisation.length + program.length + degreeLevel.length + school.length} tag{group.length + section.length + specialisation.length + program.length + degreeLevel.length + school.length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs" style={{ color: '#6B6B66' }}>All optional</span>
                    {metaOpen
                      ? <ChevronUp size={12} strokeWidth={1.5} style={{ color: '#6B6B66' }} />
                      : <ChevronDown size={12} strokeWidth={1.5} style={{ color: '#6B6B66' }} />}
                  </div>
                </button>

                <AnimatePresence>
                  {metaOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                      style={{ overflow: 'hidden' }}
                    >
                      <div className="pt-4">
                        <TagInput label="Program" tags={program} onChange={setProgram}
                          hint="e.g. Computer Science, Business Administration" />
                        <TagInput label="Degree level" tags={degreeLevel} onChange={setDegreeLevel}
                          hint="e.g. Undergraduate, Postgraduate, PhD" />
                        <TagInput label="School" tags={school} onChange={setSchool}
                          hint="e.g. School of Engineering" />
                        <TagInput label="Group" tags={group} onChange={setGroup}
                          hint="e.g. Group A, Batch 2024" />
                        <TagInput label="Section" tags={section} onChange={setSection}
                          hint="e.g. Section 1, Morning" />
                        <TagInput label="Specialisation" tags={specialisation} onChange={setSpecialisation}
                          hint="e.g. Data Science, Finance" />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
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
                  style={{ color: '#6B6B66', border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}
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