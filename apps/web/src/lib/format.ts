/**
 * Presentation helpers. Formatting only — no decisions about what a trip may
 * do next; the server owns that and publishes it as `availableTransitions`.
 */
import type { MobilityNeed, TripPriority, TripStatus, TripType } from '@rvc/shared';

// Times are 12-hour with AM/PM everywhere (Mendel's call, Sept 2026).
const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  hour12: true,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const timeFormat = new Intl.DateTimeFormat('en-US', { hour12: true, hour: 'numeric', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
const monthYearFormat = new Intl.DateTimeFormat('en-CA', { month: 'long', year: 'numeric' });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFormat.format(date);
}
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : timeFormat.format(date);
}
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : dateFormat.format(date);
}
export function formatMonthYear(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : monthYearFormat.format(date);
}

export function isToday(iso: string): boolean {
  const date = new Date(iso);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

/** "in 12 min" / "8 min ago" — short enough for a card line. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return '—';
  const diffMs = target - Date.now();
  const minutes = Math.round(diffMs / 60_000);
  const abs = Math.abs(minutes);
  if (abs < 1) return diffMs >= 0 ? 'now' : 'just now';
  if (abs < 60) return diffMs >= 0 ? `in ${abs} min` : `${abs} min ago`;
  const hours = Math.round(abs / 60);
  if (hours < 24) return diffMs >= 0 ? `in ${hours} h` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  return diffMs >= 0 ? `in ${days} d` : `${days} d ago`;
}

/** mm:ss remaining, or null once it has run out. */
export function countdown(expiresAt: string | null | undefined, now: number = Date.now()): string | null {
  if (!expiresAt) return null;
  const end = new Date(expiresAt).getTime();
  if (Number.isNaN(end)) return null;
  const remaining = end - now;
  if (remaining <= 0) return null;
  const totalSeconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const STATUS_LABELS: Record<TripStatus, string> = {
  new: 'New',
  pending: 'Needs driver',
  offered: 'Offered',
  assigned: 'Assigned',
  accepted: 'Accepted',
  en_route: 'En route',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'No answer',
};

/** Card chip colours carried over from the original app. */
const STATUS_CLASSES: Record<TripStatus, string> = {
  new: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  pending: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  offered: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-300',
  assigned: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  accepted: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  en_route: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
  in_progress: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
  completed: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  expired: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
};

export const statusLabel = (status: TripStatus): string => STATUS_LABELS[status] ?? status;
export const statusClass = (status: TripStatus): string => STATUS_CLASSES[status] ?? STATUS_CLASSES.expired;

const PRIORITY_LABELS: Record<TripPriority, string> = {
  routine: 'Routine',
  urgent: 'Urgent',
  emergency: 'Emergency',
};
const PRIORITY_CLASSES: Record<TripPriority, string> = {
  routine: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  urgent: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  emergency: 'bg-[#EA0029] text-white',
};
export const priorityLabel = (priority: TripPriority): string => PRIORITY_LABELS[priority] ?? priority;
export const priorityClass = (priority: TripPriority): string => PRIORITY_CLASSES[priority] ?? PRIORITY_CLASSES.routine;

/** Urgency ordering for the board: emergency first, then urgent, then routine. */
export const priorityRank = (priority: TripPriority): number =>
  priority === 'emergency' ? 0 : priority === 'urgent' ? 1 : 2;

const TRIP_TYPE_LABELS: Record<TripType, string> = {
  ride: 'Ride',
  equipment_delivery: 'Equipment delivery',
  hospital_food: 'Hospital food',
};
export const tripTypeLabel = (type: TripType): string => TRIP_TYPE_LABELS[type] ?? type;

const MOBILITY_LABELS: Record<MobilityNeed, string> = {
  wheelchair: 'Wheelchair',
  stretcher: 'Stretcher',
  walker: 'Walker',
  oxygen: 'Oxygen',
  attendant: 'Attendant',
  none: 'No special needs',
};
export const mobilityLabel = (need: MobilityNeed): string => MOBILITY_LABELS[need] ?? need;

/** Digits-only tel: href; the display string keeps whatever the API sent. */
export const telHref = (phone: string): string => `tel:${phone.replace(/[^\d+]/g, '')}`;

/**
 * North American numbers read the way people say them: (514) 555-9001.
 * Anything else (international, extensions, partial input) is shown as stored
 * rather than guessed at.
 */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length === 10 && (digits.length === 10 || digits.length === 11)) {
    return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
  }
  return phone;
}

export function titleCase(value: string): string {
  return value
    .replace(/[_.]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A minute of the day as a 12-hour clock: 870 -> "2:30 PM". */
export function formatMinuteOfDay(minuteOfDay: number): string {
  const wrapped = ((minuteOfDay % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
