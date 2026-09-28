import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const PICKUP_SLOT_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

export interface PickupSchedule {
  capacity: number;
  openMinute: number;
  closeMinute: number;
  leadMinutes: number;
  daysAhead: number;
}

export function readPickupSchedule(
  config: ConfigService,
): PickupSchedule | null {
  const capacity = config.get<number>('ONLINE_PICKUP_SLOT_CAPACITY');
  if (!capacity) return null;
  const minute = (key: string) => {
    const value = config.getOrThrow<string>(key);
    return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  };
  return {
    capacity,
    openMinute: minute('ONLINE_PICKUP_OPEN_LOCAL'),
    closeMinute: minute('ONLINE_PICKUP_CLOSE_LOCAL'),
    leadMinutes: config.get<number>('ONLINE_PICKUP_MIN_LEAD_MINUTES', 45),
    daysAhead: config.get<number>('ONLINE_PICKUP_DAYS_AHEAD', 7),
  };
}

export function assertPickupAt(
  pickupAt: Date,
  schedule: PickupSchedule | null,
  now: Date,
) {
  if (!schedule)
    throw new ConflictException('Scheduled pickup is not enabled.');
  const time = pickupAt.getTime();
  const localMinute =
    (pickupAt.getUTCHours() * 60 + pickupAt.getUTCMinutes() + 420) % 1440;
  if (
    !Number.isFinite(time) ||
    time < now.getTime() + schedule.leadMinutes * 60_000 ||
    time > now.getTime() + schedule.daysAhead * DAY_MS ||
    localMinute < schedule.openMinute ||
    localMinute >= schedule.closeMinute ||
    localMinute % 15 !== 0 ||
    pickupAt.getUTCSeconds() !== 0 ||
    pickupAt.getUTCMilliseconds() !== 0
  ) {
    throw new ConflictException('Pickup time is outside available slots.');
  }
}

export function pickupSlotsForDate(
  date: string,
  schedule: PickupSchedule,
  now: Date,
) {
  const localMidnight = new Date(`${date}T00:00:00+07:00`).getTime();
  const earliest = now.getTime() + schedule.leadMinutes * 60_000;
  const latest = now.getTime() + schedule.daysAhead * DAY_MS;
  const slots: Date[] = [];
  for (
    let minute = schedule.openMinute;
    minute < schedule.closeMinute;
    minute += 15
  ) {
    const pickupAt = localMidnight + minute * 60_000;
    if (pickupAt >= earliest && pickupAt <= latest)
      slots.push(new Date(pickupAt));
  }
  return slots;
}

export function vietnamDate(date: Date) {
  return new Date(date.getTime() + VIETNAM_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}
