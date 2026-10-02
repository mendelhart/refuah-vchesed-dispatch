/**
 * App shell: brand header, desktop sidebar, mobile bottom navigation.
 *
 * Two fixes carried over from the original Layout.jsx:
 *  - the sidebar was `hidden lg:fixed …` with no `lg:block`, so `hidden` won at
 *    every width and the sidebar never rendered on any screen. It is
 *    `hidden lg:flex` here and the main column keeps its `lg:ml-64` offset.
 *  - BottomNavigation existed but was never mounted; it is mounted below.
 */
import React, { useState } from 'react';
import { useOnline } from '@/lib/offline';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  BookUser,
  CalendarClock,
  CalendarRange,
  Car,
  Download,
  FileText,
  HeartHandshake,
  Home,
  IdCard,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Megaphone,
  Menu,
  MessageSquare,
  MessageSquareText,
  Moon,
  Package,
  Phone,
  Plus,
  Repeat,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  UserPlus,
  Users,
  X,
  Wrench, CookingPot, HandHelping } from 'lucide-react';
import type { Role } from '@rvc/shared';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { qk } from '@/lib/query';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { FEATURE_ROUTES, useFeatures, type FeatureFlags, type Features } from '@/lib/features';
import { BottomNavigation, bottomNavItems } from './BottomNavigation';
import type { BoardSummaryResponse, TripListResponse } from '@/types/api';
import { exitViewAs, getViewAs } from '@/lib/viewAs';
import { NotificationsBell } from './NotificationsBell';
import { roleLabel } from '@rvc/shared';
import { navLabel, useI18n } from '@/i18n';

/** Where a screen lives: the main menu, or one tap further under More / My profile / Admin. */
export type NavSection = 'main' | 'more' | 'profile' | 'admin';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: readonly Role[];
  end?: boolean;
  /** Section per role group; defaults to 'main'. */
  dispatch?: NavSection;
  volunteer?: NavSection;
  /** One-line description on the hub pages. */
  hint?: string;
  /** Shown only when this new feature is switched on. */
  flag?: keyof FeatureFlags;
  /** For coordinators limited to departments: hidden outside this one.
   *  (The server refuses those requests anyway; this keeps the menu honest.) */
  department?: string;
}

/**
 * The menu.
 *
 * Kept short on purpose. Dispatchers see the screens they work in all day;
 * everything else is one tap away under More or Admin. Volunteers see Home,
 * My rides and My profile; their own records live inside My profile.
 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: Home, roles: ['volunteer', 'dispatcher', 'admin'], end: true },
  { to: '/board', label: 'Dispatch board', icon: LayoutDashboard, roles: ['dispatcher', 'admin'] },
  { to: '/messages', label: 'Messages', icon: MessageSquare, roles: ['dispatcher', 'admin'] },
  { to: '/volunteers', label: 'Volunteers', icon: Users, roles: ['dispatcher', 'admin'] },
  { to: '/contacts', label: 'Contacts', icon: BookUser, roles: ['dispatcher', 'admin'] },
  // Top level for coordinators (user asked for it to be more prominent); volunteers never see it.
  { to: '/calls', label: 'Call log', icon: Phone, roles: ['dispatcher', 'admin'], hint: 'Calls placed through the app' },
  { to: '/recurring', label: 'Standing rides', icon: Repeat, roles: ['dispatcher', 'admin'], dispatch: 'more', hint: 'Rides that repeat every week', department: 'rides' },
  { to: '/equipment', label: 'Equipment', icon: Package, roles: ['volunteer', 'dispatcher', 'admin'], volunteer: 'more', dispatch: 'more', hint: 'Loans of wheelchairs and other equipment', department: 'equipment' },

  { to: '/my-trips', label: 'My rides', icon: Car, roles: ['volunteer', 'dispatcher', 'admin'], dispatch: 'profile' },
  { to: '/me', label: 'My profile', icon: IdCard, roles: ['volunteer', 'dispatcher', 'admin'] },
  { to: '/my-availability', label: 'My availability', icon: CalendarRange, roles: ['volunteer', 'dispatcher', 'admin'], dispatch: 'profile', volunteer: 'profile', hint: 'When you can be asked' },
  { to: '/my-profile', label: 'What I can help with', icon: ListChecks, roles: ['volunteer', 'dispatcher', 'admin'], dispatch: 'profile', volunteer: 'profile', hint: 'Services, vehicle and what you can handle' },
  { to: '/my-id-card', label: 'My ID card', icon: IdCard, roles: ['volunteer', 'dispatcher', 'admin'], dispatch: 'profile', volunteer: 'profile', hint: 'Your volunteer card and licence' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, roles: ['volunteer', 'dispatcher', 'admin'], volunteer: 'profile', dispatch: 'profile', hint: 'Name, phone, how we reach you, menu' },

  { to: '/directory', label: 'Directory', icon: Users, roles: ['volunteer'], volunteer: 'more', hint: 'The team roster' },
  { to: '/food', label: 'Food', icon: CookingPot, roles: ['dispatcher', 'admin'], dispatch: 'more', hint: 'Kitchen, stock, distribution runs and shopping lists', flag: 'foodOps', department: 'food' },
  { to: '/kitchen', label: 'Help in the kitchen', icon: CookingPot, roles: ['volunteer'], volunteer: 'more', hint: 'Sign up to cook or pack', flag: 'foodOps' },
  { to: '/lift-assist', label: 'Lift assist', icon: HandHelping, roles: ['volunteer', 'dispatcher', 'admin'], volunteer: 'more', dispatch: 'more', hint: 'A few helpers for heavy lifting, one lead', flag: 'liftAssist' },
  { to: '/duty', label: 'Phone duty', icon: CalendarClock, roles: ['dispatcher', 'admin'], dispatch: 'more', hint: 'Who is on the phones when' },
    { to: '/vehicles', label: 'Vehicles', icon: Car, roles: ['dispatcher', 'admin'], dispatch: 'more', hint: 'Organisation vehicles' },
  { to: '/admin/applications', label: 'Applications', icon: UserPlus, roles: ['dispatcher', 'admin'], dispatch: 'more', hint: 'New volunteer sign-ups to review' },

  { to: '/admin/people', label: 'People', icon: Users, roles: ['admin'], dispatch: 'admin', hint: 'Accounts, roles, invites, how each person is reached' },
  { to: '/admin/announcements', label: 'Broadcast', icon: Megaphone, roles: ['dispatcher', 'admin'], dispatch: 'more', hint: 'Message everyone or a group, with a picture' },
  { to: '/admin/notifications', label: 'Notifications', icon: Bell, roles: ['dispatcher', 'admin'], dispatch: 'admin', hint: 'Every message sent, and whether it arrived' },
  { to: '/admin/templates', label: 'Message templates', icon: MessageSquareText, roles: ['admin'], dispatch: 'admin', hint: 'Wording of the texts' },
  { to: '/impact', label: 'Organization impact', icon: HeartHandshake, roles: ['dispatcher', 'admin'], dispatch: 'admin', hint: 'Rides, volunteers and people helped, all together', department: 'reports' },
  { to: '/admin/departments', label: 'Departments', icon: Users, roles: ['admin'], dispatch: 'admin', hint: 'Which coordinators work on rides, food, equipment or reports', flag: 'departmentScoping' },
  { to: '/admin/backup', label: 'Full backup', icon: Download, roles: ['admin'], dispatch: 'admin', hint: 'Encrypted full database download' },
  { to: '/admin/exports', label: 'Exports', icon: Download, roles: ['admin'], dispatch: 'admin', hint: 'Download data' },
  { to: '/admin/audit', label: 'Audit log', icon: FileText, roles: ['dispatcher', 'admin'], dispatch: 'admin', hint: 'Who changed what' },
  { to: '/admin/data-fixes', label: 'Data fixes', icon: Wrench, roles: ['admin'], dispatch: 'admin', hint: 'Correct how a ride ended; tidy up accounts never set up' },
  { to: '/admin/settings', label: 'Dispatch settings', icon: ShieldCheck, roles: ['admin'], dispatch: 'admin', hint: 'Timings, limits, call quiet hours, announcements on/off' },
];

/** Hub entries that stand in for a whole section in the main menu. */
export const HUB_ITEMS: Array<{ to: string; label: string; icon: NavItem['icon']; section: NavSection }> = [
  { to: '/more', label: 'More', icon: Menu, section: 'more' },
  { to: '/admin', label: 'Admin', icon: ShieldCheck, section: 'admin' },
];

export function sectionOf(item: NavItem, role: Role): NavSection {
  const isDispatch = role === 'dispatcher' || role === 'admin';
  return (isDispatch ? item.dispatch : item.volunteer) ?? 'main';
}

/** Items in one section for this person (role, feature switches, hidden screens). */
export function sectionItems(
  role: Role,
  navHidden: string[] | undefined,
  section: NavSection,
  features: Features,
): NavItem[] {
  return NAV_ITEMS.filter((item) => {
    if (!item.roles.includes(role) || sectionOf(item, role) !== section) return false;
    const flag = FEATURE_ROUTES[item.to];
    if (flag && !features[flag]) return false;
    if (item.flag && !features.flags?.[item.flag]) return false;
    if (item.department && role === 'dispatcher' && features.departments && !features.departments.includes(item.department)) return false;
    return section !== 'main' || !isNavItemHidden(role, navHidden, item.to);
  });
}

/**
 * Routes nobody is allowed to hide: the way home, and the way back to the
 * setting that hides things (otherwise the last checkbox is a one-way door).
 */
const ALWAYS_VISIBLE = new Set(['/', '/settings']);

/**
 * A volunteer's own screens. Dispatchers who also drive can still use them,
 * but most do not, so for a dispatcher they start hidden and can be switched
 * on in Settings > Your menu.
 */
export const DISPATCH_DEFAULT_HIDDEN = new Set(['/my-trips', '/my-availability', '/my-profile', '/my-id-card', '/me']);

/**
 * navHidden holds route paths the person hid. A `+` prefix ("+/my-trips")
 * records the opposite: a screen that is hidden by default for their role and
 * that they chose to show. No migration needed; the column is a text array.
 */
export const SHOWN_PREFIX = '+';

export function isNavItemHidden(role: Role, navHidden: string[] | undefined, to: string): boolean {
  if (ALWAYS_VISIBLE.has(to)) return false;
  const prefs = navHidden ?? [];
  if (prefs.includes(to)) return true;
  const isDispatch = role === 'dispatcher' || role === 'admin';
  if (isDispatch && DISPATCH_DEFAULT_HIDDEN.has(to)) return !prefs.includes(`${SHOWN_PREFIX}${to}`);
  return false;
}

/** The navHidden value after flipping one screen between Shown and Hidden. */
export function toggleNavPreference(role: Role, navHidden: string[] | undefined, to: string): string[] {
  const hiddenNow = isNavItemHidden(role, navHidden, to);
  const rest = (navHidden ?? []).filter((entry) => entry !== to && entry !== `${SHOWN_PREFIX}${to}`);
  const isDispatch = role === 'dispatcher' || role === 'admin';
  const defaultHidden = isDispatch && DISPATCH_DEFAULT_HIDDEN.has(to);
  if (hiddenNow) return defaultHidden ? [...rest, `${SHOWN_PREFIX}${to}`] : rest;
  return defaultHidden ? rest : [...rest, to];
}

/** Role-eligible main-menu items minus the ones hidden for this person. */
export function visibleNavItems(role: Role, navHidden: string[] | undefined, features?: Features): NavItem[] {
  return sectionItems(role, navHidden, 'main', features ?? { announcements: true });
}

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return cn(
    'flex min-h-[44px] items-center gap-3 rounded-xl px-4 py-3 text-sm transition-colors',
    isActive
      ? 'bg-[#EA0029] font-semibold text-white shadow-md'
      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800',
  );
}

export function Layout({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { t } = useI18n();
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const role: Role = user?.role ?? 'volunteer';
  const { pathname } = useLocation();
  const isDispatch = role === 'dispatcher' || role === 'admin';
  const features = useFeatures(Boolean(user));
  const mainItems = visibleNavItems(role, user?.navHidden, features);
  const hubs = HUB_ITEMS.filter((hub) => sectionItems(role, user?.navHidden, hub.section, features).length > 0);
  const items: Array<{ to: string; label: string; icon: NavItem['icon']; end?: boolean }> = [...mainItems, ...hubs];

  // Badge sources. Both are best-effort: a failure here must never block the
  // shell, so neither result is thrown into the tree.
  const myTripsQuery = useQuery({
    queryKey: qk.trips.list({ scope: 'available', limit: 50 }),
    queryFn: () => api.get<TripListResponse>('/api/trips', { scope: 'available', limit: 50 }),
    enabled: Boolean(user),
  });
  const summaryQuery = useQuery({
    queryKey: qk.trips.summary(),
    queryFn: () => api.get<BoardSummaryResponse>('/api/trips/summary'),
    enabled: Boolean(user) && isDispatch,
  });
  // The unread conversation count sits on the board context, which dispatchers
  // already poll; asking for it separately would double the traffic for one int.
  const boardContextQuery = useQuery({
    queryKey: qk.board.context(),
    queryFn: () => api.get<{ unreadConversations: number }>('/api/board/context'),
    enabled: Boolean(user) && isDispatch,
    refetchInterval: 30_000,
  });

  const badges = {
    ...(myTripsQuery.data ? { myTrips: myTripsQuery.data.items.length } : {}),
    ...(summaryQuery.data ? { board: summaryQuery.data.needsAttention + summaryQuery.data.unanswered } : {}),
    ...(boardContextQuery.data ? { messages: boardContextQuery.data.unreadConversations } : {}),
  };

  const online = useOnline();

  const handleLogout = async (): Promise<void> => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen bg-slate-50 transition-colors dark:bg-slate-950">
      {!online ? (
        <div role="status" className="sticky top-0 z-50 bg-amber-500 px-4 py-2 text-center text-sm font-semibold text-slate-950">
          No connection. You are seeing the last saved copy, which may be out of date. Accepting and status updates need a connection.
        </div>
      ) : null}
      <ViewAsBanner />
      <header className="sticky top-0 z-50 bg-[#EA0029] text-white shadow-lg">
        <div className="flex items-center justify-between px-4 py-3">
          <Link to="/" className="flex min-w-0 items-center gap-3 min-h-[44px] py-1">
            {/* The organisation's own wordmark (refuahvchesed.org), white on the brand red. */}
            <img src="/brand/logo-white.svg" alt="" className="h-8 w-auto flex-shrink-0 sm:h-9" />
            <span className="sr-only">Refuah V&apos;Chesed</span>
            <span className="truncate border-l border-white/40 pl-3 text-sm font-medium text-white">Dispatch</span>
          </Link>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={toggle}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              className="grid h-11 w-11 place-items-center rounded-lg hover:bg-white/20"
            >
              {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
            <NotificationsBell />
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              className="grid h-11 w-11 place-items-center rounded-lg hover:bg-white/20 lg:hidden"
            >
              {menuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>
        </div>

        {menuOpen ? (
          <nav className="border-t border-red-700 bg-[#C80023] lg:hidden" aria-label="All screens">
            <div className="space-y-1 px-2 py-3">
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end ?? false}
                    onClick={() => setMenuOpen(false)}
                    className={({ isActive }) =>
                      cn(
                        'flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-3',
                        isActive ? 'bg-white font-semibold text-[#C80023] dark:text-red-400' : 'text-white hover:bg-red-800',
                      )
                    }
                  >
                    <Icon className="h-5 w-5" />
                    <span>{navLabel(t, item.to, item.label)}</span>
                  </NavLink>
                );
              })}
              <button
                type="button"
                onClick={handleLogout}
                className="flex min-h-[44px] w-full items-center gap-3 rounded-lg px-3 py-3 text-white hover:bg-red-800"
              >
                <LogOut className="h-5 w-5" />
                <span>Sign out</span>
              </button>
            </div>
          </nav>
        ) : null}
      </header>

      <div className="flex">
        {/* FIX: `hidden lg:flex` — the original was `hidden lg:fixed` with no
            `lg:block`, so the sidebar was invisible at every width. */}
        <aside className="fixed inset-y-0 start-0 z-40 hidden w-64 flex-col border-e border-slate-200 bg-white pt-[72px] shadow-sm lg:flex dark:border-slate-700 dark:bg-slate-900">
          <div className="border-b border-slate-200 p-5 dark:border-slate-700">
            <p className="text-sm font-semibold text-slate-900 dark:text-white">Dispatch</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">Montreal</p>
          </div>
          <nav className="flex-1 space-y-1 overflow-y-auto p-4" aria-label="Sections">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink key={item.to} to={item.to} end={item.end ?? false} className={navLinkClass}>
                  <Icon className="h-5 w-5 flex-shrink-0" />
                  <span className="truncate">{navLabel(t, item.to, item.label)}</span>
                </NavLink>
              );
            })}
          </nav>
          <div className="border-t border-slate-200 p-4 dark:border-slate-700">
            <p className="truncate text-sm font-medium text-slate-900 dark:text-white">{user?.fullName}</p>
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">{user?.email}</p>
            <p className="mt-1 text-xs font-medium capitalize text-[#C80023] dark:text-red-400">{roleLabel(role)}</p>
            <button
              type="button"
              onClick={handleLogout}
              className="mt-3 flex min-h-[44px] w-full items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </aside>

        <main className="w-full min-w-0 flex-1 lg:ms-64">
          <div
            className="mx-auto max-w-6xl p-4 md:p-6 lg:p-8"
            // Room for the bottom bar on phones, plus the device inset.
            style={{ paddingBottom: 'calc(88px + env(safe-area-inset-bottom))' }}
          >
            {children}
          </div>
        </main>
      </div>

      <BottomNavigation items={bottomNavItems(role, badges, !isNavItemHidden(role, user?.navHidden, '/my-trips'))} />

      {/* Only where new calls are taken: Home and the Board. Elsewhere it confused people. */}
      {isDispatch && (pathname === '/' || pathname === '/board') ? (
        <Link
          to="/board?new=1"
          aria-label="Create a new trip"
          className="fixed end-4 z-40 grid h-14 w-14 place-items-center rounded-full bg-[#EA0029] text-white shadow-lg hover:bg-[#C80023] lg:hidden"
          style={{ bottom: 'calc(72px + env(safe-area-inset-bottom))' }}
        >
          <Plus className="h-7 w-7" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}


/** Shown on every screen while an admin previews the app as someone else. */
function ViewAsBanner(): React.JSX.Element | null {
  const preview = getViewAs();
  if (!preview) return null;
  return (
    <div role="status" className="flex items-center justify-between gap-3 bg-amber-400 px-4 py-2 text-sm font-medium text-slate-900">
      <span className="min-w-0 truncate">
        Viewing as {preview.name} · read-only
      </span>
      <button
        type="button"
        onClick={exitViewAs}
        className="min-h-[36px] flex-shrink-0 rounded-full bg-slate-900 px-3 text-white hover:bg-slate-700"
      >
        Exit
      </button>
    </div>
  );
}
