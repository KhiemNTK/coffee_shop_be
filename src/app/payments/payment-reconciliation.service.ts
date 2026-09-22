import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentAttemptStatus,
  PaymentProviderRequestStatus,
  PaymentProviderRequestType,
  PaymentReconciliationIncidentStatus,
  PaymentReconciliationIncidentType,
  PaymentRefundStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { OutboxService } from '../durable/outbox.service';
import { InvoicesService } from '../invoices/invoices.service';
import { GetPaymentIncidentsDto, ResolvePaymentIncidentDto } from './dto';
import { VnpayService } from './vnpay.service';

const BATCH_SIZE = 25;
const MAX_QUERY_ATTEMPTS = 5;
const LOCK_TIMEOUT_MS = 10 * 60 * 1_000;
const RETRY_BASE_MS = 60 * 1_000;

const ATTEMPT_INCLUDE = {
  invoice: {
    select: {
      id: true,
      invoiceNumber: true,
      paymentStatus: true,
    },
  },
} as const satisfies Prisma.PaymentAttemptInclude;

type AttemptView = Prisma.PaymentAttemptGetPayload<{
  include: typeof ATTEMPT_INCLUDE;
}>;

@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly paginationUtil: PaginationUtilService,
    private readonly invoicesService: InvoicesService,
    private readonly outbox: OutboxService,
    private readonly vnpay: VnpayService,
  ) {}

  async reconcileAttempt(id: string, employeeId: string) {
    this.vnpay.assertApiConfigured();
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!attempt) {
      throw new NotFoundException(`Payment attempt with ID ${id} not found.`);
    }
    if (!(await this.claimAttempt(id))) {
      throw new ConflictException(
        'This payment attempt is already being reconciled.',
      );
    }
    return this.queryProvider(id, employeeId);
  }

  async reconcileDue() {
    await this.recoverAbandonedRefunds();
    const due = await this.prisma.paymentAttempt.findMany({
      where: {
        status: {
          in: [PaymentAttemptStatus.PENDING, PaymentAttemptStatus.EXPIRED],
        },
        nextReconcileAt: { lte: new Date() },
        OR: [
          { reconciliationLockedAt: null },
          {
            reconciliationLockedAt: {
              lt: new Date(Date.now() - LOCK_TIMEOUT_MS),
            },
          },
        ],
      },
      orderBy: [{ nextReconcileAt: 'asc' }, { id: 'asc' }],
      take: BATCH_SIZE,
      select: { id: true },
    });
    let claimed = 0;
    let processed = 0;
    let failed = 0;
    for (const { id } of due) {
      if (!(await this.claimAttempt(id, true))) continue;
      claimed++;
      try {
        await this.queryProvider(id);
        processed++;
      } catch (error) {
        failed++;
        this.logger.error(
          `Payment reconciliation failed for attempt ${id}.`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
    return { claimed, processed, failed };
  }

  async findIncidents(query: GetPaymentIncidentsDto) {
    const where: Prisma.PaymentReconciliationIncidentWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };
    const totalItems = await this.prisma.paymentReconciliationIncident.count({
      where,
    });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const incidents = await this.prisma.paymentReconciliationIncident.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      include: {
        paymentAttempt: {
          select: {
            id: true,
            merchantReference: true,
            status: true,
            amount: true,
            invoiceId: true,
          },
        },
        paymentRefund: {
          select: { id: true, status: true, amount: true },
        },
        resolvedBy: { select: { id: true, fullName: true } },
      },
    });
    return paging.format(incidents);
  }

  async resolveIncident(
    id: string,
    employeeId: string,
    dto: ResolvePaymentIncidentDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const incident = await tx.paymentReconciliationIncident.findUnique({
        where: { id },
      });
      if (!incident) {
        throw new NotFoundException(
          `Payment reconciliation incident with ID ${id} not found.`,
        );
      }
      if (incident.status !== PaymentReconciliationIncidentStatus.OPEN) {
        throw new ConflictException('This incident is already closed.');
      }
      if (dto.action === 'RESOLVE') {
        const [attempt, refund] = await Promise.all([
          tx.paymentAttempt.findUnique({
            where: { id: incident.paymentAttemptId },
            select: { status: true },
          }),
          incident.paymentRefundId
            ? tx.paymentRefund.findUnique({
                where: { id: incident.paymentRefundId },
                select: { status: true },
              })
            : null,
        ]);
        if (
          attempt?.status === PaymentAttemptStatus.REQUIRES_REVIEW ||
          refund?.status === PaymentRefundStatus.REQUIRES_REVIEW
        ) {
          throw new ConflictException(
            'Reconcile the linked payment state before resolving this incident, or explicitly ignore it.',
          );
        }
      }
      const status =
        dto.action === 'RESOLVE'
          ? PaymentReconciliationIncidentStatus.RESOLVED
          : PaymentReconciliationIncidentStatus.IGNORED;
      const updated = await tx.paymentReconciliationIncident.update({
        where: { id },
        data: {
          status,
          resolutionNote: dto.resolutionNote,
          resolvedAt: new Date(),
          resolvedById: employeeId,
        },
      });
      await tx.actionLog.create({
        data: {
          employeeId,
          actionType: 'PAYMENT_RECONCILIATION_INCIDENT_CLOSED',
          details: {
            incidentId: id,
            incidentType: incident.type,
            status,
            resolutionNote: dto.resolutionNote,
          },
        },
      });
      return updated;
    });
  }

  private async queryProvider(id: string, employeeId?: string) {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { id },
      include: ATTEMPT_INCLUDE,
    });
    if (!attempt) {
      throw new NotFoundException(`Payment attempt with ID ${id} not found.`);
    }
    const requestId = randomUUID().replaceAll('-', '');
    const input = {
      requestId,
      merchantReference: attempt.merchantReference,
      providerCreatedAt: attempt.providerCreatedAt,
      orderInfo: `Query invoice ${attempt.invoice.invoiceNumber}`,
    };
    const providerRequest = await this.prisma.paymentProviderRequest.create({
      data: {
        requestId,
        type: PaymentProviderRequestType.QUERY,
        requestPayload: this.toJson(input),
        paymentAttemptId: attempt.id,
      },
    });

    let result: Awaited<ReturnType<VnpayService['queryTransaction']>>;
    try {
      result = await this.vnpay.queryTransaction(input);
    } catch (error) {
      await this.recordQueryFailure(attempt, providerRequest.id, error);
      throw new BadGatewayException('VNPay reconciliation request failed.');
    }
    try {
      await this.prisma.paymentProviderRequest.update({
        where: { id: providerRequest.id },
        data: {
          status: PaymentProviderRequestStatus.SUCCEEDED,
          requestPayload: result.request,
          responsePayload: result.response,
          responseCode: result.response.vnp_ResponseCode ?? null,
          transactionStatus: result.response.vnp_TransactionStatus ?? null,
          completedAt: new Date(),
        },
      });
      return await this.applyQueryResponse(attempt, result, employeeId);
    } catch (error) {
      await this.releaseAttempt(attempt.id);
      throw error;
    }
  }

  private applyQueryResponse(
    attempt: AttemptView,
    result: {
      request: Record<string, string>;
      response: Record<string, string>;
    },
    employeeId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.paymentAttempt.findUnique({
        where: { id: attempt.id },
        include: ATTEMPT_INCLUDE,
      });
      if (!current) {
        throw new NotFoundException(
          `Payment attempt with ID ${attempt.id} not found.`,
        );
      }
      const responseCode = result.response.vnp_ResponseCode ?? null;
      const transactionStatus = result.response.vnp_TransactionStatus ?? null;

      if (responseCode !== '00') {
        return this.rescheduleOrReview(
          tx,
          current,
          PaymentReconciliationIncidentType.PROVIDER_UNAVAILABLE,
          { responseCode, transactionStatus },
        );
      }
      const mismatch = this.responseMismatch(current, result.response);
      if (mismatch) {
        return this.markForReview(
          tx,
          current,
          PaymentReconciliationIncidentType.PROVIDER_PAYMENT_MISMATCH,
          'VNPay transaction does not match the local payment attempt',
          { mismatch, response: result.response },
        );
      }
      if (transactionStatus === '00') {
        return this.confirmProviderPayment(
          tx,
          current,
          result.response,
          employeeId,
        );
      }
      if (['02', '04', '07', '09'].includes(transactionStatus ?? '')) {
        return this.confirmProviderFailure(tx, current, transactionStatus);
      }
      return this.rescheduleOrReview(
        tx,
        current,
        PaymentReconciliationIncidentType.STALE_ATTEMPT,
        { responseCode, transactionStatus },
      );
    });
  }

  private async confirmProviderPayment(
    tx: ExtendedPrismaTransactionClient,
    attempt: AttemptView,
    response: Record<string, string>,
    employeeId?: string,
  ) {
    const providerTransactionNo = response.vnp_TransactionNo;
    if (!providerTransactionNo || providerTransactionNo === '0') {
      return this.markForReview(
        tx,
        attempt,
        PaymentReconciliationIncidentType.PROVIDER_PAYMENT_MISMATCH,
        'VNPay confirmed payment without a transaction number',
        { response },
      );
    }
    if (attempt.status === PaymentAttemptStatus.SUCCEEDED) {
      if (
        attempt.invoice.paymentStatus !== PaymentStatus.PAID &&
        attempt.invoice.paymentStatus !== PaymentStatus.PARTIALLY_REFUNDED &&
        attempt.invoice.paymentStatus !== PaymentStatus.REFUNDED
      ) {
        return this.markForReview(
          tx,
          attempt,
          PaymentReconciliationIncidentType.PAYMENT_STATE_CONFLICT,
          'Provider payment succeeded but invoice is not paid',
          { invoiceStatus: attempt.invoice.paymentStatus },
        );
      }
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          lastReconciledAt: new Date(),
          nextReconcileAt: null,
          reconciliationLockedAt: null,
          reconciliationAttempts: { increment: 1 },
        },
      });
      await this.autoResolveIncidents(tx, attempt.id);
      return tx.paymentAttempt.findUnique({
        where: { id: attempt.id },
        include: ATTEMPT_INCLUDE,
      });
    }
    if (attempt.invoice.paymentStatus !== PaymentStatus.UNPAID) {
      return this.markForReview(
        tx,
        attempt,
        PaymentReconciliationIncidentType.PAYMENT_STATE_CONFLICT,
        'Provider payment succeeded after invoice state changed',
        { invoiceStatus: attempt.invoice.paymentStatus },
      );
    }

    await this.invoicesService.completeOnlinePayment(tx, {
      invoiceId: attempt.invoiceId,
      employeeId: attempt.createdById,
      shiftId: attempt.shiftId,
      closeSessionAfterPayment: attempt.closeSessionAfterPayment,
    });
    const completedAt = new Date();
    const updated = await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: PaymentAttemptStatus.SUCCEEDED,
        providerTransactionNo,
        failureCode: null,
        completedAt,
        lastReconciledAt: completedAt,
        nextReconcileAt: null,
        reconciliationLockedAt: null,
        reconciliationAttempts: { increment: 1 },
      },
      include: ATTEMPT_INCLUDE,
    });
    await this.autoResolveIncidents(tx, attempt.id);
    await this.logReconciliation(tx, employeeId ?? attempt.createdById, {
      paymentAttemptId: attempt.id,
      result: 'SUCCEEDED',
      source: employeeId ? 'MANUAL' : 'SCHEDULED',
    });
    await this.enqueue(tx, 'PAYMENT_RECONCILED', updated, {
      result: 'SUCCEEDED',
    });
    return updated;
  }

  private async confirmProviderFailure(
    tx: ExtendedPrismaTransactionClient,
    attempt: AttemptView,
    transactionStatus: string,
  ) {
    if (attempt.invoice.paymentStatus !== PaymentStatus.UNPAID) {
      return this.markForReview(
        tx,
        attempt,
        PaymentReconciliationIncidentType.PROVIDER_PAYMENT_MISMATCH,
        'Provider payment failed or reversed after invoice was paid',
        { transactionStatus, invoiceStatus: attempt.invoice.paymentStatus },
      );
    }
    const completedAt = new Date();
    const updated = await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: PaymentAttemptStatus.FAILED,
        providerTransactionNo: null,
        failureCode: `VNPAY_${transactionStatus}`,
        completedAt,
        lastReconciledAt: completedAt,
        nextReconcileAt: null,
        reconciliationLockedAt: null,
        reconciliationAttempts: { increment: 1 },
      },
      include: ATTEMPT_INCLUDE,
    });
    await this.enqueue(tx, 'PAYMENT_RECONCILED', updated, {
      result: 'FAILED',
      transactionStatus,
    });
    return updated;
  }

  private async rescheduleOrReview(
    tx: ExtendedPrismaTransactionClient,
    attempt: AttemptView,
    incidentType: PaymentReconciliationIncidentType,
    details: Prisma.InputJsonObject,
  ) {
    const attempts = attempt.reconciliationAttempts + 1;
    if (attempt.status === PaymentAttemptStatus.SUCCEEDED) {
      const updated = await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          lastReconciledAt: new Date(),
          nextReconcileAt: null,
          reconciliationLockedAt: null,
          reconciliationAttempts: attempts,
        },
        include: ATTEMPT_INCLUDE,
      });
      await this.openIncident(tx, {
        type: incidentType,
        deduplicationKey: `${incidentType}:${attempt.id}`,
        title: 'Confirmed payment could not be verified with VNPay',
        details,
        paymentAttemptId: attempt.id,
      });
      return updated;
    }
    if (attempts >= MAX_QUERY_ATTEMPTS) {
      return this.markForReview(
        tx,
        attempt,
        incidentType,
        'Payment attempt could not be reconciled automatically',
        details,
      );
    }
    return tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        lastReconciledAt: new Date(),
        nextReconcileAt: new Date(
          Date.now() + RETRY_BASE_MS * 2 ** (attempts - 1),
        ),
        reconciliationLockedAt: null,
        reconciliationAttempts: attempts,
      },
      include: ATTEMPT_INCLUDE,
    });
  }

  private async markForReview(
    tx: ExtendedPrismaTransactionClient,
    attempt: AttemptView,
    type: PaymentReconciliationIncidentType,
    title: string,
    details: Prisma.InputJsonObject,
  ) {
    const now = new Date();
    const updated = await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: PaymentAttemptStatus.REQUIRES_REVIEW,
        completedAt: null,
        failureCode: type,
        lastReconciledAt: now,
        nextReconcileAt: null,
        reconciliationLockedAt: null,
        reconciliationAttempts: { increment: 1 },
      },
      include: ATTEMPT_INCLUDE,
    });
    await this.openIncident(tx, {
      type,
      deduplicationKey: `${type}:${attempt.id}`,
      title,
      details,
      paymentAttemptId: attempt.id,
    });
    await this.enqueue(tx, 'PAYMENT_RECONCILIATION_REQUIRED', updated, {
      incidentType: type,
    });
    return updated;
  }

  private async recordQueryFailure(
    attempt: AttemptView,
    providerRequestId: string,
    error: unknown,
  ) {
    const message = this.errorMessage(error);
    await this.prisma.$transaction(async (tx) => {
      await tx.paymentProviderRequest.update({
        where: { id: providerRequestId },
        data: {
          status: PaymentProviderRequestStatus.FAILED,
          errorMessage: message,
          completedAt: new Date(),
        },
      });
      const current = await tx.paymentAttempt.findUnique({
        where: { id: attempt.id },
        include: ATTEMPT_INCLUDE,
      });
      if (!current) return;
      await this.rescheduleOrReview(
        tx,
        current,
        PaymentReconciliationIncidentType.PROVIDER_UNAVAILABLE,
        { error: message },
      );
    });
  }

  private responseMismatch(
    attempt: AttemptView,
    response: Record<string, string>,
  ) {
    if (response.vnp_TxnRef !== attempt.merchantReference) {
      return 'MERCHANT_REFERENCE';
    }
    if (response.vnp_TransactionType !== '01') return 'TRANSACTION_TYPE';
    if (!/^\d+$/.test(response.vnp_Amount ?? '')) return 'AMOUNT_FORMAT';
    const amount = new Prisma.Decimal(response.vnp_Amount).div(100);
    if (!amount.equals(attempt.amount)) return 'AMOUNT';
    return null;
  }

  private claimAttempt(id: string, dueOnly = false) {
    return this.prisma.paymentAttempt
      .updateMany({
        where: {
          id,
          ...(dueOnly
            ? {
                status: {
                  in: [
                    PaymentAttemptStatus.PENDING,
                    PaymentAttemptStatus.EXPIRED,
                  ],
                },
                nextReconcileAt: { lte: new Date() },
              }
            : {}),
          OR: [
            { reconciliationLockedAt: null },
            {
              reconciliationLockedAt: {
                lt: new Date(Date.now() - LOCK_TIMEOUT_MS),
              },
            },
          ],
        },
        data: { reconciliationLockedAt: new Date() },
      })
      .then((result) => result.count === 1);
  }

  private releaseAttempt(id: string) {
    return this.prisma.paymentAttempt.updateMany({
      where: { id },
      data: { reconciliationLockedAt: null },
    });
  }

  private async recoverAbandonedRefunds() {
    const refunds = await this.prisma.paymentRefund.findMany({
      where: {
        status: PaymentRefundStatus.PROCESSING,
        reconciliationLockedAt: {
          lt: new Date(Date.now() - LOCK_TIMEOUT_MS),
        },
      },
      select: { id: true, paymentAttemptId: true },
      take: BATCH_SIZE,
    });
    for (const refund of refunds) {
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.paymentRefund.updateMany({
          where: {
            id: refund.id,
            status: PaymentRefundStatus.PROCESSING,
            reconciliationLockedAt: {
              lt: new Date(Date.now() - LOCK_TIMEOUT_MS),
            },
          },
          data: {
            status: PaymentRefundStatus.REQUIRES_REVIEW,
            lastError: 'Provider request was interrupted before completion.',
            reconciliationLockedAt: null,
          },
        });
        if (updated.count !== 1) return;
        await tx.paymentProviderRequest.updateMany({
          where: {
            paymentRefundId: refund.id,
            status: PaymentProviderRequestStatus.PENDING,
          },
          data: {
            status: PaymentProviderRequestStatus.FAILED,
            errorMessage: 'Provider request was interrupted before completion.',
            completedAt: new Date(),
          },
        });
        await this.openIncident(tx, {
          type: PaymentReconciliationIncidentType.REFUND_STATE_MISMATCH,
          deduplicationKey: `refund-interrupted:${refund.id}`,
          title: 'Refund request was interrupted with an unknown outcome',
          details: { paymentRefundId: refund.id },
          paymentAttemptId: refund.paymentAttemptId,
          paymentRefundId: refund.id,
        });
      });
    }
  }

  private openIncident(
    tx: ExtendedPrismaTransactionClient,
    input: {
      type: PaymentReconciliationIncidentType;
      deduplicationKey: string;
      title: string;
      details: Prisma.InputJsonObject;
      paymentAttemptId: string;
      paymentRefundId?: string;
    },
  ) {
    return tx.paymentReconciliationIncident.upsert({
      where: { deduplicationKey: input.deduplicationKey },
      create: input,
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

  private autoResolveIncidents(
    tx: ExtendedPrismaTransactionClient,
    paymentAttemptId: string,
  ) {
    return tx.paymentReconciliationIncident.updateMany({
      where: {
        paymentAttemptId,
        paymentRefundId: null,
        status: PaymentReconciliationIncidentStatus.OPEN,
      },
      data: {
        status: PaymentReconciliationIncidentStatus.RESOLVED,
        resolvedAt: new Date(),
        resolutionNote: 'Resolved by a successful provider reconciliation.',
      },
    });
  }

  private enqueue(
    tx: ExtendedPrismaTransactionClient,
    eventName: string,
    attempt: AttemptView,
    details: Record<string, unknown>,
  ) {
    return this.outbox.enqueue(tx, {
      topic: 'payment',
      eventName,
      aggregateType: 'PaymentAttempt',
      aggregateId: attempt.id,
      payload: {
        paymentAttemptId: attempt.id,
        invoiceId: attempt.invoiceId,
        status: attempt.status,
        ...details,
        occurredAt: new Date().toISOString(),
      },
    });
  }

  private logReconciliation(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
    details: Prisma.InputJsonObject,
  ) {
    return tx.actionLog.create({
      data: {
        employeeId,
        actionType: 'PAYMENT_RECONCILED',
        details,
      },
    });
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
}
