import { InvoiceNumberService } from './invoice-number.service';

describe('InvoiceNumberService', () => {
  let service: InvoiceNumberService;

  beforeEach(() => {
    service = new InvoiceNumberService();
  });

  it('generates the first invoice number for a day', async () => {
    const tx = {
      invoice: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    await expect(
      service.generate(tx, new Date('2026-07-28T00:00:00.000Z')),
    ).resolves.toBe('INV-20260728-000001');
  });

  it('increments from the latest invoice number', async () => {
    const tx = {
      invoice: {
        findFirst: jest.fn().mockResolvedValue({
          invoiceNumber: 'INV-20260728-000009',
        }),
      },
    };

    await expect(
      service.generate(tx, new Date('2026-07-28T00:00:00.000Z')),
    ).resolves.toBe('INV-20260728-000010');
  });
});
