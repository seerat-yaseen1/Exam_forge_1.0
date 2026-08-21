import { useInstituteAuth } from '../../context/InstituteAuthContext';
import { ChangePassword } from '../../components/console/account';

export function InstituteSecurityPage() {
  const { session, changePassword } = useInstituteAuth();

  return (
    <ChangePassword
      onSubmit={(next) => changePassword(next)}
      email={session?.adminEmail}
      intro="This password administers your whole institute — every faculty member, every student and every exam in it."
    />
  );
}
