/**
 * The bell in the header: tap to see your recent notifications (ride offers,
 * cancellations, announcements). Opening it marks them read. Tapping one that
 * belongs to a trip opens that trip.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, X } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/query';
import { relativeTime } from '@/lib/format';
import { getViewAs } from '@/lib/viewAs';
import type { NotificationsResponse } from '@/types/api';

export function NotificationsBell(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: qk.me.notifications(),
    queryFn: () => api.get<NotificationsResponse>('/api/notifications'),
  });
  const unread = query.data?.unread ?? 0;
  const items = query.data?.notifications ?? [];

  const markRead = useMutation({
    mutationFn: () => api.post('/api/notifications/read', {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.me.notifications() }),
  });

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    // A "View as" preview is read-only; leave the person's notifications as they are.
    if (next && unread > 0 && !getViewAs()) markRead.mutate();
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent | TouchEvent): void => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} new` : 'Notifications'}
        className="relative grid h-11 w-11 place-items-center rounded-lg hover:bg-white/20"
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unread > 0 ? (
          <span className="absolute right-1 top-1 grid h-5 min-w-[20px] place-items-center rounded-full bg-white px-1 text-[11px] font-bold leading-none text-[#EA0029]">
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="fixed inset-x-2 top-16 z-[60] max-h-[70vh] overflow-y-auto rounded-xl border border-slate-200 bg-white text-slate-900 shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 sm:w-96 dark:border-slate-700 dark:bg-slate-900 dark:text-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
            <p className="font-semibold">Notifications</p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close notifications"
              className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400">Nothing yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {items.slice(0, 20).map((n) => {
                const body = (
                  <>
                    <span className="flex items-start justify-between gap-2">
                      <span className="font-medium">{n.title ?? "Update"}</span>
                      {!n.readAt ? <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-[#EA0029]" aria-label="new" /> : null}
                    </span>
                    {n.body ? <span className="mt-0.5 block text-sm text-slate-600 line-clamp-2 dark:text-slate-300">{n.body}</span> : null}
                    <span className="mt-1 block text-xs text-slate-400">{relativeTime(n.createdAt)}</span>
                  </>
                );
                return (
                  <li key={n.id}>
                    {n.tripId ? (
                      <button
                        type="button"
                        className="block w-full px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                        onClick={() => {
                          setOpen(false);
                          navigate(`/trips/${n.tripId}`);
                        }}
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="px-4 py-3">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
