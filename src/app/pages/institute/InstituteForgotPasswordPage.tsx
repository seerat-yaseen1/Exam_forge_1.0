import { useInstituteAuth } from '../../context/InstituteAuthContext';
import { ForgotPassword } from '../../components/console/auth';

export function InstituteForgotPasswordPage() {
  const { requestPasswordReset } = useInstituteAuth();
  return (
    <ForgotPassword
      audience="Institute admin account"
      // The institute's own code identifies the account here; the address on
      // file is where the link goes.
      withInstituteCode
      backTo="/institute/login"
      onSubmit={({ code }) => requestPasswordReset(code)}
    />
  );
}
