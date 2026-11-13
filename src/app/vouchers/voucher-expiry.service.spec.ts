import { VoucherExpiryService } from './voucher-expiry.service';
import type { VouchersService } from './vouchers.service';

describe('VoucherExpiryService', () => {
  const originalEnv = process.env.NODE_ENV;
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  });

  it('is disabled in test environments', async () => {
    process.env.NODE_ENV = 'test';
    const releaseExpiredReservations = jest
      .fn()
      .mockResolvedValue({ released: 0 });
    const scheduler = new VoucherExpiryService({
      releaseExpiredReservations,
    } as unknown as VouchersService);
    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(releaseExpiredReservations).not.toHaveBeenCalled();
    await scheduler.onModuleDestroy();
  });

  it('runs every 60 seconds and stops at shutdown', async () => {
    process.env.NODE_ENV = 'development';
    const releaseExpiredReservations = jest
      .fn()
      .mockResolvedValue({ released: 0 });
    const scheduler = new VoucherExpiryService({
      releaseExpiredReservations,
    } as unknown as VouchersService);
    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(59_999);
    expect(releaseExpiredReservations).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(releaseExpiredReservations).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(releaseExpiredReservations).toHaveBeenCalledTimes(2);
    await scheduler.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(releaseExpiredReservations).toHaveBeenCalledTimes(2);
  });

  it('does not overlap slow cleanup jobs and waits for them on shutdown', async () => {
    process.env.NODE_ENV = 'development';
    let complete!: (value: { released: number }) => void;
    const releaseExpiredReservations = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const scheduler = new VoucherExpiryService({
      releaseExpiredReservations,
    } as unknown as VouchersService);
    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(releaseExpiredReservations).toHaveBeenCalledTimes(1);
    complete({ released: 1 });
    await scheduler.onModuleDestroy();
  });
});
