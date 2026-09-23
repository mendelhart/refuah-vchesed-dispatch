/**
 * Settings: who you are, how we reach you, and — the one that keeps people
 * subscribed — how to make it stop for a while.
 */
import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BellOff, BellRing, Eye, EyeOff, Moon, Sun } from 'lucide-react';
import { NOTIFICATION_PREFERENCES, type NotificationPreference } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { formatDateTime } from '@/lib/format';
import { currentSubscription, pushSupported, subscribeToPush, unsubscribeFromPush } from '@/lib/push';
import { NAV_ITEMS, isNavItemHidden, toggleNavPreference } from '@/components/Layout';
import {
  ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, labelClass, primaryButtonClass, secondaryButtonClass,
} from '@/components/states';
import type { MeStatusResponse, MuteResponse, SessionResponse } from '@/types/api';

/**
 * How a volunteer wants to hear from us.
 *
 * Two things this list deliberately does not promise. WhatsApp is always paired
 * with another channel, because a paired session can drop without anybody
 * noticing. And "neither" does not silence a trip they have already accepted
 * being cancelled — that always reaches them.
 */
const PREFERENCE_LABELS: Record<NotificationPreference, string> = {
  sms: 'Text message only',
  push: 'Push notification only',
  whatsapp: 'WhatsApp (with push as a backup)',
  email: 'Email only',
  both: 'Both text and push',
  all: 'Every channel — text, push, WhatsApp and email',
  none: 'Neither — I will check the app',
};

/** 0 clears the mute; the server turns hours into a timestamp. */
const MUTE_OPTIONS = [
  { hours: 4, label: '4 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 24 * 30, label: 'Until I turn it back on' },
];

export function SettingsPage(): React.JSX.Element {
  const { user, refresh } = useAuth();
  const { theme, toggle } = useTheme();
  const queryClient = useQueryClient();

  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [preference, setPreference] = useState<NotificationPreference>(user?.notificationPreference ?? 'both');
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void currentSubscription()
      .then((subscription) => {
        if (!cancelled) setPushOn(Boolean(subscription));
      })
      .catch(() => {
        // No service worker yet, or push blocked — the toggle just reads "off".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const status = useQuery({
    queryKey: qk.me.status(),
    queryFn: () => api.get<MeStatusResponse>('/api/me/status'),
  });

  const saveProfile = useMutation({
    mutationFn: () =>
      api.patch<SessionResponse>('/api/me', {
        fullName: fullName.trim(),
        phone: phone.trim() || null,
        notificationPreference: preference,
      }),
    onSuccess: async () => {
      toast.success('Saved.');
      await refresh();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const mute = useMutation({
    mutationFn: (hours: number) => api.post<MuteResponse>('/api/me/mute', { hours }),
    onSuccess: (data, hours) => {
      void queryClient.invalidateQueries({ queryKey: qk.me.status() });
      toast.success(hours === 0 ? 'Notifications are back on.' : `Muted until ${formatDateTime(data.mutedUntil)}.`);
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const saveNav = useMutation({
    mutationFn: (navHidden: string[]) => api.patch<SessionResponse>('/api/me', { navHidden }),
    onSuccess: async (data) => {
      queryClient.setQueryData(qk.auth.me(), data.user);
      toast.success('Menu updated.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const handlePushToggle = async (): Promise<void> => {
    setPushBusy(true);
    try {
      if (pushOn) {
        await unsubscribeFromPush();
        setPushOn(false);
        toast.success('Push notifications turned off on this device.');
      } else {
        await subscribeToPush();
        setPushOn(true);
        toast.success('Push notifications are on for this device.');
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPushBusy(false);
    }
  };

  const mutedUntil = status.data?.mutedUntil ?? null;
  const isMuted = Boolean(mutedUntil && new Date(mutedUntil).getTime() > Date.now());

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" subtitle="Your details and how we reach you" />

      <section className={cardClass}>
        <form
          className="space-y-4 p-5 md:p-6"
          onSubmit={(event) => {
            event.preventDefault();
            saveProfile.mutate();
          }}
        >
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Your details</h2>
          <div>
            <label htmlFor="settings-name" className={labelClass}>
              Full name
            </label>
            <input id="settings-name" className={inputClass} value={fullName} onChange={(event) => setFullName(event.target.value)} />
          </div>
          <div>
            <label htmlFor="settings-phone" className={labelClass}>
              Mobile number
            </label>
            <input
              id="settings-phone"
              type="tel"
              className={inputClass}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Offers are sent here, and replies are matched back to you by this number.
            </p>
          </div>
          <div>
            <label htmlFor="settings-pref" className={labelClass}>
              How should we reach you?
            </label>
            <select
              id="settings-pref"
              className={inputClass}
              value={preference}
              onChange={(event) => setPreference(event.target.value as NotificationPreference)}
            >
              {NOTIFICATION_PREFERENCES.map((option) => (
                <option key={option} value={option}>
                  {PREFERENCE_LABELS[option]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Signed in as {user?.email} · {user?.role}
            </p>
          </div>
          <button type="submit" className={primaryButtonClass} disabled={saveProfile.isPending}>
            {saveProfile.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </section>

      <section className={cardClass}>
        <div className="space-y-4 p-5 md:p-6">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Quiet time</h2>
          {status.isPending ? (
            <ListSkeleton rows={1} lines={2} />
          ) : status.isError ? (
            <ErrorState error={status.error} onRetry={() => void status.refetch()} what="your notification status" />
          ) : (
            <>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {isMuted
                  ? `You are muted until ${formatDateTime(mutedUntil)}. You will not be offered rides until then.`
                  : 'You are getting offers normally. Mute if you are away, at a simcha, or asleep — it is better than turning notifications off for good.'}
              </p>
              <div className="flex flex-wrap gap-2">
                {MUTE_OPTIONS.map((option) => (
                  <button
                    key={option.hours}
                    type="button"
                    className={secondaryButtonClass}
                    disabled={mute.isPending}
                    onClick={() => mute.mutate(option.hours)}
                  >
                    <BellOff className="h-4 w-4" aria-hidden="true" />
                    {option.label}
                  </button>
                ))}
                {isMuted ? (
                  <button type="button" className={primaryButtonClass} disabled={mute.isPending} onClick={() => mute.mutate(0)}>
                    <BellRing className="h-4 w-4" aria-hidden="true" />
                    Turn notifications back on
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      </section>

      <section className={cardClass}>
        <div className="space-y-4 p-5 md:p-6">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Push on this device</h2>
          {pushSupported() ? (
            <>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {pushOn
                  ? 'This device will buzz when a ride is offered to you.'
                  : 'Turn this on and a ride offer reaches you without opening the app.'}
              </p>
              <button type="button" className={pushOn ? secondaryButtonClass : primaryButtonClass} disabled={pushBusy} onClick={handlePushToggle}>
                <BellRing className="h-4 w-4" aria-hidden="true" />
                {pushBusy ? 'Working…' : pushOn ? 'Turn push off here' : 'Turn push on here'}
              </button>
            </>
          ) : (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              This browser cannot do push notifications. You will still get text messages.
            </p>
          )}
        </div>
      </section>

      <section className={cardClass}>
        <div className="p-5 md:p-6">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Your menu</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Hide the screens you never use. Home and Settings always stay. Hidden screens still
            work — you just will not see them in the menu. Dispatchers start with the volunteer-only
            screens (My rides, My availability and so on) hidden; switch any of them back on here.
          </p>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {NAV_ITEMS.filter(
              (item) =>
                item.roles.includes(user?.role ?? 'volunteer') &&
                item.to !== '/' &&
                item.to !== '/settings',
            ).map((item) => {
              const role = user?.role ?? 'volunteer';
              const hiddenItem = isNavItemHidden(role, user?.navHidden, item.to);
              const nextHidden = toggleNavPreference(role, user?.navHidden, item.to);
              return (
                <li key={item.to}>
                  <button
                    type="button"
                    disabled={saveNav.isPending}
                    onClick={() => saveNav.mutate(nextHidden)}
                    aria-pressed={hiddenItem}
                    className={`flex min-h-[44px] w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                      hiddenItem
                        ? 'border-slate-200 text-slate-400 dark:border-slate-700 dark:text-slate-500'
                        : 'border-slate-300 text-slate-700 dark:border-slate-600 dark:text-slate-200'
                    }`}
                  >
                    {hiddenItem ? <EyeOff className="h-4 w-4 flex-shrink-0" /> : <Eye className="h-4 w-4 flex-shrink-0" />}
                    <span className="flex-1">{item.label}</span>
                    <span className="text-xs">{hiddenItem ? 'Hidden' : 'Shown'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-3 p-5 md:p-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Appearance</h2>
            <p className="text-sm text-slate-600 dark:text-slate-400">Currently {theme} mode.</p>
          </div>
          <button type="button" className={secondaryButtonClass} onClick={toggle}>
            {theme === 'dark' ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
            Switch to {theme === 'dark' ? 'light' : 'dark'}
          </button>
        </div>
      </section>
    </div>
  );
}
