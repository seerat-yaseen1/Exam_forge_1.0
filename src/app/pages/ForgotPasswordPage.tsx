import { useAuth } from '../context/AuthContext';
import { ForgotPassword } from '../components/console/auth';

export function ForgotPasswordPage() {
  const { requestPasswordReset } = useAuth();
  return (
    <ForgotPassword
      audience="Web owner account"
      backTo="/login"
      onSubmit={({ email }) => requestPasswordReset(email)}
    />
  );
}
