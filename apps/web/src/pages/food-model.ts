/** Pure helpers for the food screens (unit-tested in test/food-model.test.ts). */

export interface SlotOccurrence {
  slotId: string;
  date: string;
  title: string;
  startMinute: number;
  endMinute: number;
  staffNeeded: number;
  signedUp: number;
  stillNeeded: number;
  iAmSignedUp: boolean;
  names?: string[];
  notes: string | null;
  items: Array<{ name: string; unit: string; quantity: number }>;
}

/** Occurrences grouped by day, in date order, for a phone-friendly list. */
export function groupByDay(slots: SlotOccurrence[]): Array<{ date: string; slots: SlotOccurrence[] }> {
  const map = new Map<string, SlotOccurrence[]>();
  for (const s of [...slots].sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)) {
    map.set(s.date, [...(map.get(s.date) ?? []), s]);
  }
  return [...map.entries()].map(([date, list]) => ({ date, slots: list }));
}

/** Plain words for how staffed a slot is. */
export function staffingLabel(s: Pick<SlotOccurrence, 'staffNeeded' | 'signedUp' | 'stillNeeded'>): string {
  if (s.stillNeeded === 0) return `Full: ${s.signedUp} of ${s.staffNeeded}`;
  return `${s.stillNeeded} more ${s.stillNeeded === 1 ? 'person' : 'people'} needed (${s.signedUp} of ${s.staffNeeded})`;
}

/** "Tuesday 7 October" from 2026-10-07, without time-zone surprises. */
export function dayLabel(date: string, locale = 'en-CA'): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12)).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** Parses "6 dozen eggs"-style lines from a text box into list items. */
export function parseShoppingLines(text: string): Array<{ name: string; quantity: number; unit: string }> {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d+(?:[.,]\d+)?)\s*([a-zA-Zé]+)?\s+(.+)$/);
      if (!m) return { name: line, quantity: 1, unit: 'each' };
      const qty = Number(m[1]!.replace(',', '.'));
      return m[2] && m[3] ? { name: m[3], quantity: qty, unit: m[2] } : { name: m[3] ?? line, quantity: qty, unit: 'each' };
    });
}
