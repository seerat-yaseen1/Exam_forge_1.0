import { useNavigate } from 'react-router';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { SetPassword } from '../../components/console/auth';

export function StudentResetPasswordPage() {
  const navigate = useNavigate();
  const { resetPassword } = useStudentAuth();

  return (
    <SetPassword
      audience="Student account"
      intro="Enter the code from your reset email, then choose a new password."
      withCode
      backTo="/student/login"
      submitLabel="Set new password"
      onSubmit={({ code, password }) => resetPassword(code, password)}
      onDone={() => navigate('/student/login', { replace: true })}
    />
  );
}
