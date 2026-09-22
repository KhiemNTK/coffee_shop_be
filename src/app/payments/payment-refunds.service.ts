import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  PaymentAttemptStatus,
  PaymentProviderRequestStatus,
  PaymentProviderRequestType,
  PaymentReconciliationIncidentStatus,
  PaymentReconciliationIncidentType,
  PaymentRefundStatus,
  PaymentRefundType,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { OutboxService } from '../durable/outbox.service';
import { CreatePaymentRefundDto, GetPaymentRefundsDto } from './dto';
import { VnpayService } from './vnpay.service';

const RESERVED_REFUND_STATUSES = [
  PaymentRefundStatus.PENDING,
  PaymentRefundStatus.PROCESSING,
  PaymentRefundStatus.SUCCEEDED,
  PaymentRefundStatus.REQUIRES_REVIEW,
];

const REFUND_INCLUDE = {
  requestedBy: { select: { id: true, fullName: true } },
  paymentAttempt: {
    select: {
      id: true,
      amount: true,
      merchantReference: true,
      providerCreatedAt: true,
      providerTransactionNo: true,
      status: true,
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          paymentStatus: true,
        },
      },
    },
  },
} as const satisfies Prisma.PaymentRefundInclude;

type RefundView = Prisma.PaymentRefundGetPayload<{
  include: typeof REFUND_INCLUDE;
}>;

@Injectable()
export class PaymentRefundsService {
  private readonly logger = new Logger(PaymentRefundsService.name);

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly paginationUtil: PaginationUtilService,
    private readonly outbox: OutboxService,
    private readonly vnpay: VnpayService,
  ) {}

  async createRefund(
    paymentAttemptId: string,
    employeeId: string,
    dto: CreatePaymentRefundDto,
  ) {
    const requestHash = this.requestHash(paymentAttemptId, dto);
    const existing = await this.findIdempotentRefund(
      employeeId,
      dto.idempotencyKey,
    );
    if (existing) {
      this.assertIdempotentReplay(existing, paymentAttemptId, requestHash);
      return existing.status === PaymentRefundStatus.PENDING
        ? this.submitRefund(existing.id)
        : existing;
    }

    this.vnpay.assertApiConfigured();
    try {
      const refund = await runSerializableTransaction(
        this.prisma,
        async (tx) => {
          await this.assertActiveEmployee(tx, employeeId);
          const replay = await tx.paymentRefund.findUnique({
            where: {
              requestedById_idempotencyKey: {
                requestedById: employeeId,
                idempotencyKey: dto.idempotencyKey,
              },
            },
            include: REFUND_INCLUDE,
          });
          if (replay) {
            this.assertIdempotentReplay(replay, paymentAttemptId, requestHash);
            return replay;
          }

          const attempt = await tx.paymentAttempt.findUnique({
            where: { id: paymentAttemptId },
            include: { invoice: { select: { paymentStatus: true } } },
          });
          if (!attempt) {
            throw new NotFoundException(
              `Payment attempt with ID ${paymentAttemptId} not found.`,
            );
          }
          if (
            attempt.status !== PaymentAttemptStatus.SUCCEEDED ||
            !attempt.providerTransactionNo
          ) {
            throw new ConflictException(
              'Only a confirmed provider payment can be refunded.',
            );
          }
          if (
            attempt.invoice.paymentStatus !== PaymentStatus.PAID &&
            attempt.invoice.paymentStatus !== PaymentStatus.PARTIALLY_REFUNDED
          ) {
            throw new ConflictException(
              'The invoice is not in a refundable state.',
            );
          }

          const amount = new Prisma.Decimal(dto.amount);
          const reserved = await tx.paymentRefund.aggregate({
            where: {
              paymentAttemptId,
              status: { in: RESERVED_REFUND_STATUSES },
            },
            _sum: { amount: true },
          });
          const reservedAmount = reserved._sum.amount ?? new Prisma.Decimal(0);
          const remaining = attempt.amount.minus(reservedAmount);
          if (amount.gt(remaining)) {
            throw new ConflictException(
              `Refund amount exceeds the remaining refundable amount (${remaining.toFixed(2)} VND).`,
            );
          }

          const type =
            reservedAmount.isZero() && amount.equals(attempt.amount)
              ? PaymentRefundType.FULL
              : PaymentRefundType.PARTIAL;
          const created = await tx.paymentRefund.create({
            data: {
              type,
              amount,
              reason: dto.reason,
              idempotencyKey: dto.idempotencyKey,
              requestHash,
              providerRequestId: randomUUID().replaceAll('-', ''),
              paymentAttemptId,
              requestedById: employeeId,
            },
            include: REFUND_INCLUDE,
          });
          await this.log(tx, employeeId, 'PAYMENT_REFUND_REQUESTED', {
            paymentRefundId: created.id,
            paymentAttemptId,
            amount: amount.toFixed(2),
            type,
            reason: dto.reason,
          });
          await this.enqueue(tx, 'PAYMENT_REFUND_REQUESTED', created);
          return created;
        },
      );
      return refund.status === PaymentRefundStatus.PENDING
        ? this.submitRefund(refund.id)
        : refund;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const replay = await this.findIdempotentRefund(
          employeeId,
          dto.idempotencyKey,
        );
        if (replay) {
          this.assertIdempotentReplay(replay, paymentAttemptId, requestHash);
          return replay.status === PaymentRefundStatus.PENDING
            ? this.submitRefund(replay.id)
            : replay;
        }
      }
      throw error;
    }
  }

  async findRefunds(paymentAttemptId: string, query: GetPaymentRefundsDto) {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { id: paymentAttemptId },
      select: { id: true },
    });
    if (!attempt) {
      throw new NotFoundException(
        `Payment attempt with ID ${paymentAttemptId} not found.`,
      );
    }
    const where: Prisma.PaymentRefundWhereInput = {
      paymentAttemptId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };
    const totalItems = await this.prisma.paymentRefund.count({ where });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const refunds = await this.prisma.paymentRefund.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      include: REFUND_INCLUDE,
    });
    return paging.format(refunds);
  }

  async findRefund(id: string) {
    const refund = await this.prisma.paymentRefund.findUnique({
      where: { id },
      include: REFUND_INCLUDE,
    });
    if (!refund) {
      throw new NotFoundException(`Payment refund with ID ${id} not found.`);
    }
    return refund;
  }

  async recoverPendingRefunds() {
    const refunds = await this.prisma.paymentRefund.findMany({
      where: {
        status: PaymentRefundStatus.PENDING,
        requestedAt: { lt: new Date(Date.now() - 60_000) },
      },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      take: 25,
      select: { id: true },
    });
    for (const refund of refunds) {
      try {
        await this.submitRefund(refund.id);
      } catch (error) {
        this.logger.error(
          `Pending refund ${refund.id} could not be resumed.`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
    return refunds.length;
  }

  private async submitRefund(id: string) {
    const claimed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.paymentRefund.updateMany({
        where: { id, status: PaymentRefundStatus.PENDING },
        data: {
          status: PaymentRefundStatus.PROCESSING,
          reconciliationLockedAt: new Date(),
        },
      });
      if (result.count !== 1) return null;
      const refund = await tx.paymentRefund.findUnique({
        where: { id },
        include: REFUND_INCLUDE,
      });
      if (!refund) return null;
      const requestInput = this.providerRefundInput(refund);
      const providerRequest = await tx.paymentProviderRequest.create({
        data: {
          requestId: refund.providerRequestId,
          type: PaymentProviderRequestType.REFUND,
          requestPayload: this.toJson({
            ...requestInput,
            amount: refund.amount.toFixed(2),
            providerCreatedAt: refund.paymentAttempt.providerCreatedAt,
          }),
          paymentAttemptId: refund.paymentAttemptId,
          paymentRefundId: refund.id,
        },
      });
      return { refund, providerRequestId: providerRequest.id, requestInput };
    });
    if (!claimed) return this.findRefund(id);

    const { refund, providerRequestId, requestInput } = claimed;
    try {
      const result = await this.vnpay.refundTransaction(requestInput);
      return this.applyProviderResponse(refund, providerRequestId, result);
    } catch (error) {
      return this.markProviderUncertain(refund, providerRequestId, error);
    }
  }

  private providerRefundInput(refund: RefundView) {
    const requestInput = {
      requestId: refund.providerRequestId,
      merchantReference: refund.paymentAttempt.merchantReference,
      providerTransactionNo:
        refund.paymentAttempt.providerTransactionNo ?? undefined,
      providerCreatedAt: refund.paymentAttempt.providerCreatedAt,
      orderInfo: `Refund invoice ${refund.paymentAttempt.invoice.invoiceNumber}`,
      amount: refund.amount,
      createdBy: refund.requestedBy.fullName,
      transactionType: refund.type === PaymentRefundType.FULL ? '02' : '03',
    } as const;
    return requestInput;
  }

  private async applyProviderResponse(
    refund: RefundView,
    providerRequestId: string,
    result: {
      request: Record<string, string>;
      response: Record<string, string>;
    },
  ) {
    const responseCode = result.response.vnp_ResponseCode ?? null;
    const transactionStatus = result.response.vnp_TransactionStatus ?? null;
    const providerTransactionNo =
      result.response.vnp_TransactionNo &&
      result.response.vnp_TransactionNo !== '0'
        ? result.response.vnp_TransactionNo
        : null;
    const mismatch =
      responseCode === '00'
        ? this.refundResponseMismatch(refund, result.response)
        : null;
    const outcome = mismatch
      ? PaymentRefundStatus.REQUIRES_REVIEW
      : this.refundOutcome(responseCode, transactionStatus);

    return runSerializableTransaction(this.prisma, async (tx) => {
      await tx.paymentProviderRequest.update({
        where: { id: providerRequestId },
        data: {
          status: PaymentProviderRequestStatus.SUCCEEDED,
          requestPayload: result.request,
          responsePayload: result.response,
          responseCode,
          transactionStatus,
          completedAt: new Date(),
        },
      });

      if (outcome === PaymentRefundStatus.SUCCEEDED) {
        return this.completeSuccessfulRefund(tx, refund, {
          providerTransactionNo,
          responseCode,
          transactionStatus,
          message: result.response.vnp_Message ?? null,
        });
      }

      if (outcome === PaymentRefundStatus.REQUIRES_REVIEW) {
        await this.openIncident(tx, {
          type: PaymentReconciliationIncidentType.REFUND_STATE_MISMATCH,
          deduplicationKey: `refund-state:${refund.id}`,
          title: 'VNPay refund requires manual reconciliation',
          details: {
            paymentRefundId: refund.id,
            responseCode,
            transactionStatus,
            providerTransactionNo,
            mismatch,
          },
          refund,
        });
      }

      const completedAt =
        outcome === PaymentRefundStatus.FAILED ||
        outcome === PaymentRefundStatus.REJECTED
          ? new Date()
          : null;
      const updated = await tx.paymentRefund.update({
        where: { id: refund.id },
        data: {
          status: outcome,
          providerTransactionNo,
          providerResponseCode: responseCode,
          providerTransactionStatus: transactionStatus,
          providerMessage: result.response.vnp_Message ?? null,
          completedAt,
          reconciliationLockedAt: null,
        },
        include: REFUND_INCLUDE,
      });
      await this.log(tx, refund.requestedById, `PAYMENT_REFUND_${outcome}`, {
        paymentRefundId: refund.id,
        paymentAttemptId: refund.paymentAttemptId,
        responseCode,
        transactionStatus,
      });
      await this.enqueue(tx, `PAYMENT_REFUND_${outcome}`, updated);
      return updated;
    });
  }

  private async completeSuccessfulRefund(
    tx: ExtendedPrismaTransactionClient,
    refund: RefundView,
    provider: {
      providerTransactionNo: string | null;
      responseCode: string | null;
      transactionStatus: string | null;
      message: string | null;
    },
  ) {
    const completedAt = new Date();
    const updated = await tx.paymentRefund.update({
      where: { id: refund.id },
      data: {
        status: PaymentRefundStatus.SUCCEEDED,
        providerTransactionNo: provider.providerTransactionNo,
        providerResponseCode: provider.responseCode,
        providerTransactionStatus: provider.transactionStatus,
        providerMessage: provider.message,
        completedAt,
        reconciliationLockedAt: null,
      },
      include: REFUND_INCLUDE,
    });
    const successful = await tx.paymentRefund.aggregate({
      where: {
        paymentAttemptId: refund.paymentAttemptId,
        status: PaymentRefundStatus.SUCCEEDED,
      },
      _sum: { amount: true },
    });
    const refundedAmount = successful._sum.amount ?? new Prisma.Decimal(0);
    const targetStatus = refundedAmount.gte(refund.paymentAttempt.amount)
      ? PaymentStatus.REFUNDED
      : PaymentStatus.PARTIALLY_REFUNDED;
    const invoiceUpdated = await tx.invoice.updateMany({
      where: {
        id: refund.paymentAttempt.invoice.id,
        paymentStatus: {
          in: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED],
        },
      },
      data: { paymentStatus: targetStatus },
    });
    if (invoiceUpdated.count !== 1) {
      await this.openIncident(tx, {
        type: PaymentReconciliationIncidentType.PAYMENT_STATE_CONFLICT,
        deduplicationKey: `refund-invoice-state:${refund.id}`,
        title: 'Refund succeeded but invoice state could not be updated',
        details: {
          paymentRefundId: refund.id,
          invoiceId: refund.paymentAttempt.invoice.id,
          expectedInvoiceStatus: targetStatus,
          actualInvoiceStatus: refund.paymentAttempt.invoice.paymentStatus,
        },
        refund,
      });
    }
    await this.log(tx, refund.requestedById, 'PAYMENT_REFUND_SUCCEEDED', {
      paymentRefundId: refund.id,
      paymentAttemptId: refund.paymentAttemptId,
      invoiceId: refund.paymentAttempt.invoice.id,
      amount: refund.amount.toFixed(2),
      refundedAmount: refundedAmount.toFixed(2),
      invoiceStatus: targetStatus,
    });
    await this.enqueue(tx, 'PAYMENT_REFUND_SUCCEEDED', updated);
    return updated;
  }

  private async markProviderUncertain(
    refund: RefundView,
    providerRequestId: string,
    error: unknown,
  ) {
    const message = this.errorMessage(error);
    this.logger.error(`VNPay refund request ${refund.id} is uncertain.`);
    return runSerializableTransaction(this.prisma, async (tx) => {
      await tx.paymentProviderRequest.update({
        where: { id: providerRequestId },
        data: {
          status: PaymentProviderRequestStatus.FAILED,
          errorMessage: message,
          completedAt: new Date(),
        },
      });
      await this.openIncident(tx, {
        type: PaymentReconciliationIncidentType.PROVIDER_UNAVAILABLE,
        deduplicationKey: `refund-provider:${refund.id}`,
        title: 'VNPay refund outcome is unknown',
        details: {
          paymentRefundId: refund.id,
          paymentAttemptId: refund.paymentAttemptId,
          error: message,
        },
        refund,
      });
      const updated = await tx.paymentRefund.update({
        where: { id: refund.id },
        data: {
          status: PaymentRefundStatus.REQUIRES_REVIEW,
          lastError: message,
          reconciliationLockedAt: null,
        },
        include: REFUND_INCLUDE,
      });
      await this.log(
        tx,
        refund.requestedById,
        'PAYMENT_REFUND_REQUIRES_REVIEW',
        {
          paymentRefundId: refund.id,
          paymentAttemptId: refund.paymentAttemptId,
          reason: 'PROVIDER_REQUEST_UNCERTAIN',
        },
      );
      await this.enqueue(tx, 'PAYMENT_REFUND_REQUIRES_REVIEW', updated);
      return updated;
    });
  }

  private refundOutcome(
    responseCode: string | null,
    transactionStatus: string | null,
  ) {
    if (responseCode === '00' && transactionStatus === '00') {
      return PaymentRefundStatus.SUCCEEDED;
    }
    if (transactionStatus === '09') return PaymentRefundStatus.REJECTED;
    if (responseCode === '00' && transactionStatus === '02') {
      return PaymentRefundStatus.FAILED;
    }
    if (responseCode && responseCode !== '00' && responseCode !== '94') {
      return PaymentRefundStatus.FAILED;
    }
    return PaymentRefundStatus.REQUIRES_REVIEW;
  }

  private refundResponseMismatch(
    refund: RefundView,
    response: Record<string, string>,
  ) {
    if (response.vnp_TxnRef !== refund.paymentAttempt.merchantReference) {
      return 'MERCHANT_REFERENCE';
    }
    if (response.vnp_Amount !== refund.amount.mul(100).toFixed(0)) {
      return 'AMOUNT';
    }
    const expectedType = refund.type === PaymentRefundType.FULL ? '02' : '03';
    if (response.vnp_TransactionType !== expectedType) {
      return 'TRANSACTION_TYPE';
    }
    return null;
  }

  private openIncident(
    tx: ExtendedPrismaTransactionClient,
    input: {
      type: PaymentReconciliationIncidentType;
      deduplicationKey: string;
      title: string;
      details: Prisma.InputJsonObject;
      refund: RefundView;
    },
  ) {
    return tx.paymentReconciliationIncident.upsert({
      where: { deduplicationKey: input.deduplicationKey },
      create: {
        type: input.type,
        deduplicationKey: input.deduplicationKey,
        title: input.title,
        details: input.details,
        paymentAttemptId: input.refund.paymentAttemptId,
        paymentRefundId: input.refund.id,
      },
      update: {
        status: PaymentReconciliationIncidentStatus.OPEN,
        title: input.title,
        details: input.details,
        detectedAt: new Date(),
        resolvedAt: null,
        resolvedById: null,
        resolutionNote: null,
      },
    });
  }

  private enqueue(
    tx: ExtendedPrismaTransactionClient,
    eventName: string,
    refund: RefundView,
  ) {
    return this.outbox.enqueue(tx, {
      topic: 'payment',
      eventName,
      aggregateType: 'PaymentRefund',
      aggregateId: refund.id,
      payload: {
        paymentRefundId: refund.id,
        paymentAttemptId: refund.paymentAttemptId,
        invoiceId: refund.paymentAttempt.invoice.id,
        status: refund.status,
        type: refund.type,
        amount: refund.amount.toFixed(2),
        occurredAt: new Date().toISOString(),
      },
    });
  }

  private findIdempotentRefund(employeeId: string, idempotencyKey: string) {
    return this.prisma.paymentRefund.findUnique({
      where: {
        requestedById_idempotencyKey: {
          requestedById: employeeId,
          idempotencyKey,
        },
      },
      include: REFUND_INCLUDE,
    });
  }

  private assertIdempotentReplay(
    refund: { paymentAttemptId: string; requestHash: string },
    paymentAttemptId: string,
    requestHash: string,
  ) {
    if (
      refund.paymentAttemptId !== paymentAttemptId ||
      refund.requestHash !== requestHash
    ) {
      throw new ConflictException(
        'Idempotency key was already used for a different refund request.',
      );
    }
  }

  private requestHash(paymentAttemptId: string, dto: CreatePaymentRefundDto) {
    return createHash('sha256')
      .update(
        JSON.stringify({
          paymentAttemptId,
          amount: new Prisma.Decimal(dto.amount).toFixed(2),
          reason: dto.reason,
        }),
      )
      .digest('hex');
  }

  private async assertActiveEmployee(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
  ) {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!employee) {
      throw new UnauthorizedException('Employee is inactive or not found.');
    }
  }

  private log(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
    actionType: string,
    details: Prisma.InputJsonObject,
  ) {
    return tx.actionLog.create({ data: { employeeId, actionType, details } });
  }

  private toJson(value: unknown): Prisma.InputJsonObject {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
  }

  private errorMessage(error: unknown) {
    return (error instanceof Error ? error.message : String(error)).slice(
      0,
      2_000,
    );
  }

  private isUniqueViolation(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}
