import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type Invoice,
  PaymentStatus,
  Prisma,
  ServeStatus,
  SessionStatus,
} from '@prisma/client';
import {
  type ExtendedPrismaClient,
  PRISMA_SERVICE_TOKEN,
} from '../../common/prisma/prisma.service';
import { assertActiveEmployee } from '../../common/prisma/employee.util';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { runSerializableTransaction as executeSerializableTransaction } from '../../common/prisma/transaction.util';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import {
  GetOpenTakeawayFeedbackCasesDto,
  GetTakeawayFeedbackDto,
  GetTakeawayFeedbackSummaryDto,
  ResolveTakeawayFeedbackDto,
  SubmitTakeawayFeedbackDto,
} from './dto';
import { PUBLIC_TAKEAWAY_FEEDBACK_SELECT } from './takeaway-feedback.select';

const PICKUP_CODE_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_PICKUP_CODE_VERSION = 2_147_483_647;

const PICKUP_INVOICE_SELECT = {
  createdAt: true,
  paymentStatus: true,
  pickupCodeVersion: true,
  pickupCodeIssuedAt: true,
  orderSession: { select: { tableId: true, sessionStatus: true } },
  orderItems: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      quantity: true,
      selectedOptions: true,
      serveStatus: true,
      isPaid: true,
      menuItem: { select: { name: true } },
    },
  },
} satisfies Prisma.InvoiceSelect;

type PickupInvoice = Prisma.InvoiceGetPayload<{
  select: typeof PICKUP_INVOICE_SELECT;
}>;
type PickupCodeState = Pick<
  Invoice,
  'createdAt' | 'pickupCodeVersion' | 'pickupCodeIssuedAt'
>;

@Injectable()
export class TakeawayService {
  private readonly pickupCodeKey: Buffer;
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN) private readonly prisma: ExtendedPrismaClient,
    private readonly pagination: PaginationUtilService,
    config: ConfigService,
  ) {
    this.pickupCodeKey = createHmac(
      'sha256',
      config.getOrThrow<string>('JWT_SECRET'),
    )
      .update('takeaway-pickup-code:v1')
      .digest();
  }

  private runSerializableTransaction<T>(
    callback: (tx: ExtendedPrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    return executeSerializableTransaction(this.prisma, callback, {
      loggerContext: 'Orders transaction',
    });
  }

  issuePickupCode(invoiceId: string, employeeId: string) {
    return this.provisionPickupCode(invoiceId, employeeId);
  }

  rotatePickupCode(invoiceId: string, currentCode: string, employeeId: string) {
    return this.provisionPickupCode(invoiceId, employeeId, currentCode);
  }

  async revokePickupCode(
    invoiceId: string,
    currentCode: string,
    employeeId: string,
  ) {
    return this.runSerializableTransaction(async (tx) => {
      await assertActiveEmployee(tx, employeeId);
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: PICKUP_INVOICE_SELECT,
      });
      this.assertPickupInvoice(invoice);
      if (!this.verifyPickupCode(invoiceId, currentCode, invoice)) {
        throw new ConflictException('Pickup code changed or expired.');
      }
      const nextVersion = this.nextPickupCodeVersion(invoice.pickupCodeVersion);
      const updated = await tx.invoice.updateMany({
        where: {
          id: invoiceId,
          paymentStatus: PaymentStatus.PAID,
          pickupCodeVersion: invoice.pickupCodeVersion,
          pickupCodeIssuedAt: invoice.pickupCodeIssuedAt,
        },
        data: { pickupCodeVersion: nextVersion, pickupCodeIssuedAt: null },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Pickup code changed. Please retry.');
      }
      await tx.actionLog.create({
        data: {
          employeeId,
          actionType: 'PICKUP_CODE_REVOKED',
          details: { invoiceId },
        },
      });
      return { revoked: true };
    });
  }

  async getPickupStatus(invoiceId: string, code: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        ...PICKUP_INVOICE_SELECT,
        takeawayFeedback: { select: PUBLIC_TAKEAWAY_FEEDBACK_SELECT },
      },
    });
    this.assertPickupInvoice(invoice);
    const expiresAt = this.verifyPickupCode(invoiceId, code, invoice);
    if (!expiresAt) {
      throw new NotFoundException('Pickup code is not available.');
    }
    const statuses = invoice.orderItems.map((item) => item.serveStatus);
    const available = (status: ServeStatus) =>
      status === ServeStatus.READY || status === ServeStatus.SERVED;
    let status = 'PREPARING';
    if (statuses.every((value) => value === ServeStatus.SERVED)) {
      status = 'COLLECTED';
    } else if (statuses.every(available)) {
      status = 'READY';
    } else if (statuses.some(available)) {
      status = 'PARTIALLY_READY';
    }
    return {
      invoiceId,
      status,
      expiresAt,
      feedback: invoice.takeawayFeedback ?? null,
      items: invoice.orderItems.map((item) => ({
        id: item.id,
        name: item.menuItem.name,
        quantity: item.quantity,
        serveStatus: item.serveStatus,
      })),
    };
  }

  submitTakeawayFeedback({
    invoiceId,
    code,
    rating,
    comment,
  }: SubmitTakeawayFeedbackDto) {
    const normalizedComment = comment?.trim() || null;
    return this.runSerializableTransaction(async (tx) => {
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: PICKUP_INVOICE_SELECT,
      });
      this.assertPickupInvoice(invoice);
      if (!this.verifyPickupCode(invoiceId, code, invoice)) {
        throw new NotFoundException('Pickup code is not available.');
      }
      if (
        !invoice.orderItems.every(
          (item) => item.serveStatus === ServeStatus.SERVED,
        )
      ) {
        throw new ConflictException('Order is not collected yet.');
      }

      await tx.takeawayFeedback.createMany({
        data: { invoiceId, rating, comment: normalizedComment },
        skipDuplicates: true,
      });
      const feedback = await tx.takeawayFeedback.findUniqueOrThrow({
        where: { invoiceId },
        select: { id: true, rating: true, comment: true, createdAt: true },
      });
      if (
        feedback.rating !== rating ||
        feedback.comment !== normalizedComment
      ) {
        throw new ConflictException(
          'Feedback already exists for this invoice.',
        );
      }
      return feedback;
    });
  }

  async getTakeawayFeedbackSummary(query: GetTakeawayFeedbackSummaryDto) {
    const period = this.feedbackPeriod(query);
    const groups = await this.prisma.takeawayFeedback.groupBy({
      by: ['rating'],
      where: { createdAt: { gte: period.from, lte: period.to } },
      _count: { _all: true },
    });
    const ratings = [1, 2, 3, 4, 5].map((rating) => ({ rating, count: 0 }));
    for (const group of groups) {
      ratings[group.rating - 1].count = group._count._all;
    }
    const total = ratings.reduce((sum, item) => sum + item.count, 0);
    const weighted = ratings.reduce(
      (sum, item) => sum + item.rating * item.count,
      0,
    );
    return {
      ...period,
      total,
      averageRating: total ? Math.round((weighted / total) * 100) / 100 : null,
      ratings,
    };
  }

  async getTakeawayFeedback(query: GetTakeawayFeedbackDto) {
    const period = this.feedbackPeriod(query);
    const where: Prisma.TakeawayFeedbackWhereInput = {
      createdAt: { gte: period.from, lte: period.to },
      ...(query.rating ? { rating: query.rating } : {}),
    };
    const totalItems = await this.prisma.takeawayFeedback.count({ where });
    const paging = this.pagination.paging({ ...query, totalItems });
    const list = await this.prisma.takeawayFeedback.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        invoice: { select: { invoiceNumber: true } },
      },
    });
    return paging.format(list);
  }

  async getOpenTakeawayFeedbackCases(query: GetOpenTakeawayFeedbackCasesDto) {
    const where: Prisma.TakeawayFeedbackWhereInput = {
      rating: { lte: 2 },
      resolvedAt: null,
    };
    const totalItems = await this.prisma.takeawayFeedback.count({ where });
    const paging = this.pagination.paging({ ...query, totalItems });
    const list = await this.prisma.takeawayFeedback.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        invoice: { select: { invoiceNumber: true } },
      },
    });
    return paging.format(list);
  }

  resolveTakeawayFeedback(
    id: string,
    employeeId: string,
    { resolutionNote, customerReply }: ResolveTakeawayFeedbackDto,
  ) {
    return this.runSerializableTransaction(async (tx) => {
      await assertActiveEmployee(tx, employeeId);
      const feedback = await tx.takeawayFeedback.findUnique({
        where: { id },
        select: {
          id: true,
          invoiceId: true,
          rating: true,
          resolvedAt: true,
          resolutionNote: true,
          customerReply: true,
          resolvedById: true,
        },
      });
      if (!feedback) {
        throw new NotFoundException('Takeaway feedback not found.');
      }
      if (feedback.rating > 2) {
        throw new BadRequestException(
          'Only low-rated feedback can be resolved.',
        );
      }
      if (feedback.resolvedAt) {
        if (
          feedback.resolutionNote === resolutionNote &&
          (feedback.customerReply ?? null) === (customerReply ?? null) &&
          feedback.resolvedById === employeeId
        ) {
          return {
            id: feedback.id,
            rating: feedback.rating,
            resolvedAt: feedback.resolvedAt,
            resolutionNote: feedback.resolutionNote,
            customerReply: feedback.customerReply ?? null,
            resolvedById: feedback.resolvedById,
          };
        }
        throw new ConflictException('Takeaway feedback is already resolved.');
      }

      const resolvedAt = new Date();
      const updated = await tx.takeawayFeedback.updateMany({
        where: { id, rating: { lte: 2 }, resolvedAt: null },
        data: {
          resolvedAt,
          resolutionNote,
          customerReply: customerReply ?? null,
          resolvedById: employeeId,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Takeaway feedback is already resolved.');
      }
      await tx.actionLog.create({
        data: {
          employeeId,
          actionType: 'TAKEAWAY_FEEDBACK_RESOLVED',
          details: { feedbackId: id, invoiceId: feedback.invoiceId },
        },
      });
      return {
        id,
        rating: feedback.rating,
        resolvedAt,
        resolutionNote,
        customerReply: customerReply ?? null,
        resolvedById: employeeId,
      };
    });
  }

  private feedbackPeriod({ from, to }: { from?: Date; to?: Date }) {
    const end = to ?? new Date();
    const start = from ?? new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (start > end) {
      throw new BadRequestException('from must not be after to.');
    }
    return { from: start, to: end };
  }

  private provisionPickupCode(
    invoiceId: string,
    employeeId: string,
    currentCode?: string,
  ) {
    return this.runSerializableTransaction(async (tx) => {
      await assertActiveEmployee(tx, employeeId);
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: PICKUP_INVOICE_SELECT,
      });
      this.assertPickupInvoice(invoice);
      const currentExpiry = this.getPickupCodeExpiry(invoice);
      if (
        currentCode !== undefined &&
        !this.verifyPickupCode(invoiceId, currentCode, invoice)
      ) {
        throw new ConflictException('Pickup code changed or expired.');
      }
      if (
        currentCode === undefined &&
        currentExpiry &&
        currentExpiry.getTime() > Date.now()
      ) {
        return {
          invoiceId,
          code: this.signPickupCode(invoiceId, invoice.pickupCodeVersion),
          expiresAt: currentExpiry,
        };
      }

      const nextVersion = this.nextPickupCodeVersion(invoice.pickupCodeVersion);
      const issuedAt = new Date();
      const updated = await tx.invoice.updateMany({
        where: {
          id: invoiceId,
          paymentStatus: PaymentStatus.PAID,
          pickupCodeVersion: invoice.pickupCodeVersion,
          pickupCodeIssuedAt: invoice.pickupCodeIssuedAt,
        },
        data: {
          pickupCodeVersion: nextVersion,
          pickupCodeIssuedAt: issuedAt,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Pickup code changed. Please retry.');
      }
      await tx.actionLog.create({
        data: {
          employeeId,
          actionType:
            currentCode !== undefined
              ? 'PICKUP_CODE_ROTATED'
              : 'PICKUP_CODE_ISSUED',
          details: { invoiceId },
        },
      });
      return {
        invoiceId,
        code: this.signPickupCode(invoiceId, nextVersion),
        expiresAt: new Date(issuedAt.getTime() + PICKUP_CODE_TTL_MS),
      };
    });
  }

  private assertPickupInvoice(
    invoice: PickupInvoice | null,
  ): asserts invoice is PickupInvoice {
    if (
      !invoice ||
      invoice.paymentStatus !== PaymentStatus.PAID ||
      invoice.orderSession.tableId !== null ||
      invoice.orderSession.sessionStatus === SessionStatus.CANCELLED ||
      invoice.orderItems.length === 0 ||
      invoice.orderItems.some(
        (item) => !item.isPaid || item.serveStatus === ServeStatus.CANCELLED,
      )
    ) {
      throw new NotFoundException('Pickup code is not available.');
    }
  }

  private nextPickupCodeVersion(version: number | null) {
    if (version === MAX_PICKUP_CODE_VERSION) {
      throw new ConflictException('Pickup code can no longer be rotated.');
    }
    return (version ?? 0) + 1;
  }

  private getPickupCodeExpiry(invoice: PickupCodeState) {
    const issuedAt =
      invoice.pickupCodeVersion === null
        ? invoice.createdAt
        : invoice.pickupCodeIssuedAt;
    return issuedAt ? new Date(issuedAt.getTime() + PICKUP_CODE_TTL_MS) : null;
  }

  private signPickupCode(invoiceId: string, version: number | null) {
    return createHmac('sha256', this.pickupCodeKey)
      .update(version === null ? invoiceId : `${invoiceId}:${version}`)
      .digest('base64url');
  }

  // Use the caller's invoice snapshot to keep handoff validation in its transaction.
  verifyPickupCode(invoiceId: string, code: string, invoice: PickupCodeState) {
    const expiresAt = this.getPickupCodeExpiry(invoice);
    if (!expiresAt || expiresAt.getTime() <= Date.now()) {
      return null;
    }
    const expected = Buffer.from(
      this.signPickupCode(invoiceId, invoice.pickupCodeVersion),
    );
    const actual = Buffer.from(code);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      return null;
    }
    return expiresAt;
  }
}
