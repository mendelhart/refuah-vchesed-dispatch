/**
 * Mobile bottom navigation.
 *
 * The old app had this component but never mounted it, so on a phone — where
 * most volunteers actually are — there was no navigation at all once the
 * header menu was closed. It is mounted from Layout now.
 *
 * Five items, volunteer-first, each at least 44px tall, with a badge slot on
 * the icon for open/unread counts.
 */
import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  BookUser,
  Car,
  IdCard,
  Home,
  LayoutDashboard,
  Menu,
  MessageSquare,
} from 'lucide-react';
import type { Role } from '@rvc/shared';
import { cn } from '@/lib/utils';

export interface BottomNavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
}

/**
 * Five items, never more: a sixth stops being tappable one-handed on a small
 * phone. Dispatchers get the two screens they live in — the board and the
 * message queue — where volunteers get their own rides and their impact.
 */
export function bottomNavItems(
  role: Role,
  badges: { myTrips?: number; board?: number; messages?: number },
  showMyRides = true,
): BottomNavItem[] {
  const isDispatch = role === 'dispatcher' || role === 'admin';
  const withBadge = (item: BottomNavItem, badge: number | undefined): BottomNavItem =>
    badge === undefined ? item : { ...item, badge };

  if (isDispatch) {
    return [
      { to: '/', label: 'Home', icon: Home },
      withBadge({ to: '/board', label: 'Board', icon: LayoutDashboard }, badges.board),
      withBadge({ to: '/messages', label: 'Messages', icon: MessageSquare }, badges.messages),
      // A dispatcher who also drives keeps My rides here; everyone else gets
      // Contacts, the screen they reach for mid-call.
      showMyRides
        ? withBadge({ to: '/my-trips', label: 'My rides', icon: Car }, badges.myTrips)
        : { to: '/contacts', label: 'Contacts', icon: BookUser },
      { to: '/more', label: 'More', icon: Menu },
    ];
  }

  return [
    { to: '/', label: 'Home', icon: Home },
    withBadge({ to: '/my-trips', label: 'My rides', icon: Car }, badges.myTrips),
    { to: '/me', label: 'Profile', icon: IdCard },
    { to: '/more', label: 'More', icon: Menu },
  ];
}

export function BottomNavigation({ items }: { items: BottomNavItem[] }): React.JSX.Element {
  return (
    <nav
      aria-label="Primary"
      className="fixed bottom-0 left-0 right-0 z-40 select-none border-t border-slate-200 bg-white lg:hidden dark:border-slate-700 dark:bg-slate-900"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex justify-around">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex min-h-[56px] flex-1 flex-col items-center justify-center py-2 transition-colors',
                  isActive ? 'text-[#EA0029] dark:text-red-400' : 'text-slate-600 dark:text-slate-400',
                )
              }
            >
              <span className="relative">
                <Icon className="mb-1 h-6 w-6" />
                {item.badge !== undefined && item.badge > 0 ? (
                  <span
                    className="absolute -right-2 -top-1 min-w-[18px] rounded-full bg-[#EA0029] px-1 text-center text-[10px] font-semibold leading-[18px] text-white"
                    aria-label={`${item.badge} waiting`}
                  >
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                ) : null}
              </span>
              <span className="text-[11px] font-medium">{item.label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
