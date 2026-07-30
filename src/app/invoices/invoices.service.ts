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
  DiscountType,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ServeStatus,
  SessionStatus,
  TableStatus,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../../common/utils/query-util/query-util.service';
import type {
  InvoiceCalculationResult,
  InvoiceLineSnapshot,
  InvoicePromotionSnapshot,
  OrderEventBase,
} from '../../common/types';
import { ORDER_EVENTS } from '../orders/events/order.events';
import { OrderEventsPublisher } from '../orders/events/order-events.publisher';
import { CheckoutInvoiceDto, CreateInvoiceDto } from './dto/create-invoice.dto';
import { GetInvoicesPaginationDto } from './dto/get-invoice.dto';
import { UpdateInvoicePaymentDto } from './dto/update-invoice.dto';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoicePolicyService } from './invoice-policy.service';

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
    private readonly orderEventsPublisher: OrderEventsPublisher,
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
    const invoice = await this.createInvoiceInternal({
      employeeId,
      input: createInvoiceDto,
      paymentStatus: PaymentStatus.PENDING,
      paymentMethod: PaymentMethod.CASH,
      closeSessionAfterPayment: false,
    });

    this.emitInvoiceEvent(ORDER_EVENTS.INVOICE_CREATED, invoice);
    return invoice;
  }

  async checkoutInvoice(
    employeeId: string,
    checkoutInvoiceDto: CheckoutInvoiceDto,
  ) {
    if (checkoutInvoiceDto.idempotencyKey) {
      throw new BadRequestException(
        'idempotencyKey requires a persisted idempotency store before it can be supported safely.',
      );
    }

    const invoice = await this.createInvoiceInternal({
      employeeId,
      input: checkoutInvoiceDto,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: checkoutInvoiceDto.paymentMethod,
      amountTendered: checkoutInvoiceDto.amountTendered,
      closeSessionAfterPayment: checkoutInvoiceDto.closeSessionAfterPayment,
    });

    this.emitInvoiceEvent(ORDER_EVENTS.INVOICE_CREATED, invoice);
    this.emitInvoiceEvent(ORDER_EVENTS.INVOICE_PAID, invoice);
    return invoice;
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

      this.invoicePolicy.assertInvoiceIsPending(existingInvoice);

      if (updatePaymentDto.paymentStatus === PaymentStatus.FAILED) {
        await tx.orderItem.updateMany({
          where: {
            invoiceId: id,
            isPaid: false,
          },
          data: {
            invoiceId: null,
          },
        });

        await tx.invoice.update({
          where: { id },
          data: {
            paymentStatus: PaymentStatus.FAILED,
            employeeId,
          },
        });

        return this.findInvoiceInTransaction(tx, id);
      }

      const paymentMethod =
        updatePaymentDto.paymentMethod ?? existingInvoice.paymentMethod;
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
        },
      });

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

      return this.findInvoiceInTransaction(tx, id);
    });

    this.emitInvoiceEvent(
      invoice.paymentStatus === PaymentStatus.PAID
        ? ORDER_EVENTS.INVOICE_PAID
        : ORDER_EVENTS.INVOICE_VOIDED,
      invoice,
    );

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

      this.invoicePolicy.assertInvoiceIsPending(existingInvoice);

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
          paymentStatus: PaymentStatus.FAILED,
          employeeId,
        },
      });

      return this.findInvoiceInTransaction(tx, id);
    });

    this.emitInvoiceEvent(ORDER_EVENTS.INVOICE_VOIDED, invoice);
    return invoice;
  }

  private async createInvoiceInternal({
    employeeId,
    input,
    paymentStatus,
    paymentMethod,
    amountTendered,
    closeSessionAfterPayment,
  }: {
    employeeId: string;
    input: CreateInvoiceDto;
    paymentStatus: PaymentStatus;
    paymentMethod: PaymentMethod;
    amountTendered?: string | number;
    closeSessionAfterPayment: boolean;
  }) {
    return this.runSerializableTransaction(async (tx) => {
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
          shiftId: true,
        },
      });

      if (!session) {
        throw new NotFoundException(
          `Order session with ID ${input.orderSessionId} not found.`,
        );
      }
      this.invoicePolicy.assertActiveSession(session.sessionStatus);

      const items = await this.getInvoiceItems(tx, {
        orderSessionId: input.orderSessionId,
        orderItemIds: input.orderItemIds,
      });
      this.invoicePolicy.assertInvoiceItemsAreBillable(items);

      const promotion = input.promotionId
        ? await this.getPromotion(tx, input.promotionId)
        : null;
      const calculation = this.calculateInvoice({
        items,
        promotion,
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
          shiftId: session.shiftId,
          promotionId: promotion?.id ?? null,
        },
        select: { id: true },
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

      if (paymentStatus === PaymentStatus.PAID && closeSessionAfterPayment) {
        await this.closeSessionIfFullyPaid(tx, session);
      }

      return this.findInvoiceInTransaction(tx, invoice.id);
    });
  }

  private async getInvoiceItems(
    tx: any,
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

  private async getPromotion(
    tx: any,
    promotionId: string,
  ): Promise<InvoicePromotionSnapshot> {
    const promotion = await tx.promotion.findUnique({
      where: { id: promotionId },
      select: {
        id: true,
        discountType: true,
        discountValue: true,
        maxDiscount: true,
        startDate: true,
        endDate: true,
      },
    });

    if (!promotion) {
      throw new NotFoundException(
        `Promotion with ID ${promotionId} not found.`,
      );
    }

    const now = new Date();
    if (promotion.startDate > now || promotion.endDate < now) {
      throw new BadRequestException('Promotion is not active.');
    }

    return promotion;
  }

  private calculateInvoice({
    items,
    promotion,
    taxRate,
    paymentStatus,
    paymentMethod,
    amountTendered,
  }: {
    items: InvoiceLineSnapshot[];
    promotion: InvoicePromotionSnapshot | null;
    taxRate?: string | number;
    paymentStatus: PaymentStatus;
    paymentMethod: PaymentMethod;
    amountTendered?: string | number;
  }): InvoiceCalculationResult {
    const subTotal = items
      .reduce(
        (total, item) =>
          total.plus(new Decimal(item.priceAtTime).mul(item.quantity)),
        new Decimal(0),
      )
      .toDecimalPlaces(2);
    const discountAmount = this.calculateDiscount(subTotal, promotion);
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

  private calculateDiscount(
    subTotal: Decimal,
    promotion: InvoicePromotionSnapshot | null,
  ) {
    if (!promotion) return new Decimal(0);

    const rawDiscount =
      promotion.discountType === DiscountType.PERCENTAGE
        ? subTotal.mul(promotion.discountValue).div(100)
        : new Decimal(promotion.discountValue);
    const cappedByPromotion = promotion.maxDiscount
      ? Decimal.min(rawDiscount, promotion.maxDiscount)
      : rawDiscount;

    return Decimal.min(cappedByPromotion, subTotal).toDecimalPlaces(2);
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

  private async closeSessionIfFullyPaid(
    tx: any,
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

  private async findInvoiceInTransaction(tx: any, id: string) {
    const invoice = await tx.invoice.findUnique({
      where: { id },
      include: this.invoiceInclude,
    });

    if (!invoice) {
      throw new NotFoundException(`Invoice with ID ${id} not found.`);
    }

    return invoice;
  }

  private emitInvoiceEvent(
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
    this.orderEventsPublisher.emit(eventName, {
      ...this.createEventBase([invoice.orderSession.tableId]),
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      orderSessionId: invoice.orderSessionId,
      tableId: invoice.orderSession.tableId,
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
    callback: (tx: any) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 1;
      attempt <= this.maxSerializableTransactionRetries;
      attempt++
    ) {
      try {
        return (await (this.prisma.$transaction as any)(
          callback,
          this.serializableTransaction,
        )) as T;
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
