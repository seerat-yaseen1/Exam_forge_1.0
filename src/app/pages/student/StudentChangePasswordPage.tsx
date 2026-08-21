import { useNavigate, Navigate } from 'react-router';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { FirstLoginNotice, SetPassword } from '../../components/console/auth';

/**
 * The forced password change on a first sign-in.
 *
 * A route rather than a modal, because it is not optional: there is nothing
 * behind it to go back to, and the guards in every dashboard layout send you
 * here until it is done.
 */
export function StudentChangePasswordPage() {
  const navigate = useNavigate();
  const { session, changePassword } = useStudentAuth();

  if (!session) return <Navigate to="/student/login" replace />;
  if (!session.firstLoginRequired) return <Navigate to="/student/dashboard" replace />;

  return (
    <SetPassword
      audience="Set your password"
      intro="This one is the only thing between your account and someone sitting an exam as you."
      notice={
        <FirstLoginNotice>
          You are signed in with a temporary password. Choose a permanent one to reach your
          workspace.
        </FirstLoginNotice>
      }
      submitLabel="Set password and continue"
      onSubmit={async ({ password }) => {
        const result = await changePassword(password);
        if (result.success) navigate('/student/dashboard', { replace: true });
        return result;
      }}
    />
  );
}
