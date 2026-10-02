/**
 * The "more than one ride" part of the new-trip form: a ride home, extra
 * stops and the people riding. Pure functions, unit-tested in
 * src/test/journey-model.test.ts.
 */
import type { MobilityNeed } from '@rvc/shared';

export type ReturnChoice = 'none' | 'scheduled' | 'call_when_ready';

export interface StopDraft { line1: string; departAt: string }
export interface PassengerDraft { name: string; mobilityNeeds: MobilityNeed[]; seats: number }

export interface JourneyDraft {
  returnChoice: ReturnChoice;
  returnAt: string;
  expectedAt: string;
  stops: StopDraft[];
  passengers: PassengerDraft[];
}

export function blankJourney(): JourneyDraft {
  return { returnChoice: 'none', returnAt: '', expectedAt: '', stops: [], passengers: [] };
}

/** True when the form needs the journeys endpoint rather than a single ride. */
export function journeyIsUsed(d: JourneyDraft): boolean {
  return d.returnChoice !== 'none' || d.stops.length > 0 || d.passengers.length > 0;
}

const iso = (local: string): string => new Date(local).toISOString();

/** The body for POST /api/journeys, given the single-ride body the form already builds. */
export function buildJourneyPayload(trip: Record<string, unknown>, d: JourneyDraft): Record<string, unknown> {
  const ret =
    d.returnChoice === 'scheduled'
      ? { mode: 'scheduled', pickupAt: d.returnAt ? iso(d.returnAt) : '' }
      : d.returnChoice === 'call_when_ready'
        ? { mode: 'call_when_ready', expectedAt: d.expectedAt ? iso(d.expectedAt) : null }
        : { mode: 'none' };
  return {
    trip,
    stops: d.stops
      .filter((s) => s.line1.trim())
      .map((s) => ({ address: { line1: s.line1.trim(), city: 'Montreal' }, departAt: s.departAt ? iso(s.departAt) : '' })),
    return: ret,
    passengers: d.passengers
      .filter((p) => p.name.trim())
      .map((p) => ({ name: p.name.trim(), mobilityNeeds: p.mobilityNeeds, seats: Math.min(8, Math.max(1, Math.round(p.seats) || 1)) })),
  };
}

/** How many rides the journey will make, for the button label. */
export function rideCount(d: JourneyDraft): number {
  return 1 + d.stops.filter((s) => s.line1.trim()).length + (d.returnChoice === 'scheduled' ? 1 : 0);
}

export function seatsNeeded(d: JourneyDraft): number {
  return d.passengers.filter((p) => p.name.trim()).reduce((n, p) => n + (Math.round(p.seats) || 1), 0);
}
