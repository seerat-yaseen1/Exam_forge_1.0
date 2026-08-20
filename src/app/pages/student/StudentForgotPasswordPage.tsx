import { useStudentAuth } from '../../context/StudentAuthContext';
import { ForgotPassword } from '../../components/console/auth';

export function StudentForgotPasswordPage() {
  const { requestPasswordReset } = useStudentAuth();
  return (
    <ForgotPassword
      audience="Student account"
      withInstituteCode
      backTo="/student/login"
      onSubmit={({ code, email }) => requestPasswordReset(code, email)}
    />
  );
}
