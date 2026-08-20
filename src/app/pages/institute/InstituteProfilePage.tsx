import { useInstituteAuth } from '../../context/InstituteAuthContext';
import { formatDateLong } from '../../../lib/dateFormat';
import { daysUntilExpiry, NO_EXPIRY_LABEL } from '../../../lib/instituteValidity';
import { expiryPhrase } from '../../../lib/fleetOverview';
import { AccountProfile } from '../../components/console/account';
import { Card, Chip, SectionHeading } from '../../components/console/ui';

/**
 * An institute admin's profile carries something the other roles' do not: the
 * permission gates their Web Owner has set. They are read-only here and shown
 * anyway, because "why can I not create questions" is otherwise an
 * unanswerable question from inside the product — the admin can see the
 * section is missing and has no way to learn that it is deliberate.
 */
export function InstituteProfilePage() {
  const { session } = useInstituteAuth();
  if (!session) return null;

  const days = daysUntilExpiry(session.activeUntil);

  const gates: Array<[string, boolean]> = [
    ['Create faculty', session.canAdminCreateFaculty],
    ['Create students', session.canAdminCreateStudents],
    ['Create questions', session.canAdminCreateQuestions],
    ['Manage exam rosters', session.canAdminManageExamRosters],
    ['Schools & hierarchy', session.schoolsManagementEnabled],
    ['Faculty may add students', session.facultyCanCreateStudents],
    ['Faculty may manage rosters', session.facultyCanManageExamRosters],
  ];

  return (
    <AccountProfile
      name={session.adminName}
      role="Institute admin"
      subtitle={session.instituteName}
      status={{ label: session.status === 'active' ? 'Active' : 'Disabled', ok: session.status === 'active' }}
      fields={[
        { label: 'Administrator', value: session.adminName },
        { label: 'Email', value: session.adminEmail, mono: true },
        { label: 'Institute', value: session.instituteName },
        { label: 'Institute code', value: session.instituteCode, mono: true },
        {
          label: 'Access until',
          value: session.activeUntil ? formatDateLong(session.activeUntil) : NO_EXPIRY_LABEL,
        },
        { label: 'Validity', value: expiryPhrase(days) },
      ]}
      managedBy={
        <>
          Your institute's name, code and access window are set by the platform owner. Everything
          inside your institute — faculty, students, schools — is yours to manage.
        </>
      }
    >
      <section>
        <SectionHeading label="What your institute may do" hint="Set by the platform owner." />
        <Card>
          <div className="flex items-center gap-1.5 flex-wrap">
            {gates.map(([label, granted]) => (
              <Chip key={label} tone={granted ? 'success' : 'muted'}>
                {granted ? label : `${label} — off`}
              </Chip>
            ))}
          </div>
          <p className="ef-t-xs ef-muted" style={{ marginTop: 14, lineHeight: 'var(--ef-leading-relaxed)' }}>
            A capability that is off does not appear anywhere in your console. If one you need is
            missing, this is the list to quote when you ask for it.
          </p>
        </Card>
      </section>
    </AccountProfile>
  );
}
