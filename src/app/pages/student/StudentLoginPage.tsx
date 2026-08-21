import { useNavigate, Navigate } from 'react-router';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { SignIn } from '../../components/console/auth';

export function StudentLoginPage() {
  const navigate = useNavigate();
  const { session, login } = useStudentAuth();

  if (session) return <Navigate to="/student/dashboard" replace />;

  return (
    <SignIn
      audience="Student access"
      withInstituteCode
      hint="Your institute code was in your registration email."
      forgotTo="/student/forgot-password"
      otherRoles={[
        { to: '/login', label: 'Web Owner' },
        { to: '/institute/login', label: 'Institute Admin' },
        { to: '/faculty/login', label: 'Faculty' },
      ]}
      onSubmit={async ({ code, email, password }) => {
        const result = await login(code, email, password);
        if (!result.success) return result;
        navigate('/student/dashboard', { replace: true });
        return { success: true };
      }}
    />
  );
}
