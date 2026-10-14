import { createHash, randomBytes } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CUSTOMER_SESSION_TTL_MS,
  WISHLIST_LIMIT,
} from '../../common/consts/customer-auth';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { GoogleIdentityService } from '../auth/google-identity.service';
import { TurnstileService } from '../auth/turnstile.service';
import {
  PUBLIC_MENU_SELECT,
  PUBLIC_MENU_WHERE,
} from '../menu/public-menu-query';

const CUSTOMER_SELECT = { id: true, email: true } as const;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

@Injectable()
export class CustomersService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN) private readonly prisma: ExtendedPrismaClient,
    private readonly google: GoogleIdentityService,
    private readonly turnstile: TurnstileService,
  ) {}

  async signIn(
    idToken: string,
    turnstileToken?: string,
    ip?: string,
    previousToken?: unknown,
  ) {
    await this.turnstile.verify(turnstileToken, ip, 'login');
    const identity = await this.google.verify(idToken);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_TTL_MS);
    const customer = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const account = await tx.customer.upsert({
          where: { googleSubject: identity.subject },
          create: {
            googleSubject: identity.subject,
            email: identity.email.toLowerCase(),
          },
          update: { email: identity.email.toLowerCase() },
          select: CUSTOMER_SELECT,
        });
        await this.lockCustomer(tx, account.id);
        const older = await tx.customerSession.findMany({
          where: { customerId: account.id, expiresAt: { gt: new Date() } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: 9,
          select: { id: true },
        });
        await tx.customerSession.deleteMany({
          where: {
            OR: [
              { customerId: account.id, expiresAt: { lte: new Date() } },
              { id: { in: older.map((session) => session.id) } },
              ...(typeof previousToken === 'string' &&
              TOKEN_PATTERN.test(previousToken)
                ? [{ tokenHash: this.hash(previousToken) }]
                : []),
            ],
          },
        });
        await tx.customerSession.create({
          data: {
            customerId: account.id,
            tokenHash: this.hash(token),
            expiresAt,
          },
        });
        return account;
      },
    );
    return { customer, token, expiresAt };
  }

  async authenticate(token: unknown) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token))
      throw new UnauthorizedException('Customer sign-in required.');
    const session = await this.prisma.customerSession.findUnique({
      where: { tokenHash: this.hash(token) },
      select: {
        expiresAt: true,
        customer: {
          select: { ...CUSTOMER_SELECT, isActive: true, deletedAt: true },
        },
      },
    });
    if (
      !session ||
      session.expiresAt <= new Date() ||
      !session.customer.isActive ||
      session.customer.deletedAt
    )
      throw new UnauthorizedException('Customer session expired or inactive.');
    return { id: session.customer.id, email: session.customer.email };
  }

  async logout(token: unknown) {
    if (typeof token === 'string' && TOKEN_PATTERN.test(token))
      await this.prisma.customerSession.deleteMany({
        where: { tokenHash: this.hash(token) },
      });
    return { success: true };
  }

  async getWishlist(customerId: string) {
    const rows = await this.prisma.customerWishlist.findMany({
      where: { customerId },
      orderBy: [{ createdAt: 'desc' }, { menuItemId: 'asc' }],
      take: WISHLIST_LIMIT,
      select: {
        menuItemId: true,
        menuItem: {
          select: {
            ...PUBLIC_MENU_SELECT,
            isAvailable: true,
            deletedAt: true,
            category: { select: { id: true, name: true, deletedAt: true } },
            kitchenStation: { select: { isActive: true, deletedAt: true } },
          },
        },
      },
    });
    return {
      customerId,
      items: rows.map(({ menuItemId, menuItem }) => {
        const { deletedAt, kitchenStation, category, ...item } = menuItem;
        return {
          menuItemId,
          item:
            deletedAt || category.deletedAt
              ? null
              : {
                  ...item,
                  category: { id: category.id, name: category.name },
                  isAvailable:
                    item.isAvailable &&
                    (!kitchenStation ||
                      (kitchenStation.isActive && !kitchenStation.deletedAt)),
                },
        };
      }),
    };
  }

  addFavorite(customerId: string, menuItemId: string) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      // Serialize the per-customer limit; a unique junction alone cannot prevent concurrent overflow.
      await this.lockCustomer(tx, customerId);
      const existing = await tx.customerWishlist.findUnique({
        where: { customerId_menuItemId: { customerId, menuItemId } },
        select: { menuItemId: true },
      });
      if (existing) return { success: true };
      const item = await tx.menuItem.findFirst({
        where: { ...PUBLIC_MENU_WHERE, id: menuItemId },
        select: { id: true },
      });
      if (!item) throw new NotFoundException('Menu item is not available.');
      if (
        (await tx.customerWishlist.count({ where: { customerId } })) >=
        WISHLIST_LIMIT
      )
        throw new ConflictException({
          code: 'WISHLIST_LIMIT_REACHED',
          message: 'Wishlist limit reached. Remove a favorite first.',
        });
      await tx.customerWishlist.create({ data: { customerId, menuItemId } });
      return { success: true };
    });
  }

  removeFavorite(customerId: string, menuItemId: string) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.lockCustomer(tx, customerId);
      await tx.customerWishlist.deleteMany({
        where: { customerId, menuItemId },
      });
      return { success: true };
    });
  }

  private async lockCustomer(tx: ExtendedPrismaTransactionClient, id: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Customer" WHERE "id" = ${id}
      AND "isActive" = true AND "deletedAt" IS NULL FOR UPDATE
    `);
    if (!rows.length) throw new UnauthorizedException('Customer is inactive.');
  }

  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
}
