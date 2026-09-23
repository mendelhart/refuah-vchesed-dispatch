import type { NotificationPreference } from '@rvc/shared';

/**
 * The four ways a volunteer can be reached. Each volunteer picks one in
 * Settings; dispatchers can switch it for them from Volunteers or People.
 */
export const CHANNEL_CHOICES: Array<{ value: NotificationPreference; label: string; short: string }> = [
  { value: 'push', label: 'App notifications', short: 'App' },
  { value: 'sms', label: 'Text message (SMS)', short: 'SMS' },
  { value: 'whatsapp', label: 'WhatsApp', short: 'WhatsApp' },
  { value: 'voice', label: 'Phone call (English)', short: 'Voice call' },
];

/** Older values still stored for some people, shown until someone changes them. */
const LEGACY: Partial<Record<NotificationPreference, string>> = {
  both: 'Text + app (older setting)',
  all: 'Every channel (older setting)',
  email: 'Email (older setting)',
  none: 'App only, no alerts (older setting)',
};

export function channelOptions(current?: string | null): Array<{ value: string; label: string }> {
  const opts = CHANNEL_CHOICES.map((c) => ({ value: c.value as string, label: c.label }));
  if (current && !CHANNEL_CHOICES.some((c) => c.value === current)) {
    opts.push({ value: current, label: LEGACY[current as NotificationPreference] ?? current });
  }
  return opts;
}

export function channelShort(value?: string | null): string {
  const c = CHANNEL_CHOICES.find((x) => x.value === value);
  if (c) return c.short;
  return value ? (LEGACY[value as NotificationPreference] ?? value) : 'SMS';
}
