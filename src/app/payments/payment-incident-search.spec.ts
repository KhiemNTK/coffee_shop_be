import { PaymentReconciliationService } from './payment-reconciliation.service';
import { GetPaymentIncidentsDto } from './dto';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';

describe('Payment incident search', () => {
  const incident = { count: jest.fn(), findMany: jest.fn() };
  const service = new PaymentReconciliationService(
    { paymentReconciliationIncident: incident } as never,
    new PaginationUtilService(),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    incident.count.mockResolvedValue(41);
    incident.findMany.mockResolvedValue([]);
  });

  it('uses the same server-side search and status for the count and page', async () => {
    await service.findIncidents(
      GetPaymentIncidentsDto.schema.parse({
        keyword: ' INV-2026 ',
        status: 'OPEN',
        page: 2,
      }),
    );
    const where = incident.count.mock.calls[0][0].where;
    expect(where.status).toBe('OPEN');
    expect(where.OR).toContainEqual({
      paymentAttempt: {
        invoice: {
          invoiceNumber: { contains: 'INV-2026', mode: 'insensitive' },
        },
      },
    });
    expect(incident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where, skip: 20, take: 20 }),
    );
    expect(
      where.OR.some((value: Record<string, unknown>) => 'id' in value),
    ).toBe(false);
  });

  it('matches complete UUIDs without applying text operators to UUID columns', async () => {
    const keyword = '30000000-0000-4000-8000-000000000001';
    await service.findIncidents(
      GetPaymentIncidentsDto.schema.parse({ keyword }),
    );
    expect(incident.count.mock.calls[0][0].where.OR).toEqual(
      expect.arrayContaining([
        { id: keyword },
        { paymentAttemptId: keyword },
        { paymentRefundId: keyword },
        { paymentAttempt: { invoiceId: keyword } },
      ]),
    );
  });

  it('bounds query text at the request boundary', () => {
    expect(
      GetPaymentIncidentsDto.schema.safeParse({ keyword: 'a'.repeat(121) })
        .success,
    ).toBe(false);
  });
});
