import { useNavigate, Navigate } from 'react-router';
import { useInstituteAuth } from '../../context/InstituteAuthContext';
import { FirstLoginNotice, SetPassword } from '../../components/console/auth';

/**
 * The forced password change on a first sign-in.
 *
 * A route rather than a modal, because it is not optional: there is nothing
 * behind it to go back to, and the guards in every dashboard layout send you
 * here until it is done.
 */
export function InstituteChangePasswordPage() {
  const navigate = useNavigate();
  const { session, changePassword } = useInstituteAuth();

  if (!session) return <Navigate to="/institute/login" replace />;
  if (!session.firstLoginRequired) return <Navigate to="/institute/dashboard" replace />;

  return (
    <SetPassword
      audience="Set your password"
      intro="This one administers your whole institute — every faculty member, every student and every exam in it."
      notice={
        <FirstLoginNotice>
          You are signed in with a temporary password. Choose a permanent one to reach your
          workspace.
        </FirstLoginNotice>
      }
      submitLabel="Set password and continue"
      onSubmit={async ({ password }) => {
        const result = await changePassword(password);
        if (result.success) navigate('/institute/dashboard', { replace: true });
        return result;
      }}
    />
  );
}
