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
  ServeStatus,
} from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { assertActiveEmployee } from '../../common/prisma/employee.util';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
import type {
  AuthenticatedPrintDevice,
  ClaimedPrintJob,
  ExtendedPrismaTransactionClient,
  KitchenPrintSplit,
  ReceiptPrintPayload,
  PrecheckPrintPayload,
} from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { IdempotencyService } from '../durable/idempotency.service';
import { readSelectedOptions } from '../menu/menu-option-selection';
import { InvoicesService } from '../invoices/invoices.service';
import { readInvoiceSnapshot } from '../invoices/invoice-snapshot';
import {
  ClaimPrintJobsDto,
  CreatePrintDeviceDto,
  CreatePrecheckDto,
  GetPrintDevicesDto,
  GetPrintJobsDto,
  PrintAgentHeartbeatDto,
  ReprintReceiptDto,
  RetryPrintJobDto,
  ResolvePrintJobDto,
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
      selectedOptions: true,
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
    private readonly invoices: InvoicesService,
  ) {}

  async createDevice(employeeId: string, dto: CreatePrintDeviceDto) {
    if (dto.type === PrintDeviceType.KITCHEN && dto.isDefault) {
      throw new ConflictException(
        'Kitchen printers must be assigned to a station, not set as default.',
      );
    }
    const apiKey = this.generateApiKey();
    const device = await this.transaction(async (tx) => {
      await assertActiveEmployee(tx, employeeId);
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
      ...(query.keyword
        ? { name: { contains: query.keyword, mode: 'insensitive' } }
        : {}),
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
      await assertActiveEmployee(tx, employeeId);
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
      await assertActiveEmployee(tx, employeeId);
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
      await assertActiveEmployee(tx, employeeId);
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
      ...(query.orderSessionId ? { orderSessionId: query.orderSessionId } : {}),
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
      await assertActiveEmployee(tx, employeeId);
      const job = await tx.printJob.findUnique({
        where: { id },
        include: {
          kitchenTicket: {
            select: {
              availableAt: true,
              items: {
                where: { orderItem: { serveStatus: ServeStatus.CANCELLED } },
                select: { orderItemId: true },
              },
            },
          },
        },
      });
      if (!job) throw new NotFoundException(`Print job ${id} not found.`);
      if (job.status === PrintJobStatus.REQUIRES_REVIEW) {
        throw new ConflictException({
          code: 'PRINT_JOB_REQUIRES_REVIEW',
          message: 'Check the printer and reconcile this job before retrying.',
        });
      }
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

      let payload: Prisma.InputJsonObject | undefined;
      if (
        job.type === PrintJobType.KITCHEN_TICKET &&
        this.isKitchenOrderPayload(job.payload)
      ) {
        const cancelled = new Set(
          job.kitchenTicket?.items.map((item) => item.orderItemId),
        );
        const items = job.payload.items.filter(
          (item) => !cancelled.has(item.orderItemId),
        );
        if (items.length === 0)
          throw new ConflictException(
            'Cancelled kitchen items cannot be printed again.',
          );
        payload = { ...job.payload, items };
      }

      const updated = await tx.printJob.updateMany({
        where: { id, status: job.status },
        data: {
          status: PrintJobStatus.PENDING,
          deviceId,
          attempts: 0,
          availableAt: new Date(
            Math.max(
              Date.now(),
              job.kitchenTicket?.availableAt?.getTime() ?? 0,
            ),
          ),
          failedAt: null,
          lastError: null,
          ...(payload ? { payload } : {}),
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

  async resolveJob(id: string, employeeId: string, dto: ResolvePrintJobDto) {
    return this.transaction(async (tx) => {
      await assertActiveEmployee(tx, employeeId);
      const job = await tx.printJob.findUnique({ where: { id } });
      if (!job) throw new NotFoundException(`Print job ${id} not found.`);
      if (
        job.status !== PrintJobStatus.REQUIRES_REVIEW ||
        job.updatedAt.toISOString() !== dto.expectedUpdatedAt
      ) {
        throw new ConflictException(
          'Print job state changed. Refresh before resolving.',
        );
      }
      if (dto.outcome === 'PRINTED' && !job.deviceId) {
        throw new ConflictException(
          'Cannot confirm printing without an assigned device.',
        );
      }
      const updated = await tx.printJob.updateMany({
        where: {
          id,
          status: PrintJobStatus.REQUIRES_REVIEW,
          updatedAt: job.updatedAt,
        },
        data: {
          status:
            dto.outcome === 'PRINTED'
              ? PrintJobStatus.PRINTED
              : PrintJobStatus.FAILED,
          printedAt: dto.outcome === 'PRINTED' ? new Date() : null,
          failedAt: dto.outcome === 'NOT_PRINTED' ? new Date() : null,
          leaseTokenHash: null,
          lastError:
            dto.outcome === 'NOT_PRINTED'
              ? 'Operator confirmed no paper was printed.'
              : null,
        },
      });
      if (updated.count !== 1)
        throw new ConflictException(
          'Print job state changed. Refresh before resolving.',
        );
      await this.audit(tx, employeeId, 'PRINT_JOB_RESOLVED', {
        printJobId: id,
        outcome: dto.outcome,
        reason: dto.reason,
      });
      return tx.printJob.findUniqueOrThrow({
        where: { id },
        select: this.jobSelect,
      });
    });
  }

  createPrecheck(employeeId: string, dto: CreatePrecheckDto) {
    return this.idempotency.execute(
      {
        employeeId,
        operation: 'printing.precheck',
        key: dto.idempotencyKey,
        request: dto,
      },
      async (tx) => {
        const quote = await this.invoices.quoteInvoiceInTransaction(
          tx,
          employeeId,
          dto,
        );
        const session = await tx.orderSession.findUniqueOrThrow({
          where: { id: dto.orderSessionId },
          select: { table: { select: { name: true } } },
        });
        const employee = await tx.employee.findUniqueOrThrow({
          where: { id: employeeId },
          select: { fullName: true },
        });
        const items = await tx.orderItem.findMany({
          where: {
            orderSessionId: dto.orderSessionId,
            id: { in: quote.orderItemIds },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            quantity: true,
            priceAtTime: true,
            selectedOptions: true,
            menuItem: { select: { name: true } },
          },
        });
        const payload: PrecheckPrintPayload = {
          documentType: 'PRECHECK',
          title: 'PHIEU TAM TINH - CHUA THANH TOAN',
          paymentStatus: 'UNPAID',
          orderSessionId: dto.orderSessionId,
          createdAt: new Date().toISOString(),
          tableName: session.table?.name ?? null,
          cashierName: employee.fullName,
          promotionId: dto.promotionId ?? null,
          subTotal: quote.subTotal.toString(),
          discountAmount: quote.discountAmount.toString(),
          taxAmount: quote.taxAmount.toString(),
          taxRate: quote.taxRate.toString(),
          totalAmount: quote.totalAmount.toString(),
          items: items.map((item) => ({
            orderItemId: item.id,
            name: item.menuItem.name,
            quantity: item.quantity,
            unitPrice: item.priceAtTime.toString(),
            lineTotal: item.priceAtTime.mul(item.quantity).toString(),
            selectedOptions: readSelectedOptions(item.selectedOptions),
          })),
        };
        const job = await tx.printJob.create({
          data: {
            type: PrintJobType.PRECHECK,
            orderSessionId: dto.orderSessionId,
            payload,
            copies: dto.copies,
            deviceId: await this.resolveReceiptDevice(tx, dto.deviceId),
            requestedById: employeeId,
            deduplicationKey: `PRECHECK:${employeeId}:${dto.idempotencyKey}`,
          },
          select: this.jobSelect,
        });
        await this.audit(tx, employeeId, 'PRECHECK_PRINT_REQUESTED', {
          printJobId: job.id,
          orderSessionId: dto.orderSessionId,
          orderItemIds: quote.orderItemIds,
          totalAmount: quote.totalAmount.toString(),
        });
        return job;
      },
    );
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
        if (
          await tx.printJob.count({
            where: {
              invoiceId,
              type: PrintJobType.RECEIPT,
              status: PrintJobStatus.REQUIRES_REVIEW,
            },
          })
        ) {
          throw new ConflictException({
            code: 'PRINT_JOB_REQUIRES_REVIEW',
            message:
              'Reconcile the uncertain receipt before requesting another copy.',
          });
        }
        const deviceId = await this.resolveReceiptDevice(tx, dto.deviceId);
        const original = await tx.printJob.findFirst({
          where: {
            invoiceId,
            type: PrintJobType.RECEIPT,
            reprintOfId: null,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, payload: true },
        });
        // shortcut: uncaptured receipts use current names, add sale-time names if legacy fidelity is required.
        const originalPayload = original?.payload;
        const job = await tx.printJob.create({
          data: {
            type: PrintJobType.RECEIPT,
            payload: {
              ...(originalPayload &&
              typeof originalPayload === 'object' &&
              !Array.isArray(originalPayload)
                ? originalPayload
                : this.receiptPayload(invoice)),
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
      availableAt?: Date;
    },
  ) {
    return tx.printJob.create({
      data: {
        type: PrintJobType.KITCHEN_TICKET,
        kitchenTicketId: input.kitchenTicketId,
        deviceId: input.deviceId,
        payload: input.payload,
        availableAt: input.availableAt,
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
          "leaseExpiresAt" = clock_timestamp() + ${PRINT_JOB_LEASE_MS} * INTERVAL '1 millisecond',
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
    const leaseTokenHash = this.hash(leaseToken);
    const updated = await this.prisma.printJob.updateMany({
      where: {
        id: jobId,
        deviceId,
        status: {
          in: [PrintJobStatus.PROCESSING, PrintJobStatus.REQUIRES_REVIEW],
        },
        leaseTokenHash,
      },
      data: {
        status: PrintJobStatus.PRINTED,
        printedAt: new Date(),
        lockedAt: null,
        leaseExpiresAt: null,
        // Keep the final token hash so a lost acknowledgement can be retried safely.
        lastError: null,
      },
    });
    if (updated.count !== 1) {
      const completed = await this.prisma.printJob.findFirst({
        where: {
          id: jobId,
          deviceId,
          status: PrintJobStatus.PRINTED,
          leaseTokenHash,
        },
        select: { id: true },
      });
      if (!completed)
        throw new ConflictException('Print job lease is stale or invalid.');
    }
    return { success: true };
  }

  async getAgentJob(deviceId: string, jobId: string) {
    const job = await this.prisma.printJob.findFirst({
      where: { id: jobId, deviceId },
      select: {
        id: true,
        status: true,
        attempts: true,
        leaseExpiresAt: true,
        printedAt: true,
        updatedAt: true,
      },
    });
    if (!job) throw new NotFoundException(`Print job ${jobId} not found.`);
    return job;
  }

  async failJob(
    deviceId: string,
    jobId: string,
    leaseToken: string,
    error: string,
    outcome: 'NOT_PRINTED' | 'UNKNOWN' = 'UNKNOWN',
  ) {
    return this.transaction(async (tx) => {
      const job = await tx.printJob.findFirst({
        where: {
          id: jobId,
          deviceId,
          status: PrintJobStatus.PROCESSING,
          leaseTokenHash: this.hash(leaseToken),
          leaseExpiresAt: { gte: new Date() },
        },
        include: {
          kitchenTicket: {
            select: {
              items: {
                where: { orderItem: { serveStatus: ServeStatus.CANCELLED } },
                select: { orderItemId: true },
              },
            },
          },
        },
      });
      if (!job) {
        throw new ConflictException('Print job lease is stale or invalid.');
      }
      const exhausted = job.attempts >= job.maxAttempts;
      const uncertain = outcome === 'UNKNOWN';
      let payload: Prisma.InputJsonObject | undefined;
      if (
        !uncertain &&
        job.type === PrintJobType.KITCHEN_TICKET &&
        this.isKitchenOrderPayload(job.payload)
      ) {
        const cancelled = new Set(
          job.kitchenTicket?.items.map((item) => item.orderItemId),
        );
        payload = {
          ...job.payload,
          items: job.payload.items.filter(
            (item) => !cancelled.has(item.orderItemId),
          ),
        };
      }
      const cancelled =
        Array.isArray(payload?.items) && payload.items.length === 0;
      const updated = await tx.printJob.updateMany({
        where: {
          id: job.id,
          status: PrintJobStatus.PROCESSING,
          leaseTokenHash: job.leaseTokenHash,
        },
        data: {
          status: cancelled
            ? PrintJobStatus.CANCELLED
            : uncertain
              ? PrintJobStatus.REQUIRES_REVIEW
              : exhausted
                ? PrintJobStatus.FAILED
                : PrintJobStatus.PENDING,
          availableAt: new Date(
            Date.now() + Math.min(300, 2 ** (job.attempts - 1)) * 1_000,
          ),
          lockedAt: null,
          leaseExpiresAt: null,
          leaseTokenHash: uncertain ? job.leaseTokenHash : null,
          failedAt: !cancelled && !uncertain && exhausted ? new Date() : null,
          lastError: error,
          ...(payload ? { payload } : {}),
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Print job state changed. Please retry.');
      }
      return {
        success: true,
        retrying: !cancelled && !uncertain && !exhausted,
      };
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
    orderSessionId: true,
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
    const snapshot = readInvoiceSnapshot(invoice.documentSnapshot);
    return {
      isReprint: false,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      createdAt: invoice.createdAt.toISOString(),
      tableName: snapshot
        ? snapshot.tableName
        : (invoice.orderSession.table?.name ?? null),
      cashierName: invoice.employee.fullName,
      paymentMethod: invoice.paymentMethod,
      paymentStatus: invoice.paymentStatus,
      subTotal: invoice.subTotal.toString(),
      discountAmount: invoice.discountAmount.toString(),
      taxAmount: invoice.taxAmount.toString(),
      totalAmount: invoice.totalAmount.toString(),
      amountTendered: invoice.amountTendered?.toString() ?? null,
      changeAmount: invoice.changeAmount?.toString() ?? null,
      items: snapshot
        ? snapshot.items.map((item) => ({
            orderItemId: item.orderItemId,
            name: item.name,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            lineTotal: new Prisma.Decimal(item.unitPrice)
              .mul(item.quantity)
              .toFixed(2),
            selectedOptions: item.selectedOptions,
          }))
        : invoice.orderItems.map((item) => ({
            orderItemId: item.id,
            name: item.menuItem.name,
            quantity: item.quantity,
            unitPrice: item.priceAtTime.toString(),
            lineTotal: item.priceAtTime.mul(item.quantity).toString(),
            selectedOptions: readSelectedOptions(item.selectedOptions),
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
      jobType === PrintJobType.KITCHEN_TICKET
        ? PrintDeviceType.KITCHEN
        : PrintDeviceType.RECEIPT;
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
        type: { in: [PrintJobType.RECEIPT, PrintJobType.PRECHECK] },
        status: PrintJobStatus.PENDING,
        deviceId: null,
      },
      data: { deviceId },
    });
  }

  recoverExpiredLeases() {
    return this.prisma.$transaction((tx) => this.recoverExpiredJobs(tx));
  }

  private recoverExpiredJobs(
    tx: ExtendedPrismaTransactionClient,
    deviceId?: string,
  ) {
    return tx.$executeRaw(Prisma.sql`
      WITH expired AS (
        SELECT "id" FROM "PrintJob"
        WHERE "status" = 'PROCESSING'::"PrintJobStatus"
          AND "leaseExpiresAt" < CURRENT_TIMESTAMP
          ${deviceId ? Prisma.sql`AND "deviceId" = ${deviceId}` : Prisma.empty}
        ORDER BY "leaseExpiresAt", "id"
        LIMIT 200
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "PrintJob" job
      SET
        "status" = 'REQUIRES_REVIEW'::"PrintJobStatus",
        "lockedAt" = NULL,
        "leaseExpiresAt" = NULL,
        "lastError" = 'Print acknowledgement missing. Check the printer before retrying.',
        "updatedAt" = CURRENT_TIMESTAMP
      FROM expired WHERE job."id" = expired."id"
    `);
  }

  private isKitchenOrderPayload(
    payload: unknown,
  ): payload is Prisma.JsonObject & {
    items: Array<Prisma.JsonObject & { orderItemId: string }>;
  } {
    if (
      payload === null ||
      Array.isArray(payload) ||
      typeof payload !== 'object'
    )
      return false;
    const value = payload as Prisma.JsonObject;
    return (
      value.documentType !== 'KITCHEN_CANCELLATION' &&
      Array.isArray(value.items) &&
      value.items.every(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          typeof item.orderItemId === 'string',
      )
    );
  }

  async splitKitchenItems(
    tx: ExtendedPrismaTransactionClient,
    {
      employeeId,
      destinationSessionId,
      destinationTableName,
      moves,
    }: KitchenPrintSplit,
  ) {
    if (moves.length === 0) return;
    const movesById = new Map(moves.map((move) => [move.orderItemId, move]));
    const jobs = await tx.printJob.findMany({
      where: {
        type: PrintJobType.KITCHEN_TICKET,
        deduplicationKey: { startsWith: 'KITCHEN_TICKET:' },
        kitchenTicket: {
          items: { some: { orderItemId: { in: [...movesById.keys()] } } },
        },
      },
      orderBy: { id: 'asc' },
    });
    for (const job of jobs) {
      if (job.status === PrintJobStatus.CANCELLED) continue;
      if (!this.isKitchenOrderPayload(job.payload)) {
        throw new ConflictException(
          'Invalid kitchen print payload. Reconcile before splitting.',
        );
      }
      const movedItems: Prisma.InputJsonObject[] = [];
      const remaining = job.payload.items.map((item) => {
        const move = movesById.get(item.orderItemId);
        if (!move) return item;
        if (item.quantity !== move.originalQuantity) {
          throw new ConflictException(
            'Kitchen print quantity changed. Refresh before splitting.',
          );
        }
        movedItems.push({
          ...item,
          orderItemId: move.movedOrderItemId,
          quantity: move.quantityToMove,
        });
        return {
          ...item,
          quantity: move.originalQuantity - move.quantityToMove,
        };
      });
      if (movedItems.length === 0) continue;
      // A claimed ticket may already be on paper, so its quantities are immutable.
      if (
        job.status !== PrintJobStatus.PENDING &&
        job.status !== PrintJobStatus.FAILED
      ) {
        throw new ConflictException({
          code: 'KITCHEN_SPLIT_REQUIRES_UNPRINTED',
          message:
            'Cannot partially split a line after its kitchen ticket was claimed. Move the whole line instead.',
        });
      }
      const updated = await tx.printJob.updateMany({
        where: { id: job.id, status: job.status, updatedAt: job.updatedAt },
        data: { payload: { ...job.payload, items: remaining } },
      });
      if (updated.count !== 1) {
        throw new ConflictException(
          'Kitchen print state changed. Retry splitting.',
        );
      }
      await tx.printJob.create({
        data: {
          type: PrintJobType.KITCHEN_TICKET,
          kitchenTicketId: job.kitchenTicketId,
          deviceId: job.deviceId,
          requestedById: employeeId,
          status: job.status,
          copies: job.copies,
          maxAttempts: job.maxAttempts,
          availableAt: job.availableAt,
          deduplicationKey: `KITCHEN_TICKET:${job.id}:SPLIT:${destinationSessionId}`,
          payload: {
            ...job.payload,
            orderSessionId: destinationSessionId,
            tableName: destinationTableName,
            items: movedItems,
          },
        },
      });
    }
  }

  async cancelKitchenItems(
    tx: ExtendedPrismaTransactionClient,
    orderItemIds: string[],
    employeeId: string,
    reason: string,
  ) {
    if (orderItemIds.length === 0) return;
    const cancelled = new Set(orderItemIds);
    const jobs = await tx.printJob.findMany({
      where: {
        type: PrintJobType.KITCHEN_TICKET,
        deduplicationKey: { startsWith: 'KITCHEN_TICKET:' },
        kitchenTicket: {
          items: { some: { orderItemId: { in: orderItemIds } } },
        },
      },
      orderBy: { id: 'asc' },
    });
    for (const job of jobs) {
      if (job.status === PrintJobStatus.CANCELLED) continue;
      if (!this.isKitchenOrderPayload(job.payload)) {
        throw new ConflictException(
          'Invalid kitchen print payload. Reconcile the ticket before cancellation.',
        );
      }
      const items = job.payload.items.filter((item) =>
        cancelled.has(item.orderItemId),
      );
      if (items.length === 0) continue;
      if (
        job.status === PrintJobStatus.PENDING ||
        job.status === PrintJobStatus.FAILED
      ) {
        const remaining = job.payload.items.filter(
          (item) => !cancelled.has(item.orderItemId),
        );
        const updated = await tx.printJob.updateMany({
          where: { id: job.id, status: job.status, updatedAt: job.updatedAt },
          data: {
            payload: { ...job.payload, items: remaining },
            ...(remaining.length === 0
              ? { status: PrintJobStatus.CANCELLED, failedAt: null }
              : {}),
          },
        });
        if (updated.count !== 1)
          throw new ConflictException(
            'Kitchen print state changed. Retry cancellation.',
          );
      } else {
        const signature = this.hash(
          items
            .map((item) => item.orderItemId)
            .sort()
            .join(','),
        );
        await tx.printJob.createMany({
          data: {
            type: PrintJobType.KITCHEN_TICKET,
            kitchenTicketId: job.kitchenTicketId,
            deviceId: job.deviceId,
            requestedById: employeeId,
            deduplicationKey: `KITCHEN_CANCELLATION:${job.id}:${signature}`,
            payload: {
              ...job.payload,
              documentType: 'KITCHEN_CANCELLATION',
              title: 'CANCELLED ITEMS',
              originalJobId: job.id,
              reason,
              items,
            },
          },
          skipDuplicates: true,
        });
      }
    }
  }

  private lockDevice(tx: ExtendedPrismaTransactionClient, deviceId: string) {
    return tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "PrintDevice"
      WHERE "id" = ${deviceId}
      FOR UPDATE
    `);
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
