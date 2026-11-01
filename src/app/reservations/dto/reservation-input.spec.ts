import {
  CreatePublicReservationRequestDto,
  CreateReservationDto,
  GetAvailableReservationTablesDto,
  UpdateReservationDto,
} from './reservation.dto';
import { UpdateRoleInputSchema } from '../../roles/dto/update-role.dto';

describe('Reservation and role input contracts', () => {
  const input = {
    customerName: 'Guest',
    phoneNumber: '+84 (912) 345-678',
    startsAt: '2027-01-01T08:00:00Z',
    endsAt: '2027-01-01T09:00:00Z',
    guestCount: 2,
    tableId: '10000000-0000-4000-8000-000000000001',
  };
  it('normalizes formatted phone numbers consistently for public, staff and edits', () => {
    for (const schema of [
      CreatePublicReservationRequestDto.schema,
      CreateReservationDto.schema,
      UpdateReservationDto.schema,
    ])
      expect(schema.parse(input).phoneNumber).toBe('+84912345678');
  });
  it.each([
    '++++++++',
    '()--()--',
    '1234567',
    '1+23456789',
    '++84912345678',
    '1234567890123456',
    '090abc1234',
  ])('rejects a non-contactable phone: %s', (phoneNumber) => {
    expect(
      CreatePublicReservationRequestDto.schema.safeParse({
        ...input,
        phoneNumber,
      }).success,
    ).toBe(false);
  });
  it('bounds availability pagination and rejects reversed or invalid identities', () => {
    expect(
      GetAvailableReservationTablesDto.schema.safeParse(input).success,
    ).toBe(true);
    for (const bad of [
      { page: 0 },
      { itemPerPage: 101 },
      { excludeReservationId: 0 },
      { tableId: 'invalid' },
    ]) {
      const result = GetAvailableReservationTablesDto.schema.safeParse({
        ...input,
        ...bad,
      });
      expect(result.success).toBe(false);
    }
    expect(
      GetAvailableReservationTablesDto.schema.safeParse({
        ...input,
        startsAt: input.endsAt,
        endsAt: input.startsAt,
      }).success,
    ).toBe(false);
  });
  it('fails closed for role edits without an observed version or changed field', () => {
    expect(UpdateRoleInputSchema.safeParse({ name: 'Renamed' }).success).toBe(
      false,
    );
    expect(
      UpdateRoleInputSchema.safeParse({ expectedUpdatedAt: input.startsAt })
        .success,
    ).toBe(false);
    expect(
      UpdateRoleInputSchema.parse({
        description: null,
        expectedUpdatedAt: input.startsAt,
      }),
    ).toMatchObject({ description: null, expectedUpdatedAt: expect.any(Date) });
  });
});
