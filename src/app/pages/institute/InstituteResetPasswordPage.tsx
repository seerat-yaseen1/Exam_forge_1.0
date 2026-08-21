import { useNavigate } from 'react-router';
import { useInstituteAuth } from '../../context/InstituteAuthContext';
import { SetPassword } from '../../components/console/auth';

export function InstituteResetPasswordPage() {
  const navigate = useNavigate();
  const { resetPassword } = useInstituteAuth();

  return (
    <SetPassword
      audience="Institute admin account"
      intro="Enter the code from your reset email, then choose a new password."
      withCode
      backTo="/institute/login"
      submitLabel="Set new password"
      onSubmit={({ code, password }) => resetPassword(code, password)}
      onDone={() => navigate('/institute/login', { replace: true })}
    />
  );
}
