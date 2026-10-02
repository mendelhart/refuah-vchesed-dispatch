/** The context strip above the Board: who is on the phones, unread messages,
 *  sign-ups to review, overdue equipment, today's Hebrew date and zmanim. */
import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ClipboardList, Flame, MessageSquare, Package, Phone } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDateTime, formatTime, telHref, formatPhone } from '@/lib/format';
import type { RestPeriod } from './board-model';

/** Shapes from `GET /api/board/context`. Declared here because this strip is
 *  the only consumer and the endpoint composes them from five services. */
export interface BoardContextResponse {
  onDutyNow: { userId: string; fullName: string; phone: string | null; startsAt: string; endsAt: string } | null;
  unreadConversations: number;
  applications: Record<string, number>;
  overdueEquipment: number;
  restPeriods: RestPeriod[];
  hebrewToday: {
    date: string;
    hebrewDate: string;
    hebrewDateHe: string;
    parsha: string | null;
    holidays: string[];
    isRoshChodesh: boolean;
    isFastDay: boolean;
    isYomTov: boolean;
    candleLighting: string | null;
    havdalah: string | null;
  } | null;
  zmanim: { sunset: string | null; tzeit: string | null } | null;
}

// Context, not controls: smaller on a phone so the strip takes one or two
// lines instead of pushing the rides down. Full size from lg up.
const chipClass =
  'inline-flex min-h-[36px] max-w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs lg:min-h-[44px] lg:px-3 lg:text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200';

/**
 * The strip above the board.
 *
 * Everything here is context, not work, so a failure renders nothing at all:
 * an error banner about the Hebrew date would push the actual rides down the
 * screen to tell a dispatcher something they did not ask for.
 */
export function BoardContextStrip(): React.JSX.Element | null {
  const context = useQuery({
    queryKey: qk.board.context(),
    queryFn: () => api.get<BoardContextResponse>('/api/board/context'),
    retry: false,
  });

  const data = context.data;
  if (!data) return null;

  const now = Date.now();
  const nextRest = data.restPeriods.find((period) => new Date(period.endsAt).getTime() > now) ?? null;
  const waitingApplications = (data.applications.submitted ?? 0) + (data.applications.info_requested ?? 0);
  const hebrew = data.hebrewToday;

  return (
    <div>
      <div className="flex flex-wrap items-stretch gap-2">
        {hebrew ? (
          <span className={chipClass}>
            <CalendarDays className="h-4 w-4 flex-shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
            <span>
              <span className="font-medium text-slate-900 dark:text-white">
                {new Date(`${hebrew.date}T12:00:00`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                {' · '}
                {hebrew.hebrewDate}
              </span>
              {hebrew.parsha ? (
                <span className="ml-1 text-slate-500 lg:ml-0 lg:block lg:text-xs dark:text-slate-400">{hebrew.parsha}</span>
              ) : hebrew.holidays.length > 0 ? (
                <span className="ml-1 text-slate-500 lg:ml-0 lg:block lg:text-xs dark:text-slate-400">{hebrew.holidays.join(' · ')}</span>
              ) : null}
            </span>
          </span>
        ) : null}

        {nextRest ? (
          <span className={chipClass}>
            <Flame className="h-4 w-4 flex-shrink-0 text-amber-500" aria-hidden="true" />
            <span>
              <span className="font-medium text-slate-900 dark:text-white">{nextRest.label}</span>
              <span className="ml-1 text-slate-500 lg:ml-0 lg:block lg:text-xs dark:text-slate-400">
                Starts {formatDateTime(nextRest.startsAt)} · ends {formatDateTime(nextRest.endsAt)}
              </span>
            </span>
          </span>
        ) : null}

        <span className={chipClass}>
          <Phone className="h-4 w-4 flex-shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
          {data.onDutyNow ? (
            <span>
              <span className="font-medium text-slate-900 dark:text-white">{data.onDutyNow.fullName}</span>
              <span className="ml-1 text-slate-500 lg:ml-0 lg:block lg:text-xs dark:text-slate-400">
                on the phone until {formatTime(data.onDutyNow.endsAt)}
              </span>
            </span>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">Nobody is on the phone right now</span>
          )}
        </span>
        {data.onDutyNow?.phone ? (
          <a className={`${chipClass} font-medium text-[#C80023] dark:text-red-400`} href={telHref(data.onDutyNow.phone)}>
            <Phone className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            {formatPhone(data.onDutyNow.phone)}
          </a>
        ) : null}

        {data.unreadConversations > 0 ? (
        <Link className={chipClass} to="/messages">
          <MessageSquare className="h-4 w-4 flex-shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
          <span className="font-medium text-slate-900 dark:text-white">{data.unreadConversations}</span>
          unread
        </Link>
        ) : null}
        {waitingApplications > 0 ? (
        <Link className={chipClass} to="/admin/applications">
          <ClipboardList className="h-4 w-4 flex-shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
          <span className="font-medium text-slate-900 dark:text-white">{waitingApplications}</span>
          waiting
        </Link>
        ) : null}
        {data.overdueEquipment > 0 ? (
        <Link className={chipClass} to="/equipment">
          <Package className="h-4 w-4 flex-shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
          <span className="font-medium text-slate-900 dark:text-white">{data.overdueEquipment}</span>
          overdue
        </Link>
        ) : null}
      </div>
    </div>
  );
}
