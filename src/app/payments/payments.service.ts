import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PaymentAttemptStatus,
  PaymentProvider,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import type {
  ExtendedPrismaTransactionClient,
  PaymentCallbackQuery,
} from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { CashierShiftLedgerService } from '../cashier-shifts/cashier-shift-ledger.service';
import { InvoicesService } from '../invoices/invoices.service';
import { CreatePaymentAttemptDto, GetPaymentAttemptsDto } from './dto';
import { VnpayService } from './vnpay.service';

const VNPAY_RESPONSE = {
  SUCCESS: { RspCode: '00', Message: 'Confirm Success' },
  NOT_FOUND: { RspCode: '01', Message: 'Order not found' },
  ALREADY_CONFIRMED: { RspCode: '02', Message: 'Order already confirmed' },
  INVALID_AMOUNT: { RspCode: '04', Message: 'Invalid amount' },
  INVALID_SIGNATURE: { RspCode: '97', Message: 'Invalid signature' },
  UNKNOWN_ERROR: { RspCode: '99', Message: 'Unknown error' },
} as const;

const PAYMENT_ATTEMPT_INCLUDE = {
  invoice: {
    select: {
      id: true,
      invoiceNumber: true,
      totalAmount: true,
      paymentStatus: true,
    },
  },
  createdBy: { select: { id: true, fullName: true } },
  shift: { select: { id: true, status: true, openedAt: true } },
} as const satisfies Prisma.PaymentAttemptInclude;

type PaymentAttemptView = Prisma.PaymentAttemptGetPayload<{
  include: typeof PAYMENT_ATTEMPT_INCLUDE;
}>;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly config: ConfigService,
    private readonly paginationUtil: PaginationUtilService,
    private readonly cashierShiftLedger: CashierShiftLedgerService,
    private readonly invoicesService: InvoicesService,
    private readonly vnpay: VnpayService,
  ) {}

  async createAttempt(
    invoiceId: string,
    employeeId: string,
    ipAddress: string,
    dto: CreatePaymentAttemptDto,
  ) {
    this.vnpay.assertConfigured();
    const requestHash = this.createRequestHash(invoiceId, dto);
    const existing = await this.prisma.paymentAttempt.findUnique({
      where: {
        createdById_idempotencyKey: {
          createdById: employeeId,
          idempotencyKey: dto.idempotencyKey,
        },
      },
      include: PAYMENT_ATTEMPT_INCLUDE,
    });
    if (existing) {
      return this.resolveExistingAttempt(
        existing,
        invoiceId,
        employeeId,
        requestHash,
        ipAddress,
        dto,
      );
    }

    try {
      const attempt = await this.runSerializable(async (tx) => {
        await this.assertActiveEmployee(tx, employeeId);
        const replay = await tx.paymentAttempt.findUnique({
          where: {
            createdById_idempotencyKey: {
              createdById: employeeId,
              idempotencyKey: dto.idempotencyKey,
            },
          },
          include: PAYMENT_ATTEMPT_INCLUDE,
        });
        if (replay) {
          this.assertIdempotentReplay(
            replay,
            invoiceId,
            employeeId,
            requestHash,
          );
          return replay;
        }

        const invoice = await tx.invoice.findUnique({
          where: { id: invoiceId },
          select: {
            id: true,
            invoiceNumber: true,
            totalAmount: true,
            paymentStatus: true,
          },
        });
        if (!invoice) {
          throw new NotFoundException(
            `Invoice with ID ${invoiceId} not found.`,
          );
        }
        if (invoice.paymentStatus !== PaymentStatus.UNPAID) {
          throw new ConflictException(
            'Only unpaid invoices can create payment attempts.',
          );
        }

        const now = new Date();
        await tx.paymentAttempt.updateMany({
          where: {
            invoiceId,
            status: PaymentAttemptStatus.PENDING,
            expiresAt: { lte: now },
          },
          data: {
            status: PaymentAttemptStatus.EXPIRED,
            completedAt: now,
          },
        });
        const pending = await tx.paymentAttempt.findFirst({
          where: { invoiceId, status: PaymentAttemptStatus.PENDING },
          select: { id: true },
        });
        if (pending) {
          throw new ConflictException(
            'This invoice already has a pending payment attempt.',
          );
        }

        const shift = await this.cashierShiftLedger.requireOpenShift(
          tx,
          employeeId,
        );
        const ttlMinutes = this.config.get<number>(
          'VNPAY_ATTEMPT_TTL_MINUTES',
          15,
        );
        const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
        const created = await tx.paymentAttempt.create({
          data: {
            provider: PaymentProvider.VNPAY,
            amount: invoice.totalAmount,
            merchantReference: this.createMerchantReference(),
            idempotencyKey: dto.idempotencyKey,
            requestHash,
            closeSessionAfterPayment: dto.closeSessionAfterPayment,
            expiresAt,
            invoiceId,
            createdById: employeeId,
            shiftId: shift.id,
          },
          include: PAYMENT_ATTEMPT_INCLUDE,
        });
        await this.log(tx, employeeId, 'PAYMENT_ATTEMPT_CREATED', {
          paymentAttemptId: created.id,
          invoiceId,
          provider: created.provider,
          merchantReference: created.merchantReference,
          amount: created.amount.toString(),
          expiresAt: created.expiresAt.toISOString(),
        });
        return created;
      });
      return this.presentAttempt(attempt, ipAddress, dto);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const replay = await this.prisma.paymentAttempt.findUnique({
          where: {
            createdById_idempotencyKey: {
              createdById: employeeId,
              idempotencyKey: dto.idempotencyKey,
            },
          },
          include: PAYMENT_ATTEMPT_INCLUDE,
        });
        if (replay) {
          return this.resolveExistingAttempt(
            replay,
            invoiceId,
            employeeId,
            requestHash,
            ipAddress,
            dto,
          );
        }
      }
      throw error;
    }
  }

  async findAttempts(invoiceId: string, query: GetPaymentAttemptsDto) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true },
    });
    if (!invoice) {
      throw new NotFoundException(`Invoice with ID ${invoiceId} not found.`);
    }
    const where: Prisma.PaymentAttemptWhereInput = {
      invoiceId,
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const totalItems = await this.prisma.paymentAttempt.count({ where });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const attempts = await this.prisma.paymentAttempt.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: PAYMENT_ATTEMPT_INCLUDE,
    });
    return paging.format(attempts);
  }

  async findAttempt(id: string) {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { id },
      include: PAYMENT_ATTEMPT_INCLUDE,
    });
    if (!attempt) {
      throw new NotFoundException(`Payment attempt with ID ${id} not found.`);
    }
    return attempt;
  }

  async handleVnpayIpn(query: PaymentCallbackQuery) {
    const verification = this.vnpay.verifyCallback(query);
    if (!verification.isValid) return VNPAY_RESPONSE.INVALID_SIGNATURE;

    const merchantReference = verification.params.vnp_TxnRef;
    const rawAmount = verification.params.vnp_Amount;
    if (!merchantReference || !/^\d+$/.test(rawAmount ?? '')) {
      return VNPAY_RESPONSE.UNKNOWN_ERROR;
    }
    const amount = new Prisma.Decimal(rawAmount).div(100);

    try {
      const result = await this.runSerializable(async (tx) => {
        const attempt = await tx.paymentAttempt.findUnique({
          where: { merchantReference },
          include: { invoice: { select: { paymentStatus: true } } },
        });
        const event = await tx.paymentWebhookEvent.create({
          data: {
            provider: PaymentProvider.VNPAY,
            payloadHash: verification.payloadHash,
            merchantReference,
            providerTransactionNo:
              verification.params.vnp_TransactionNo || null,
            responseCode: verification.params.vnp_ResponseCode || null,
            transactionStatus:
              verification.params.vnp_TransactionStatus || null,
            payload: verification.params,
            paymentAttemptId: attempt?.id,
          },
        });
        if (!attempt) {
          await this.completeWebhook(tx, event.id, '01');
          return { response: VNPAY_RESPONSE.NOT_FOUND, invoice: null };
        }
        if (!attempt.amount.equals(amount)) {
          await this.completeWebhook(tx, event.id, '04');
          return { response: VNPAY_RESPONSE.INVALID_AMOUNT, invoice: null };
        }
        const succeeded =
          verification.params.vnp_ResponseCode === '00' &&
          verification.params.vnp_TransactionStatus === '00';
        if (attempt.status === PaymentAttemptStatus.SUCCEEDED) {
          await this.completeWebhook(tx, event.id, '02');
          return {
            response: VNPAY_RESPONSE.ALREADY_CONFIRMED,
            invoice: null,
          };
        }
        if (attempt.invoice.paymentStatus !== PaymentStatus.UNPAID) {
          await this.completeWebhook(
            tx,
            event.id,
            succeeded ? '02_PAYMENT_STATE_CONFLICT' : '02',
          );
          return {
            response: VNPAY_RESPONSE.ALREADY_CONFIRMED,
            invoice: null,
          };
        }

        const rawProviderTransactionNo = verification.params.vnp_TransactionNo;
        const providerTransactionNo =
          rawProviderTransactionNo && rawProviderTransactionNo !== '0'
            ? rawProviderTransactionNo
            : null;
        if (succeeded && !providerTransactionNo) {
          await this.completeWebhook(tx, event.id, '99');
          return { response: VNPAY_RESPONSE.UNKNOWN_ERROR, invoice: null };
        }

        if (!succeeded) {
          const completedAt = new Date();
          await tx.paymentAttempt.update({
            where: { id: attempt.id },
            data: {
              status: PaymentAttemptStatus.FAILED,
              providerTransactionNo,
              failureCode:
                verification.params.vnp_ResponseCode || 'UNKNOWN_FAILURE',
              completedAt,
            },
          });
          await this.completeWebhook(tx, event.id, '00');
          await this.log(tx, attempt.createdById, 'VNPAY_PAYMENT_FAILED', {
            paymentAttemptId: attempt.id,
            invoiceId: attempt.invoiceId,
            responseCode: verification.params.vnp_ResponseCode ?? null,
            transactionStatus:
              verification.params.vnp_TransactionStatus ?? null,
          });
          return { response: VNPAY_RESPONSE.SUCCESS, invoice: null };
        }

        const invoice = await this.invoicesService.completeOnlinePayment(tx, {
          invoiceId: attempt.invoiceId,
          employeeId: attempt.createdById,
          shiftId: attempt.shiftId,
          closeSessionAfterPayment: attempt.closeSessionAfterPayment,
        });
        const completedAt = new Date();
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: {
            status: PaymentAttemptStatus.SUCCEEDED,
            providerTransactionNo,
            failureCode: null,
            completedAt,
          },
        });
        await tx.paymentAttempt.updateMany({
          where: {
            invoiceId: attempt.invoiceId,
            id: { not: attempt.id },
            status: PaymentAttemptStatus.PENDING,
          },
          data: {
            status: PaymentAttemptStatus.FAILED,
            failureCode: 'SUPERSEDED',
            completedAt,
          },
        });
        await this.completeWebhook(tx, event.id, '00');
        await this.log(tx, attempt.createdById, 'VNPAY_PAYMENT_SUCCEEDED', {
          paymentAttemptId: attempt.id,
          invoiceId: attempt.invoiceId,
          providerTransactionNo,
          amount: attempt.amount.toString(),
        });
        return { response: VNPAY_RESPONSE.SUCCESS, invoice };
      });
      return result.response;
    } catch (error) {
      if (this.isPayloadReplay(error)) {
        return VNPAY_RESPONSE.ALREADY_CONFIRMED;
      }
      this.logger.error(
        `VNPay IPN processing failed for ${merchantReference}.`,
        error instanceof Error ? error.stack : undefined,
      );
      return VNPAY_RESPONSE.UNKNOWN_ERROR;
    }
  }

  async inspectVnpayReturn(query: PaymentCallbackQuery) {
    const verification = this.vnpay.verifyCallback(query);
    const merchantReference = verification.isValid
      ? verification.params.vnp_TxnRef
      : undefined;
    const attempt = merchantReference
      ? await this.prisma.paymentAttempt.findUnique({
          where: { merchantReference },
          select: {
            id: true,
            invoiceId: true,
            status: true,
            amount: true,
            completedAt: true,
          },
        })
      : null;
    return {
      signatureValid: verification.isValid,
      responseCode: verification.params.vnp_ResponseCode ?? null,
      transactionStatus: verification.params.vnp_TransactionStatus ?? null,
      attempt,
    };
  }

  private async resolveExistingAttempt(
    attempt: PaymentAttemptView,
    invoiceId: string,
    employeeId: string,
    requestHash: string,
    ipAddress: string,
    dto: CreatePaymentAttemptDto,
  ) {
    this.assertIdempotentReplay(attempt, invoiceId, employeeId, requestHash);
    if (
      attempt.status === PaymentAttemptStatus.PENDING &&
      attempt.expiresAt <= new Date()
    ) {
      const completedAt = new Date();
      await this.prisma.paymentAttempt.updateMany({
        where: { id: attempt.id, status: PaymentAttemptStatus.PENDING },
        data: { status: PaymentAttemptStatus.EXPIRED, completedAt },
      });
      return {
        ...attempt,
        status: PaymentAttemptStatus.EXPIRED,
        completedAt,
        paymentUrl: null,
      };
    }
    return this.presentAttempt(attempt, ipAddress, dto);
  }

  private presentAttempt(
    attempt: PaymentAttemptView,
    ipAddress: string,
    dto: CreatePaymentAttemptDto,
  ) {
    const paymentUrl =
      attempt.status === PaymentAttemptStatus.PENDING
        ? this.vnpay.createPaymentUrl({
            amount: attempt.amount,
            invoiceNumber: attempt.invoice.invoiceNumber,
            merchantReference: attempt.merchantReference,
            ipAddress,
            expiresAt: attempt.expiresAt,
            locale: dto.locale,
            bankCode: dto.bankCode,
          })
        : null;
    return { ...attempt, paymentUrl };
  }

  private assertIdempotentReplay(
    attempt: {
      invoiceId: string;
      createdById: string;
      requestHash: string;
    },
    invoiceId: string,
    employeeId: string,
    requestHash: string,
  ) {
    if (
      attempt.invoiceId !== invoiceId ||
      attempt.createdById !== employeeId ||
      attempt.requestHash !== requestHash
    ) {
      throw new ConflictException(
        'Idempotency key was already used for a different payment request.',
      );
    }
  }

  private createRequestHash(invoiceId: string, dto: CreatePaymentAttemptDto) {
    return createHash('sha256')
      .update(
        JSON.stringify({
          invoiceId,
          provider: PaymentProvider.VNPAY,
          locale: dto.locale,
          bankCode: dto.bankCode ?? null,
          closeSessionAfterPayment: dto.closeSessionAfterPayment,
        }),
      )
      .digest('hex');
  }

  private createMerchantReference() {
    return `PA${randomUUID().replaceAll('-', '').toUpperCase()}`;
  }

  private completeWebhook(
    tx: ExtendedPrismaTransactionClient,
    id: string,
    processingCode: string,
  ) {
    return tx.paymentWebhookEvent.update({
      where: { id },
      data: { processingCode, processedAt: new Date() },
    });
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

  private async log(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
    actionType: string,
    details: Prisma.InputJsonObject,
  ) {
    await tx.actionLog.create({ data: { employeeId, actionType, details } });
  }

  private isUniqueViolation(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private isPayloadReplay(error: unknown) {
    if (!this.isUniqueViolation(error)) return false;
    const target = (error as Prisma.PrismaClientKnownRequestError).meta?.target;
    return (
      (Array.isArray(target) && target.includes('payloadHash')) ||
      target === 'PaymentWebhookEvent_payloadHash_key'
    );
  }

  private async runSerializable<T>(
    callback: (tx: ExtendedPrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.prisma.$transaction(callback, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034';
        if (!retryable || attempt === 3) throw error;
        this.logger.warn(
          `Payment transaction conflict. Retrying ${attempt + 1}/3`,
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 25));
      }
    }
    throw new ConflictException('Transaction failed. Please try again.');
  }
}
