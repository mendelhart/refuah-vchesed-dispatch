import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth, FullPageSpinner } from "@/lib/auth";
import { useRealtime } from "@/lib/realtime";
import { Layout } from "@/components/Layout";
import { RequireAuth, RequireRole } from "@/components/RouteGuards";
import { LoginPage } from "@/pages/Login";
import { AcceptInvitePage } from "@/pages/AcceptInvite";
import { ResetPasswordPage } from "@/pages/ResetPassword";
import { HomePage } from "@/pages/Home";
import { BoardPage } from "@/pages/Board";
import { TripDetailPage } from "@/pages/TripDetail";
import { MyTripsPage } from "@/pages/MyTrips";
import { AcceptFromLinkPage } from "@/pages/AcceptFromLink";
import { ImpactPage } from "@/pages/Impact";
import { DirectoryPage } from "@/pages/Directory";
import { CallsPage } from "@/pages/Calls";
import { EquipmentPage } from "@/pages/Equipment";
import { SettingsPage } from "@/pages/Settings";
import { HubPage } from "@/pages/Hub";
import { MyAvailabilityPage } from "@/pages/MyAvailability";
import { MyProfilePage } from "@/pages/MyProfile";
import { VerifyCardPage } from "@/pages/VerifyCard";
import { PrivacyPage } from "@/pages/Privacy";
import { InstallPrompt } from "@/lib/install-prompt";

/**
 * Routes a volunteer never opens are split out of the main bundle.
 *
 * Most people using this are on a phone, on mobile data, often in a hospital
 * car park. The dispatcher board's neighbours — the message console, the admin
 * screens, the QR encoder on the ID card — are a large share of the JavaScript
 * here and none of it is needed to accept a ride, so it loads only when
 * somebody actually navigates there.
 */
const CallersPage = React.lazy(() =>
  import('@/pages/Callers').then((m) => ({ default: m.CallersPage })),
);
const RecurringPage = React.lazy(() =>
  import('@/pages/Recurring').then((m) => ({ default: m.RecurringPage })),
);
const MessagesPage = React.lazy(() =>
  import('@/pages/Messages').then((m) => ({ default: m.MessagesPage })),
);
const VolunteersPage = React.lazy(() =>
  import('@/pages/Volunteers').then((m) => ({ default: m.VolunteersPage })),
);
const DutyPage = React.lazy(() =>
  import('@/pages/Duty').then((m) => ({ default: m.DutyPage })),
);
const MyIdCardPage = React.lazy(() =>
  import('@/pages/MyIdCard').then((m) => ({ default: m.MyIdCardPage })),
);
const VolunteerSignupPage = React.lazy(() =>
  import('@/pages/VolunteerSignup').then((m) => ({ default: m.VolunteerSignupPage })),
);
const ApplicationsPage = React.lazy(() =>
  import('@/pages/admin/Applications').then((m) => ({ default: m.ApplicationsPage })),
);
const TemplatesPage = React.lazy(() =>
  import('@/pages/admin/Templates').then((m) => ({ default: m.TemplatesPage })),
);
const AnnouncementsPage = React.lazy(() =>
  import('@/pages/admin/Announcements').then((m) => ({ default: m.AnnouncementsPage })),
);
const DataFixesPage = React.lazy(() =>
  import('@/pages/admin/DataFixes').then((m) => ({ default: m.DataFixesPage })),
);
const BackupPage = React.lazy(() => import('@/pages/admin/Backup').then((m) => ({ default: m.BackupPage })));
const ExportsPage = React.lazy(() =>
  import('@/pages/admin/Exports').then((m) => ({ default: m.ExportsPage })),
);
const AuditPage = React.lazy(() =>
  import('@/pages/admin/Audit').then((m) => ({ default: m.AuditPage })),
);
const NotificationsAdminPage = React.lazy(() =>
  import('@/pages/admin/Notifications').then((m) => ({ default: m.NotificationsAdminPage })),
);
const FoodPage = React.lazy(() => import('@/pages/Food').then((m) => ({ default: m.FoodPage })));
const LiftAssistPage = React.lazy(() => import('@/pages/LiftAssist').then((m) => ({ default: m.LiftAssistPage })));
const ReportsPage = React.lazy(() => import('@/pages/Reports').then((m) => ({ default: m.ReportsPage })));
const GoogleReturnPage = React.lazy(() => import('@/pages/GoogleReturn').then((m) => ({ default: m.GoogleReturnPage })));
const GoogleSignInAdminPage = React.lazy(() => import('@/pages/admin/GoogleSignIn').then((m) => ({ default: m.GoogleSignInAdminPage })));
const EmailDesignsPage = React.lazy(() => import('@/pages/EmailBuilder').then((m) => ({ default: m.EmailDesignsPage })));
const EmailDesignPage = React.lazy(() => import('@/pages/EmailBuilder').then((m) => ({ default: m.EmailDesignPage })));
const KitchenPage = React.lazy(() => import('@/pages/Kitchen').then((m) => ({ default: m.KitchenPage })));
const DepartmentsPage = React.lazy(() =>
  import('@/pages/admin/Departments').then((m) => ({ default: m.DepartmentsPage })),
);
const AdminSettingsPage = React.lazy(() =>
  import('@/pages/admin/AdminSettings').then((m) => ({ default: m.AdminSettingsPage })),
);
const PeoplePage = React.lazy(() =>
  import('@/pages/admin/People').then((m) => ({ default: m.PeoplePage })),
);
const VehiclesPage = React.lazy(() =>
  import('@/pages/Vehicles').then((m) => ({ default: m.VehiclesPage })),
);
const ContactsHubPage = React.lazy(() =>
  import('@/pages/ContactsHub').then((m) => ({ default: m.ContactsHubPage })),
);

const DISPATCH = ["dispatcher", "admin"] as const;
const ADMIN = ["admin"] as const;

/** Every authenticated route shares the shell. */
function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <RequireAuth>
      <Layout>
        <React.Suspense fallback={<FullPageSpinner label="Loading" />}>{children}</React.Suspense>
      </Layout>
    </RequireAuth>
  );
}

export function App(): React.JSX.Element {
  const { user } = useAuth();
  // Live board updates, only once we know who is watching.
  useRealtime(Boolean(user));

  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/google" element={<React.Suspense fallback={<FullPageSpinner label="Loading" />}><GoogleReturnPage /></React.Suspense>} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />

        {/* Public, unauthenticated: the signup form and the card check a hospital
          reception desk lands on after scanning a volunteer's badge. Neither
          sits inside the app shell — there is nothing to navigate to. */}
        <Route
        path="/volunteer/apply"
        element={
          <React.Suspense fallback={<FullPageSpinner label="Loading" />}>
            <VolunteerSignupPage />
          </React.Suspense>
        }
      />
        <Route path="/verify/:token" element={<VerifyCardPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />

        <Route
          path="/"
          element={
            <Shell>
              <HomePage />
            </Shell>
          }
        />
        <Route
          path="/board"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <BoardPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/trips/:id"
          element={
            <Shell>
              <TripDetailPage />
            </Shell>
          }
        />
        <Route
          path="/my-trips"
          element={
            <Shell>
              <MyTripsPage />
            </Shell>
          }
        />
        <Route
          path="/o/:code"
          element={
            <Shell>
              <AcceptFromLinkPage />
            </Shell>
          }
        />
        <Route
          path="/impact"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <ImpactPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/directory"
          element={
            <Shell>
              <DirectoryPage />
            </Shell>
          }
        />
        <Route
          path="/calls"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <CallsPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/equipment"
          element={
            <Shell>
              <EquipmentPage />
            </Shell>
          }
        />
        <Route
          path="/vehicles"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <VehiclesPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/contacts"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <ContactsHubPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/settings"
          element={
            <Shell>
              <SettingsPage />
            </Shell>
          }
        />
        <Route
          path="/my-availability"
          element={
            <Shell>
              <MyAvailabilityPage />
            </Shell>
          }
        />
        <Route
          path="/my-profile"
          element={
            <Shell>
              <MyProfilePage />
            </Shell>
          }
        />
        <Route
          path="/my-id-card"
          element={
            <Shell>
              <MyIdCardPage />
            </Shell>
          }
        />
        <Route
          path="/duty"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <DutyPage />
              </RequireRole>
            </Shell>
          }
        />

        <Route
          path="/callers"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <CallersPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/recurring"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <RecurringPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/messages"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <MessagesPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/volunteers"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <VolunteersPage />
              </RequireRole>
            </Shell>
          }
        />

        <Route path="/more" element={<Shell><HubPage section="more" /></Shell>} />
        <Route path="/me" element={<Shell><HubPage section="profile" /></Shell>} />
        <Route
          path="/admin"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <HubPage section="admin" />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/admin/audit"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <AuditPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/admin/notifications"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <NotificationsAdminPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route path="/food" element={<Shell><RequireRole roles={DISPATCH}><FoodPage /></RequireRole></Shell>} />
        <Route path="/kitchen" element={<Shell><KitchenPage /></Shell>} />
        <Route path="/lift-assist" element={<Shell><LiftAssistPage /></Shell>} />
        <Route path="/reports" element={<Shell><RequireRole roles={DISPATCH}><ReportsPage /></RequireRole></Shell>} />
        <Route path="/email-builder" element={<Shell><RequireRole roles={DISPATCH}><EmailDesignsPage /></RequireRole></Shell>} />
        <Route path="/email-builder/:id" element={<Shell><RequireRole roles={DISPATCH}><EmailDesignPage /></RequireRole></Shell>} />
        <Route path="/admin/google-sign-in" element={<Shell><RequireRole roles={ADMIN}><GoogleSignInAdminPage /></RequireRole></Shell>} />
        <Route
          path="/admin/departments"
          element={
            <Shell>
              <RequireRole roles={ADMIN}>
                <DepartmentsPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/admin/settings"
          element={
            <Shell>
              <RequireRole roles={ADMIN}>
                <AdminSettingsPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/admin/people"
          element={
            <Shell>
              <RequireRole roles={ADMIN}>
                <PeoplePage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/admin/applications"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <ApplicationsPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/admin/applications/:id"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <ApplicationsPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/admin/templates"
          element={
            <Shell>
              <RequireRole roles={ADMIN}>
                <TemplatesPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/admin/announcements"
          element={
            <Shell>
              <RequireRole roles={DISPATCH}>
                <AnnouncementsPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/admin/data-fixes"
          element={
            <Shell>
              <RequireRole roles={ADMIN}>
                <DataFixesPage />
              </RequireRole>
            </Shell>
          }
        />
        <Route
          path="/admin/backup"
          element={
            <Shell><RequireRole roles={ADMIN}><BackupPage /></RequireRole></Shell>
          }
        />
        <Route
          path="/admin/exports"
          element={
            <Shell>
              <RequireRole roles={ADMIN}>
                <ExportsPage />
              </RequireRole>
            </Shell>
          }
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <InstallPrompt />
    </>
  );
}
