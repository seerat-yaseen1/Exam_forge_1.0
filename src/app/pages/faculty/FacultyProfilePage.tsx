import { motion } from 'motion/react';
import { useFacultyAuth } from '../../context/FacultyAuthContext';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export function FacultyProfilePage() {
  const { session } = useFacultyAuth();

  const rows: { label: string; value: string | undefined }[] = [
    { label: 'Full name',      value: session?.name },
    { label: 'Email',          value: session?.email },
    { label: 'Role',           value: 'Faculty' },
    { label: 'Institute',      value: session?.instituteName },
    { label: 'Institute code', value: session?.instituteCode },
    { label: 'Account status', value: session?.status === 'active' ? 'Active' : 'Disabled' },
    { label: 'Member since',   value: session?.createdAt ? formatDate(session.createdAt) : '—' },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="px-8 py-10"
      style={{ maxWidth: 640, margin: '0 auto' }}
    >
      <p className="text-xs mb-1" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>PROFILE</p>
      <h1 className="text-base mb-8" style={{ color: '#0C0C0B', borderBottom: '1px solid #E3E1DB', paddingBottom: 20 }}>
        {session?.name}
      </h1>

      <div style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}>
        {rows.map((row, i) => (
          <div key={i} className="flex items-start px-5 py-4"
            style={{ borderBottom: i < rows.length - 1 ? '1px solid #F0EFEB' : 'none' }}>
            <p className="text-xs w-40 flex-shrink-0" style={{ color: '#9A9891', paddingTop: 1 }}>{row.label}</p>
            <p className="text-sm"
              style={{
                color: '#0C0C0B',
                fontFamily: row.label === 'Email' || row.label === 'Institute code' ? 'monospace' : 'inherit',
                letterSpacing: row.label === 'Institute code' ? '0.12em' : 'inherit',
              }}>
              {row.value ?? '—'}
            </p>
          </div>
        ))}
      </div>

      <p className="text-xs mt-4" style={{ color: '#C4C3BD' }}>
        Profile details are managed by your institute administrator.
      </p>
    </motion.div>
  );
}
