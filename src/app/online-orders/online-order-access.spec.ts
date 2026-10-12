import { onlineOrderAccessExpiresAt } from './online-order-access';

describe('online order access expiry', () => {
  const createdAt = new Date('2026-10-01T00:00:00Z');

  it('keeps unscheduled access at 72 hours', () => {
    expect(
      onlineOrderAccessExpiresAt({ createdAt, pickupAt: null }).toISOString(),
    ).toBe('2026-10-04T00:00:00.000Z');
  });

  it('covers scheduled collection with a bounded 24-hour grace period', () => {
    expect(
      onlineOrderAccessExpiresAt({
        createdAt,
        pickupAt: new Date('2026-10-08T10:00:00Z'),
      }).toISOString(),
    ).toBe('2026-10-09T10:00:00.000Z');
  });

  it('does not shorten the original window for a near-term pickup', () => {
    expect(
      onlineOrderAccessExpiresAt({
        createdAt,
        pickupAt: createdAt,
      }).toISOString(),
    ).toBe('2026-10-04T00:00:00.000Z');
  });
});
