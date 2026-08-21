import { useNavigate, Navigate } from 'react-router';
import { useInstituteAuth } from '../../context/InstituteAuthContext';
import { SignIn } from '../../components/console/auth';

export function InstituteLoginPage() {
  const navigate = useNavigate();
  const { session, login } = useInstituteAuth();

  if (session) return <Navigate to="/institute/dashboard" replace />;

  return (
    <SignIn
      audience="Institute admin access"
      hint="The account that manages your institute — its faculty, its students and its exams."
      forgotTo="/institute/forgot-password"
      otherRoles={[
        { to: '/login', label: 'Web Owner' },
        { to: '/faculty/login', label: 'Faculty' },
        { to: '/student/login', label: 'Student' },
      ]}
      onSubmit={async ({ email, password }) => {
        const result = await login(email, password);
        if (!result.success) return result;
        navigate('/institute/dashboard', { replace: true });
        return { success: true };
      }}
    />
  );
}
