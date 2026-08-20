import { lazy } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';

// ── Eager: the router shell ───────────────────────────────────────
// Roots (auth-context providers) and dashboard layouts stay in the main
// chunk on purpose. Both sit ABOVE the pages in the route tree, so making
// them lazy would create a request waterfall (root chunk → layout chunk →
// page chunk) on every first navigation. They are small; the pages are not.
import { InstituteRoot } from './pages/institute/InstituteRoot';
import { Root } from './Root';
import { DashboardLayout } from './layouts/DashboardLayout';
import { InstituteDashboardLayout } from './layouts/InstituteDashboardLayout';
import { FacultyDashboardLayout } from './layouts/FacultyDashboardLayout';
import { StudentDashboardLayout } from './layouts/StudentDashboardLayout';
import { FacultyRoot } from './pages/faculty/FacultyRoot';
import { StudentRoot } from './pages/student/StudentRoot';
// Eager on purpose: a boundary that arrives as its own lazy chunk cannot
// catch the failure of the chunk it is supposed to be guarding.
import { ErrorBoundary } from './components/ErrorBoundary';

// ── Lazy: every page ──────────────────────────────────────────────
// Remediation plan Batch C / ext #18. Each page becomes its own chunk, so a
// student never downloads the Web Owner's assignment builder and nobody
// downloads the exam shell until they enter an exam.
//
// The .then() unwrap is required because pages use NAMED exports and
// React.lazy expects a module whose `default` is the component. Writing it
// out per page (rather than via a generic helper) keeps each component's
// prop types intact — ResetPasswordActionPage takes a `role` prop that a
// helper returning ComponentType<any> would silently stop checking.
//
// Suspense boundary: App.tsx wraps RouterProvider — see the note there.
const LoginPage = lazy(() => import('./pages/LoginPage').then((m) => ({ default: m.LoginPage })));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })));
const ResetPasswordActionPage = lazy(() => import('./pages/ResetPasswordActionPage').then((m) => ({ default: m.ResetPasswordActionPage })));
const LandingPage = lazy(() => import('./pages/LandingPage').then((m) => ({ default: m.LandingPage })));
const ProfilePage = lazy(() => import('./pages/ProfilePage').then((m) => ({ default: m.ProfilePage })));
const SecurityPage = lazy(() => import('./pages/SecurityPage').then((m) => ({ default: m.SecurityPage })));
const UserManagementPage = lazy(() => import('./pages/UserManagementPage').then((m) => ({ default: m.UserManagementPage })));
const QuestionsPage = lazy(() => import('./pages/QuestionsPage').then((m) => ({ default: m.QuestionsPage })));
const SubjectsPage = lazy(() => import('./pages/SubjectsPage').then((m) => ({ default: m.SubjectsPage })));
const AssignmentsPage = lazy(() => import('./pages/AssignmentsPage').then((m) => ({ default: m.AssignmentsPage })));
const SEBSettingsPage = lazy(() => import('./pages/SEBSettingsPage').then((m) => ({ default: m.SEBSettingsPage })));
const AssessmentRosterPage = lazy(() => import('./pages/AssessmentRosterPage').then((m) => ({ default: m.AssessmentRosterPage })));
const ReportsInboxPage = lazy(() => import('./pages/ReportsInboxPage').then((m) => ({ default: m.ReportsInboxPage })));
const InstituteDetailPage = lazy(() => import('./pages/InstituteDetailPage').then((m) => ({ default: m.InstituteDetailPage })));
const InstituteLoginPage = lazy(() => import('./pages/institute/InstituteLoginPage').then((m) => ({ default: m.InstituteLoginPage })));
const InstituteChangePasswordPage = lazy(() => import('./pages/institute/InstituteChangePasswordPage').then((m) => ({ default: m.InstituteChangePasswordPage })));
const InstituteForgotPasswordPage = lazy(() => import('./pages/institute/InstituteForgotPasswordPage').then((m) => ({ default: m.InstituteForgotPasswordPage })));
const InstituteLandingPage = lazy(() => import('./pages/institute/InstituteLandingPage').then((m) => ({ default: m.InstituteLandingPage })));
const InstituteProfilePage = lazy(() => import('./pages/institute/InstituteProfilePage').then((m) => ({ default: m.InstituteProfilePage })));
const InstituteSecurityPage = lazy(() => import('./pages/institute/InstituteSecurityPage').then((m) => ({ default: m.InstituteSecurityPage })));
const InstituteQuestionsPage = lazy(() => import('./pages/institute/InstituteQuestionsPage').then((m) => ({ default: m.InstituteQuestionsPage })));
const InstituteAssignmentsPage = lazy(() => import('./pages/institute/InstituteAssignmentsPage').then((m) => ({ default: m.InstituteAssignmentsPage })));
const InstituteAssessmentRosterPage = lazy(() => import('./pages/institute/InstituteAssessmentRosterPage').then((m) => ({ default: m.InstituteAssessmentRosterPage })));
const InstituteReportsInboxPage = lazy(() => import('./pages/institute/InstituteReportsInboxPage').then((m) => ({ default: m.InstituteReportsInboxPage })));
const FacultyLoginPage = lazy(() => import('./pages/faculty/FacultyLoginPage').then((m) => ({ default: m.FacultyLoginPage })));
const FacultyChangePasswordPage = lazy(() => import('./pages/faculty/FacultyChangePasswordPage').then((m) => ({ default: m.FacultyChangePasswordPage })));
const FacultyForgotPasswordPage = lazy(() => import('./pages/faculty/FacultyForgotPasswordPage').then((m) => ({ default: m.FacultyForgotPasswordPage })));
const FacultyLandingPage = lazy(() => import('./pages/faculty/FacultyLandingPage').then((m) => ({ default: m.FacultyLandingPage })));
const FacultyProfilePage = lazy(() => import('./pages/faculty/FacultyProfilePage').then((m) => ({ default: m.FacultyProfilePage })));
const FacultySecurityPage = lazy(() => import('./pages/faculty/FacultySecurityPage').then((m) => ({ default: m.FacultySecurityPage })));
const FacultyQuestionsPage = lazy(() => import('./pages/faculty/FacultyQuestionsPage').then((m) => ({ default: m.FacultyQuestionsPage })));
const FacultyAssignmentsPage = lazy(() => import('./pages/faculty/FacultyAssignmentsPage').then((m) => ({ default: m.FacultyAssignmentsPage })));
const FacultyAssessmentRosterPage = lazy(() => import('./pages/faculty/FacultyAssessmentRosterPage').then((m) => ({ default: m.FacultyAssessmentRosterPage })));
const FacultyReportsInboxPage = lazy(() => import('./pages/faculty/FacultyReportsInboxPage').then((m) => ({ default: m.FacultyReportsInboxPage })));
const StudentLoginPage = lazy(() => import('./pages/student/StudentLoginPage').then((m) => ({ default: m.StudentLoginPage })));
const StudentChangePasswordPage = lazy(() => import('./pages/student/StudentChangePasswordPage').then((m) => ({ default: m.StudentChangePasswordPage })));
const StudentForgotPasswordPage = lazy(() => import('./pages/student/StudentForgotPasswordPage').then((m) => ({ default: m.StudentForgotPasswordPage })));
const StudentLandingPage = lazy(() => import('./pages/student/StudentLandingPage').then((m) => ({ default: m.StudentLandingPage })));
const StudentProfilePage = lazy(() => import('./pages/student/StudentProfilePage').then((m) => ({ default: m.StudentProfilePage })));
const StudentSecurityPage = lazy(() => import('./pages/student/StudentSecurityPage').then((m) => ({ default: m.StudentSecurityPage })));
const StudentAppearancePage = lazy(() => import('./pages/student/StudentAppearancePage').then((m) => ({ default: m.StudentAppearancePage })));
const StudentProgressPage = lazy(() => import('./pages/student/StudentProgressPage').then((m) => ({ default: m.StudentProgressPage })));
const StudentAssessmentsPage = lazy(() => import('./pages/student/StudentAssessmentsPage').then((m) => ({ default: m.StudentAssessmentsPage })));
const ExamBriefingPage = lazy(() => import('./pages/student/ExamBriefingPage').then((m) => ({ default: m.ExamBriefingPage })));
const ExamShell = lazy(() => import('./pages/student/ExamShell').then((m) => ({ default: m.ExamShell })));
const ExamResultsPage = lazy(() => import('./pages/student/ExamResultsPage').then((m) => ({ default: m.ExamResultsPage })));
const SebQuitPage = lazy(() => import('./pages/student/SebQuitPage').then((m) => ({ default: m.SebQuitPage })));

export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      // ── Web Owner auth ────────────────────────────────────────────
      { index: true, element: <Navigate to="/login" replace /> },
      { path: '/login',           element: <LoginPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
      { path: '/reset-password',  element: <ResetPasswordActionPage role="web_owner" /> },

      // ── Web Owner dashboard ───────────────────────────────────────
      {
        path: '/dashboard',
        element: <DashboardLayout />,
        children: [
          { index: true,                                     element: <LandingPage /> },
          { path: 'profile',                                 element: <ProfilePage /> },
          { path: 'security',                                element: <SecurityPage /> },
          { path: 'user-management',                         element: <UserManagementPage /> },
          { path: 'user-management/:id',                     element: <InstituteDetailPage /> },
          { path: 'questions',                               element: <QuestionsPage /> },
          { path: 'subjects',                                element: <SubjectsPage /> },
          { path: 'assignments',                             element: <AssignmentsPage /> },
          { path: 'assignments/:assessmentId/roster',        element: <AssessmentRosterPage /> },
          { path: 'reports',                                 element: <ReportsInboxPage /> },
          { path: 'seb',                                     element: <SEBSettingsPage /> },
        ],
      },

      // ── Institute Admin ───────────────────────────────────────────
      {
        path: '/institute',
        element: <InstituteRoot />,
        children: [
          { index: true, element: <Navigate to="/institute/login" replace /> },
          { path: 'login',           element: <InstituteLoginPage /> },
          { path: 'change-password', element: <InstituteChangePasswordPage /> },
          { path: 'forgot-password', element: <InstituteForgotPasswordPage /> },
          { path: 'reset-password',  element: <ResetPasswordActionPage role="institute" /> },
          {
            element: <InstituteDashboardLayout />,
            children: [
              { path: 'dashboard',                           element: <InstituteLandingPage /> },
              { path: 'profile',                             element: <InstituteProfilePage /> },
              { path: 'security',                            element: <InstituteSecurityPage /> },
              { path: 'questions',                           element: <InstituteQuestionsPage /> },
              { path: 'assignments',                         element: <InstituteAssignmentsPage /> },
              { path: 'assignments/:assessmentId/roster',   element: <InstituteAssessmentRosterPage /> },
              { path: 'reports',                            element: <InstituteReportsInboxPage /> },
            ],
          },
        ],
      },

      // ── Faculty ───────────────────────────────────────────────────
      {
        path: '/faculty',
        element: <FacultyRoot />,
        children: [
          { index: true, element: <Navigate to="/faculty/login" replace /> },
          { path: 'login',            element: <FacultyLoginPage /> },
          { path: 'change-password',  element: <FacultyChangePasswordPage /> },
          { path: 'forgot-password',  element: <FacultyForgotPasswordPage /> },
          { path: 'reset-password',   element: <ResetPasswordActionPage role="faculty" /> },
          {
            element: <FacultyDashboardLayout />,
            children: [
              { path: 'dashboard',                              element: <FacultyLandingPage /> },
              { path: 'profile',                               element: <FacultyProfilePage /> },
              { path: 'security',                              element: <FacultySecurityPage /> },
              { path: 'questions',                             element: <FacultyQuestionsPage /> },
              { path: 'assignments',                           element: <FacultyAssignmentsPage /> },
              { path: 'assignments/:assessmentId/roster',      element: <FacultyAssessmentRosterPage /> },
              { path: 'reports',                               element: <FacultyReportsInboxPage /> },
            ],
          },
        ],
      },

      // ── Student ───────────────────────────────────────────────────
      {
        path: '/student',
        element: <StudentRoot />,
        children: [
          { index: true, element: <Navigate to="/student/login" replace /> },
          { path: 'login',            element: <StudentLoginPage /> },
          { path: 'change-password',  element: <StudentChangePasswordPage /> },
          { path: 'forgot-password',  element: <StudentForgotPasswordPage /> },
          { path: 'reset-password',   element: <ResetPasswordActionPage role="student" /> },
          // ── Exam routes (outside dashboard layout — full page takeover) ──
          // Wrapped in their OWN error boundary (audit E-01), for two reasons.
          //
          // Placement: it has to be here, around the element, not inside
          // ExamShell. A boundary rendered BY the component that throws cannot
          // catch it — ExamShell's own hooks run before its return, so a throw
          // during its render would sail straight past a boundary nested in
          // its output and hit the root one instead.
          //
          // Variant: 'exam' strips every exit control from the fallback. The
          // root boundary offers "Back to sign in", which inside a supervised
          // sitting would be a way to walk out of an exam without submitting
          // and without the abandonment being recorded. Reload is the only
          // recovery offered, and it is safe because it re-enters ExamShell
          // against the same server-side attempt.
          {
            path: 'exam/:assessmentId/briefing',
            element: (
              <ErrorBoundary variant="exam" label="exam-briefing">
                <ExamBriefingPage />
              </ErrorBoundary>
            ),
          },
          // ── The exam shell is exempt from the student's theme ──────
          // A candidate's colour preference stops at the door of a sitting:
          // the shell renders in the classic palette the invigilation rules,
          // the integrity overlays and the printed guidance were all written
          // against, whatever theme the account carries.
          //
          // The exemption is a wrapper here rather than an edit inside
          // ExamShell because the shell has nine top-level returns (loading,
          // refused-device, terminated, submitted, …) and pinning it at the
          // route covers all nine at once — including any added later.
          //
          // `display: contents` means the element takes part in inheritance,
          // which is all a custom-property scope needs, while contributing no
          // box of its own: the shell's `fixed inset-0` root is laid out
          // exactly as if this div were not here.
          {
            path: 'exam/:assessmentId/shell',
            element: (
              <ErrorBoundary variant="exam" label="exam-shell">
                <div className="ef-exam-scope" style={{ display: 'contents' }}>
                  <ExamShell />
                </div>
              </ErrorBoundary>
            ),
          },
          {
            element: <StudentDashboardLayout />,
            children: [
              { path: 'dashboard',                      element: <StudentLandingPage /> },
              { path: 'assessments',                    element: <StudentAssessmentsPage /> },
              { path: 'progress',                       element: <StudentProgressPage /> },
              { path: 'exam/:assessmentId/results',     element: <ExamResultsPage /> },
              { path: 'profile',                        element: <StudentProfilePage /> },
              { path: 'appearance',                     element: <StudentAppearancePage /> },
              { path: 'security',                       element: <StudentSecurityPage /> },
            ],
          },
        ],
      },

      // ── SEB quit target (Phase 3, Stage 3) ────────────────────────
      // Public, no auth: the .seb config's quit URL points here so SEB
      // closes on navigation. If quit URL isn't configured, the page shows
      // manual quit instructions instead. Must stay ABOVE the catch-all —
      // a redirect to /login would break the quit navigation.
      { path: '/seb-quit', element: <SebQuitPage /> },

      // ── Catch-all ─────────────────────────────────────────────────
      { path: '*', element: <Navigate to="/login" replace /> },
    ],
  },
]);