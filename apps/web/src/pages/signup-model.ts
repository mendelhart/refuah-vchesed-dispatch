import type { VolunteerCapability } from '@rvc/shared';
interface AvailabilityWindow { weekday: number; startMinute: number; endMinute: number }
export interface FormState {
  fullName: string;
  email: string;
  phone: string;
  addressLine: string;
  city: string;
  postalCode: string;
  serviceArea: string;
  requestedServices: string[];
  requestedGroups: string[];
  capabilities: VolunteerCapability[];
  hasVehicle: boolean;
  vehicleType: string;
  vehicleSeats: string;
  availabilityNote: string;
  availabilityParts: string[];
  languages: string[];
  otherLanguage: string;
  referredBy: string;
  notes: string;
  notificationPreference: string;
  consentContact: boolean;
  consentBackgroundCheck: boolean;
  website: string;
}

export const EMPTY_FORM: FormState = {
  fullName: '',
  email: '',
  phone: '',
  addressLine: '',
  city: '',
  postalCode: '',
  serviceArea: '',
  requestedServices: [],
  requestedGroups: [],
  capabilities: [],
  hasVehicle: true,
  vehicleType: '',
  vehicleSeats: '',
  availabilityNote: '',
  availabilityParts: [],
  languages: [],
  otherLanguage: '',
  referredBy: '',
  notes: '',
  notificationPreference: 'sms',
  consentContact: false,
  consentBackgroundCheck: false,
  website: '',
};

/** Contiguous day parts become one window, so a full day is one row not three. */
export function buildAvailability(parts: string[]): AvailabilityWindow[] {
  const windows: AvailabilityWindow[] = [];
  for (let weekday = 0; weekday < DAY_NAMES.length; weekday += 1) {
    let open: AvailabilityWindow | null = null;
    for (const part of DAY_PARTS) {
      if (!parts.includes(`${weekday}:${part.key}`)) {
        if (open) windows.push(open);
        open = null;
        continue;
      }
      if (open && open.endMinute === part.startMinute) open.endMinute = part.endMinute;
      else {
        if (open) windows.push(open);
        open = { weekday, startMinute: part.startMinute, endMinute: part.endMinute };
      }
    }
    if (open) windows.push(open);
  }
  return windows;
}

export function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}


export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Rough day parts, so the question can be answered with a thumb in a queue. */
export const DAY_PARTS = [
  { key: 'morning', label: 'Morning', startMinute: 8 * 60, endMinute: 12 * 60 },
  { key: 'afternoon', label: 'Afternoon', startMinute: 12 * 60, endMinute: 17 * 60 },
  { key: 'evening', label: 'Evening', startMinute: 17 * 60, endMinute: 22 * 60 },
] as const;

