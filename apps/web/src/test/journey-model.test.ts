import { describe, expect, it } from 'vitest';
import { blankJourney, buildJourneyPayload, journeyIsUsed, rideCount, seatsNeeded } from '@/components/journey-model';

describe('journey model', () => {
  it('a blank journey is not used, so the form sends a single ride as before', () => {
    expect(journeyIsUsed(blankJourney())).toBe(false);
  });

  it('a ride home, a stop or a passenger each make it a journey', () => {
    expect(journeyIsUsed({ ...blankJourney(), returnChoice: 'call_when_ready' })).toBe(true);
    expect(journeyIsUsed({ ...blankJourney(), stops: [{ line1: 'x', departAt: '' }] })).toBe(true);
    expect(journeyIsUsed({ ...blankJourney(), passengers: [{ name: 'A', mobilityNeeds: [], seats: 1 }] })).toBe(true);
  });

  it('builds the request: blank rows dropped, seats kept between 1 and 8', () => {
    const body = buildJourneyPayload({ callerName: 'Sara' }, {
      returnChoice: 'scheduled', returnAt: '2026-10-05T16:00', expectedAt: '',
      stops: [{ line1: ' 5600 Avenue Durocher ', departAt: '2026-10-05T12:00' }, { line1: '  ', departAt: '' }],
      passengers: [{ name: 'Sara', mobilityNeeds: ['wheelchair'], seats: 1 }, { name: '', mobilityNeeds: [], seats: 2 }, { name: 'Group', mobilityNeeds: [], seats: 40 }],
    });
    expect(body.trip).toEqual({ callerName: 'Sara' });
    expect((body.stops as Array<{ address: { line1: string } }>).map((s) => s.address.line1)).toEqual(['5600 Avenue Durocher']);
    expect((body.return as { mode: string }).mode).toBe('scheduled');
    expect((body.passengers as Array<{ seats: number }>).map((p) => p.seats)).toEqual([1, 8]);
  });

  it('call when ready sends no time unless an expected one is given', () => {
    const body = buildJourneyPayload({}, { ...blankJourney(), returnChoice: 'call_when_ready' });
    expect(body.return).toEqual({ mode: 'call_when_ready', expectedAt: null });
  });

  it('counts rides and seats for the button and the warning', () => {
    const d = { ...blankJourney(), returnChoice: 'scheduled' as const, stops: [{ line1: 'a', departAt: '' }], passengers: [{ name: 'A', mobilityNeeds: [], seats: 2 }, { name: 'B', mobilityNeeds: [], seats: 1 }] };
    expect(rideCount(d)).toBe(3);
    expect(seatsNeeded(d)).toBe(3);
    expect(rideCount({ ...d, returnChoice: 'call_when_ready' })).toBe(2);
  });
});
