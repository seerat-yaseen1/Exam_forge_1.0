import { useNavigate } from 'react-router';
import { useFacultyAuth } from '../../context/FacultyAuthContext';
import { SetPassword } from '../../components/console/auth';

export function FacultyResetPasswordPage() {
  const navigate = useNavigate();
  const { resetPassword } = useFacultyAuth();

  return (
    <SetPassword
      audience="Faculty account"
      intro="Enter the code from your reset email, then choose a new password."
      withCode
      backTo="/faculty/login"
      submitLabel="Set new password"
      onSubmit={({ code, password }) => resetPassword(code, password)}
      onDone={() => navigate('/faculty/login', { replace: true })}
    />
  );
}
