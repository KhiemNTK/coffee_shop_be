import { createHash, randomBytes } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  PaymentStatus,
  Prisma,
  PrintDeviceStatus,
  PrintDeviceType,
  PrintJobStatus,
  PrintJobType,
} from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
import type {
  AuthenticatedPrintDevice,
  ClaimedPrintJob,
  ExtendedPrismaTransactionClient,
  ReceiptPrintPayload,
} from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { IdempotencyService } from '../durable/idempotency.service';
import {
  ClaimPrintJobsDto,
  CreatePrintDeviceDto,
  GetPrintDevicesDto,
  GetPrintJobsDto,
  PrintAgentHeartbeatDto,
  ReprintReceiptDto,
  RetryPrintJobDto,
  UpdatePrintDeviceDto,
} from './dto';

const PRINT_JOB_LEASE_MS = 60_000;
const PRINT_DEVICE_ONLINE_MS = 90_000;

const RECEIPT_INVOICE_INCLUDE = {
  orderSession: { select: { table: { select: { name: true } } } },
  employee: { select: { fullName: true } },
  orderItems: {
    orderBy: { createdAt: 'asc' as const },
    select: {
      id: true,
      quantity: true,
      priceAtTime: true,
      menuItem: { select: { name: true } },
    },
  },
} satisfies Prisma.InvoiceInclude;

type ReceiptInvoice = Prisma.InvoiceGetPayload<{
  include: typeof RECEIPT_INVOICE_INCLUDE;
}>;

@Injectable()
export class PrintingService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly pagination: PaginationUtilService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async createDevice(employeeId: string, dto: CreatePrintDeviceDto) {
    if (dto.type === PrintDeviceType.KITCHEN && dto.isDefault) {
      throw new ConflictException(
        'Kitchen printers must be assigned to a station, not set as default.',
      );
    }
    const apiKey = this.generateApiKey();
    const device = await this.transaction(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const defaultCount =
        dto.type === PrintDeviceType.RECEIPT
          ? await tx.printDevice.count({
              where: {
                type: PrintDeviceType.RECEIPT,
                isActive: true,
                isDefault: true,
                deletedAt: null,
              },
            })
          : 0;
      const isDefault =
        dto.type === PrintDeviceType.RECEIPT &&
        (dto.isDefault ?? defaultCount === 0);
      if (isDefault) await this.clearDefault(tx, dto.type);

      const created = await tx.printDevice.create({
        data: {
          name: dto.name,
          type: dto.type,
          paperSize: dto.paperSize,
          isDefault,
          apiKeyHash: this.hash(apiKey),
        },
        select: this.deviceSelect,
      });
      if (isDefault) {
        await this.assignPendingDefaultJobs(tx, created.id);
      }
      await this.audit(tx, employeeId, 'PRINT_DEVICE_CREATED', {
        printDeviceId: created.id,
        name: created.name,
        type: created.type,
      });
      return created;
    });

    return { device: this.withOnlineState(device), apiKey };
  }

  async getDevices(query: GetPrintDevicesDto) {
    const where: Prisma.PrintDeviceWhereInput = {
      deletedAt: null,
      ...(query.type ? { type: query.type } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
    };
    const totalItems = await this.prisma.printDevice.count({ where });
    const paging = this.pagination.paging({ ...query, totalItems });
    const devices = await this.prisma.printDevice.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ type: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      select: this.deviceSelect,
    });
    return paging.format(devices.map((device) => this.withOnlineState(device)));
  }

  async getDevice(id: string) {
    const device = await this.prisma.printDevice.findFirst({
      where: { id, deletedAt: null },
      select: this.deviceSelect,
    });
    if (!device) throw new NotFoundException(`Print device ${id} not found.`);
    return this.withOnlineState(device);
  }

  async updateDevice(
    id: string,
    employeeId: string,
    dto: UpdatePrintDeviceDto,
  ) {
    return this.transaction(async (tx) => {
      await this.lockDevice(tx, id);
      await this.assertActiveEmployee(tx, employeeId);
      const existing = await tx.printDevice.findFirst({
        where: { id, deletedAt: null },
        include: {
          _count: { select: { kitchenStations: true, printJobs: true } },
        },
      });
      if (!existing)
        throw new NotFoundException(`Print device ${id} not found.`);

      const type = dto.type ?? existing.type;
      if (type === PrintDeviceType.KITCHEN && dto.isDefault) {
        throw new ConflictException(
          'Kitchen printers must be assigned to a station, not set as default.',
        );
      }
      if (
        type !== PrintDeviceType.KITCHEN &&
        existing._count.kitchenStations > 0
      ) {
        throw new ConflictException(
          'A device assigned to kitchen stations must remain a kitchen printer.',
        );
      }
      if (type !== existing.type && existing._count.printJobs > 0) {
        throw new ConflictException(
          'A print device type cannot change after jobs have been assigned.',
        );
      }
      const isActive = dto.isActive ?? existing.isActive;
      const isDefault =
        isActive && type === PrintDeviceType.RECEIPT
          ? (dto.isDefault ??
            (type === existing.type ? existing.isDefault : false))
          : false;
      if (dto.isActive === false) {
        await this.recoverExpiredJobs(tx, id);
        const activeLeases = await tx.printJob.count({
          where: { deviceId: id, status: PrintJobStatus.PROCESSING },
        });
        if (activeLeases > 0) {
          throw new ConflictException(
            'Wait for active print leases to finish before disabling the device.',
          );
        }
      }
      if (isDefault) await this.clearDefault(tx, type, id);

      const device = await tx.printDevice.update({
        where: { id },
        data: {
          name: dto.name,
          type,
          paperSize: dto.paperSize,
          isActive,
          isDefault,
          status:
            dto.status ??
            (dto.isActive === false
              ? PrintDeviceStatus.PAUSED
              : dto.isActive === true
                ? PrintDeviceStatus.READY
                : undefined),
        },
        select: this.deviceSelect,
      });
      if (dto.isActive === false) {
        await tx.printJob.updateMany({
          where: { deviceId: id, status: PrintJobStatus.PENDING },
          data: { deviceId: null },
        });
      } else if (isDefault) {
        await this.assignPendingDefaultJobs(tx, id);
      }
      await this.audit(tx, employeeId, 'PRINT_DEVICE_UPDATED', {
        printDeviceId: id,
        changes: this.jsonObject(dto),
      });
      return this.withOnlineState(device);
    });
  }

  async deleteDevice(id: string, employeeId: string) {
    await this.transaction(async (tx) => {
      await this.lockDevice(tx, id);
      await this.assertActiveEmployee(tx, employeeId);
      const device = await tx.printDevice.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!device) throw new NotFoundException(`Print device ${id} not found.`);

      await this.recoverExpiredJobs(tx, id);
      const processing = await tx.printJob.count({
        where: { deviceId: id, status: PrintJobStatus.PROCESSING },
      });
      if (processing > 0) {
        throw new ConflictException(
          'Cannot delete a print device while it has leased jobs.',
        );
      }
      await tx.kitchenStation.updateMany({
        where: { printDeviceId: id },
        data: { printDeviceId: null },
      });
      await tx.printJob.updateMany({
        where: { deviceId: id, status: PrintJobStatus.PENDING },
        data: { deviceId: null },
      });
      await tx.printDevice.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          isActive: false,
          isDefault: false,
          status: PrintDeviceStatus.PAUSED,
        },
      });
      await this.audit(tx, employeeId, 'PRINT_DEVICE_DELETED', {
        printDeviceId: id,
      });
    });
    return { success: true };
  }

  async rotateDeviceKey(id: string, employeeId: string) {
    const apiKey = this.generateApiKey();
    await this.transaction(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const updated = await tx.printDevice.updateMany({
        where: { id, deletedAt: null },
        data: { apiKeyHash: this.hash(apiKey) },
      });
      if (updated.count !== 1) {
        throw new NotFoundException(`Print device ${id} not found.`);
      }
      await this.audit(tx, employeeId, 'PRINT_DEVICE_KEY_ROTATED', {
        printDeviceId: id,
      });
    });
    return { printDeviceId: id, apiKey };
  }

  async getJobs(query: GetPrintJobsDto) {
    const where: Prisma.PrintJobWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.deviceId ? { deviceId: query.deviceId } : {}),
      ...(query.invoiceId ? { invoiceId: query.invoiceId } : {}),
    };
    const totalItems = await this.prisma.printJob.count({ where });
    const paging = this.pagination.paging({ ...query, totalItems });
    const jobs = await this.prisma.printJob.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        ...this.jobSelect,
        payload: false,
        device: { select: { id: true, name: true, type: true } },
        requestedBy: { select: { id: true, fullName: true } },
      },
    });
    return paging.format(jobs);
  }

  async getJob(id: string) {
    const job = await this.prisma.printJob.findUnique({
      where: { id },
      select: {
        ...this.jobSelect,
        device: { select: { id: true, name: true, type: true } },
        requestedBy: { select: { id: true, fullName: true } },
      },
    });
    if (!job) throw new NotFoundException(`Print job ${id} not found.`);
    return job;
  }

  async retryJob(id: string, employeeId: string, dto: RetryPrintJobDto) {
    return this.transaction(async (tx) => {
      await this.assertActiveEmployee(tx, employeeId);
      const job = await tx.printJob.findUnique({ where: { id } });
      if (!job) throw new NotFoundException(`Print job ${id} not found.`);
      if (
        job.status !== PrintJobStatus.PENDING &&
        job.status !== PrintJobStatus.FAILED
      ) {
        throw new ConflictException(
          'Only pending or failed jobs can be retried.',
        );
      }

      const deviceId = dto.deviceId === undefined ? job.deviceId : dto.deviceId;
      if (deviceId) await this.assertCompatibleDevice(tx, deviceId, job.type);

      const updated = await tx.printJob.updateMany({
        where: { id, status: job.status },
        data: {
          status: PrintJobStatus.PENDING,
          deviceId,
          attempts: 0,
          availableAt: new Date(),
          failedAt: null,
          lastError: null,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Print job state changed. Please retry.');
      }
      await this.audit(tx, employeeId, 'PRINT_JOB_RETRIED', {
        printJobId: id,
        deviceId,
      });
      return tx.printJob.findUniqueOrThrow({
        where: { id },
        select: this.jobSelect,
      });
    });
  }

  reprintReceipt(
    invoiceId: string,
    employeeId: string,
    dto: ReprintReceiptDto,
  ) {
    return this.idempotency.execute(
      {
        employeeId,
        operation: `receipt-reprint:${invoiceId}`,
        key: dto.idempotencyKey,
        request: dto,
      },
      async (tx) => {
        const employee = await tx.employee.findFirst({
          where: { id: employeeId, isActive: true, deletedAt: null },
          select: { id: true },
        });
        if (!employee) {
          throw new UnauthorizedException('Employee is inactive or not found.');
        }
        const invoice = await this.findPrintableInvoice(tx, invoiceId);
        const deviceId = await this.resolveReceiptDevice(tx, dto.deviceId);
        const original = await tx.printJob.findFirst({
          where: {
            invoiceId,
            type: PrintJobType.RECEIPT,
            status: PrintJobStatus.PRINTED,
          },
          orderBy: { printedAt: 'asc' },
          select: { id: true },
        });
        const job = await tx.printJob.create({
          data: {
            type: PrintJobType.RECEIPT,
            payload: {
              ...this.receiptPayload(invoice),
              isReprint: true,
            },
            copies: dto.copies,
            deviceId,
            invoiceId,
            requestedById: employeeId,
            reprintOfId: original?.id,
            deduplicationKey: `REPRINT:${invoiceId}:${employeeId}:${dto.idempotencyKey}`,
          },
          select: this.jobSelect,
        });
        await this.audit(tx, employeeId, 'RECEIPT_REPRINT_REQUESTED', {
          invoiceId,
          printJobId: job.id,
          reason: dto.reason,
          copies: dto.copies,
          deviceId,
        });
        return job;
      },
    );
  }

  async createAutomaticReceipt(invoiceId: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.printJob.findUnique({
          where: { deduplicationKey: `AUTO_RECEIPT:${invoiceId}` },
        });
        if (existing) return existing;

        const invoice = await tx.invoice.findFirst({
          where: {
            id: invoiceId,
            paymentStatus: {
              in: [
                PaymentStatus.PAID,
                PaymentStatus.PARTIALLY_REFUNDED,
                PaymentStatus.REFUNDED,
              ],
            },
          },
          include: RECEIPT_INVOICE_INCLUDE,
        });
        if (!invoice) return null;
        const deviceId = await this.resolveReceiptDevice(tx);
        return tx.printJob.create({
          data: {
            type: PrintJobType.RECEIPT,
            payload: this.receiptPayload(invoice),
            invoiceId,
            deviceId,
            deduplicationKey: `AUTO_RECEIPT:${invoiceId}`,
          },
        });
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      return this.prisma.printJob.findUnique({
        where: { deduplicationKey: `AUTO_RECEIPT:${invoiceId}` },
      });
    }
  }

  cancelPendingReceiptJobs(invoiceId: string) {
    return this.prisma.printJob.updateMany({
      where: {
        invoiceId,
        type: PrintJobType.RECEIPT,
        status: PrintJobStatus.PENDING,
      },
      data: { status: PrintJobStatus.CANCELLED },
    });
  }

  enqueueKitchenTicket(
    tx: ExtendedPrismaTransactionClient,
    input: {
      kitchenTicketId: string;
      deviceId: string;
      payload: Prisma.InputJsonObject;
    },
  ) {
    return tx.printJob.create({
      data: {
        type: PrintJobType.KITCHEN_TICKET,
        kitchenTicketId: input.kitchenTicketId,
        deviceId: input.deviceId,
        payload: input.payload,
        deduplicationKey: `KITCHEN_TICKET:${input.kitchenTicketId}`,
      },
    });
  }

  async heartbeat(
    device: AuthenticatedPrintDevice,
    dto: PrintAgentHeartbeatDto,
  ) {
    const now = new Date();
    const updated = await this.prisma.printDevice.updateMany({
      where: {
        id: device.id,
        isActive: true,
        deletedAt: null,
        status: { not: PrintDeviceStatus.PAUSED },
      },
      data: {
        status: dto.status,
        lastSeenAt: now,
        lastError:
          dto.status === PrintDeviceStatus.ERROR ? (dto.error ?? null) : null,
      },
    });
    if (updated.count === 0) {
      await this.prisma.printDevice.updateMany({
        where: { id: device.id, isActive: true, deletedAt: null },
        data: { lastSeenAt: now },
      });
    }
    return this.getDevice(device.id);
  }

  async claimJobs(device: AuthenticatedPrintDevice, dto: ClaimPrintJobsDto) {
    const leaseToken = randomBytes(32).toString('base64url');
    const leaseTokenHash = this.hash(leaseToken);
    const leaseExpiresAt = new Date(Date.now() + PRINT_JOB_LEASE_MS);

    const jobs = await this.prisma.$transaction(async (tx) => {
      const current = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "PrintDevice"
        WHERE "id" = ${device.id}
          AND "isActive" = true
          AND "deletedAt" IS NULL
          AND "status" = 'READY'::"PrintDeviceStatus"
        FOR UPDATE
      `);
      if (current.length !== 1) {
        throw new ConflictException('Print device is not ready to claim jobs.');
      }
      await this.recoverExpiredJobs(tx, device.id);

      return tx.$queryRaw<ClaimedPrintJob[]>(Prisma.sql`
        WITH candidates AS (
          SELECT "id"
          FROM "PrintJob"
          WHERE "deviceId" = ${device.id}
            AND "status" = 'PENDING'::"PrintJobStatus"
            AND "availableAt" <= CURRENT_TIMESTAMP
            AND "attempts" < "maxAttempts"
          ORDER BY "createdAt", "id"
          LIMIT ${dto.limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "PrintJob" job
        SET
          "status" = 'PROCESSING'::"PrintJobStatus",
          "attempts" = job."attempts" + 1,
          "lockedAt" = CURRENT_TIMESTAMP,
          "leaseExpiresAt" = ${leaseExpiresAt},
          "leaseTokenHash" = ${leaseTokenHash},
          "updatedAt" = CURRENT_TIMESTAMP
        FROM candidates
        WHERE job."id" = candidates."id"
        RETURNING
          job."id",
          job."type",
          job."payload",
          job."copies",
          job."attempts",
          job."leaseExpiresAt"
      `);
    });

    return {
      jobs: jobs.map((job) => ({
        ...job,
        leaseToken,
      })),
    };
  }

  async completeJob(deviceId: string, jobId: string, leaseToken: string) {
    const updated = await this.prisma.printJob.updateMany({
      where: {
        id: jobId,
        deviceId,
        status: PrintJobStatus.PROCESSING,
        leaseTokenHash: this.hash(leaseToken),
        leaseExpiresAt: { gte: new Date() },
      },
      data: {
        status: PrintJobStatus.PRINTED,
        printedAt: new Date(),
        lockedAt: null,
        leaseExpiresAt: null,
        leaseTokenHash: null,
        lastError: null,
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Print job lease is stale or invalid.');
    }
    return { success: true };
  }

  async failJob(
    deviceId: string,
    jobId: string,
    leaseToken: string,
    error: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.printJob.findFirst({
        where: {
          id: jobId,
          deviceId,
          status: PrintJobStatus.PROCESSING,
          leaseTokenHash: this.hash(leaseToken),
          leaseExpiresAt: { gte: new Date() },
        },
      });
      if (!job) {
        throw new ConflictException('Print job lease is stale or invalid.');
      }
      const exhausted = job.attempts >= job.maxAttempts;
      const updated = await tx.printJob.updateMany({
        where: {
          id: job.id,
          status: PrintJobStatus.PROCESSING,
          leaseTokenHash: job.leaseTokenHash,
        },
        data: {
          status: exhausted ? PrintJobStatus.FAILED : PrintJobStatus.PENDING,
          availableAt: new Date(
            Date.now() + Math.min(300, 2 ** (job.attempts - 1)) * 1_000,
          ),
          lockedAt: null,
          leaseExpiresAt: null,
          leaseTokenHash: null,
          failedAt: exhausted ? new Date() : null,
          lastError: error,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Print job state changed. Please retry.');
      }
      return { success: true, retrying: !exhausted };
    });
  }

  private readonly deviceSelect = {
    id: true,
    name: true,
    type: true,
    paperSize: true,
    isActive: true,
    isDefault: true,
    status: true,
    lastSeenAt: true,
    lastError: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  private readonly jobSelect = {
    id: true,
    type: true,
    status: true,
    payload: true,
    copies: true,
    attempts: true,
    maxAttempts: true,
    availableAt: true,
    leaseExpiresAt: true,
    printedAt: true,
    failedAt: true,
    lastError: true,
    createdAt: true,
    updatedAt: true,
    deviceId: true,
    requestedById: true,
    invoiceId: true,
    kitchenTicketId: true,
    reprintOfId: true,
  } as const;

  private withOnlineState<
    T extends { isActive: boolean; lastSeenAt: Date | null },
  >(device: T) {
    return {
      ...device,
      isOnline:
        device.isActive &&
        device.lastSeenAt !== null &&
        device.lastSeenAt.getTime() >= Date.now() - PRINT_DEVICE_ONLINE_MS,
    };
  }

  private async findPrintableInvoice(
    tx: ExtendedPrismaTransactionClient,
    invoiceId: string,
  ) {
    const invoice = await tx.invoice.findFirst({
      where: {
        id: invoiceId,
        paymentStatus: {
          in: [
            PaymentStatus.PAID,
            PaymentStatus.PARTIALLY_REFUNDED,
            PaymentStatus.REFUNDED,
          ],
        },
      },
      include: RECEIPT_INVOICE_INCLUDE,
    });
    if (!invoice) {
      throw new ConflictException('Only paid invoices can be printed.');
    }
    return invoice;
  }

  private receiptPayload(invoice: ReceiptInvoice): ReceiptPrintPayload {
    return {
      isReprint: false,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      createdAt: invoice.createdAt.toISOString(),
      tableName: invoice.orderSession.table?.name ?? null,
      cashierName: invoice.employee.fullName,
      paymentMethod: invoice.paymentMethod,
      paymentStatus: invoice.paymentStatus,
      subTotal: invoice.subTotal.toString(),
      discountAmount: invoice.discountAmount.toString(),
      taxAmount: invoice.taxAmount.toString(),
      totalAmount: invoice.totalAmount.toString(),
      amountTendered: invoice.amountTendered?.toString() ?? null,
      changeAmount: invoice.changeAmount?.toString() ?? null,
      items: invoice.orderItems.map((item) => ({
        orderItemId: item.id,
        name: item.menuItem.name,
        quantity: item.quantity,
        unitPrice: item.priceAtTime.toString(),
        lineTotal: item.priceAtTime.mul(item.quantity).toString(),
      })),
    };
  }

  private async resolveReceiptDevice(
    tx: ExtendedPrismaTransactionClient,
    requestedDeviceId?: string,
  ) {
    if (requestedDeviceId) {
      await this.assertCompatibleDevice(
        tx,
        requestedDeviceId,
        PrintJobType.RECEIPT,
      );
      return requestedDeviceId;
    }
    const device = await tx.printDevice.findFirst({
      where: {
        type: PrintDeviceType.RECEIPT,
        isActive: true,
        isDefault: true,
        deletedAt: null,
      },
      select: { id: true },
    });
    return device?.id ?? null;
  }

  private async assertCompatibleDevice(
    tx: ExtendedPrismaTransactionClient,
    deviceId: string,
    jobType: PrintJobType,
  ) {
    const expectedType =
      jobType === PrintJobType.RECEIPT
        ? PrintDeviceType.RECEIPT
        : PrintDeviceType.KITCHEN;
    const device = await tx.printDevice.findFirst({
      where: {
        id: deviceId,
        type: expectedType,
        isActive: true,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!device) {
      throw new ConflictException(
        `An active ${expectedType.toLowerCase()} print device is required.`,
      );
    }
  }

  private clearDefault(
    tx: ExtendedPrismaTransactionClient,
    type: PrintDeviceType,
    exceptId?: string,
  ) {
    return tx.printDevice.updateMany({
      where: {
        type,
        isDefault: true,
        deletedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      data: { isDefault: false },
    });
  }

  private assignPendingDefaultJobs(
    tx: ExtendedPrismaTransactionClient,
    deviceId: string,
  ) {
    return tx.printJob.updateMany({
      where: {
        type: PrintJobType.RECEIPT,
        status: PrintJobStatus.PENDING,
        deviceId: null,
      },
      data: { deviceId },
    });
  }

  private recoverExpiredJobs(
    tx: ExtendedPrismaTransactionClient,
    deviceId: string,
  ) {
    return tx.$executeRaw(Prisma.sql`
      UPDATE "PrintJob"
      SET
        "status" = CASE
          WHEN "attempts" >= "maxAttempts" THEN 'FAILED'::"PrintJobStatus"
          ELSE 'PENDING'::"PrintJobStatus"
        END,
        "availableAt" = CURRENT_TIMESTAMP,
        "lockedAt" = NULL,
        "leaseExpiresAt" = NULL,
        "leaseTokenHash" = NULL,
        "failedAt" = CASE
          WHEN "attempts" >= "maxAttempts" THEN CURRENT_TIMESTAMP
          ELSE NULL
        END,
        "lastError" = 'Print agent lease expired.',
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "deviceId" = ${deviceId}
        AND "status" = 'PROCESSING'::"PrintJobStatus"
        AND "leaseExpiresAt" < CURRENT_TIMESTAMP
    `);
  }

  private lockDevice(tx: ExtendedPrismaTransactionClient, deviceId: string) {
    return tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "PrintDevice"
      WHERE "id" = ${deviceId}
      FOR UPDATE
    `);
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

  private audit(
    tx: ExtendedPrismaTransactionClient,
    employeeId: string,
    actionType: string,
    details: Prisma.InputJsonObject,
  ) {
    return tx.actionLog.create({
      data: { employeeId, actionType, details },
    });
  }

  private transaction<T>(
    callback: (tx: ExtendedPrismaTransactionClient) => Promise<T>,
  ) {
    return runSerializableTransaction(this.prisma, callback, {
      loggerContext: 'Printing transaction',
      retryUniqueViolations: true,
    });
  }

  private generateApiKey() {
    return randomBytes(32).toString('base64url');
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private jsonObject(value: object): Prisma.InputJsonObject {
    return Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined),
    );
  }

  private isUniqueViolation(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}
