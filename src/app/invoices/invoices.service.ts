import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentMethod,
  PaymentAttemptStatus,
  PaymentStatus,
  Prisma,
  ServeStatus,
  SessionStatus,
  TableStatus,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import {
  type ExtendedPrismaClient,
  PRISMA_SERVICE_TOKEN,
} from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../../common/utils/query-util/query-util.service';
import type {
  ExtendedPrismaTransactionClient,
  InvoiceCalculationResult,
  InvoiceLineSnapshot,
  PromotionCalculationResult,
  OrderEventBase,
} from '../../common/types';
import { IdempotencyService } from '../durable/idempotency.service';
import { OutboxService } from '../durable/outbox.service';
import { ORDER_EVENTS } from '../orders/events/order.events';
import { PromotionCalculatorService } from '../promotions/services/promotion-calculator.service';
import {
  CheckoutInvoiceDto,
  CreateInvoiceDto,
  GetInvoicesPaginationDto,
  UpdateInvoicePaymentDto,
} from './dto';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoicePolicyService } from './invoice-policy.service';
import { CashierShiftLedgerService } from '../cashier-shifts/cashier-shift-ledger.service';

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);
  private readonly maxSerializableTransactionRetries = 3;
  private readonly serializableTransaction = {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  } as const;

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly paginationUtilService: PaginationUtilService,
    private readonly queryUtilService: QueryUtilService,
    private readonly invoicePolicy: InvoicePolicyService,
    private readonly invoiceNumberService: InvoiceNumberService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly promotionCalculatorService: PromotionCalculatorService,
    private readonly cashierShiftLedger: CashierShiftLedgerService,
  ) {}

  private readonly invoiceInclude = {
    orderItems: {
      include: {
        menuItem: {
          select: {
            id: true,
            name: true,
            price: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc' as const,
      },
    },
    orderSession: {
      select: {
        id: true,
        sessionStatus: true,
        tableId: true,
        table: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
      },
    },
    employee: {
      select: {
        id: true,
        fullName: true,
        email: true,
      },
    },
    promotion: true,
    shift: true,
  } as const;

  async createInvoice(employeeId: string, createInvoiceDto: CreateInvoiceDto) {
    return this.createInvoiceInternal({
      employeeId,
      input: createInvoiceDto,
      paymentStatus: PaymentStatus.UNPAID,
      paymentMethod: PaymentMethod.CASH,
      closeSessionAfterPayment: false,
      eventNames: [ORDER_EVENTS.INVOICE_CREATED],
    });
  }

  async checkoutInvoice(
    employeeId: string,
    checkoutInvoiceDto: CheckoutInvoiceDto,
  ) {
    if (checkoutInvoiceDto.paymentMethod === PaymentMethod.TRANSFER) {
      throw new BadRequestException(
        'Online transfers must use a payment attempt.',
      );
    }
    const createInput = {
      employeeId,
      input: checkoutInvoiceDto,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: checkoutInvoiceDto.paymentMethod,
      amountTendered: checkoutInvoiceDto.amountTendered,
      closeSessionAfterPayment: checkoutInvoiceDto.closeSessionAfterPayment,
      eventNames: [ORDER_EVENTS.INVOICE_CREATED, ORDER_EVENTS.INVOICE_PAID],
    };
    const { idempotencyKey, ...request } = checkoutInvoiceDto;
    if (idempotencyKey) {
      return this.idempotency.execute(
        {
          employeeId,
          operation: 'invoice.checkout',
          key: idempotencyKey,
          request,
        },
        (tx) => this.createInvoiceInTransaction(tx, createInput),
      );
    }

    return this.createInvoiceInternal(createInput);
  }

  async getInvoices({
    page,
    itemPerPage,
    select,
    createdFrom,
    createdTo,
    paymentStatus,
    paymentMethod,
    orderSessionId,
    employeeId,
    shiftId,
  }: GetInvoicesPaginationDto) {
    const fieldsSelect =
      this.queryUtilService.convertFieldsSelectOption<any>(select);
    const where: Prisma.InvoiceWhereInput = {
      ...(paymentStatus ? { paymentStatus } : {}),
      ...(paymentMethod ? { paymentMethod } : {}),
      ...(orderSessionId ? { orderSessionId } : {}),
      ...(employeeId ? { employeeId } : {}),
      ...(shiftId ? { shiftId } : {}),
      ...(createdFrom || createdTo
        ? {
            createdAt: {
              ...(createdFrom ? { gte: createdFrom } : {}),
              ...(createdTo ? { lte: createdTo } : {}),
            },
          }
        : {}),
    };

    const totalItems = await this.prisma.invoice.count({ where });
    const paging = this.paginationUtilService.paging({
      page,
      itemPerPage,
      totalItems,
    });

    const list = await this.prisma.invoice.findMany({
      ...(fieldsSelect
        ? { select: fieldsSelect }
        : { include: this.invoiceInclude }),
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: { createdAt: 'desc' },
    });

    return paging.format(list);
  }

  async getInvoiceById(id: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: this.invoiceInclude,
    });

    if (!invoice) {
      throw new NotFoundException(`Invoice with ID ${id} not found.`);
    }

    return invoice;
  }

  async updatePayment(
    id: string,
    employeeId: string,
    updatePaymentDto: UpdateInvoicePaymentDto,
  ) {
    const invoice = await this.runSerializableTransaction(async (tx) => {
      const employee = await tx.employee.findUnique({
        where: { id: employeeId },
        select: { isActive: true },
      });
      this.invoicePolicy.assertActiveEmployee(employee);

      const existingInvoice = await tx.invoice.findUnique({
        where: { id },
        include: {
          orderSession: true,
          orderItems: {
            select: {
              id: true,
              isPaid: true,
              invoiceId: true,
            },
          },
        },
      });

      if (!existingInvoice) {
        throw new NotFoundException(`Invoice with ID ${id} not found.`);
      }

      this.invoicePolicy.assertInvoiceIsUnpaid(existingInvoice);
      await this.assertNoPendingOnlinePayment(tx, id);

      const paymentMethod =
        updatePaymentDto.paymentMethod ?? existingInvoice.paymentMethod;
      if (paymentMethod === PaymentMethod.TRANSFER) {
        throw new BadRequestException(
          'Online transfers must be confirmed by the payment provider.',
        );
      }
      const amountTendered = this.resolvePaidAmountTendered({
        paymentMethod,
        totalAmount: existingInvoice.totalAmount,
        amountTendered: updatePaymentDto.amountTendered,
      });
      this.invoicePolicy.assertPaidPaymentAmount({
        paymentMethod,
        amountTendered,
        totalAmount: existingInvoice.totalAmount,
      });
      const shift = await this.cashierShiftLedger.requireOpenShift(
        tx,
        employeeId,
      );

      await tx.invoice.update({
        where: { id },
        data: {
          paymentStatus: PaymentStatus.PAID,
          paymentMethod,
          amountTendered,
          changeAmount: amountTendered
            ? amountTendered.minus(existingInvoice.totalAmount)
            : new Decimal(0),
          employeeId,
          shiftId: shift.id,
        },
      });

      if (paymentMethod === PaymentMethod.CASH) {
        await this.cashierShiftLedger.recordCashInvoice(tx, {
          shift,
          invoiceId: existingInvoice.id,
          invoiceNumber: existingInvoice.invoiceNumber,
          employeeId,
          amount: existingInvoice.totalAmount,
        });
      }

      await tx.orderItem.updateMany({
        where: {
          invoiceId: id,
          isPaid: false,
        },
        data: {
          isPaid: true,
        },
      });

      if (updatePaymentDto.closeSessionAfterPayment) {
        await this.closeSessionIfFullyPaid(tx, existingInvoice.orderSession);
      }

      const invoice = await this.findInvoiceInTransaction(tx, id);
      await this.enqueueInvoiceEvent(tx, ORDER_EVENTS.INVOICE_PAID, invoice);
      return invoice;
    });
    return invoice;
  }

  async voidInvoice(id: string, employeeId: string) {
    const invoice = await this.runSerializableTransaction(async (tx) => {
      const employee = await tx.employee.findUnique({
        where: { id: employeeId },
        select: { isActive: true },
      });
      this.invoicePolicy.assertActiveEmployee(employee);

      const existingInvoice = await tx.invoice.findUnique({
        where: { id },
        include: { orderSession: true },
      });

      if (!existingInvoice) {
        throw new NotFoundException(`Invoice with ID ${id} not found.`);
      }

      this.invoicePolicy.assertInvoiceIsUnpaid(existingInvoice);
      await this.assertNoPendingOnlinePayment(tx, id);

      await tx.orderItem.updateMany({
        where: {
          invoiceId: id,
          isPaid: false,
        },
        data: {
          invoiceId: null,
          isPaid: false,
        },
      });

      await tx.invoice.update({
        where: { id },
        data: {
          paymentStatus: PaymentStatus.VOIDED,
          employeeId,
        },
      });

      const invoice = await this.findInvoiceInTransaction(tx, id);
      await this.enqueueInvoiceEvent(tx, ORDER_EVENTS.INVOICE_VOIDED, invoice);
      return invoice;
    });
    return invoice;
  }

  async completeOnlinePayment(
    tx: ExtendedPrismaTransactionClient,
    input: {
      invoiceId: string;
      employeeId: string;
      shiftId: string;
      closeSessionAfterPayment: boolean;
    },
  ) {
    const invoice = await tx.invoice.findUnique({
      where: { id: input.invoiceId },
      include: { orderSession: true },
    });
    if (!invoice) {
      throw new NotFoundException(
        `Invoice with ID ${input.invoiceId} not found.`,
      );
    }
    this.invoicePolicy.assertInvoiceIsUnpaid(invoice);

    const updated = await tx.invoice.updateMany({
      where: {
        id: invoice.id,
        paymentStatus: PaymentStatus.UNPAID,
      },
      data: {
        paymentStatus: PaymentStatus.PAID,
        paymentMethod: PaymentMethod.TRANSFER,
        amountTendered: invoice.totalAmount,
        changeAmount: new Decimal(0),
        employeeId: input.employeeId,
        shiftId: input.shiftId,
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException(
        'Invoice payment state changed during provider confirmation.',
      );
    }

    await tx.orderItem.updateMany({
      where: { invoiceId: invoice.id, isPaid: false },
      data: { isPaid: true },
    });
    if (input.closeSessionAfterPayment) {
      await this.closeSessionIfFullyPaid(tx, invoice.orderSession);
    }
    const paidInvoice = await this.findInvoiceInTransaction(tx, invoice.id);
    await this.enqueueInvoiceEvent(tx, ORDER_EVENTS.INVOICE_PAID, paidInvoice);
    return paidInvoice;
  }

  private async createInvoiceInternal({
    employeeId,
    input,
    paymentStatus,
    paymentMethod,
    amountTendered,
    closeSessionAfterPayment,
    eventNames,
  }: {
    employeeId: string;
    input: CreateInvoiceDto;
    paymentStatus: PaymentStatus;
    paymentMethod: PaymentMethod;
    amountTendered?: string | number;
    closeSessionAfterPayment: boolean;
    eventNames: Array<
      typeof ORDER_EVENTS.INVOICE_CREATED | typeof ORDER_EVENTS.INVOICE_PAID
    >;
  }) {
    return this.runSerializableTransaction((tx) =>
      this.createInvoiceInTransaction(tx, {
        employeeId,
        input,
        paymentStatus,
        paymentMethod,
        amountTendered,
        closeSessionAfterPayment,
        eventNames,
      }),
    );
  }

  private async createInvoiceInTransaction(
    tx: ExtendedPrismaTransactionClient,
    {
      employeeId,
      input,
      paymentStatus,
      paymentMethod,
      amountTendered,
      closeSessionAfterPayment,
      eventNames,
    }: {
      employeeId: string;
      input: CreateInvoiceDto;
      paymentStatus: PaymentStatus;
      paymentMethod: PaymentMethod;
      amountTendered?: string | number;
      closeSessionAfterPayment: boolean;
      eventNames: Array<
        typeof ORDER_EVENTS.INVOICE_CREATED | typeof ORDER_EVENTS.INVOICE_PAID
      >;
    },
  ) {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { isActive: true },
    });
    this.invoicePolicy.assertActiveEmployee(employee);

    const session = await tx.orderSession.findUnique({
      where: { id: input.orderSessionId },
      select: {
        id: true,
        sessionStatus: true,
        tableId: true,
      },
    });

    if (!session) {
      throw new NotFoundException(
        `Order session with ID ${input.orderSessionId} not found.`,
      );
    }
    this.invoicePolicy.assertActiveSession(session.sessionStatus);
    const shift =
      paymentStatus === PaymentStatus.PAID
        ? await this.cashierShiftLedger.requireOpenShift(tx, employeeId)
        : null;

    const items = await this.getInvoiceItems(tx, {
      orderSessionId: input.orderSessionId,
      orderItemIds: input.orderItemIds,
    });
    this.invoicePolicy.assertInvoiceItemsAreBillable(items);

    const subTotal = this.calculateSubTotal(items);
    const promotionCalculation = input.promotionId
      ? await this.promotionCalculatorService.calculateDiscountTx(tx, {
          promotionId: input.promotionId,
          subTotal,
          at: new Date(),
        })
      : null;
    const calculation = this.calculateInvoice({
      subTotal,
      promotionCalculation,
      taxRate: input.taxRate,
      paymentStatus,
      paymentMethod,
      amountTendered,
    });

    const invoice = await tx.invoice.create({
      data: {
        invoiceNumber: await this.invoiceNumberService.generate(tx),
        subTotal: calculation.subTotal,
        discountAmount: calculation.discountAmount,
        totalAmount: calculation.totalAmount,
        amountTendered: calculation.amountTendered,
        changeAmount: calculation.changeAmount,
        paymentMethod,
        paymentStatus,
        taxAmount: calculation.taxAmount,
        taxRate: calculation.taxRate,
        orderSessionId: session.id,
        employeeId,
        shiftId: shift?.id ?? null,
        promotionId: promotionCalculation?.promotionId ?? null,
      },
      select: { id: true, invoiceNumber: true },
    });

    const updatedItems = await tx.orderItem.updateMany({
      where: {
        id: { in: items.map((item) => item.id) },
        orderSessionId: session.id,
        isPaid: false,
        invoiceId: null,
        serveStatus: { not: ServeStatus.CANCELLED },
      },
      data: {
        invoiceId: invoice.id,
        ...(paymentStatus === PaymentStatus.PAID ? { isPaid: true } : {}),
      },
    });

    if (updatedItems.count !== items.length) {
      throw new ConflictException(
        'One or more order items were changed by another operation. Please refresh and try again.',
      );
    }

    if (
      paymentStatus === PaymentStatus.PAID &&
      paymentMethod === PaymentMethod.CASH &&
      shift
    ) {
      await this.cashierShiftLedger.recordCashInvoice(tx, {
        shift,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        employeeId,
        amount: calculation.totalAmount,
      });
    }

    if (paymentStatus === PaymentStatus.PAID && closeSessionAfterPayment) {
      await this.closeSessionIfFullyPaid(tx, session);
    }

    const persistedInvoice = await this.findInvoiceInTransaction(
      tx,
      invoice.id,
    );
    for (const eventName of eventNames) {
      await this.enqueueInvoiceEvent(tx, eventName, persistedInvoice);
    }
    return persistedInvoice;
  }

  private async getInvoiceItems(
    tx: ExtendedPrismaTransactionClient,
    {
      orderSessionId,
      orderItemIds,
    }: {
      orderSessionId: string;
      orderItemIds?: string[];
    },
  ): Promise<InvoiceLineSnapshot[]> {
    const uniqueItemIds = orderItemIds ? [...new Set(orderItemIds)] : undefined;
    if (orderItemIds && uniqueItemIds?.length !== orderItemIds.length) {
      throw new BadRequestException(
        'Duplicate order item IDs are not allowed.',
      );
    }

    const items = await tx.orderItem.findMany({
      where: {
        orderSessionId,
        ...(uniqueItemIds
          ? { id: { in: uniqueItemIds } }
          : {
              isPaid: false,
              invoiceId: null,
              serveStatus: { not: ServeStatus.CANCELLED },
            }),
      },
      select: {
        id: true,
        quantity: true,
        priceAtTime: true,
        serveStatus: true,
        isPaid: true,
        invoiceId: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (uniqueItemIds && items.length !== uniqueItemIds.length) {
      throw new BadRequestException(
        'One or more order items do not belong to this order session.',
      );
    }

    return items;
  }

  private calculateInvoice({
    subTotal,
    promotionCalculation,
    taxRate,
    paymentStatus,
    paymentMethod,
    amountTendered,
  }: {
    subTotal: Decimal;
    promotionCalculation: PromotionCalculationResult | null;
    taxRate?: string | number;
    paymentStatus: PaymentStatus;
    paymentMethod: PaymentMethod;
    amountTendered?: string | number;
  }): InvoiceCalculationResult {
    const discountAmount =
      promotionCalculation?.discountAmount ?? new Decimal(0);
    const resolvedTaxRate = this.toDecimal(taxRate ?? 0);
    const taxableAmount = Decimal.max(subTotal.minus(discountAmount), 0);
    const taxAmount = taxableAmount
      .mul(resolvedTaxRate)
      .div(100)
      .toDecimalPlaces(2);
    const totalAmount = taxableAmount.plus(taxAmount).toDecimalPlaces(2);
    const resolvedAmountTendered =
      paymentStatus === PaymentStatus.PAID
        ? this.resolvePaidAmountTendered({
            paymentMethod,
            totalAmount,
            amountTendered,
          })
        : null;

    if (paymentStatus === PaymentStatus.PAID) {
      this.invoicePolicy.assertPaidPaymentAmount({
        paymentMethod,
        amountTendered: resolvedAmountTendered,
        totalAmount,
      });
    }

    return {
      subTotal,
      discountAmount,
      taxAmount,
      taxRate: resolvedTaxRate,
      totalAmount,
      amountTendered: resolvedAmountTendered,
      changeAmount: resolvedAmountTendered
        ? resolvedAmountTendered.minus(totalAmount).toDecimalPlaces(2)
        : null,
    };
  }

  private resolvePaidAmountTendered({
    paymentMethod,
    totalAmount,
    amountTendered,
  }: {
    paymentMethod: PaymentMethod;
    totalAmount: Decimal;
    amountTendered?: string | number | Decimal | null;
  }) {
    if (amountTendered !== undefined && amountTendered !== null) {
      return this.toDecimal(amountTendered);
    }

    if (paymentMethod === PaymentMethod.CASH) {
      return null;
    }

    return totalAmount;
  }

  private toDecimal(value: string | number | Decimal) {
    return new Decimal(value).toDecimalPlaces(4);
  }

  private calculateSubTotal(items: InvoiceLineSnapshot[]) {
    return items
      .reduce(
        (total, item) =>
          total.plus(new Decimal(item.priceAtTime).mul(item.quantity)),
        new Decimal(0),
      )
      .toDecimalPlaces(2);
  }

  private async closeSessionIfFullyPaid(
    tx: ExtendedPrismaTransactionClient,
    session: {
      id: string;
      sessionStatus: SessionStatus;
      tableId: string | null;
    },
  ) {
    if (session.sessionStatus !== SessionStatus.ACTIVE) return;

    const remainingUnpaidItems = await tx.orderItem.count({
      where: {
        orderSessionId: session.id,
        serveStatus: { not: ServeStatus.CANCELLED },
        isPaid: false,
      },
    });

    if (remainingUnpaidItems > 0) return;

    const updatedSession = await tx.orderSession.updateMany({
      where: { id: session.id, sessionStatus: SessionStatus.ACTIVE },
      data: { sessionStatus: SessionStatus.COMPLETED },
    });

    if (updatedSession.count !== 1) {
      throw new ConflictException(
        'Order session was changed by another operation. Please refresh and try again.',
      );
    }

    if (session.tableId) {
      await tx.diningTable.updateMany({
        where: { id: session.tableId },
        data: { status: TableStatus.EMPTY },
      });
    }
  }

  private async findInvoiceInTransaction(
    tx: ExtendedPrismaTransactionClient,
    id: string,
  ) {
    const invoice = await tx.invoice.findUnique({
      where: { id },
      include: this.invoiceInclude,
    });

    if (!invoice) {
      throw new NotFoundException(`Invoice with ID ${id} not found.`);
    }

    return invoice;
  }

  private async assertNoPendingOnlinePayment(
    tx: ExtendedPrismaTransactionClient,
    invoiceId: string,
  ) {
    const pendingAttempt = await tx.paymentAttempt.findFirst({
      where: { invoiceId, status: PaymentAttemptStatus.PENDING },
      select: { id: true },
    });
    if (pendingAttempt) {
      throw new ConflictException(
        'Invoice has a pending online payment attempt.',
      );
    }
  }

  private enqueueInvoiceEvent(
    tx: ExtendedPrismaTransactionClient,
    eventName:
      | typeof ORDER_EVENTS.INVOICE_CREATED
      | typeof ORDER_EVENTS.INVOICE_PAID
      | typeof ORDER_EVENTS.INVOICE_VOIDED,
    invoice: {
      id: string;
      invoiceNumber: string;
      orderSessionId: string;
      orderSession: { tableId: string | null };
    },
  ) {
    return this.outbox.enqueue(tx, {
      topic: 'order',
      eventName,
      aggregateType: 'Invoice',
      aggregateId: invoice.id,
      payload: {
        ...this.createEventBase([invoice.orderSession.tableId]),
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        orderSessionId: invoice.orderSessionId,
        tableId: invoice.orderSession.tableId,
      },
    });
  }

  private createEventBase(
    affectedTableIds: Array<string | null | undefined>,
  ): OrderEventBase {
    return {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      affectedTableIds: [
        ...new Set(
          affectedTableIds.filter((tableId): tableId is string =>
            Boolean(tableId),
          ),
        ),
      ],
    };
  }

  private async runSerializableTransaction<T>(
    callback: (tx: ExtendedPrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 1;
      attempt <= this.maxSerializableTransactionRetries;
      attempt++
    ) {
      try {
        return await this.prisma.$transaction(
          callback,
          this.serializableTransaction,
        );
      } catch (error) {
        if (
          this.isRetryableTransactionError(error) &&
          attempt < this.maxSerializableTransactionRetries
        ) {
          this.logger.warn(
            `Invoice transaction conflict. Retrying attempt ${attempt + 1}/${this.maxSerializableTransactionRetries}`,
          );
          await new Promise((resolve) => setTimeout(resolve, attempt * 25));
          continue;
        }

        throw error;
      }
    }

    throw new ConflictException('Transaction failed. Please try again.');
  }

  private isRetryableTransactionError(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2034' || error.code === 'P2002')
    );
  }
}
