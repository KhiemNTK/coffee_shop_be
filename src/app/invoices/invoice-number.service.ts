import { Injectable } from '@nestjs/common';

@Injectable()
export class InvoiceNumberService {
  async generate(tx: any, createdAt = new Date()) {
    const prefix = this.getPrefix(createdAt);
    const latest = await tx.invoice.findFirst({
      where: {
        invoiceNumber: {
          startsWith: prefix,
        },
      },
      orderBy: {
        invoiceNumber: 'desc',
      },
      select: {
        invoiceNumber: true,
      },
    });

    const nextSequence = this.getNextSequence(latest?.invoiceNumber);
    return `${prefix}-${String(nextSequence).padStart(6, '0')}`;
  }

  private getPrefix(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `INV-${year}${month}${day}`;
  }

  private getNextSequence(invoiceNumber?: string | null) {
    if (!invoiceNumber) return 1;

    const sequence = Number(invoiceNumber.split('-').at(-1));
    return Number.isFinite(sequence) ? sequence + 1 : 1;
  }
}
