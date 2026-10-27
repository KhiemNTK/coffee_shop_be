import { OpenSessionSchema } from './open-session.dto';

describe('POS session opening identity', () => {
  it('requires a UUID key instead of accepting a blind create', () => {
    expect(OpenSessionSchema.safeParse({ tableId: null }).success).toBe(false);
    expect(
      OpenSessionSchema.safeParse({ idempotencyKey: 'invalid' }).success,
    ).toBe(false);
    expect(
      OpenSessionSchema.parse({
        idempotencyKey: '93000000-0000-4000-8000-000000000001',
      }),
    ).toMatchObject({ tableId: null });
  });
});
