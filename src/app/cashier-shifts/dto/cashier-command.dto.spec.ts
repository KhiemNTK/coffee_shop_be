import {
  CloseCashierShiftDto,
  CreateCashMovementDto,
  OpenCashierShiftDto,
} from './cashier-shift.dto';

describe('Cashier command preconditions', () => {
  const id = '83000000-0000-4000-8000-000000000001';
  it.each([
    [OpenCashierShiftDto.schema, { fundId: id, startingCash: '0' }],
    [
      CloseCashierShiftDto.schema,
      { expectedShiftId: id, reportedEndingCash: '0' },
    ],
    [
      CreateCashMovementDto.schema,
      {
        expectedShiftId: id,
        type: 'INCOME',
        amount: '10',
        description: 'Cash float',
      },
    ],
  ] as const)('requires a valid idempotency key', (schema, payload) => {
    expect(schema.safeParse(payload).success).toBe(false);
    expect(
      schema.safeParse({ ...payload, idempotencyKey: 'short' }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...payload, idempotencyKey: 'valid-command-key' })
        .success,
    ).toBe(true);
  });

  it.each([
    [CloseCashierShiftDto.schema, { reportedEndingCash: '0' }],
    [
      CreateCashMovementDto.schema,
      { type: 'INCOME', amount: '10', description: 'Cash float' },
    ],
  ] as const)('requires an explicit valid shift target', (schema, payload) => {
    const body = { ...payload, idempotencyKey: 'valid-command-key' };
    expect(schema.safeParse(body).success).toBe(false);
    expect(
      schema.safeParse({ ...body, expectedShiftId: 'invalid' }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...body, expectedShiftId: id }).success).toBe(
      true,
    );
  });
});
