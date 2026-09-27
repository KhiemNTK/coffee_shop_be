import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnlineOrderStatus, Prisma, ServeStatus } from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { OrdersService } from '../orders/orders.service';
import {
  CreateOnlineOrderDto,
  GetPendingOnlineOrdersDto,
  OnlineOrderAccessDto,
} from './dto';

const REVIEW_WINDOW_MS = 30 * 60 * 1000;
const ACCESS_WINDOW_MS = 72 * 60 * 60 * 1000;

const publicRequestSelect = {
  id: true,
  requestHash: true,
  status: true,
  createdAt: true,
  expiresAt: true,
  quotedSubtotal: true,
  items: {
    orderBy: { lineNumber: 'asc' },
    select: {
      lineNumber: true,
      menuItemId: true,
      quotedName: true,
      quotedUnitPrice: true,
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

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly orders: OrdersService,
    private readonly pagination: PaginationUtilService,
    config: ConfigService,
  ) {
    this.accessKey = createHmac(
      'sha256',
      config.getOrThrow<string>('JWT_SECRET'),
    )
      .update('online-order-access:v1')
      .digest();
  }

  async createPublicRequest(dto: CreateOnlineOrderDto) {
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          pickupName: dto.pickupName,
          phoneNumber: dto.phoneNumber,
          items: dto.items,
        }),
      )
      .digest('hex');
    const existing = await this.prisma.onlineOrderRequest.findUnique({
      where: { clientRequestId: dto.clientRequestId },
      select: publicRequestSelect,
    });
    if (existing) return this.replay(existing, requestHash);

    const menuItemIds = [...new Set(dto.items.map((item) => item.menuItemId))];
    const menuItems = await this.prisma.menuItem.findMany({
      where: {
        id: { in: menuItemIds },
        deletedAt: null,
        isAvailable: true,
        category: { deletedAt: null },
        OR: [
          { kitchenStationId: null },
          { kitchenStation: { is: { isActive: true, deletedAt: null } } },
        ],
      },
      select: { id: true, name: true, price: true },
    });
    if (menuItems.length !== menuItemIds.length) {
      throw new NotFoundException('One or more menu items are unavailable.');
    }
    const menuById = new Map(menuItems.map((item) => [item.id, item]));
    const items = dto.items.map((item, index) => {
      const menuItem = menuById.get(item.menuItemId)!;
      return {
        lineNumber: index + 1,
        menuItemId: item.menuItemId,
        quantity: item.quantity,
        note: item.note,
        quotedName: menuItem.name,
        quotedUnitPrice: menuItem.price,
      };
    });
    const quotedSubtotal = items.reduce(
      (sum, item) => sum.plus(item.quotedUnitPrice.mul(item.quantity)),
      new Prisma.Decimal(0),
    );

    try {
      const created = await this.prisma.onlineOrderRequest.create({
        data: {
          clientRequestId: dto.clientRequestId,
          requestHash,
          pickupName: dto.pickupName,
          phoneNumber: dto.phoneNumber,
          quotedSubtotal,
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
        quotedSubtotal: true,
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
              },
            },
          },
        },
      },
    });
    if (
      !request ||
      request.createdAt.getTime() + ACCESS_WINDOW_MS < Date.now()
    ) {
      throw new NotFoundException('Order request not found.');
    }
    const orderItems = request.orderSession?.orderItems ?? [];
    const activeItems = orderItems.filter(
      (item) => item.serveStatus !== ServeStatus.CANCELLED,
    );
    const fulfillmentStatus =
      request.status !== OnlineOrderStatus.ACCEPTED || activeItems.length === 0
        ? null
        : activeItems.every((item) => item.serveStatus === ServeStatus.SERVED)
          ? 'COLLECTED'
          : activeItems.every(
                (item) =>
                  item.serveStatus === ServeStatus.READY ||
                  item.serveStatus === ServeStatus.SERVED,
              )
            ? 'READY'
            : 'PREPARING';

    return {
      requestId: request.id,
      status:
        request.status === OnlineOrderStatus.PENDING &&
        request.expiresAt <= new Date()
          ? 'EXPIRED'
          : request.status,
      expiresAt: request.expiresAt,
      rejectionReason: request.rejectionReason,
      quotedSubtotal: request.quotedSubtotal,
      items: request.items,
      fulfillmentStatus,
      isPaid:
        activeItems.length > 0 && activeItems.every((item) => item.isPaid),
      orderItems,
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
    throw new ConflictException('Order request can no longer be cancelled.');
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
          expiresAt: true,
          createdAt: true,
          items: publicRequestSelect.items,
        },
      }),
    ]);
    return this.pagination.paging({ ...query, totalItems }).format(list);
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
        orderSessionId: true,
        items: publicRequestSelect.items,
      },
    });
    if (!request) throw new NotFoundException('Order request not found.');
    return request;
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
            items: {
              orderBy: { lineNumber: 'asc' },
              select: {
                menuItemId: true,
                quantity: true,
                note: true,
                quotedUnitPrice: true,
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
        const quotedPrices = new Map(
          request.items.map((item) => [item.menuItemId, item.quotedUnitPrice]),
        );
        const orderSessionId = await this.orders.createOnlineTakeawaySession(
          tx,
          employeeId,
          request.items.map((item) => ({
            menuItemId: item.menuItemId,
            quantity: item.quantity,
            note: item.note ?? undefined,
          })),
          quotedPrices,
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
      items: request.items,
      accessToken: this.signAccess(request.id),
    };
  }

  private signAccess(requestId: string) {
    return createHmac('sha256', this.accessKey).update(requestId).digest('hex');
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
