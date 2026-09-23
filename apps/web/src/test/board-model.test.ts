import { describe, expect, it } from 'vitest';
import type { TripDto } from '@rvc/shared';
import { SEGMENTS, boardListParams, dayBounds, findRestPeriod, groupBoardTrips } from '@/pages/board-model';

function trip(id: string, priority: string, pickupAt: string, isOverdue = false): TripDto {
  return { id, priority, pickupAt, isOverdue } as unknown as TripDto;
}

describe('board tabs', () => {
  it('opens on "Need driver", which includes expired offers', () => {
    expect(SEGMENTS[0]!.id).toBe('needs-driver');
    expect(SEGMENTS[0]!.status).toContain('expired');
  });

  it('every status an open ride can have shows up in some tab', () => {
    const covered = new Set(SEGMENTS.flatMap((s) => s.status ?? []));
    for (const status of ['new', 'pending', 'expired', 'offered', 'assigned', 'accepted', 'en_route', 'in_progress']) {
      expect(covered.has(status as never)).toBe(true);
    }
  });

  it('Completed asks for history, the others for the live board', () => {
    const completed = SEGMENTS.find((s) => s.id === 'completed')!;
    expect(boardListParams(completed, '').scope).toBe('history');
    expect(boardListParams(SEGMENTS[0]!, '').scope).toBe('board');
  });

  it('Today is limited to the local day and search is passed through', () => {
    const today = SEGMENTS.find((s) => s.id === 'today')!;
    const now = new Date(2026, 8, 23, 15, 30);
    const params = boardListParams(today, 'cohen', now);
    expect(params.search).toBe('cohen');
    expect(params.from).toBe(dayBounds(now).from);
    expect(new Date(params.from!).getHours()).toBe(0);
    expect(new Date(params.to!).getHours()).toBe(23);
    expect(boardListParams(SEGMENTS[0]!, '').from).toBeUndefined();
  });
});

describe('board ordering', () => {
  it('puts overdue first, then emergency, urgent, routine, then earliest pickup', () => {
    const grouped = groupBoardTrips([
      trip('routine-late', 'routine', '2026-09-23T18:00:00Z'),
      trip('routine-early', 'routine', '2026-09-23T09:00:00Z'),
      trip('urgent', 'urgent', '2026-09-23T20:00:00Z'),
      trip('emergency', 'emergency', '2026-09-23T21:00:00Z'),
      trip('overdue', 'routine', '2026-09-23T22:00:00Z', true),
    ]);
    expect(grouped.all.map((t) => t.id)).toEqual(['overdue', 'emergency', 'urgent', 'routine-early', 'routine-late']);
    expect(grouped.needsAttention.map((t) => t.id)).toEqual(['overdue', 'emergency']);
    expect(grouped.urgent.map((t) => t.id)).toEqual(['urgent']);
    expect(grouped.scheduled.map((t) => t.id)).toEqual(['routine-early', 'routine-late']);
    expect(grouped.total).toBe(5);
  });

  it('never shows a ride in two sections', () => {
    const grouped = groupBoardTrips([
      trip('a', 'urgent', '2026-09-23T10:00:00Z', true),
      trip('b', 'emergency', '2026-09-23T10:00:00Z', true),
      trip('c', 'routine', '2026-09-23T10:00:00Z'),
    ]);
    const ids = [...grouped.needsAttention, ...grouped.urgent, ...grouped.scheduled].map((t) => t.id);
    expect(ids.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('rest periods', () => {
  const shabbos = { startsAt: '2026-09-25T22:30:00Z', endsAt: '2026-09-26T23:35:00Z', label: 'Shabbos', kind: 'shabbat' };
  it('marks a pickup inside Shabbos and not one outside it', () => {
    expect(findRestPeriod([shabbos], '2026-09-26T12:00:00Z')?.label).toBe('Shabbos');
    expect(findRestPeriod([shabbos], '2026-09-25T20:00:00Z')).toBeNull();
    expect(findRestPeriod([shabbos], 'garbage')).toBeNull();
  });
});
