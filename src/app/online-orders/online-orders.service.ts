import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnlineOrderStatus,
  PrintJobStatus,
  Prisma,
  ServeStatus,
  SessionStatus,
} from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { TurnstileService } from '../auth/turnstile.service';
import { OrdersService } from '../orders/orders.service';
import { InvoicesService } from '../invoices/invoices.service';
import { InventoryConsumptionService } from '../inventory/services/inventory-consumption.service';
import { IdempotencyService } from '../durable/idempotency.service';
import { OutboxService } from '../durable/outbox.service';
import { ORDER_EVENTS } from '../orders/events/order.events';
import {
  ORDER_MENU_ITEM_SELECT,
  readSelectedOptions,
  resolveMenuSelection,
} from '../menu/menu-option-selection';
import {
  CreateOnlineOrderDto,
  CancelAcceptedOnlineOrderDto,
  CollectOnlineOrderDto,
  GetPendingOnlineOrdersDto,
  OnlineOrderAccessDto,
  ReorderTemplateDto,
  RevokeReorderKeyDto,
} from './dto';
import {
  assertPickupAt,
  pickupSlotsForDate,
  readPickupSchedule,
  type PickupSchedule,
} from './pickup-schedule';
import {
  ONLINE_ORDER_ACCESS_WINDOW_MS,
  ONLINE_ORDER_TELEGRAM_EVENT,
} from './telegram-events';

const REVIEW_WINDOW_MS = 30 * 60 * 1000;
const REORDER_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
const NO_SHOW_GRACE_MS = 15 * 60 * 1000;
const CUSTOMER_CANCELLATION_REASON = 'Customer cancelled before preparation.';

const publicRequestSelect = {
  id: true,
  requestHash: true,
  reorderNonce: true,
  status: true,
  createdAt: true,
  expiresAt: true,
  quotedSubtotal: true,
  pickupAt: true,
  items: {
    orderBy: { lineNumber: 'asc' },
    select: {
      lineNumber: true,
      menuItemId: true,
      quotedName: true,
      quotedUnitPrice: true,
      quotedOptions: true,
      quantity: true,
      note: true,
    },
  },
} satisfies Prisma.OnlineOrderRequestSelect;

type PublicRequest = Prisma.OnlineOrderRequestGetPayload<{
  select: typeof publicRequestSelect;
}>;

@Injectable()
export class OnlineOrdersService {
  private readonly accessKey: Buffer;
  private readonly reorderKey: Buffer;
  private readonly pickupSchedule: PickupSchedule | null;
  private readonly telegramBotUsername?: string;

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly orders: OrdersService,
    private readonly invoices: InvoicesService,
    private readonly inventoryConsumption: InventoryConsumptionService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly pagination: PaginationUtilService,
    config: ConfigService,
    private readonly turnstile: TurnstileService,
  ) {
    this.pickupSchedule = readPickupSchedule(config);
    this.telegramBotUsername = config.get<string>('TELEGRAM_BOT_USERNAME');
    this.accessKey = createHmac(
      'sha256',
      config.getOrThrow<string>('JWT_SECRET'),
    )
      .update('online-order-access:v1')
      .digest();
    this.reorderKey = createHmac(
      'sha256',
      config.get<string>('ONLINE_REORDER_SECRET') ??
        config.getOrThrow<string>('JWT_SECRET'),
    )
      .update('online-order-reorder:v1')
      .digest();
  }

  async createPublicRequest(dto: CreateOnlineOrderDto, ipAddress?: string) {
    const maxSubtotal = dto.maxSubtotal
      ? new Prisma.Decimal(dto.maxSubtotal).toFixed(2)
      : undefined;
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          pickupName: dto.pickupName,
          phoneNumber: dto.phoneNumber,
          pickupAt: dto.pickupAt?.toISOString(),
          maxSubtotal,
          items: dto.items,
        }),
      )
      .digest('hex');
    const existing = await this.prisma.onlineOrderRequest.findUnique({
      where: { clientRequestId: dto.clientRequestId },
      select: publicRequestSelect,
    });
    if (existing) return this.replay(existing, requestHash);
    await this.turnstile.verify(dto.turnstileToken, ipAddress, 'online_order');
    if (dto.pickupAt)
      assertPickupAt(dto.pickupAt, this.pickupSchedule, new Date());

    const menuItemIds = [...new Set(dto.items.map((item) => item.menuItemId))];
    const menuById = await this.availableMenuItems(menuItemIds);
    if (menuById.size !== menuItemIds.length) {
      throw new NotFoundException('One or more menu items are unavailable.');
    }
    const items = dto.items.map((item, index) => {
      const menuItem = menuById.get(item.menuItemId)!;
      const selection = resolveMenuSelection(menuItem, item.optionIds);
      return {
        lineNumber: index + 1,
        menuItemId: item.menuItemId,
        quantity: item.quantity,
        note: item.note,
        quotedName: menuItem.name,
        quotedUnitPrice: selection.unitPrice,
        quotedOptions: selection.selectedOptions,
      };
    });
    const quotedSubtotal = items.reduce(
      (sum, item) => sum.plus(item.quotedUnitPrice.mul(item.quantity)),
      new Prisma.Decimal(0),
    );
    if (maxSubtotal && quotedSubtotal.gt(maxSubtotal)) {
      throw new ConflictException(
        'Order price increased; review the current quote.',
      );
    }

    try {
      const created = await this.prisma.onlineOrderRequest.create({
        data: {
          clientRequestId: dto.clientRequestId,
          requestHash,
          reorderNonce: randomBytes(32).toString('hex'),
          pickupName: dto.pickupName,
          phoneNumber: dto.phoneNumber,
          quotedSubtotal,
          pickupAt: dto.pickupAt,
          expiresAt: new Date(Date.now() + REVIEW_WINDOW_MS),
          items: { create: items },
        },
        select: publicRequestSelect,
      });
      return this.replay(created, requestHash);
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      ) {
        throw error;
      }
      const duplicate = await this.prisma.onlineOrderRequest.findUnique({
        where: { clientRequestId: dto.clientRequestId },
        select: publicRequestSelect,
      });
      if (!duplicate) throw error;
      return this.replay(duplicate, requestHash);
    }
  }

  async getPickupSlots(date: string) {
    const schedule = this.pickupSchedule;
    if (!schedule)
      return { date, timeZone: 'Asia/Ho_Chi_Minh', enabled: false, slots: [] };
    const slots = pickupSlotsForDate(date, schedule, new Date());
    if (slots.length === 0)
      return { date, timeZone: 'Asia/Ho_Chi_Minh', enabled: true, slots: [] };
    const counts = await this.prisma.onlineOrderRequest.groupBy({
      by: ['pickupAt'],
      where: {
        status: OnlineOrderStatus.ACCEPTED,
        pickupAt: { gte: slots[0], lte: slots[slots.length - 1] },
      },
      _count: { _all: true },
    });
    const booked = new Map(
      counts.map((row) => [row.pickupAt?.getTime(), row._count._all]),
    );
    return {
      date,
      timeZone: 'Asia/Ho_Chi_Minh',
      enabled: true,
      slots: slots.map((pickupAt) => ({
        pickupAt: pickupAt.toISOString(),
        remaining: Math.max(
          0,
          schedule.capacity - (booked.get(pickupAt.getTime()) ?? 0),
        ),
      })),
    };
  }

  async trackPublicRequest({ requestId, accessToken }: OnlineOrderAccessDto) {
    this.assertAccess(requestId, accessToken);
    const request = await this.prisma.onlineOrderRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        expiresAt: true,
        rejectionReason: true,
        cancellationReason: true,
        noShowAt: true,
        telegramChatId: true,
        quotedSubtotal: true,
        pickupAt: true,
        items: publicRequestSelect.items,
        orderSession: {
          select: {
            orderItems: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: {
                id: true,
                menuItemId: true,
                quantity: true,
                note: true,
                serveStatus: true,
                isPaid: true,
                selectedOptions: true,
              },
            },
          },
        },
      },
    });
    if (
      !request ||
      request.createdAt.getTime() + ONLINE_ORDER_ACCESS_WINDOW_MS < Date.now()
    ) {
      throw new NotFoundException('Order request not found.');
    }
    const orderItems = request.orderSession?.orderItems ?? [];
    const activeItems = orderItems.filter(
      (item) => item.serveStatus !== ServeStatus.CANCELLED,
    );
    const fulfillmentStatus = this.fulfillmentStatus(
      request.status,
      orderItems,
    );

    return {
      requestId: request.id,
      status:
        request.status === OnlineOrderStatus.PENDING &&
        request.expiresAt <= new Date()
          ? 'EXPIRED'
          : request.status,
      expiresAt: request.expiresAt,
      rejectionReason: request.rejectionReason,
      cancellationReason: request.cancellationReason,
      noShowAt: request.noShowAt,
      quotedSubtotal: request.quotedSubtotal,
      pickupAt: request.pickupAt,
      items: request.items,
      fulfillmentStatus,
      isPaid:
        activeItems.length > 0 && activeItems.every((item) => item.isPaid),
      orderItems,
      telegram: {
        enabled: Boolean(this.telegramBotUsername),
        subscribed: Boolean(request.telegramChatId),
      },
    };
  }

  async reorderTemplate({
    requestId,
    accessToken,
    reorderToken,
  }: ReorderTemplateDto) {
    if (accessToken) this.assertAccess(requestId, accessToken);
    const request = await this.prisma.onlineOrderRequest.findUnique({
      where: { id: requestId },
      select: {
        createdAt: true,
        reorderNonce: true,
        quotedSubtotal: true,
        items: {
          orderBy: { lineNumber: 'asc' },
          select: {
            menuItemId: true,
            quantity: true,
            note: true,
            quotedName: true,
            quotedUnitPrice: true,
            quotedOptions: true,
          },
        },
      },
    });
    if (!request) throw new NotFoundException('Order request not found.');
    if (accessToken) {
      if (
        request.createdAt.getTime() + ONLINE_ORDER_ACCESS_WINDOW_MS <
        Date.now()
      ) {
        throw new NotFoundException('Order request not found.');
      }
    } else {
      this.assertReorderAccess(
        requestId,
        reorderToken,
        request.reorderNonce,
        request.createdAt,
      );
    }
    const items = request.items.map((item) => ({
      menuItemId: item.menuItemId,
      quantity: item.quantity,
      note: item.note ?? undefined,
      optionIds: readSelectedOptions(item.quotedOptions).map(
        (option) => option.id,
      ),
    }));
    const menuById = await this.availableMenuItems([
      ...new Set(items.map((item) => item.menuItemId)),
    ]);
    const lines = request.items.map((item, index) => {
      const menuItem = menuById.get(item.menuItemId);
      const previous = {
        lineNumber: index + 1,
        previousName: item.quotedName,
        previousUnitPrice: item.quotedUnitPrice.toFixed(2),
      };
      if (!menuItem) {
        return {
          ...previous,
          available: false,
          reason: 'ITEM_UNAVAILABLE',
          currentName: null,
          currentUnitPrice: null,
        };
      }
      try {
        const selection = resolveMenuSelection(
          menuItem,
          items[index].optionIds,
        );
        return {
          ...previous,
          available: true,
          reason: null,
          currentName: menuItem.name,
          currentUnitPrice: selection.unitPrice.toFixed(2),
        };
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
        return {
          ...previous,
          available: false,
          reason: 'SELECTION_UNAVAILABLE',
          currentName: menuItem.name,
          currentUnitPrice: null,
        };
      }
    });
    const canSubmit = lines.every((line) => line.available);
    return {
      items,
      quote: {
        previousSubtotal: request.quotedSubtotal.toFixed(2),
        currentSubtotal: canSubmit
          ? lines
              .reduce(
                (sum, line, index) =>
                  sum.plus(
                    new Prisma.Decimal(line.currentUnitPrice!).mul(
                      items[index].quantity,
                    ),
                  ),
                new Prisma.Decimal(0),
              )
              .toFixed(2)
          : null,
        canSubmit,
        lines,
      },
    };
  }

  async issueReorderKey({ requestId, accessToken }: OnlineOrderAccessDto) {
    this.assertAccess(requestId, accessToken);
    const request = await this.prisma.onlineOrderRequest.findUnique({
      where: { id: requestId },
      select: { createdAt: true, reorderNonce: true },
    });
    if (
      !request ||
      request.createdAt.getTime() + ONLINE_ORDER_ACCESS_WINDOW_MS < Date.now()
    ) {
      throw new NotFoundException('Order request not found.');
    }
    let nonce = request.reorderNonce;
    if (!nonce) {
      const candidate = randomBytes(32).toString('hex');
      const updated = await this.prisma.onlineOrderRequest.updateMany({
        where: { id: requestId, reorderNonce: null },
        data: { reorderNonce: candidate },
      });
      nonce =
        updated.count === 1
          ? candidate
          : ((
              await this.prisma.onlineOrderRequest.findUnique({
                where: { id: requestId },
                select: { reorderNonce: true },
              })
            )?.reorderNonce ?? null);
    }
    if (!nonce) throw new NotFoundException('Order request not found.');
    return {
      requestId,
      reorderToken: this.signReorder(requestId, nonce),
      expiresAt: this.reorderExpiresAt(request.createdAt),
    };
  }

  async revokeReorderKey({ requestId, reorderToken }: RevokeReorderKeyDto) {
    const request = await this.prisma.onlineOrderRequest.findUnique({
      where: { id: requestId },
      select: { createdAt: true, reorderNonce: true },
    });
    if (!request) throw new NotFoundException('Order request not found.');
    this.assertReorderAccess(
      requestId,
      reorderToken,
      request.reorderNonce,
      request.createdAt,
    );
    const revoked = await this.prisma.onlineOrderRequest.updateMany({
      where: { id: requestId, reorderNonce: request.reorderNonce },
      data: { reorderNonce: null },
    });
    if (revoked.count !== 1) {
      throw new NotFoundException('Order request not found.');
    }
    return { revoked: true };
  }

  async createTelegramLink({ requestId, accessToken }: OnlineOrderAccessDto) {
    if (!this.telegramBotUsername) {
      throw new ServiceUnavailableException(
        'Telegram notifications are disabled.',
      );
    }
    this.assertAccess(requestId, accessToken);
    const now = new Date();
    const request = await this.prisma.onlineOrderRequest.findUnique({
      where: { id: requestId },
      select: {
        createdAt: true,
        expiresAt: true,
        status: true,
        telegramChatId: true,
      },
    });
    if (
      !request ||
      request.createdAt.getTime() + ONLINE_ORDER_ACCESS_WINDOW_MS <
        now.getTime()
    ) {
      throw new NotFoundException('Order request not found.');
    }
    if (
      request.telegramChatId ||
      (request.status === OnlineOrderStatus.PENDING &&
        request.expiresAt <= now) ||
      (request.status !== OnlineOrderStatus.PENDING &&
        request.status !== OnlineOrderStatus.ACCEPTED)
    ) {
      throw new ConflictException('Telegram cannot be linked to this order.');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + 30 * 60_000);
    const updated = await this.prisma.onlineOrderRequest.updateMany({
      where: {
        id: requestId,
        telegramChatId: null,
        OR: [
          { status: OnlineOrderStatus.ACCEPTED },
          { status: OnlineOrderStatus.PENDING, expiresAt: { gt: now } },
        ],
      },
      data: {
        telegramLinkTokenHash: createHash('sha256').update(token).digest('hex'),
        telegramLinkExpiresAt: expiresAt,
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Telegram cannot be linked to this order.');
    }
    return {
      url: `https://t.me/${this.telegramBotUsername}?start=${token}`,
      expiresAt,
    };
  }

  async cancelPublicRequest({ requestId, accessToken }: OnlineOrderAccessDto) {
    this.assertAccess(requestId, accessToken);
    const cancelled = await this.prisma.onlineOrderRequest.updateMany({
      where: {
        id: requestId,
        status: OnlineOrderStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      data: { status: OnlineOrderStatus.CANCELLED, cancelledAt: new Date() },
    });
    if (cancelled.count === 1) {
      return { requestId, status: OnlineOrderStatus.CANCELLED };
    }
    const request = await this.prisma.onlineOrderRequest.findUnique({
      where: { id: requestId },
      select: { status: true },
    });
    if (!request) throw new NotFoundException('Order request not found.');
    if (request.status === OnlineOrderStatus.CANCELLED) {
      return { requestId, status: request.status };
    }
    if (request.status !== OnlineOrderStatus.ACCEPTED) {
      throw new ConflictException('Order request can no longer be cancelled.');
    }
    return runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const current = await tx.onlineOrderRequest.findUnique({
          where: { id: requestId },
          select: {
            status: true,
            createdAt: true,
            orderSessionId: true,
            orderSession: {
              select: {
                tableId: true,
                sessionStatus: true,
                orderItems: {
                  select: {
                    id: true,
                    serveStatus: true,
                    isPaid: true,
                    invoiceId: true,
                  },
                },
                kitchenTickets: {
                  select: {
                    printJobs: { select: { id: true, status: true } },
                  },
                },
              },
            },
          },
        });
        if (!current) throw new NotFoundException('Order request not found.');
        if (current.status === OnlineOrderStatus.CANCELLED) {
          return { requestId, status: OnlineOrderStatus.CANCELLED };
        }
        if (
          current.createdAt.getTime() + ONLINE_ORDER_ACCESS_WINDOW_MS <
          Date.now()
        ) {
          throw new NotFoundException('Order request not found.');
        }
        const session = current.orderSession;
        const items = session?.orderItems ?? [];
        const printJobs =
          session?.kitchenTickets.flatMap((ticket) => ticket.printJobs) ?? [];
        if (
          current.status !== OnlineOrderStatus.ACCEPTED ||
          !current.orderSessionId ||
          !session ||
          session.tableId !== null ||
          session.sessionStatus !== SessionStatus.ACTIVE ||
          items.length === 0 ||
          items.some(
            (item) =>
              item.serveStatus !== ServeStatus.PENDING ||
              item.isPaid ||
              item.invoiceId !== null,
          ) ||
          printJobs.some((job) => job.status !== PrintJobStatus.PENDING)
        ) {
          throw new ConflictException(
            'Preparation or printing has started; contact the shop to cancel.',
          );
        }
        const now = new Date();
        if (printJobs.length > 0) {
          const cancelledJobs = await tx.printJob.updateMany({
            where: {
              id: { in: printJobs.map((job) => job.id) },
              status: PrintJobStatus.PENDING,
            },
            data: { status: PrintJobStatus.CANCELLED },
          });
          if (cancelledJobs.count !== printJobs.length) {
            throw new ConflictException(
              'Printing has started; contact the shop.',
            );
          }
        }
        const cancelledItems = await tx.orderItem.updateMany({
          where: {
            id: { in: items.map((item) => item.id) },
            orderSessionId: current.orderSessionId,
            serveStatus: ServeStatus.PENDING,
            isPaid: false,
            invoiceId: null,
          },
          data: { serveStatus: ServeStatus.CANCELLED },
        });
        const cancelledSession = await tx.orderSession.updateMany({
          where: {
            id: current.orderSessionId,
            sessionStatus: SessionStatus.ACTIVE,
          },
          data: { sessionStatus: SessionStatus.CANCELLED },
        });
        const cancelledRequest = await tx.onlineOrderRequest.updateMany({
          where: {
            id: requestId,
            status: OnlineOrderStatus.ACCEPTED,
            orderSessionId: current.orderSessionId,
          },
          data: {
            status: OnlineOrderStatus.CANCELLED,
            cancellationReason: CUSTOMER_CANCELLATION_REASON,
            cancelledAt: now,
          },
        });
        if (
          cancelledItems.count !== items.length ||
          cancelledSession.count !== 1 ||
          cancelledRequest.count !== 1
        ) {
          throw new ConflictException(
            'Online order changed during cancellation.',
          );
        }
        await this.enqueueCancellationEvents(
          tx,
          requestId,
          current.orderSessionId,
          items,
        );
        return { requestId, status: OnlineOrderStatus.CANCELLED };
      },
      { loggerContext: 'Customer online order cancellation' },
    );
  }

  async findPending(query: GetPendingOnlineOrdersDto) {
    const where: Prisma.OnlineOrderRequestWhereInput = {
      status: OnlineOrderStatus.PENDING,
      expiresAt: { gt: new Date() },
    };
    const paging = this.pagination.paging(query);
    const [totalItems, list] = await Promise.all([
      this.prisma.onlineOrderRequest.count({ where }),
      this.prisma.onlineOrderRequest.findMany({
        where,
        skip: paging.skip,
        take: paging.itemPerPage,
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          pickupName: true,
          phoneNumber: true,
          quotedSubtotal: true,
          pickupAt: true,
          expiresAt: true,
          createdAt: true,
          items: publicRequestSelect.items,
        },
      }),
    ]);
    return this.pagination.paging({ ...query, totalItems }).format(list);
  }

  async findFulfillment(query: GetPendingOnlineOrdersDto) {
    const now = new Date();
    const overdueBefore = new Date(now.getTime() - NO_SHOW_GRACE_MS);
    const where: Prisma.OnlineOrderRequestWhereInput = {
      status: OnlineOrderStatus.ACCEPTED,
      ...(query.overdueOnly ? { pickupAt: { lt: overdueBefore } } : {}),
      orderSession: {
        is: {
          orderItems: {
            some: {
              serveStatus: {
                in: [
                  ServeStatus.PENDING,
                  ServeStatus.COOKING,
                  ServeStatus.READY,
                ],
              },
            },
          },
        },
      },
    };
    const paging = this.pagination.paging(query);
    const [totalItems, list] = await Promise.all([
      this.prisma.onlineOrderRequest.count({ where }),
      this.prisma.onlineOrderRequest.findMany({
        where,
        skip: paging.skip,
        take: paging.itemPerPage,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          pickupName: true,
          phoneNumber: true,
          quotedSubtotal: true,
          createdAt: true,
          pickupAt: true,
          orderSessionId: true,
          orderSession: {
            select: {
              sessionStatus: true,
              orderItems: {
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: {
                  id: true,
                  quantity: true,
                  priceAtTime: true,
                  serveStatus: true,
                  readyAt: true,
                  isPaid: true,
                  invoiceId: true,
                  selectedOptions: true,
                  menuItem: { select: { name: true } },
                },
              },
            },
          },
        },
      }),
    ]);
    return paging.format(
      list.map(({ orderSession, ...request }) => ({
        ...request,
        isOverdue:
          request.pickupAt !== null && request.pickupAt < overdueBefore,
        isNoShowEligible: this.isNoShowEligible(
          request.pickupAt,
          orderSession?.orderItems ?? [],
          now,
        ),
        sessionStatus: orderSession?.sessionStatus ?? null,
        orderItems: orderSession?.orderItems ?? [],
        fulfillmentStatus: this.fulfillmentStatus(
          OnlineOrderStatus.ACCEPTED,
          orderSession?.orderItems ?? [],
        ),
      })),
    );
  }

  async findOne(id: string) {
    const request = await this.prisma.onlineOrderRequest.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        pickupName: true,
        phoneNumber: true,
        quotedSubtotal: true,
        createdAt: true,
        expiresAt: true,
        reviewedAt: true,
        reviewedById: true,
        rejectionReason: true,
        pickupAt: true,
        cancellationReason: true,
        noShowAt: true,
        orderSessionId: true,
        orderSession: {
          select: {
            sessionStatus: true,
            orderItems: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: {
                id: true,
                quantity: true,
                priceAtTime: true,
                serveStatus: true,
                readyAt: true,
                isPaid: true,
                invoiceId: true,
                selectedOptions: true,
                menuItem: { select: { name: true } },
              },
            },
          },
        },
        items: publicRequestSelect.items,
      },
    });
    if (!request) throw new NotFoundException('Order request not found.');
    return {
      ...request,
      isNoShowEligible: this.isNoShowEligible(
        request.pickupAt,
        request.orderSession?.orderItems ?? [],
        new Date(),
      ),
      fulfillmentStatus: this.fulfillmentStatus(
        request.status,
        request.orderSession?.orderItems ?? [],
      ),
    };
  }

  async collect(id: string, employeeId: string, dto: CollectOnlineOrderDto) {
    this.assertAccess(id, dto.accessToken);
    const access = await this.prisma.onlineOrderRequest.findUnique({
      where: { id },
      select: { createdAt: true },
    });
    if (
      !access ||
      access.createdAt.getTime() + ONLINE_ORDER_ACCESS_WINDOW_MS < Date.now()
    ) {
      throw new NotFoundException('Order request not found.');
    }

    return this.idempotency.execute(
      {
        employeeId,
        operation: 'online-order.cod.collect',
        key: dto.idempotencyKey,
        request: { requestId: id, amountTendered: dto.amountTendered },
      },
      async (tx) => {
        const request = await tx.onlineOrderRequest.findUnique({
          where: { id },
          select: {
            status: true,
            quotedSubtotal: true,
            orderSessionId: true,
            orderSession: {
              select: {
                tableId: true,
                sessionStatus: true,
                orderItems: {
                  select: {
                    id: true,
                    serveStatus: true,
                    quantity: true,
                    priceAtTime: true,
                    isPaid: true,
                    invoiceId: true,
                  },
                },
              },
            },
          },
        });
        const session = request?.orderSession;
        if (
          request?.status !== OnlineOrderStatus.ACCEPTED ||
          !request.orderSessionId ||
          !session ||
          session.tableId !== null ||
          session.sessionStatus !== SessionStatus.ACTIVE
        ) {
          throw new ConflictException(
            'Online order is not available for pickup.',
          );
        }
        const items = session.orderItems;
        if (
          items.length === 0 ||
          items.some(
            (item) =>
              item.serveStatus !== ServeStatus.READY ||
              item.isPaid ||
              item.invoiceId !== null,
          )
        ) {
          throw new ConflictException(
            'All order items must be ready and unpaid before collection.',
          );
        }
        const subtotal = items.reduce(
          (sum, item) => sum.plus(item.priceAtTime.mul(item.quantity)),
          new Prisma.Decimal(0),
        );
        if (!subtotal.equals(request.quotedSubtotal)) {
          throw new ConflictException(
            'Online order total changed after confirmation.',
          );
        }

        const invoice = await this.invoices.checkoutOnlinePickupInTransaction(
          tx,
          employeeId,
          request.orderSessionId,
          dto.amountTendered,
        );
        const itemIds = items.map((item) => item.id);
        const collected = await tx.orderItem.updateMany({
          where: {
            id: { in: itemIds },
            orderSessionId: request.orderSessionId,
            serveStatus: ServeStatus.READY,
            isPaid: true,
            invoiceId: invoice.id,
          },
          data: { serveStatus: ServeStatus.SERVED },
        });
        if (collected.count !== itemIds.length) {
          throw new ConflictException(
            'Order items changed during pickup. Please retry.',
          );
        }
        const collectedAt = new Date();
        await tx.actionLog.create({
          data: {
            employeeId,
            actionType: 'ONLINE_ORDER_COD_COLLECTED',
            details: {
              onlineOrderRequestId: id,
              invoiceId: invoice.id,
              orderItemIds: itemIds,
            },
          },
        });
        for (const itemId of itemIds) {
          await this.enqueueItemStatusEvent(
            tx,
            itemId,
            request.orderSessionId,
            ServeStatus.READY,
            ServeStatus.SERVED,
          );
        }
        return {
          requestId: id,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          totalAmount: invoice.totalAmount.toString(),
          amountTendered: invoice.amountTendered?.toString() ?? null,
          changeAmount: invoice.changeAmount?.toString() ?? null,
          collectedItemIds: itemIds,
          collectedAt: collectedAt.toISOString(),
        };
      },
    );
  }

  cancelAccepted(id: string, employeeId: string, reason: string) {
    return this.cancelAcceptedRequest(id, employeeId, reason, false);
  }

  markNoShow(id: string, employeeId: string) {
    return this.cancelAcceptedRequest(
      id,
      employeeId,
      'Customer did not collect the prepared order.',
      true,
    );
  }

  private cancelAcceptedRequest(
    id: string,
    employeeId: string,
    reason: string,
    noShow: boolean,
  ) {
    return runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const employee = await tx.employee.findFirst({
          where: { id: employeeId, isActive: true, deletedAt: null },
          select: { id: true },
        });
        if (!employee) throw new UnauthorizedException('Employee is inactive.');
        const request = await tx.onlineOrderRequest.findUnique({
          where: { id },
          select: {
            status: true,
            cancellationReason: true,
            noShowAt: true,
            pickupAt: true,
            orderSessionId: true,
            orderSession: {
              select: {
                tableId: true,
                sessionStatus: true,
                orderItems: {
                  select: {
                    id: true,
                    serveStatus: true,
                    readyAt: true,
                    isPaid: true,
                    invoiceId: true,
                  },
                },
              },
            },
          },
        });
        if (!request)
          throw new NotFoundException('Online order request not found.');
        if (
          request.status === OnlineOrderStatus.CANCELLED &&
          request.cancellationReason === reason &&
          Boolean(request.noShowAt) === noShow
        ) {
          return {
            requestId: id,
            status: OnlineOrderStatus.CANCELLED,
            ...(noShow ? { noShowAt: request.noShowAt } : {}),
          };
        }
        const session = request.orderSession;
        if (
          request.status !== OnlineOrderStatus.ACCEPTED ||
          !request.orderSessionId ||
          !session ||
          session.tableId !== null ||
          session.sessionStatus !== SessionStatus.ACTIVE ||
          session.orderItems.some(
            (item) =>
              item.isPaid ||
              item.invoiceId ||
              item.serveStatus === ServeStatus.SERVED,
          )
        ) {
          throw new ConflictException(
            'Only an unpaid, uncollected online order can be cancelled.',
          );
        }
        const activeItems = session.orderItems.filter(
          (item) => item.serveStatus !== ServeStatus.CANCELLED,
        );
        const now = new Date();
        if (
          noShow &&
          !this.isNoShowEligible(request.pickupAt, session.orderItems, now)
        ) {
          throw new ConflictException(
            'No-show requires a prepared order past its pickup grace period.',
          );
        }
        for (const item of activeItems) {
          if (
            item.serveStatus === ServeStatus.COOKING ||
            item.serveStatus === ServeStatus.READY
          ) {
            await this.inventoryConsumption.recordWaste(tx, {
              orderItemId: item.id,
              employeeId,
              reason,
            });
          }
        }
        if (activeItems.length > 0) {
          const cancelled = await tx.orderItem.updateMany({
            where: {
              id: { in: activeItems.map((item) => item.id) },
              orderSessionId: request.orderSessionId,
              serveStatus: {
                in: [
                  ServeStatus.PENDING,
                  ServeStatus.COOKING,
                  ServeStatus.READY,
                ],
              },
              isPaid: false,
              invoiceId: null,
            },
            data: { serveStatus: ServeStatus.CANCELLED },
          });
          if (cancelled.count !== activeItems.length) {
            throw new ConflictException(
              'Order items changed during cancellation.',
            );
          }
        }
        await tx.printJob.updateMany({
          where: {
            kitchenTicket: { orderSessionId: request.orderSessionId },
            status: PrintJobStatus.PENDING,
          },
          data: { status: PrintJobStatus.CANCELLED },
        });
        const sessionUpdate = await tx.orderSession.updateMany({
          where: {
            id: request.orderSessionId,
            sessionStatus: SessionStatus.ACTIVE,
          },
          data: { sessionStatus: SessionStatus.CANCELLED },
        });
        const requestUpdate = await tx.onlineOrderRequest.updateMany({
          where: {
            id,
            status: OnlineOrderStatus.ACCEPTED,
            orderSessionId: request.orderSessionId,
          },
          data: {
            status: OnlineOrderStatus.CANCELLED,
            cancellationReason: reason,
            cancelledAt: now,
            ...(noShow ? { noShowAt: now } : {}),
          },
        });
        if (sessionUpdate.count !== 1 || requestUpdate.count !== 1) {
          throw new ConflictException(
            'Online order changed during cancellation.',
          );
        }
        await tx.actionLog.create({
          data: {
            employeeId,
            actionType: noShow
              ? 'ONLINE_ORDER_NO_SHOW'
              : 'ONLINE_ORDER_CANCELLED',
            details: {
              onlineOrderRequestId: id,
              orderSessionId: request.orderSessionId,
              reason,
              ...(noShow ? { pickupAt: request.pickupAt?.toISOString() } : {}),
            },
          },
        });
        await this.enqueueCancellationEvents(
          tx,
          id,
          request.orderSessionId,
          activeItems,
        );
        return {
          requestId: id,
          status: OnlineOrderStatus.CANCELLED,
          ...(noShow ? { noShowAt: now } : {}),
        };
      },
      { loggerContext: 'Online order cancellation' },
    );
  }

  private async enqueueCancellationEvents(
    tx: ExtendedPrismaTransactionClient,
    requestId: string,
    sessionId: string,
    items: Array<{ id: string; serveStatus: ServeStatus }>,
  ) {
    await this.enqueueTelegramStatus(
      tx,
      requestId,
      OnlineOrderStatus.CANCELLED,
    );
    for (const item of items) {
      await this.enqueueItemStatusEvent(
        tx,
        item.id,
        sessionId,
        item.serveStatus,
        ServeStatus.CANCELLED,
      );
    }
    await this.outbox.enqueue(tx, {
      topic: 'order',
      eventName: ORDER_EVENTS.SESSION_CANCELLED,
      aggregateType: 'OrderSession',
      aggregateId: sessionId,
      payload: {
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        affectedTableIds: [],
        sessionId,
        tableId: null,
      },
    });
  }

  private enqueueItemStatusEvent(
    tx: ExtendedPrismaTransactionClient,
    itemId: string,
    sessionId: string,
    previousStatus: ServeStatus,
    currentStatus: ServeStatus,
  ) {
    return this.outbox.enqueue(tx, {
      topic: 'order',
      eventName: ORDER_EVENTS.ITEM_STATUS_UPDATED,
      aggregateType: 'OrderItem',
      aggregateId: itemId,
      payload: {
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        affectedTableIds: [],
        orderItemId: itemId,
        orderSessionId: sessionId,
        tableId: null,
        previousStatus,
        currentStatus,
        isServed: currentStatus === ServeStatus.SERVED,
      },
    });
  }

  private isNoShowEligible(
    pickupAt: Date | null,
    items: Array<{
      serveStatus: ServeStatus;
      readyAt: Date | null;
      isPaid: boolean;
      invoiceId: string | null;
    }>,
    now: Date,
  ) {
    if (!pickupAt) return false;
    const active = items.filter(
      (item) => item.serveStatus !== ServeStatus.CANCELLED,
    );
    if (
      active.length === 0 ||
      active.some(
        (item) =>
          item.serveStatus !== ServeStatus.READY ||
          !item.readyAt ||
          item.isPaid ||
          item.invoiceId !== null,
      )
    )
      return false;
    const lastReadyAt = Math.max(
      ...active.map((item) => item.readyAt!.getTime()),
    );
    return (
      now.getTime() >=
      Math.max(pickupAt.getTime(), lastReadyAt) + NO_SHOW_GRACE_MS
    );
  }

  accept(id: string, employeeId: string) {
    return runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const request = await tx.onlineOrderRequest.findUnique({
          where: { id },
          select: {
            id: true,
            status: true,
            expiresAt: true,
            pickupAt: true,
            items: {
              orderBy: { lineNumber: 'asc' },
              select: {
                menuItemId: true,
                quantity: true,
                note: true,
                quotedUnitPrice: true,
                quotedOptions: true,
              },
            },
          },
        });
        if (!request) throw new NotFoundException('Order request not found.');
        const now = new Date();
        if (
          request.status !== OnlineOrderStatus.PENDING ||
          request.expiresAt <= now
        ) {
          throw new ConflictException('Order request is no longer pending.');
        }
        if (request.pickupAt) {
          if (!this.pickupSchedule || request.pickupAt <= now) {
            throw new ConflictException('Scheduled pickup time has passed.');
          }
          const booked = await tx.onlineOrderRequest.count({
            where: {
              status: OnlineOrderStatus.ACCEPTED,
              pickupAt: request.pickupAt,
            },
          });
          if (booked >= this.pickupSchedule.capacity) {
            throw new ConflictException('Pickup slot is full.');
          }
        }
        const quotes = request.items.map((item) => ({
          unitPrice: item.quotedUnitPrice,
          selectedOptions: readSelectedOptions(item.quotedOptions),
        }));
        const orderSessionId = await this.orders.createOnlineTakeawaySession(
          tx,
          employeeId,
          request.items.map((item) => ({
            menuItemId: item.menuItemId,
            quantity: item.quantity,
            note: item.note ?? undefined,
            optionIds: readSelectedOptions(item.quotedOptions).map(
              (option) => option.id,
            ),
          })),
          quotes,
        );
        const updated = await tx.onlineOrderRequest.updateMany({
          where: {
            id,
            status: OnlineOrderStatus.PENDING,
            expiresAt: { gt: new Date() },
          },
          data: {
            status: OnlineOrderStatus.ACCEPTED,
            reviewedAt: new Date(),
            reviewedById: employeeId,
            orderSessionId,
          },
        });
        if (updated.count !== 1) {
          throw new ConflictException('Order request is no longer pending.');
        }
        await tx.actionLog.create({
          data: {
            employeeId,
            actionType: 'ONLINE_ORDER_ACCEPTED',
            details: { onlineOrderRequestId: id, orderSessionId },
          },
        });
        await this.enqueueTelegramStatus(tx, id, OnlineOrderStatus.ACCEPTED);
        return {
          requestId: id,
          status: OnlineOrderStatus.ACCEPTED,
          orderSessionId,
        };
      },
      { loggerContext: 'Online order acceptance' },
    );
  }

  reject(id: string, employeeId: string, reason: string) {
    return runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const employee = await tx.employee.findFirst({
          where: { id: employeeId, isActive: true, deletedAt: null },
          select: { id: true },
        });
        if (!employee) throw new UnauthorizedException('Employee is inactive.');
        const now = new Date();
        const updated = await tx.onlineOrderRequest.updateMany({
          where: {
            id,
            status: OnlineOrderStatus.PENDING,
            expiresAt: { gt: now },
          },
          data: {
            status: OnlineOrderStatus.REJECTED,
            rejectionReason: reason,
            reviewedAt: now,
            reviewedById: employeeId,
          },
        });
        if (updated.count !== 1) {
          throw new ConflictException('Order request is no longer pending.');
        }
        await tx.actionLog.create({
          data: {
            employeeId,
            actionType: 'ONLINE_ORDER_REJECTED',
            details: { onlineOrderRequestId: id, reason },
          },
        });
        await this.enqueueTelegramStatus(tx, id, OnlineOrderStatus.REJECTED);
        return { requestId: id, status: OnlineOrderStatus.REJECTED };
      },
      { loggerContext: 'Online order rejection' },
    );
  }

  private replay(request: PublicRequest, requestHash: string) {
    if (request.requestHash !== requestHash) {
      throw new ConflictException(
        'Client request ID was already used with a different order.',
      );
    }
    return {
      requestId: request.id,
      status: request.status,
      expiresAt: request.expiresAt,
      quotedSubtotal: request.quotedSubtotal,
      pickupAt: request.pickupAt,
      items: request.items,
      accessToken: this.signAccess(request.id),
      reorderToken:
        request.reorderNonce &&
        request.createdAt.getTime() + ONLINE_ORDER_ACCESS_WINDOW_MS >
          Date.now() &&
        this.reorderExpiresAt(request.createdAt).getTime() > Date.now()
          ? this.signReorder(request.id, request.reorderNonce)
          : null,
      reorderExpiresAt: request.reorderNonce
        ? this.reorderExpiresAt(request.createdAt)
        : null,
    };
  }

  private async availableMenuItems(ids: string[]) {
    const items = await this.prisma.menuItem.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
        isAvailable: true,
        category: { deletedAt: null },
        OR: [
          { kitchenStationId: null },
          { kitchenStation: { is: { isActive: true, deletedAt: null } } },
        ],
      },
      select: ORDER_MENU_ITEM_SELECT,
    });
    return new Map(items.map((item) => [item.id, item]));
  }

  private reorderExpiresAt(createdAt: Date) {
    return new Date(createdAt.getTime() + REORDER_WINDOW_MS);
  }

  private signReorder(requestId: string, nonce: string) {
    return createHmac('sha256', this.reorderKey)
      .update(requestId)
      .update(':')
      .update(nonce)
      .digest('hex');
  }

  private assertReorderAccess(
    requestId: string,
    token: string | undefined,
    nonce: string | null,
    createdAt: Date,
  ) {
    if (
      !nonce ||
      !token ||
      !/^[0-9a-f]{64}$/.test(token) ||
      this.reorderExpiresAt(createdAt).getTime() <= Date.now()
    ) {
      throw new NotFoundException('Order request not found.');
    }
    if (
      !timingSafeEqual(
        Buffer.from(this.signReorder(requestId, nonce), 'hex'),
        Buffer.from(token, 'hex'),
      )
    ) {
      throw new NotFoundException('Order request not found.');
    }
  }

  private fulfillmentStatus(
    status: OnlineOrderStatus,
    items: Array<{ serveStatus: ServeStatus }>,
  ) {
    if (status !== OnlineOrderStatus.ACCEPTED || items.length === 0)
      return null;
    if (items.every((item) => item.serveStatus === ServeStatus.SERVED))
      return 'COLLECTED';
    if (items.some((item) => item.serveStatus === ServeStatus.CANCELLED))
      return 'NEEDS_REVIEW';
    const ready = (item: { serveStatus: ServeStatus }) =>
      item.serveStatus === ServeStatus.READY ||
      item.serveStatus === ServeStatus.SERVED;
    if (items.every(ready)) return 'READY';
    if (items.some(ready)) return 'PARTIALLY_READY';
    return 'PREPARING';
  }

  private signAccess(requestId: string) {
    return createHmac('sha256', this.accessKey).update(requestId).digest('hex');
  }

  private enqueueTelegramStatus(
    tx: ExtendedPrismaTransactionClient,
    requestId: string,
    status: OnlineOrderStatus,
  ) {
    if (!this.telegramBotUsername) return;
    return this.outbox.enqueue(tx, {
      topic: 'order',
      eventName: ONLINE_ORDER_TELEGRAM_EVENT,
      aggregateType: 'OnlineOrderRequest',
      aggregateId: requestId,
      payload: { requestId, status },
    });
  }

  private assertAccess(requestId: string, accessToken: string) {
    if (!/^[0-9a-f]{64}$/.test(accessToken)) {
      throw new NotFoundException('Order request not found.');
    }
    const expected = Buffer.from(this.signAccess(requestId), 'hex');
    const received = Buffer.from(accessToken, 'hex');
    if (!timingSafeEqual(expected, received)) {
      throw new NotFoundException('Order request not found.');
    }
  }
}
