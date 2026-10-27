import { ShiftStatus } from '@prisma/client';
import { CashierShiftsController } from './cashier-shifts.controller';
import { CashierShiftsService } from './cashier-shifts.service';
import { GetCashierShiftsDto } from './dto';

describe('Cashier handover history scope', () => {
  it('ignores client-supplied employee and status filters for own closed shifts', async () => {
    const service = { findAll: jest.fn() };
    const controller = new CashierShiftsController(
      service as unknown as CashierShiftsService,
    );
    await controller.findMyClosedShifts(
      'authenticated-cashier',
      GetCashierShiftsDto.schema.parse({
        employeeId: '10000000-0000-4000-8000-000000000002',
        status: ShiftStatus.OPEN,
        page: 2,
        itemPerPage: 20,
      }),
    );
    expect(service.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: 'authenticated-cashier',
        status: ShiftStatus.CLOSED,
        page: 2,
        itemPerPage: 20,
      }),
    );
  });
});
