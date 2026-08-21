import { useFacultyAuth } from '../../context/FacultyAuthContext';
import { ChangePassword } from '../../components/console/account';

export function FacultySecurityPage() {
  const { session, changePassword } = useFacultyAuth();

  return (
    <ChangePassword
      onSubmit={(next) => changePassword(next)}
      email={session?.email}
      intro="This password opens the question bank and, where you have been granted it, live exam rosters."
    />
  );
}
