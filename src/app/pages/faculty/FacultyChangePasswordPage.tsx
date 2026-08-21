import { useNavigate, Navigate } from 'react-router';
import { useFacultyAuth } from '../../context/FacultyAuthContext';
import { FirstLoginNotice, SetPassword } from '../../components/console/auth';

/**
 * The forced password change on a first sign-in.
 *
 * A route rather than a modal, because it is not optional: there is nothing
 * behind it to go back to, and the guards in every dashboard layout send you
 * here until it is done.
 */
export function FacultyChangePasswordPage() {
  const navigate = useNavigate();
  const { session, changePassword } = useFacultyAuth();

  if (!session) return <Navigate to="/faculty/login" replace />;
  if (!session.firstLoginRequired) return <Navigate to="/faculty/dashboard" replace />;

  return (
    <SetPassword
      audience="Set your password"
      intro="This one opens the question bank and, where you have been granted it, live exam rosters."
      notice={
        <FirstLoginNotice>
          You are signed in with a temporary password. Choose a permanent one to reach your
          workspace.
        </FirstLoginNotice>
      }
      submitLabel="Set password and continue"
      onSubmit={async ({ password }) => {
        const result = await changePassword(password);
        if (result.success) navigate('/faculty/dashboard', { replace: true });
        return result;
      }}
    />
  );
}
