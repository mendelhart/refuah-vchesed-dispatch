import { Errors } from './errors.js';

/**
 * Phone normalisation to E.164.
 *
 * Everything stored, compared or dialled goes through here. The legacy app
 * compared "the last ten digits", which meant any number ending in the same ten
 * digits matched — that is how an SMS from a spoofed caller-ID could be accepted
 * as a volunteer. Exact E.164 equality replaces it.
 */
const DEFAULT_COUNTRY_CODE = '1'; // Canada / US

export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+${DEFAULT_COUNTRY_CODE}${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

export function requirePhone(input: string | null | undefined, field = 'phone'): string {
  const normalized = normalizePhone(input);
  if (!normalized) {
    throw Errors.validation(`${field} is not a valid phone number`, { field });
  }
  return normalized;
}

export function last4(phone: string): string {
  return phone.slice(-4);
}

/** For display to users who are not entitled to the full number. */
export function maskPhone(phone: string): string {
  return `••• ••• ${last4(phone)}`;
}
