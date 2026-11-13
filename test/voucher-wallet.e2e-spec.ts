import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import {
  PrismaService,
  type ExtendedPrismaClient,
} from '../src/common/prisma/prisma.service';
import { runSerializableTransaction } from '../src/common/prisma/transaction.util';
import { ONLINE_ORDER_NO_SHOW_GRACE_MS } from '../src/common/consts/online-order-settings';
import { PaginationUtilService } from '../src/common/utils/pagination-util/pagination-util.service';
import { QueryUtilService } from '../src/common/utils/query-util/query-util.service';
import { CashierShiftLedgerService } from '../src/app/cashier-shifts/cashier-shift-ledger.service';
import { CreateCustomerOrderDto } from '../src/app/customers/customer.dto';
import { IdempotencyService } from '../src/app/durable/idempotency.service';
import { OutboxService } from '../src/app/durable/outbox.service';
import { InventoryConsumptionService } from '../src/app/inventory/services/inventory-consumption.service';
import { InvoiceNumberService } from '../src/app/invoices/invoice-number.service';
import { InvoicePolicyService } from '../src/app/invoices/invoice-policy.service';
import { InvoicesService } from '../src/app/invoices/invoices.service';
import { CashRefundsService } from '../src/app/invoices/cash-refunds.service';
import { KitchenRoutingService } from '../src/app/kitchen/kitchen-routing.service';
import {
  CreateOnlineOrderDto,
  QuoteOnlineOrderDto,
} from '../src/app/online-orders/dto';
import { OnlineOrderIntakeService } from '../src/app/online-orders/online-order-intake.service';
import { OnlineOrdersService } from '../src/app/online-orders/online-orders.service';
import { ORDER_EVENTS } from '../src/app/orders/events/order.events';
import { OrderPolicyService } from '../src/app/orders/order-policy.service';
import { OrdersService } from '../src/app/orders/orders.service';
import { TakeawayService } from '../src/app/orders/takeaway.service';
import { PrintingService } from '../src/app/printing/printing.service';
import { PromotionPolicyService } from '../src/app/promotions/policies/promotion-policy.service';
import { PromotionsRepository } from '../src/app/promotions/repositories/promotions.repository';
import { PromotionCalculatorService } from '../src/app/promotions/services/promotion-calculator.service';
import {
  CreateVoucherCampaignDto,
  GetCustomerVouchersDto,
  GiftCustomerVoucherDto,
  RevokeCustomerVoucherDto,
  VoucherCampaignVersionDto,
} from '../src/app/vouchers/dto/voucher.dto';
import { VoucherCampaignsService } from '../src/app/vouchers/voucher-campaigns.service';
import { VouchersService } from '../src/app/vouchers/vouchers.service';

describe('Voucher wallet (isolated PostgreSQL)', () => {
  const databaseName = `voucher_wallet_${randomUUID().replaceAll('-', '')}_test`;
  const clients: PrismaClient[] = [];
  const workers: ReturnType<typeof services>[] = [];
  const employeeIds = [randomUUID(), randomUUID()];
  const customerIds = [randomUUID(), randomUUID()];
  const fundId = randomUUID();
  const menuItemId = randomUUID();
  let admin: PrismaClient | undefined;
  let created = false;
  let db: ExtendedPrismaClient;
  let databaseUrl: string;

  function services(client: PrismaClient) {
    const prisma: ExtendedPrismaClient =
      PrismaService.prototype.getExtendedClient.call(client);
    const pagination = new PaginationUtilService();
    const config = new ConfigService({
      JWT_SECRET: 'isolated-voucher-wallet-test-only',
      ONLINE_ASAP_OPEN_LOCAL: '00:00',
      ONLINE_ASAP_CLOSE_LOCAL: '24:00',
    });
    const outbox = new OutboxService();
    const idempotency = new IdempotencyService(prisma);
    const inventory = new InventoryConsumptionService(outbox);
    const ledger = new CashierShiftLedgerService();
    const calculator = new PromotionCalculatorService(
      new PromotionsRepository(prisma),
      new PromotionPolicyService(),
    );
    const vouchers = new VouchersService(
      prisma,
      calculator,
      pagination,
      idempotency,
    );
    const printing = {
      cancelKitchenItems: jest.fn().mockResolvedValue(undefined),
    } as unknown as PrintingService;
    const orders = new OrdersService(
      prisma,
      outbox,
      new OrderPolicyService(),
      inventory,
      ledger,
      new KitchenRoutingService(printing),
      pagination,
      new TakeawayService(prisma, pagination, config),
      idempotency,
      printing,
    );
    const invoices = new InvoicesService(
      prisma,
      pagination,
      new QueryUtilService(),
      new InvoicePolicyService(),
      new InvoiceNumberService(),
      idempotency,
      outbox,
      calculator,
      ledger,
      inventory,
    );
    return {
      db: prisma,
      vouchers,
      campaigns: new VoucherCampaignsService(prisma, pagination),
      refunds: new CashRefundsService(
        prisma,
        ledger,
        idempotency,
        outbox,
        pagination,
      ),
      online: new OnlineOrdersService(
        prisma,
        orders,
        invoices,
        inventory,
        idempotency,
        outbox,
        pagination,
        config,
        { verify: jest.fn().mockResolvedValue(undefined) } as never,
        new OnlineOrderIntakeService(prisma, config),
        printing,
        vouchers,
      ),
    };
  }

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL ?? '');
    assert(
      process.env.NODE_ENV === 'test' &&
        ['postgres:', 'postgresql:'].includes(target.protocol) &&
        ['localhost', '127.0.0.1'].includes(target.hostname) &&
        /^\/[^/]+_test$/.test(decodeURIComponent(target.pathname)),
      'Only use a dedicated loopback *_test PostgreSQL database, never a business database.',
    );
    const adminUrl = new URL(target);
    adminUrl.pathname = '/postgres';
    admin = new PrismaClient({ datasources: { db: { url: adminUrl.href } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    target.pathname = `/${databaseName}`;
    databaseUrl = target.href;
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      {
        cwd: `${__dirname}/..`,
        env: { ...process.env, DATABASE_URL: target.href },
        stdio: 'pipe',
        timeout: 90_000,
      },
    );
    for (let index = 0; index < 2; index++) {
      const client = new PrismaClient({
        datasources: { db: { url: target.href } },
        transactionOptions: { maxWait: 5_000, timeout: 10_000 },
      });
      clients.push(client);
      workers.push(services(client));
    }
    db = workers[0].db;
    const position = await db.position.create({
      data: { name: 'Voucher test operators', salary: 0 },
    });
    for (const id of employeeIds) {
      await db.employee.create({
        data: {
          id,
          positionId: position.id,
          fullName: 'Voucher operator',
          email: `${id}@example.test`,
          username: id,
          password: 'not-a-login',
        },
      });
    }
    for (const id of customerIds) {
      await db.customer.create({
        data: { id, googleSubject: id, email: `${id}@example.test` },
      });
    }
    await db.fund.create({
      data: { id: fundId, name: 'Voucher test cash', type: 'CASH' },
    });
    await db.cashierShift.create({
      data: { employeeId: employeeIds[0], fundId },
    });
    const category = await db.menuCategory.create({
      data: { name: 'Voucher test menu' },
    });
    await db.menuItem.create({
      data: {
        id: menuItemId,
        categoryId: category.id,
        name: 'Voucher test coffee',
        price: '25000.05',
      },
    });
  }, 120_000);

  afterAll(async () => {
    try {
      for (const client of clients) await client.$disconnect();
    } finally {
      try {
        if (created) {
          assert(/^voucher_wallet_[a-f0-9]{32}_test$/.test(databaseName));
          await admin!.$executeRawUnsafe(
            `DROP DATABASE "${databaseName}" WITH (FORCE)`,
          );
        }
      } finally {
        await admin?.$disconnect();
      }
    }
  }, 30_000);

  async function campaign(patch: Partial<CreateVoucherCampaignDto> = {}) {
    const draft = await workers[0].campaigns.create(
      employeeIds[0],
      CreateVoucherCampaignDto.schema.parse({
        name: `Voucher ${randomUUID()}`,
        isPublic: true,
        discountType: 'PERCENTAGE',
        discountValue: '12.50',
        maxDiscount: '10000.00',
        minSubtotal: '20000.00',
        startDate: new Date(Date.now() - 3_600_000).toISOString(),
        endDate: new Date(Date.now() + 3_600_000).toISOString(),
        issuanceLimit: 20,
        ...patch,
      }),
    );
    return workers[0].campaigns.publish(
      draft.id,
      employeeIds[0],
      VoucherCampaignVersionDto.schema.parse({
        expectedUpdatedAt: draft.updatedAt.toISOString(),
      }),
    );
  }

  async function grant(customerId = customerIds[0]) {
    const terms = await campaign();
    await workers[0].vouchers.claim(customerId, terms.id);
    const voucher = await db.customerVoucher.findUniqueOrThrow({
      where: {
        campaignId_sourceKey: {
          campaignId: terms.id,
          sourceKey: `CLAIM:${customerId}`,
        },
      },
    });
    return { terms, voucher };
  }

  const basket = () => [{ menuItemId, quantity: 2 }];
  const guestDto = () => ({
    clientRequestId: randomUUID(),
    pickupName: 'Voucher customer',
    phoneNumber: '0901234567',
    items: basket(),
  });

  async function confirmedDto(
    voucherId: string,
    customerId = customerIds[0],
    worker = workers[0],
  ) {
    const quote = await worker.online.quoteCustomerBasket(customerId, {
      items: basket(),
      voucherId,
    });
    const { expectedCustomerId: _, ...dto } =
      CreateCustomerOrderDto.schema.parse({
        ...guestDto(),
        expectedCustomerId: customerId,
        voucherId,
        expectedTotal: quote.totalAmount,
        quoteFingerprint: quote.quoteFingerprint,
      });
    return { dto, quote };
  }

  async function pending() {
    const fixture = await grant();
    const { dto, quote } = await confirmedDto(fixture.voucher.id);
    const request = await workers[0].online.createPublicRequest(
      dto,
      undefined,
      customerIds[0],
    );
    return { ...fixture, dto, quote, request };
  }

  async function accepted(ready = false) {
    const fixture = await pending();
    const acceptedOrder = await workers[0].online.accept(
      fixture.request.requestId,
      employeeIds[0],
    );
    if (ready) {
      await db.orderItem.updateMany({
        where: { orderSessionId: acceptedOrder.orderSessionId },
        data: { serveStatus: 'READY', readyAt: new Date() },
      });
    }
    return { ...fixture, sessionId: acceptedOrder.orderSessionId };
  }

  const collectionDto = (accessToken: string) => ({
    accessToken,
    amountTendered: '50000.00',
    idempotencyKey: randomUUID(),
  });

  const redemption = (requestId: string) =>
    db.voucherRedemption.findUniqueOrThrow({
      where: { onlineOrderRequestId: requestId },
    });

  function oneConflict(results: PromiseSettledResult<unknown>[]) {
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const failed = results.filter((result) => result.status === 'rejected');
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(ConflictException);
  }

  it('backfills existing order totals with no discount and preserves decimal precision', async () => {
    const target = new URL(databaseUrl);
    target.searchParams.set('schema', 'voucher_backfill');
    await db.$executeRawUnsafe('CREATE SCHEMA voucher_backfill');
    const migration = readFileSync(
      join(
        __dirname,
        '../prisma/migrations/20261110000000_customer_voucher_wallet/migration.sql',
      ),
      'utf8',
    );
    execFileSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js'),
        'db',
        'execute',
        '--stdin',
        '--url',
        target.href,
      ],
      {
        cwd: `${__dirname}/..`,
        env: { ...process.env, DATABASE_URL: target.href },
        input: `
        BEGIN;
        CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');
        CREATE TABLE "Customer" ("id" TEXT PRIMARY KEY);
        CREATE TABLE "Employee" ("id" TEXT PRIMARY KEY);
        CREATE TABLE "Invoice" ("id" TEXT PRIMARY KEY);
        CREATE TABLE "OnlineOrderRequest" ("id" TEXT PRIMARY KEY, "quotedSubtotal" DECIMAL(18,2) NOT NULL);
        INSERT INTO "OnlineOrderRequest" VALUES ('a', 0), ('b', 50000.10), ('c', 9999999999999999.99);
        ${migration}
        COMMIT;
      `,
        stdio: 'pipe',
        timeout: 30_000,
      },
    );
    expect(
      await db.$queryRawUnsafe(
        `SELECT "id", "discountAmount"::text AS discount, "quotedTotal"::text AS total FROM voucher_backfill."OnlineOrderRequest" ORDER BY "id"`,
      ),
    ).toEqual([
      { id: 'a', discount: '0.00', total: '0.00' },
      { id: 'b', discount: '0.00', total: '50000.10' },
      { id: 'c', discount: '0.00', total: '9999999999999999.99' },
    ]);
  });

  it('keeps a manager configuration version valid across quota issuance', async () => {
    const observed = await campaign();
    await workers[0].vouchers.claim(customerIds[0], observed.id);
    const issued = await db.voucherCampaign.findUniqueOrThrow({
      where: { id: observed.id },
    });
    expect(issued.updatedAt).toEqual(observed.updatedAt);
    expect(issued.issuedCount).toBe(1);
    const paused = await workers[1].campaigns.pause(
      observed.id,
      employeeIds[0],
      {
        expectedUpdatedAt: observed.updatedAt,
      },
    );
    expect(paused.status).toBe('PAUSED');
    await expect(
      workers[0].campaigns.publish(observed.id, employeeIds[0], {
        expectedUpdatedAt: observed.updatedAt,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('serializes the final issuance and replays one customer claim without consuming the cap twice', async () => {
    const last = await campaign({ issuanceLimit: 1 });
    oneConflict(
      await Promise.allSettled([
        workers[0].vouchers.claim(customerIds[0], last.id),
        workers[1].vouchers.claim(customerIds[1], last.id),
      ]),
    );
    const winner = await db.customerVoucher.findFirstOrThrow({
      where: { campaignId: last.id },
    });
    await workers[1].vouchers.claim(winner.customerId, last.id);
    expect(
      await db.customerVoucher.count({ where: { campaignId: last.id } }),
    ).toBe(1);
    expect(
      (await db.voucherCampaign.findUniqueOrThrow({ where: { id: last.id } }))
        .issuedCount,
    ).toBe(1);

    const next = await campaign({ issuanceLimit: 2 });
    await Promise.all([
      workers[0].vouchers.claim(customerIds[0], next.id),
      workers[1].vouchers.claim(customerIds[0], next.id),
    ]);
    expect(
      await db.customerVoucher.count({ where: { campaignId: next.id } }),
    ).toBe(1);
    expect(
      (await db.voucherCampaign.findUniqueOrThrow({ where: { id: next.id } }))
        .issuedCount,
    ).toBe(1);
    await workers[1].vouchers.claim(customerIds[1], next.id);
    expect(
      (await db.voucherCampaign.findUniqueOrThrow({ where: { id: next.id } }))
        .issuedCount,
    ).toBe(2);
  });

  it('deduplicates a gift across connections and staff actors and rejects a changed idempotent body', async () => {
    const terms = await campaign({ isPublic: false, issuanceLimit: 1 });
    const source = await workers[0].online.createPublicRequest(
      guestDto(),
      undefined,
      customerIds[0],
    );
    const gifts = employeeIds.map((_, index) =>
      GiftCustomerVoucherDto.schema.parse({
        sourceOrderId: source.requestId,
        reason: 'Thank you for this order',
        idempotencyKey: `gift-${index}-${randomUUID()}`,
      }),
    );
    await Promise.all([
      workers[0].vouchers.gift(terms.id, employeeIds[0], gifts[0]),
      workers[1].vouchers.gift(terms.id, employeeIds[1], gifts[1]),
    ]);
    expect(
      await db.customerVoucher.count({
        where: { campaignId: terms.id, sourceOrderId: source.requestId },
      }),
    ).toBe(1);
    expect(
      (await db.voucherCampaign.findUniqueOrThrow({ where: { id: terms.id } }))
        .issuedCount,
    ).toBe(1);
    await workers[1].vouchers.gift(terms.id, employeeIds[0], gifts[0]);
    await expect(
      workers[0].vouchers.gift(terms.id, employeeIds[0], {
        ...gifts[0],
        reason: 'A different gift reason',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('rolls back gift issuance and revocation when their staff audit cannot be recorded', async () => {
    const fixture = await grant();
    const source = await workers[0].online.createPublicRequest(
      guestDto(),
      undefined,
      customerIds[0],
    );
    const giftKey = randomUUID();
    const revokeKey = randomUUID();
    const auditCount = await db.actionLog.count();
    await db.$executeRawUnsafe(
      `CREATE FUNCTION voucher_wallet_fail_grant_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected voucher audit failure'; END; $$`,
    );
    try {
      await db.$executeRawUnsafe(
        `CREATE TRIGGER voucher_wallet_fail_grant_audit BEFORE INSERT ON "ActionLog" FOR EACH ROW WHEN (NEW."actionType" IN ('CUSTOMER_VOUCHER_GIFTED', 'CUSTOMER_VOUCHER_REVOKED')) EXECUTE FUNCTION voucher_wallet_fail_grant_audit()`,
      );
      await expect(
        workers[0].vouchers.gift(fixture.terms.id, employeeIds[0], {
          sourceOrderId: source.requestId,
          reason: 'Service recovery',
          idempotencyKey: giftKey,
        }),
      ).rejects.toThrow('Injected voucher audit failure');
      await expect(
        workers[0].vouchers.revoke(fixture.voucher.id, employeeIds[0], {
          expectedUpdatedAt: fixture.voucher.updatedAt,
          reason: 'Issued by mistake',
          idempotencyKey: revokeKey,
        }),
      ).rejects.toThrow('Injected voucher audit failure');
      expect(
        (
          await db.voucherCampaign.findUniqueOrThrow({
            where: { id: fixture.terms.id },
          })
        ).issuedCount,
      ).toBe(1);
      expect(
        await db.customerVoucher.count({
          where: { campaignId: fixture.terms.id },
        }),
      ).toBe(1);
      expect(
        (
          await db.customerVoucher.findUniqueOrThrow({
            where: { id: fixture.voucher.id },
          })
        ).revokedAt,
      ).toBeNull();
      expect(await db.actionLog.count()).toBe(auditCount);
      expect(
        await db.idempotencyRequest.count({
          where: { key: { in: [giftKey, revokeKey] } },
        }),
      ).toBe(0);
    } finally {
      await db.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS voucher_wallet_fail_grant_audit ON "ActionLog"',
      );
      await db.$executeRawUnsafe(
        'DROP FUNCTION voucher_wallet_fail_grant_audit()',
      );
    }
  });

  it('allows only one of two concurrent quoted online orders to reserve the same voucher', async () => {
    const { voucher } = await grant();
    const first = await confirmedDto(voucher.id);
    const second = await confirmedDto(voucher.id, customerIds[0], workers[1]);
    const results = await Promise.allSettled([
      workers[0].online.createPublicRequest(
        first.dto,
        undefined,
        customerIds[0],
      ),
      workers[1].online.createPublicRequest(
        second.dto,
        undefined,
        customerIds[0],
      ),
    ]);
    oneConflict(results);
    expect(
      await db.onlineOrderRequest.count({
        where: {
          clientRequestId: {
            in: [first.dto.clientRequestId, second.dto.clientRequestId],
          },
        },
      }),
    ).toBe(1);
    const held = await db.voucherRedemption.findMany({
      where: { customerVoucherId: voucher.id },
    });
    expect(held).toHaveLength(1);
    expect(held[0].status).toBe('RESERVED');
    const order = await db.onlineOrderRequest.findUniqueOrThrow({
      where: { id: held[0].onlineOrderRequestId },
    });
    expect(order.quotedSubtotal.toFixed(2)).toBe('50000.10');
    expect(order.discountAmount.toFixed(2)).toBe('6250.01');
    expect(order.quotedTotal.toFixed(2)).toBe('43750.09');
  });

  it('replays the same online command but rejects changed bodies and unconfirmed pricing without another hold', async () => {
    const fixture = await pending();
    const replay = await workers[1].online.createPublicRequest(
      fixture.dto,
      undefined,
      customerIds[0],
    );
    expect(replay.requestId).toBe(fixture.request.requestId);
    expect(replay.quotedTotal.toFixed(2)).toBe(fixture.quote.totalAmount);
    await expect(
      workers[0].online.createPublicRequest(
        {
          ...fixture.dto,
          items: [{ menuItemId, quantity: 1 }],
        },
        undefined,
        customerIds[0],
      ),
    ).rejects.toThrow(ConflictException);
    expect(
      await db.voucherRedemption.count({
        where: { customerVoucherId: fixture.voucher.id },
      }),
    ).toBe(1);

    const { voucher } = await grant();
    const { dto } = await confirmedDto(voucher.id);
    for (const patch of [
      { expectedTotal: '43750.08' },
      { quoteFingerprint: '0'.repeat(64) },
    ]) {
      await expect(
        workers[0].online.createPublicRequest(
          { ...dto, ...patch },
          undefined,
          customerIds[0],
        ),
      ).rejects.toThrow(ConflictException);
      expect(
        await db.onlineOrderRequest.count({
          where: { clientRequestId: dto.clientRequestId },
        }),
      ).toBe(0);
      expect(
        await db.voucherRedemption.count({
          where: { customerVoucherId: voucher.id },
        }),
      ).toBe(0);
    }
  });

  it('lazily frees expired pending reservations but never releases an accepted hold', async () => {
    const stale = await pending();
    const held = await accepted();
    await db.onlineOrderRequest.updateMany({
      where: { id: { in: [stale.request.requestId, held.request.requestId] } },
      data: {
        createdAt: new Date(Date.now() - 3_600_000),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    await workers[0].vouchers.getWallet(
      customerIds[0],
      GetCustomerVouchersDto.schema.parse({}),
    );
    expect((await redemption(stale.request.requestId)).status).toBe('RELEASED');
    expect((await redemption(held.request.requestId)).status).toBe('RESERVED');
    await workers[1].vouchers.releaseExpiredReservations();
    expect((await redemption(held.request.requestId)).status).toBe('RESERVED');
    await expect(
      runSerializableTransaction(db, (tx) =>
        workers[0].vouchers.releaseInTransaction(
          tx,
          held.request.requestId,
          'REQUEST_EXPIRED',
        ),
      ),
    ).rejects.toThrow(ConflictException);
    const reuse = await confirmedDto(stale.voucher.id);
    await workers[0].online.createPublicRequest(
      reuse.dto,
      undefined,
      customerIds[0],
    );
    expect(
      await db.voucherRedemption.count({
        where: { customerVoucherId: stale.voucher.id, status: 'RESERVED' },
      }),
    ).toBe(1);
  });

  it('returns entitlement on customer cancellation, staff rejection, and accepted cancellation', async () => {
    for (const action of ['cancel', 'reject', 'cancelAccepted'] as const) {
      const fixture = await pending();
      if (action === 'cancel') {
        await workers[0].online.cancelPublicRequest({
          requestId: fixture.request.requestId,
          accessToken: fixture.request.accessToken,
        });
      } else if (action === 'reject') {
        await workers[0].online.reject(
          fixture.request.requestId,
          employeeIds[0],
          'Cannot fulfill this order',
        );
      } else {
        await workers[0].online.accept(
          fixture.request.requestId,
          employeeIds[0],
        );
        await workers[0].online.cancelAccepted(
          fixture.request.requestId,
          employeeIds[0],
          'Customer changed plans',
        );
      }
      expect((await redemption(fixture.request.requestId)).status).toBe(
        'RELEASED',
      );
      const reuse = await confirmedDto(fixture.voucher.id);
      await workers[1].online.createPublicRequest(
        reuse.dto,
        undefined,
        customerIds[0],
      );
      expect(
        await db.voucherRedemption.count({
          where: { customerVoucherId: fixture.voucher.id, status: 'RESERVED' },
        }),
      ).toBe(1);
      expect(
        (
          await db.voucherCampaign.findUniqueOrThrow({
            where: { id: fixture.terms.id },
          })
        ).issuedCount,
      ).toBe(1);
    }
  });

  it('releases no-show holds without extending an expired entitlement', async () => {
    const fixture = await accepted(true);
    // Age persisted timestamps to cross expiry and no-show boundaries without sleeps.
    const endDate = new Date(Date.now() - 1_000);
    await db.voucherCampaign.update({
      where: { id: fixture.terms.id },
      data: { endDate },
    });
    await db.orderItem.updateMany({
      where: { orderSessionId: fixture.sessionId },
      data: {
        readyAt: new Date(Date.now() - ONLINE_ORDER_NO_SHOW_GRACE_MS - 60_000),
      },
    });
    await workers[0].online.markNoShow(
      fixture.request.requestId,
      employeeIds[0],
    );
    expect(await redemption(fixture.request.requestId)).toMatchObject({
      status: 'RELEASED',
      releaseReason: 'NO_SHOW',
    });
    await expect(
      workers[0].online.quoteCustomerBasket(customerIds[0], {
        items: basket(),
        voucherId: fixture.voucher.id,
      }),
    ).rejects.toThrow(ConflictException);
    expect(
      (
        await db.voucherCampaign.findUniqueOrThrow({
          where: { id: fixture.terms.id },
        })
      ).endDate,
    ).toEqual(endDate);
    expect(
      (
        await db.customerVoucher.findUniqueOrThrow({
          where: { id: fixture.voucher.id },
        })
      ).createdAt,
    ).toEqual(fixture.voucher.createdAt);
    const wallet = await workers[0].vouchers.getWallet(
      customerIds[0],
      GetCustomerVouchersDto.schema.parse({ status: 'EXPIRED' }),
    );
    expect(wallet.list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fixture.voucher.id, status: 'EXPIRED' }),
      ]),
    );
  });

  it('collects the discounted cents once after campaign pause and forbids revoking reserved or redeemed vouchers', async () => {
    const fixture = await accepted(true);
    const revoke = async () => {
      const current = await db.customerVoucher.findUniqueOrThrow({
        where: { id: fixture.voucher.id },
      });
      return workers[0].vouchers.revoke(
        current.id,
        employeeIds[0],
        RevokeCustomerVoucherDto.schema.parse({
          expectedUpdatedAt: current.updatedAt.toISOString(),
          reason: 'Reserved and used vouchers must not be revoked',
          idempotencyKey: randomUUID(),
        }),
      );
    };
    await expect(revoke()).rejects.toThrow(ConflictException);
    const current = await db.voucherCampaign.findUniqueOrThrow({
      where: { id: fixture.terms.id },
    });
    await workers[0].campaigns.pause(
      current.id,
      employeeIds[0],
      VoucherCampaignVersionDto.schema.parse({
        expectedUpdatedAt: current.updatedAt.toISOString(),
      }),
    );
    const before = await db.fund.findUniqueOrThrow({ where: { id: fundId } });
    const dto = collectionDto(fixture.request.accessToken);
    const result = await workers[0].online.collect(
      fixture.request.requestId,
      employeeIds[0],
      dto,
    );
    const replay = await workers[1].online.collect(
      fixture.request.requestId,
      employeeIds[0],
      dto,
    );
    expect(replay).toEqual(result);
    const invoice = await db.invoice.findUniqueOrThrow({
      where: { id: result.invoiceId },
    });
    expect(invoice.subTotal.toFixed(2)).toBe('50000.10');
    expect(invoice.discountAmount.toFixed(2)).toBe('6250.01');
    expect(invoice.totalAmount.toFixed(2)).toBe('43750.09');
    expect(invoice.amountTendered?.toFixed(2)).toBe('50000.00');
    expect(invoice.changeAmount?.toFixed(2)).toBe('6249.91');
    expect(invoice.paymentStatus).toBe('PAID');
    expect(invoice.promotionId).toBeNull();
    expect(invoice.documentSnapshot).toMatchObject({
      voucher: fixture.quote.voucher,
    });
    const ledger = await db.cashTransaction.findMany({
      where: { invoiceId: invoice.id },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].amount.toFixed(2)).toBe('43750.09');
    expect(ledger[0]).toMatchObject({ type: 'INCOME', fundId });
    expect(
      (await db.fund.findUniqueOrThrow({ where: { id: fundId } })).balance
        .minus(before.balance)
        .toFixed(2),
    ).toBe('43750.09');
    expect(
      await db.invoice.count({ where: { orderSessionId: fixture.sessionId } }),
    ).toBe(1);
    expect(
      await db.voucherRedemption.count({
        where: { customerVoucherId: fixture.voucher.id },
      }),
    ).toBe(1);
    expect(await redemption(fixture.request.requestId)).toMatchObject({
      status: 'REDEEMED',
      invoiceId: invoice.id,
    });
    expect(
      await db.actionLog.count({
        where: {
          actionType: 'ONLINE_ORDER_COD_COLLECTED',
          details: {
            path: ['onlineOrderRequestId'],
            equals: fixture.request.requestId,
          },
        },
      }),
    ).toBe(1);
    expect(
      await db.outboxEvent.count({
        where: {
          aggregateId: invoice.id,
          eventName: ORDER_EVENTS.INVOICE_PAID,
        },
      }),
    ).toBe(1);
    await expect(revoke()).rejects.toThrow(ConflictException);
    expect(
      (
        await db.customerVoucher.findUniqueOrThrow({
          where: { id: fixture.voucher.id },
        })
      ).revokedAt,
    ).toBeNull();
    const items = await db.orderItem.findMany({
      where: { orderSessionId: fixture.sessionId },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      isPaid: true,
      invoiceId: invoice.id,
      serveStatus: 'SERVED',
    });
    expect(
      (
        await db.orderSession.findUniqueOrThrow({
          where: { id: fixture.sessionId },
        })
      ).sessionStatus,
    ).toBe('COMPLETED');
  });

  it('does not restore a voucher after partial or full cash refunds', async () => {
    const fixture = await accepted(true);
    const paid = await workers[0].online.collect(
      fixture.request.requestId,
      employeeIds[0],
      collectionDto(fixture.request.accessToken),
    );
    const shift = await db.cashierShift.findFirstOrThrow({
      where: { employeeId: employeeIds[0], closedAt: null },
    });
    for (const [amount, status] of [
      ['10000.00', 'PARTIALLY_REFUNDED'],
      ['33750.09', 'REFUNDED'],
    ] as const) {
      await workers[0].refunds.create(paid.invoiceId, employeeIds[0], {
        expectedShiftId: shift.id,
        amount,
        reason: 'Customer service recovery',
        idempotencyKey: randomUUID(),
      });
      expect(
        (await db.invoice.findUniqueOrThrow({ where: { id: paid.invoiceId } }))
          .paymentStatus,
      ).toBe(status);
      expect((await redemption(fixture.request.requestId)).status).toBe(
        'REDEEMED',
      );
      const wallet = await workers[0].vouchers.getWallet(
        customerIds[0],
        GetCustomerVouchersDto.schema.parse({ status: 'USED' }),
      );
      expect(wallet.list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: fixture.voucher.id, status: 'USED' }),
        ]),
      );
      await expect(confirmedDto(fixture.voucher.id)).rejects.toThrow(
        ConflictException,
      );
    }
    expect(
      await db.voucherRedemption.count({
        where: { customerVoucherId: fixture.voucher.id },
      }),
    ).toBe(1);
  });

  it('allows either collection or cancellation to win without redeeming and releasing the same voucher', async () => {
    const fixture = await accepted(true);
    const results = await Promise.allSettled([
      workers[0].online.collect(
        fixture.request.requestId,
        employeeIds[0],
        collectionDto(fixture.request.accessToken),
      ),
      workers[1].online.cancelAccepted(
        fixture.request.requestId,
        employeeIds[0],
        'Customer cannot collect',
      ),
    ]);
    oneConflict(results);
    const saved = await redemption(fixture.request.requestId);
    const invoices = await db.invoice.findMany({
      where: { orderSessionId: fixture.sessionId },
    });
    if (saved.status === 'REDEEMED') {
      expect(invoices).toHaveLength(1);
      expect(invoices[0].paymentStatus).toBe('PAID');
      expect(saved.releasedAt).toBeNull();
    } else {
      expect(saved.status).toBe('RELEASED');
      expect(saved.invoiceId).toBeNull();
      expect(invoices).toHaveLength(0);
    }
  });

  it('honors a confirmed hold after campaign expiry instead of recalculating its discount', async () => {
    const fixture = await accepted(true);
    await db.voucherCampaign.update({
      where: { id: fixture.terms.id },
      data: { endDate: new Date(Date.now() - 1_000) },
    });
    await db.onlineOrderRequest.update({
      where: { id: fixture.request.requestId },
      data: {
        createdAt: new Date(Date.now() - 3_600_000),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    await workers[1].vouchers.releaseExpiredReservations();
    expect((await redemption(fixture.request.requestId)).status).toBe(
      'RESERVED',
    );
    const result = await workers[0].online.collect(
      fixture.request.requestId,
      employeeIds[0],
      collectionDto(fixture.request.accessToken),
    );
    const invoice = await db.invoice.findUniqueOrThrow({
      where: { id: result.invoiceId },
    });
    expect(invoice.totalAmount.toFixed(2)).toBe(fixture.quote.totalAmount);
    expect(invoice.documentSnapshot).toMatchObject({
      voucher: fixture.quote.voucher,
    });
    expect((await redemption(fixture.request.requestId)).status).toBe(
      'REDEEMED',
    );
  });

  it.each([
    {
      table: 'ActionLog',
      column: 'actionType',
      value: 'ONLINE_ORDER_COD_COLLECTED',
    },
    {
      table: 'OutboxEvent',
      column: 'eventName',
      value: ORDER_EVENTS.ITEM_STATUS_UPDATED,
    },
  ])(
    'rolls back invoice, redemption, business state and cash when $table persistence fails',
    async ({ table, column, value }) => {
      const fixture = await accepted(true);
      const dto = collectionDto(fixture.request.accessToken);
      const before = {
        fund: await db.fund.findUniqueOrThrow({ where: { id: fundId } }),
        audit: await db.actionLog.count(),
        outbox: await db.outboxEvent.count(),
      };
      await db.$executeRawUnsafe(`
      CREATE FUNCTION voucher_wallet_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected voucher durable write failure'; END; $$
    `);
      try {
        // Fail after invoicing and redemption, inside the real PostgreSQL transaction.
        await db.$executeRawUnsafe(`
        CREATE TRIGGER voucher_wallet_fail_write BEFORE INSERT ON "${table}"
        FOR EACH ROW WHEN (NEW."${column}" = '${value}')
        EXECUTE FUNCTION voucher_wallet_fail_write()
      `);
        await expect(
          workers[0].online.collect(
            fixture.request.requestId,
            employeeIds[0],
            dto,
          ),
        ).rejects.toThrow('Injected voucher durable write failure');
        expect(
          await db.invoice.count({
            where: { orderSessionId: fixture.sessionId },
          }),
        ).toBe(0);
        expect(await redemption(fixture.request.requestId)).toMatchObject({
          status: 'RESERVED',
          invoiceId: null,
          redeemedAt: null,
        });
        expect(
          (
            await db.fund.findUniqueOrThrow({ where: { id: fundId } })
          ).balance.eq(before.fund.balance),
        ).toBe(true);
        expect(
          await db.cashTransaction.count({
            where: { invoice: { orderSessionId: fixture.sessionId } },
          }),
        ).toBe(0);
        expect(await db.actionLog.count()).toBe(before.audit);
        expect(await db.outboxEvent.count()).toBe(before.outbox);
        expect(
          await db.idempotencyRequest.count({
            where: {
              employeeId: employeeIds[0],
              operation: 'online-order.cod.collect',
              key: dto.idempotencyKey,
            },
          }),
        ).toBe(0);
        expect(
          (
            await db.orderSession.findUniqueOrThrow({
              where: { id: fixture.sessionId },
            })
          ).sessionStatus,
        ).toBe('ACTIVE');
        expect(
          await db.orderItem.findMany({
            where: { orderSessionId: fixture.sessionId },
          }),
        ).toEqual([
          expect.objectContaining({
            serveStatus: 'READY',
            isPaid: false,
            invoiceId: null,
          }),
        ]);
      } finally {
        await db.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS voucher_wallet_fail_write ON "${table}"`,
        );
        await db.$executeRawUnsafe('DROP FUNCTION voucher_wallet_fail_write()');
      }
      const retried = await workers[1].online.collect(
        fixture.request.requestId,
        employeeIds[0],
        dto,
      );
      expect(await redemption(fixture.request.requestId)).toMatchObject({
        status: 'REDEEMED',
        invoiceId: retried.invoiceId,
      });
    },
  );

  it('isolates customer wallets, quotes and orders and rejects guest voucher inputs before writing', async () => {
    const fixture = await pending();
    const wallet = await workers[1].vouchers.getWallet(
      customerIds[1],
      GetCustomerVouchersDto.schema.parse({}),
    );
    expect(wallet.list).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fixture.voucher.id }),
      ]),
    );
    await expect(
      workers[1].online.quoteCustomerBasket(customerIds[1], {
        items: basket(),
        voucherId: fixture.voucher.id,
      }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      workers[1].online.getCustomerOrder(
        customerIds[1],
        fixture.request.requestId,
      ),
    ).rejects.toThrow(NotFoundException);
    await expect(
      workers[1].online.createPublicRequest(
        fixture.dto,
        undefined,
        customerIds[1],
      ),
    ).rejects.toThrow(ConflictException);

    const { voucher } = await grant();
    const { dto } = await confirmedDto(voucher.id);
    expect(CreateOnlineOrderDto.schema.safeParse(dto).success).toBe(false);
    expect(
      QuoteOnlineOrderDto.schema.safeParse({
        items: basket(),
        voucherId: voucher.id,
      }).success,
    ).toBe(false);
    await expect(workers[0].online.createPublicRequest(dto)).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(
      workers[0].online.createPublicRequest(dto, undefined, customerIds[1]),
    ).rejects.toThrow(NotFoundException);
    expect(
      await db.onlineOrderRequest.count({
        where: { clientRequestId: dto.clientRequestId },
      }),
    ).toBe(0);
    expect(
      await db.voucherRedemption.count({
        where: { customerVoucherId: voucher.id },
      }),
    ).toBe(0);
    const guest = await workers[0].online.createPublicRequest(guestDto());
    const terms = await campaign({ isPublic: false });
    await expect(
      workers[0].vouchers.gift(
        terms.id,
        employeeIds[0],
        GiftCustomerVoucherDto.schema.parse({
          sourceOrderId: guest.requestId,
          reason: 'Guests do not own a wallet',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow('An authenticated customer order is required.');
    expect(
      (await db.voucherCampaign.findUniqueOrThrow({ where: { id: terms.id } }))
        .issuedCount,
    ).toBe(0);
  });
});
