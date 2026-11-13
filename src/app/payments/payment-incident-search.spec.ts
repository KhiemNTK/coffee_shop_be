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

  it('returns bounded diagnostic fields and the actual refund amount, not raw provider data', async () => {
    incident.findMany.mockResolvedValue([
      {
        id: 'incident',
        paymentAttempt: { provider: 'VNPAY', amount: '100000' },
        paymentRefund: { amount: '20000', status: 'REQUIRES_REVIEW' },
        details: {
          mismatch: 'AMOUNT',
          response: {
            vnp_Amount: '2000000',
            vnp_ResponseCode: '00',
            vnp_SecureHash: 'never-return',
            customerPhone: 'never-return',
          },
        },
      },
    ]);
    const result = await service.findIncidents(
      GetPaymentIncidentsDto.schema.parse({}),
    );
    expect(result.list[0]).toMatchObject({
      paymentRefund: { amount: '20000' },
      diagnostics: {
        providerAmount: '20000.00',
        reasonCode: 'AMOUNT',
        responseCode: '00',
      },
    });
    expect(result.list[0]).not.toHaveProperty('details');
    expect(JSON.stringify(result)).not.toContain('never-return');
  });
});
