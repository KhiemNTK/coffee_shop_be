import { createHash } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import type { CustomerRequest } from '../../common/types';
import type { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import type { TurnstileService } from '../auth/turnstile.service';
import { CustomerOrdersController } from '../customers/customer-orders.controller';
import type { IdempotencyService } from '../durable/idempotency.service';
import type { OutboxService } from '../durable/outbox.service';
import type { InventoryConsumptionService } from '../inventory/services/inventory-consumption.service';
import type { InvoicesService } from '../invoices/invoices.service';
import type { OrdersService } from '../orders/orders.service';
import type { CreateOnlineOrderDto } from './dto';
import type { OnlineOrderIntakeService } from './online-order-intake.service';
import { OnlineOrdersService } from './online-orders.service';

describe('Online order read-only recovery', () => {
  const prisma = {
    onlineOrderRequest: { findUnique: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  };
  const turnstile = { verify: jest.fn() };
  const inventory = { reserveSession: jest.fn(), canFulfill: jest.fn() };
  const service = new OnlineOrdersService(
    prisma as unknown as ExtendedPrismaClient,
    {} as OrdersService,
    {} as InvoicesService,
    inventory as unknown as InventoryConsumptionService,
    {} as IdempotencyService,
    {} as OutboxService,
    {} as PaginationUtilService,
    {
      get: () => undefined,
      getOrThrow: () => 'isolated-recovery-test-secret',
    } as unknown as ConfigService,
    turnstile as unknown as TurnstileService,
    {} as OnlineOrderIntakeService,
  );
  const dto: CreateOnlineOrderDto = {
    clientRequestId: '6f967ae8-33dc-49c0-989d-a9c623d52a9b',
    pickupName: 'Recovery fixture',
    phoneNumber: '0900000000',
    maxSubtotal: '30000.00',
    items: [
      { menuItemId: 'd1ebfac7-36dc-442d-9cb0-68be76a5aa9c', quantity: 1 },
    ],
  };
  const saved = (customerId?: string) => ({
    id: 'da03d07a-fb4b-4805-8225-6c099e3aa563',
    customerId: customerId ?? null,
    requestHash: createHash('sha256')
      .update(
        JSON.stringify({
          pickupName: dto.pickupName,
          phoneNumber: dto.phoneNumber,
          maxSubtotal: dto.maxSubtotal,
          items: dto.items,
          ...(customerId ? { customerId } : {}),
        }),
      )
      .digest('hex'),
    status: 'PENDING',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    quotedSubtotal: new Prisma.Decimal('30000.00'),
    items: [],
  });

  beforeEach(() => jest.resetAllMocks());
  afterEach(() => {
    expect(prisma.onlineOrderRequest.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(inventory.reserveSession).not.toHaveBeenCalled();
  });

  it('recovers an identical saved request without calling Cloudflare or inventory', async () => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValue(saved());
    const result = await service.recoverPublicRequest({
      ...dto,
      maxSubtotal: '30000',
    });
    expect(result.requestId).toBe(saved().id);
    expect(result.accessToken).toMatch(/^[a-f0-9]{64}$/);
    expect(turnstile.verify).not.toHaveBeenCalled();
    expect(inventory.canFulfill).not.toHaveBeenCalled();
  });

  it('never creates a missing request during recovery', async () => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValue(null);
    await expect(service.recoverPublicRequest(dto)).rejects.toMatchObject({
      status: 404,
      response: { code: 'ONLINE_ORDER_RECOVERY_NOT_FOUND' },
    });
    expect(turnstile.verify).not.toHaveBeenCalled();
  });

  it('recovers by a saved request proof without contact details, and rejects a wrong proof or owner', async () => {
    const record = saved('customer-a');
    prisma.onlineOrderRequest.findUnique.mockResolvedValue(record);
    const proof = {
      clientRequestId: dto.clientRequestId,
      requestHash: record.requestHash,
    };
    await expect(
      service.recoverByKey(proof, 'customer-a'),
    ).resolves.toHaveProperty('requestId', record.id);
    await expect(service.recoverByKey(proof)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      service.recoverByKey(proof, 'customer-b'),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.recoverByKey(
        { ...proof, requestHash: '0'.repeat(64) },
        'customer-a',
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(turnstile.verify).not.toHaveBeenCalled();
    expect(inventory.canFulfill).not.toHaveBeenCalled();
  });

  it('never creates a missing order from a saved proof', async () => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValue(null);
    await expect(
      service.recoverByKey({
        clientRequestId: dto.clientRequestId,
        requestHash: saved().requestHash,
      }),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'ONLINE_ORDER_RECOVERY_NOT_FOUND' },
    });
  });

  it('rejects payload changes and a different or missing customer', async () => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValue(saved());
    await expect(
      service.recoverPublicRequest({ ...dto, pickupName: 'Changed' }),
    ).rejects.toMatchObject({ status: 409 });
    prisma.onlineOrderRequest.findUnique.mockResolvedValue(saved('customer-a'));
    await expect(service.recoverPublicRequest(dto)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      service.recoverPublicRequest(dto, 'customer-b'),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.recoverPublicRequest(dto, 'customer-a'),
    ).resolves.toHaveProperty('accessToken');
  });

  it('still requires CAPTCHA for a fresh creation after a missing recovery', async () => {
    prisma.onlineOrderRequest.findUnique.mockResolvedValue(null);
    turnstile.verify.mockRejectedValue(new ForbiddenException());
    await expect(service.createPublicRequest(dto)).rejects.toMatchObject({
      status: 403,
    });
    expect(turnstile.verify).toHaveBeenCalledWith(
      undefined,
      undefined,
      'online_order',
    );
  });

  it('rejects a stale customer identity at the HTTP controller boundary', async () => {
    const recoverPublicRequest = jest.fn();
    const controller = new CustomerOrdersController({
      recoverPublicRequest,
    } as unknown as OnlineOrdersService);
    const request = { customer: { id: 'current-customer' } } as CustomerRequest;
    expect(() =>
      controller.recover(request, {
        ...dto,
        expectedCustomerId: 'previous-customer',
      }),
    ).toThrow(ConflictException);
    expect(recoverPublicRequest).not.toHaveBeenCalled();
    await controller.recover(request, {
      ...dto,
      expectedCustomerId: 'current-customer',
    });
    expect(recoverPublicRequest).toHaveBeenCalledWith(
      expect.objectContaining({ clientRequestId: dto.clientRequestId }),
      'current-customer',
    );
  });

  it('binds proof recovery to the authenticated customer at the controller boundary', async () => {
    const recoverByKey = jest.fn();
    const controller = new CustomerOrdersController({
      recoverByKey,
    } as unknown as OnlineOrdersService);
    const request = { customer: { id: 'customer-a' } } as CustomerRequest;
    const proof = {
      clientRequestId: dto.clientRequestId,
      requestHash: saved('customer-a').requestHash,
    };
    expect(() =>
      controller.recoverByKey(request, {
        ...proof,
        expectedCustomerId: 'customer-b',
      }),
    ).toThrow(ConflictException);
    expect(recoverByKey).not.toHaveBeenCalled();
    await controller.recoverByKey(request, {
      ...proof,
      expectedCustomerId: 'customer-a',
    });
    expect(recoverByKey).toHaveBeenCalledWith(
      expect.objectContaining(proof),
      'customer-a',
    );
  });
});
