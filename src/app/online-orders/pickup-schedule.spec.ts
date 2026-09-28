import { ConflictException } from '@nestjs/common';
import {
  assertPickupAt,
  pickupSlotsForDate,
  type PickupSchedule,
} from './pickup-schedule';

describe('online pickup schedule', () => {
  const schedule: PickupSchedule = {
    capacity: 4,
    openMinute: 7 * 60,
    closeMinute: 22 * 60,
    leadMinutes: 45,
    daysAhead: 7,
  };
  const now = new Date('2026-09-27T12:00:00.000Z');

  it('offers aligned local slots within the lead time and opening hours', () => {
    const slots = pickupSlotsForDate('2026-09-28', schedule, now);
    expect(slots[0].toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(slots.at(-1)?.toISOString()).toBe('2026-09-28T14:45:00.000Z');
    expect(slots).toHaveLength(60);
    expect(() => assertPickupAt(slots[0], schedule, now)).not.toThrow();
  });

  it('rejects disabled, too-soon and off-grid pickup times', () => {
    expect(() =>
      assertPickupAt(new Date('2026-09-28T00:00:00Z'), null, now),
    ).toThrow(ConflictException);
    expect(() =>
      assertPickupAt(new Date('2026-09-27T12:30:00Z'), schedule, now),
    ).toThrow(ConflictException);
    expect(() =>
      assertPickupAt(new Date('2026-09-28T00:01:00Z'), schedule, now),
    ).toThrow(ConflictException);
    expect(() =>
      assertPickupAt(new Date('2026-09-28T15:00:00Z'), schedule, now),
    ).toThrow(ConflictException);
  });
});
