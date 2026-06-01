import { createBrowserRouter, Navigate } from 'react-router';
import { FirebaseTestPage } from './pages/FirebaseTestPage';
import { FirebaseDebugPage } from './pages/FirebaseDebugPage';
import { InitializeWebOwnerPage } from './pages/InitializeWebOwnerPage';
import { InstituteRoot } from './pages/institute/InstituteRoot';
import { Root } from './Root';
import { LoginPage } from './pages/LoginPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { DashboardLayout } from './layouts/DashboardLayout';
import { InstituteDashboardLayout } from './layouts/InstituteDashboardLayout';
import { FacultyDashboardLayout } from './layouts/FacultyDashboardLayout';
import { StudentDashboardLayout } from './layouts/StudentDashboardLayout';
import { LandingPage } from './pages/LandingPage';
import { ProfilePage } from './pages/ProfilePage';
import { SecurityPage } from './pages/SecurityPage';
import { UserManagementPage } from './pages/UserManagementPage';
import { QuestionsPage } from './pages/QuestionsPage';
import { SubjectsPage } from './pages/SubjectsPage';
import { AssignmentsPage } from './pages/AssignmentsPage';
import { AssessmentRosterPage } from './pages/AssessmentRosterPage';
import { ReportsInboxPage } from './pages/ReportsInboxPage';
import { InstituteDetailPage } from './pages/InstituteDetailPage';
import { InstituteLoginPage } from './pages/institute/InstituteLoginPage';
import { InstituteChangePasswordPage } from './pages/institute/InstituteChangePasswordPage';
import { InstituteForgotPasswordPage } from './pages/institute/InstituteForgotPasswordPage';
import { InstituteResetPasswordPage } from './pages/institute/InstituteResetPasswordPage';
import { InstituteLandingPage } from './pages/institute/InstituteLandingPage';
import { InstituteProfilePage } from './pages/institute/InstituteProfilePage';
import { InstituteSecurityPage } from './pages/institute/InstituteSecurityPage';
import { InstituteQuestionsPage } from './pages/institute/InstituteQuestionsPage';
import { InstituteAssignmentsPage } from './pages/institute/InstituteAssignmentsPage';
import { InstituteAssessmentRosterPage } from './pages/institute/InstituteAssessmentRosterPage';
import { InstituteReportsInboxPage } from './pages/institute/InstituteReportsInboxPage';
import { FacultyRoot } from './pages/faculty/FacultyRoot';
import { FacultyLoginPage } from './pages/faculty/FacultyLoginPage';
import { FacultyChangePasswordPage } from './pages/faculty/FacultyChangePasswordPage';
import { FacultyForgotPasswordPage } from './pages/faculty/FacultyForgotPasswordPage';
import { FacultyResetPasswordPage } from './pages/faculty/FacultyResetPasswordPage';
import { FacultyLandingPage } from './pages/faculty/FacultyLandingPage';
import { FacultyProfilePage } from './pages/faculty/FacultyProfilePage';
import { FacultySecurityPage } from './pages/faculty/FacultySecurityPage';
import { FacultyQuestionsPage } from './pages/faculty/FacultyQuestionsPage';
import { FacultyAssignmentsPage } from './pages/faculty/FacultyAssignmentsPage';
import { FacultyAssessmentRosterPage } from './pages/faculty/FacultyAssessmentRosterPage';
import { FacultyReportsInboxPage } from './pages/faculty/FacultyReportsInboxPage';
import { StudentRoot } from './pages/student/StudentRoot';
import { StudentLoginPage } from './pages/student/StudentLoginPage';
import { StudentChangePasswordPage } from './pages/student/StudentChangePasswordPage';
import { StudentForgotPasswordPage } from './pages/student/StudentForgotPasswordPage';
import { StudentResetPasswordPage } from './pages/student/StudentResetPasswordPage';
import { StudentLandingPage } from './pages/student/StudentLandingPage';
import { StudentProfilePage } from './pages/student/StudentProfilePage';
import { StudentSecurityPage } from './pages/student/StudentSecurityPage';
import { StudentAssessmentsPage } from './pages/student/StudentAssessmentsPage';
import { ExamBriefingPage } from './pages/student/ExamBriefingPage';
import { ExamShell } from './pages/student/ExamShell';
import { ExamResultsPage } from './pages/student/ExamResultsPage';

export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      // ── Firebase Test (Public) ────────────────────────────────────
      { path: '/firebase-test', element: <FirebaseTestPage /> },
      
      // ── Firebase Debug (Public) ───────────────────────────────────
      { path: '/firebase-debug', element: <FirebaseDebugPage /> },
      
      // ── Initialize Web Owner (Public) ─────────────────────────────
      { path: '/initialize', element: <InitializeWebOwnerPage /> },

      // ── Web Owner auth ────────────────────────────────────────────
      { index: true, element: <Navigate to="/login" replace /> },
      { path: '/login',           element: <LoginPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
      { path: '/reset-password',  element: <ResetPasswordPage /> },

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
          { path: 'reset-password',  element: <InstituteResetPasswordPage /> },
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
          { path: 'reset-password',   element: <FacultyResetPasswordPage /> },
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
          { path: 'reset-password',   element: <StudentResetPasswordPage /> },
          // ── Exam routes (outside dashboard layout — full page takeover) ──
          { path: 'exam/:assessmentId/briefing', element: <ExamBriefingPage /> },
          { path: 'exam/:assessmentId/shell',    element: <ExamShell /> },
          {
            element: <StudentDashboardLayout />,
            children: [
              { path: 'dashboard',                      element: <StudentLandingPage /> },
              { path: 'assessments',                    element: <StudentAssessmentsPage /> },
              { path: 'exam/:assessmentId/results',     element: <ExamResultsPage /> },
              { path: 'profile',                        element: <StudentProfilePage /> },
              { path: 'security',                       element: <StudentSecurityPage /> },
            ],
          },
        ],
      },

      // ── Catch-all ─────────────────────────────────────────────────
      { path: '*', element: <Navigate to="/login" replace /> },
    ],
  },
]);