import { useNavigate, Navigate } from 'react-router';
import { useFacultyAuth } from '../../context/FacultyAuthContext';
import { SignIn } from '../../components/console/auth';

export function FacultyLoginPage() {
  const navigate = useNavigate();
  const { session, login } = useFacultyAuth();

  if (session) {
    return session.firstLoginRequired
      ? <Navigate to="/faculty/change-password" replace />
      : <Navigate to="/faculty/dashboard" replace />;
  }

  return (
    <SignIn
      audience="Faculty access"
      // Faculty sign in with their institute's code as well as their address,
      // because the same email may exist at more than one institute on the
      // platform. The code is in their welcome email.
      withInstituteCode
      hint="Your institute code came with your welcome email."
      forgotTo="/faculty/forgot-password"
      otherRoles={[
        { to: '/login', label: 'Web Owner' },
        { to: '/institute/login', label: 'Institute Admin' },
        { to: '/student/login', label: 'Student' },
      ]}
      onSubmit={async ({ code, email, password }) => {
        const result = await login(code, email, password);
        if (!result.success) return result;
        navigate(result.firstLoginRequired ? '/faculty/change-password' : '/faculty/dashboard', {
          replace: true,
        });
        return { success: true };
      }}
    />
  );
}
