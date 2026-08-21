import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { verifyPasswordResetCode, confirmPasswordReset } from 'firebase/auth';
import { auth } from '../../lib/firebase';
import { AuthNotice, AuthPending, SetPassword } from '../components/console/auth';

// ══════════════════════════════════════════════════════════════════
// Shared password-reset landing page.
//
// This is where Firebase's password-reset EMAIL LINK lands. The link
// carries an ?oobCode=... (Firebase's single-use, expiring reset token).
// The page verifies the code, lets the user set a new password inside our
// own branded UI, and confirms the reset — no Firebase-hosted page, and no
// legacy 16-character code. One page serves every role (webOwner,
// institute, faculty, student); `role` only selects which login link to
// return to.
//
// Firebase Console prerequisites (one-time):
//   • Authentication → Settings → Authorized domains: include the Vercel
//     production domain (and any preview domain used for testing).
//   • Authentication → Templates → Password reset → the action link must
//     point at this route. With the default handler the link arrives as
//     https://<app>/reset-password?oobCode=...&mode=resetPassword — which
//     is exactly what this page reads.
//
// ── WHY FOUR SCREENS AND NOT ONE FORM ─────────────────────────────
// A reset link is opened once, usually on a phone, often days later. Three
// of the four things that can happen are not "here is a form": we are still
// checking, the link is spent, or the job is done. Each of those is its own
// screen with its own single action, because the alternative — a form that
// is greyed out with a red line above it — leaves someone staring at fields
// they cannot use, with nothing to press.
// ══════════════════════════════════════════════════════════════════

type Role = 'web_owner' | 'institute' | 'faculty' | 'student';
type Stage = 'verifying' | 'form' | 'success' | 'invalid';

const LOGIN_PATH: Record<Role, string> = {
  web_owner: '/login',
  institute: '/institute/login',
  faculty:   '/faculty/login',
  student:   '/student/login',
};

export function ResetPasswordActionPage({ role }: { role: Role }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const oobCode = params.get('oobCode') ?? '';
  const loginPath = LOGIN_PATH[role];
  const toLogin = () => navigate(loginPath, { replace: true });

  const [stage, setStage] = useState<Stage>('verifying');
  const [accountEmail, setAccountEmail] = useState('');

  // Verify the reset code as soon as the page loads. A missing / expired /
  // already-used code lands on the 'invalid' stage instead of a dead form.
  useEffect(() => {
    let cancelled = false;
    if (!oobCode) { setStage('invalid'); return; }
    verifyPasswordResetCode(auth, oobCode)
      .then((email) => { if (!cancelled) { setAccountEmail(email); setStage('form'); } })
      .catch(() => { if (!cancelled) setStage('invalid'); });
    return () => { cancelled = true; };
  }, [oobCode]);

  if (stage === 'verifying') {
    return (
      <AuthPending title="Checking your link">
        One moment — reset links are single-use, so we confirm this one is still good
        before letting you set a password.
      </AuthPending>
    );
  }

  if (stage === 'invalid') {
    return (
      <AuthNotice
        tone="danger"
        icon={<AlertTriangle size={20} strokeWidth={1.7} />}
        title="This link has expired"
        action={{ label: 'Request a new link', onClick: toLogin }}
      >
        Reset links work once and only for a short while. Nothing is wrong with your
        account — sign in and choose “Forgot password?” to send a fresh one.
      </AuthNotice>
    );
  }

  if (stage === 'success') {
    return (
      <AuthNotice
        tone="success"
        icon={<CheckCircle2 size={20} strokeWidth={1.7} />}
        title="Password updated"
        action={{ label: 'Go to sign in', onClick: toLogin }}
      >
        {accountEmail
          ? <>You can sign in as <span className="ef-ink">{accountEmail}</span> with your new password.</>
          : 'You can sign in with your new password now.'}
      </AuthNotice>
    );
  }

  return (
    <SetPassword
      audience="Set a new password"
      intro={
        <>
          For <span className="ef-ink">{accountEmail}</span>. Pick something you have not
          used here before — this is the one credential that lets someone sit an exam as you.
        </>
      }
      backTo={loginPath}
      submitLabel="Update password"
      onSubmit={async ({ password }) => {
        try {
          await confirmPasswordReset(auth, oobCode, password);
          setStage('success');
          return { success: true };
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          // The code can expire between opening the mail and pressing the
          // button. That is not a form error — the form is now useless, so
          // the whole screen becomes the expired one.
          if (code === 'auth/expired-action-code' || code === 'auth/invalid-action-code') {
            setStage('invalid');
            return { success: false };
          }
          if (code === 'auth/weak-password') {
            return { success: false, error: 'Password is too weak. Use at least 8 characters.' };
          }
          return { success: false, error: 'Could not reset password. Please try again.' };
        }
      }}
    />
  );
}
