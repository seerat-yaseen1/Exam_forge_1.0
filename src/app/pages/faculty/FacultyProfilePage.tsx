import { useFacultyAuth } from '../../context/FacultyAuthContext';
import { formatDateLong } from '../../../lib/dateFormat';
import { AccountProfile } from '../../components/console/account';

export function FacultyProfilePage() {
  const { session } = useFacultyAuth();
  if (!session) return null;

  return (
    <AccountProfile
      name={session.name}
      role="Faculty"
      subtitle={session.instituteName}
      status={{ label: session.status === 'active' ? 'Active' : 'Disabled', ok: session.status === 'active' }}
      fields={[
        { label: 'Full name', value: session.name },
        { label: 'Email', value: session.email, mono: true },
        { label: 'Institute', value: session.instituteName },
        { label: 'Institute code', value: session.instituteCode, mono: true },
        { label: 'Member since', value: session.createdAt ? formatDateLong(session.createdAt) : '—' },
        {
          label: 'Exam rosters',
          value: session.canManageExamRosters ? 'Can manage' : 'Not granted',
        },
      ]}
      managedBy={
        <>
          Your name, email and what you are allowed to do are set by your institute administrator —
          ask them if any of it is wrong. Your password and the way this console looks are yours to
          change.
        </>
      }
    />
  );
}
