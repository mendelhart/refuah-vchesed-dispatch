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
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  BookUser,
  CalendarClock,
  CalendarRange,
  Car,
  ClipboardList,
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
} from 'lucide-react';
import type { Role } from '@rvc/shared';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { qk } from '@/lib/query';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { BottomNavigation, bottomNavItems } from './BottomNavigation';
import type { BoardSummaryResponse, NotificationsResponse, TripListResponse } from '@/types/api';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: readonly Role[];
  end?: boolean;
}

/**
 * The sidebar.
 *
 * Ordered by how often somebody reaches for it, not by which module it belongs
 * to: dispatch work first, then the volunteer's own record, then the things an
 * administrator touches weekly at most. A flat list beats nested menus here —
 * dispatchers navigate this under time pressure with one hand.
 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: Home, roles: ['volunteer', 'dispatcher', 'admin'], end: true },
  { to: '/board', label: 'Dispatch board', icon: LayoutDashboard, roles: ['dispatcher', 'admin'] },
  { to: '/messages', label: 'Messages', icon: MessageSquare, roles: ['dispatcher', 'admin'] },
  { to: '/callers', label: 'Callers', icon: BookUser, roles: ['dispatcher', 'admin'] },
  { to: '/recurring', label: 'Standing rides', icon: Repeat, roles: ['dispatcher', 'admin'] },
  { to: '/volunteers', label: 'Volunteers', icon: Users, roles: ['dispatcher', 'admin'] },
  { to: '/duty', label: 'Phone duty', icon: CalendarClock, roles: ['volunteer', 'dispatcher', 'admin'] },

  { to: '/my-trips', label: 'My rides', icon: Car, roles: ['volunteer', 'dispatcher', 'admin'] },
  { to: '/my-availability', label: 'My availability', icon: CalendarRange, roles: ['volunteer', 'dispatcher', 'admin'] },
  { to: '/my-profile', label: 'What I can help with', icon: ListChecks, roles: ['volunteer', 'dispatcher', 'admin'] },
  { to: '/my-id-card', label: 'My ID card', icon: IdCard, roles: ['volunteer', 'dispatcher', 'admin'] },
  { to: '/impact', label: 'My impact', icon: HeartHandshake, roles: ['volunteer', 'dispatcher', 'admin'] },

  { to: '/directory', label: 'Directory', icon: Users, roles: ['volunteer', 'dispatcher', 'admin'] },
  { to: '/calls', label: 'Call log', icon: Phone, roles: ['volunteer', 'dispatcher', 'admin'] },
  { to: '/contacts', label: 'Contacts', icon: ClipboardList, roles: ['dispatcher', 'admin'] },
  { to: '/equipment', label: 'Equipment', icon: Package, roles: ['volunteer', 'dispatcher', 'admin'] },
  { to: '/vehicles', label: 'Vehicles', icon: Car, roles: ['dispatcher', 'admin'] },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, roles: ['volunteer', 'dispatcher', 'admin'] },

  { to: '/admin/applications', label: 'Applications', icon: UserPlus, roles: ['dispatcher', 'admin'] },
  { to: '/admin/announcements', label: 'Announcements', icon: Megaphone, roles: ['dispatcher', 'admin'] },
  { to: '/admin/exports', label: 'Exports', icon: Download, roles: ['dispatcher', 'admin'] },
  { to: '/admin/people', label: 'People', icon: Users, roles: ['admin'] },
  { to: '/admin/templates', label: 'Message templates', icon: MessageSquareText, roles: ['admin'] },
  { to: '/admin/notifications', label: 'Notifications', icon: Bell, roles: ['dispatcher', 'admin'] },
  { to: '/admin/audit', label: 'Audit log', icon: FileText, roles: ['dispatcher', 'admin'] },
  { to: '/admin/settings', label: 'Dispatch settings', icon: ShieldCheck, roles: ['admin'] },
];

/**
 * Routes nobody is allowed to hide: the way home, and the way back to the
 * setting that hides things (otherwise the last checkbox is a one-way door).
 */
const ALWAYS_VISIBLE = new Set(['/', '/settings']);

/** Role-eligible items minus the ones this person chose to hide. */
export function visibleNavItems(role: Role, navHidden: string[] | undefined): NavItem[] {
  const hidden = new Set(navHidden ?? []);
  return NAV_ITEMS.filter(
    (item) => item.roles.includes(role) && (ALWAYS_VISIBLE.has(item.to) || !hidden.has(item.to)),
  );
}

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return cn(
    'flex min-h-[44px] items-center gap-3 rounded-xl px-4 py-3 text-sm transition-colors',
    isActive
      ? 'bg-[#E31E24] font-semibold text-white shadow-md'
      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800',
  );
}

export function Layout({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const role: Role = user?.role ?? 'volunteer';
  const isDispatch = role === 'dispatcher' || role === 'admin';
  const items = visibleNavItems(role, user?.navHidden);

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
  const notificationsQuery = useQuery({
    queryKey: qk.me.notifications(),
    queryFn: () => api.get<NotificationsResponse>('/api/notifications'),
    enabled: Boolean(user),
  });

  // TODO: there is no in-app notification feed screen in the agreed route list,
  // so the unread count is shown but never cleared. `POST /api/notifications/read`
  // exists and should be called from a feed screen once one is specified.
  const unread = notificationsQuery.data?.unread ?? 0;
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

  const handleLogout = async (): Promise<void> => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen bg-slate-50 transition-colors dark:bg-slate-950">
      <header className="sticky top-0 z-50 bg-[#E31E24] text-white shadow-lg">
        <div className="flex items-center justify-between px-4 py-3">
          <Link to="/" className="flex min-w-0 items-center gap-3 min-h-[44px] py-1">
            <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg bg-white/15 text-base font-black">
              RV
            </span>
            <span className="truncate text-base font-semibold sm:text-lg">Refuah V&apos;Chesed</span>
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
            {unread > 0 ? (
              <span className="rounded-full bg-white/20 px-2 py-1 text-xs font-semibold" aria-label={`${unread} unread notifications`}>
                {unread}
              </span>
            ) : null}
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
          <nav className="border-t border-red-700 bg-[#C41A1F] lg:hidden" aria-label="All screens">
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
                        isActive ? 'bg-white font-semibold text-[#E31E24]' : 'text-red-50 hover:bg-red-800',
                      )
                    }
                  >
                    <Icon className="h-5 w-5" />
                    <span>{item.label}</span>
                  </NavLink>
                );
              })}
              <button
                type="button"
                onClick={handleLogout}
                className="flex min-h-[44px] w-full items-center gap-3 rounded-lg px-3 py-3 text-red-50 hover:bg-red-800"
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
        <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-slate-200 bg-white pt-[72px] shadow-sm lg:flex dark:border-slate-700 dark:bg-slate-900">
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
                  <span className="truncate">{item.label}</span>
                </NavLink>
              );
            })}
          </nav>
          <div className="border-t border-slate-200 p-4 dark:border-slate-700">
            <p className="truncate text-sm font-medium text-slate-900 dark:text-white">{user?.fullName}</p>
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">{user?.email}</p>
            <p className="mt-1 text-xs font-medium capitalize text-[#E31E24]">{role}</p>
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

        <main className="w-full flex-1 lg:ml-64">
          <div
            className="mx-auto max-w-6xl p-4 md:p-6 lg:p-8"
            // Room for the bottom bar on phones, plus the device inset.
            style={{ paddingBottom: 'calc(88px + env(safe-area-inset-bottom))' }}
          >
            {children}
          </div>
        </main>
      </div>

      <BottomNavigation items={bottomNavItems(role, badges)} />

      {isDispatch ? (
        <Link
          to="/board?new=1"
          aria-label="Create a new trip"
          className="fixed right-4 z-40 grid h-14 w-14 place-items-center rounded-full bg-[#E31E24] text-white shadow-lg hover:bg-[#C41A1F] lg:hidden"
          style={{ bottom: 'calc(72px + env(safe-area-inset-bottom))' }}
        >
          <Plus className="h-7 w-7" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}
