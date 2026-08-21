import { useFacultyAuth } from '../../context/FacultyAuthContext';
import { ForgotPassword } from '../../components/console/auth';

export function FacultyForgotPasswordPage() {
  const { requestPasswordReset } = useFacultyAuth();
  return (
    <ForgotPassword
      audience="Faculty account"
      withInstituteCode
      backTo="/faculty/login"
      onSubmit={({ code, email }) => requestPasswordReset(code, email)}
    />
  );
}
