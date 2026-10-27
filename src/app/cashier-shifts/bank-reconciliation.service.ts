import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BankStatementEntryDirection,
  BankStatementMatchStatus,
  CashHandoverSettlementStatus,
  CashHandoverStatus,
  FundType,
  Prisma,
} from '@prisma/client';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { assertActiveEmployee } from '../../common/prisma/employee.util';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { CashHandoversService } from './cash-handovers.service';
import {
  CreateBankStatementImportDto,
  GetBankStatementEntriesDto,
  GetBankStatementImportsDto,
  IgnoreBankStatementEntryDto,
} from './dto';

const DEBIT_IGNORE_REASON =
  'Debit entry is outside incoming cash handover reconciliation.';

@Injectable()
export class BankReconciliationService {
  private readonly logger = new Logger(BankReconciliationService.name);

  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly paginationUtil: PaginationUtilService,
    private readonly cashHandoversService: CashHandoversService,
  ) {}

  async createImport(employeeId: string, dto: CreateBankStatementImportDto) {
    await assertActiveEmployee(this.prisma, employeeId);
    const { entries, checksum } = this.importIdentity(dto);
    const existing = await this.findByChecksum(dto.fundId, checksum);
    if (existing) return { statementImport: existing, replayed: true };
    const fund = await this.prisma.fund.findFirst({
      where: { id: dto.fundId, type: FundType.BANK, deletedAt: null },
      select: { id: true },
    });
    if (!fund) {
      throw new NotFoundException(
        `Active bank fund with ID ${dto.fundId} not found.`,
      );
    }

    const importedAt = new Date();
    let replayed = false;
    const statementImport = await this.prisma
      .$transaction(async (tx) => {
        const created = await tx.bankStatementImport.create({
          data: {
            fundId: fund.id,
            importedById: employeeId,
            sourceFileName: dto.sourceFileName,
            statementFrom: dto.statementFrom,
            statementTo: dto.statementTo,
            checksum,
            entries: {
              create: entries.map((entry) => {
                const ignored =
                  entry.direction === BankStatementEntryDirection.DEBIT;
                return {
                  externalId: entry.externalId,
                  direction: entry.direction,
                  amount: new Prisma.Decimal(entry.amount),
                  transactionDate: entry.transactionDate,
                  bankReference: entry.bankReference,
                  description: entry.description,
                  fundId: fund.id,
                  matchStatus: ignored
                    ? BankStatementMatchStatus.IGNORED
                    : BankStatementMatchStatus.UNMATCHED,
                  mismatchReason: ignored ? DEBIT_IGNORE_REASON : null,
                  ignoredAt: ignored ? importedAt : null,
                };
              }),
            },
          },
          include: this.importInclude,
        });
        await this.log(tx, employeeId, 'BANK_STATEMENT_IMPORTED', {
          importId: created.id,
          fundId: fund.id,
          checksum,
          sourceFileName: dto.sourceFileName,
          entryCount: entries.length,
        });
        return created;
      })
      .catch(async (error: unknown) => {
        if (this.isUniqueViolation(error)) {
          const existing = await this.findByChecksum(dto.fundId, checksum);
          if (existing) {
            replayed = true;
            return existing;
          }
          throw new ConflictException(
            'This statement or one of its bank transaction IDs was already imported.',
          );
        }
        throw error;
      });

    if (replayed) return { statementImport, replayed: true };

    try {
      const reconciliation = await this.reconcile(
        statementImport.id,
        employeeId,
      );
      return { statementImport, reconciliation };
    } catch (error) {
      this.logger.error(
        `Statement ${statementImport.id} was imported but automatic reconciliation failed.`,
        error instanceof Error ? error.stack : undefined,
      );
      return {
        statementImport,
        reconciliation: null,
        reconciliationPending: true,
      };
    }
  }

  async recoverImport(employeeId: string, dto: CreateBankStatementImportDto) {
    await assertActiveEmployee(this.prisma, employeeId);
    const { checksum } = this.importIdentity(dto);
    const statementImport = await this.findByChecksum(dto.fundId, checksum);
    if (!statementImport) {
      throw new NotFoundException({
        code: 'BANK_IMPORT_RECOVERY_NOT_FOUND',
        message: 'No statement matching this exact content was found.',
      });
    }
    return { statementImport, replayed: true };
  }

  private findByChecksum(fundId: string, checksum: string) {
    return this.prisma.bankStatementImport.findUnique({
      where: { fundId_checksum: { fundId, checksum } },
      include: this.importInclude,
    });
  }

  private importIdentity(dto: CreateBankStatementImportDto) {
    const entries = dto.entries.map((entry) => ({
      ...entry,
      externalId: entry.externalId.toUpperCase(),
      bankReference: entry.bankReference?.toUpperCase(),
    }));
    if (
      new Set(entries.map(({ externalId }) => externalId)).size !==
      entries.length
    ) {
      throw new ConflictException(
        'Statement entries must have unique external IDs.',
      );
    }
    return { entries, checksum: this.createChecksum({ ...dto, entries }) };
  }

  async findImports(query: GetBankStatementImportsDto) {
    const where: Prisma.BankStatementImportWhereInput = {
      ...(query.fundId ? { fundId: query.fundId } : {}),
      ...(query.createdFrom || query.createdTo
        ? {
            createdAt: {
              ...(query.createdFrom ? { gte: query.createdFrom } : {}),
              ...(query.createdTo ? { lt: query.createdTo } : {}),
            },
          }
        : {}),
    };
    const totalItems = await this.prisma.bankStatementImport.count({ where });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const imports = await this.prisma.bankStatementImport.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: this.importInclude,
    });
    return paging.format(imports);
  }

  async findImport(id: string) {
    const statementImport = await this.prisma.bankStatementImport.findUnique({
      where: { id },
      include: {
        ...this.importInclude,
        entries: {
          orderBy: [{ transactionDate: 'asc' }, { id: 'asc' }],
          include: this.entryRelations,
        },
      },
    });
    if (!statementImport) {
      throw new NotFoundException(
        `Bank statement import with ID ${id} not found.`,
      );
    }
    return statementImport;
  }

  async findEntries(query: GetBankStatementEntriesDto) {
    const where: Prisma.BankStatementEntryWhereInput = {
      ...(query.importId ? { importId: query.importId } : {}),
      ...(query.fundId ? { fundId: query.fundId } : {}),
      ...(query.matchStatus ? { matchStatus: query.matchStatus } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.transactionFrom || query.transactionTo
        ? {
            transactionDate: {
              ...(query.transactionFrom ? { gte: query.transactionFrom } : {}),
              ...(query.transactionTo ? { lt: query.transactionTo } : {}),
            },
          }
        : {}),
    };
    const totalItems = await this.prisma.bankStatementEntry.count({ where });
    const paging = this.paginationUtil.paging({ ...query, totalItems });
    const entries = await this.prisma.bankStatementEntry.findMany({
      where,
      skip: paging.skip,
      take: paging.itemPerPage,
      orderBy: [{ transactionDate: 'desc' }, { id: 'desc' }],
      include: this.entryRelations,
    });
    return paging.format(entries);
  }

  async reconcile(importId: string, employeeId: string) {
    await assertActiveEmployee(this.prisma, employeeId);
    const statementImport = await this.prisma.bankStatementImport.findUnique({
      where: { id: importId },
      select: { id: true, fundId: true },
    });
    if (!statementImport) {
      throw new NotFoundException(
        `Bank statement import with ID ${importId} not found.`,
      );
    }

    const entries = await this.prisma.bankStatementEntry.findMany({
      where: {
        importId,
        direction: BankStatementEntryDirection.CREDIT,
        matchStatus: {
          in: [
            BankStatementMatchStatus.UNMATCHED,
            BankStatementMatchStatus.MISMATCH,
          ],
        },
      },
      orderBy: [{ transactionDate: 'asc' }, { id: 'asc' }],
      take: 100,
    });

    for (const entry of entries) {
      await this.reconcileEntry(entry, employeeId);
    }

    const summary = await this.getSummary(importId);
    await this.prisma.actionLog.create({
      data: {
        employeeId,
        actionType: 'BANK_STATEMENT_RECONCILED',
        details: {
          importId,
          fundId: statementImport.fundId,
          summary,
        },
      },
    });
    return summary;
  }

  async ignoreEntry(
    id: string,
    employeeId: string,
    dto: IgnoreBankStatementEntryDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await assertActiveEmployee(tx, employeeId);
      const entry = await tx.bankStatementEntry.findUnique({
        where: { id },
        select: { id: true, matchStatus: true, importId: true, fundId: true },
      });
      if (!entry) {
        throw new NotFoundException(
          `Bank statement entry with ID ${id} not found.`,
        );
      }
      if (entry.matchStatus === BankStatementMatchStatus.MATCHED) {
        throw new ConflictException(
          'A matched statement entry cannot be ignored.',
        );
      }

      if (entry.matchStatus === BankStatementMatchStatus.IGNORED) {
        return tx.bankStatementEntry.findUniqueOrThrow({
          where: { id },
          include: this.entryRelations,
        });
      }
      const ignored = await tx.bankStatementEntry.updateMany({
        where: {
          id,
          matchStatus: {
            in: [
              BankStatementMatchStatus.UNMATCHED,
              BankStatementMatchStatus.MISMATCH,
            ],
          },
        },
        data: {
          matchStatus: BankStatementMatchStatus.IGNORED,
          mismatchReason: dto.reason,
          ignoredAt: new Date(),
          matchedAt: null,
          matchedHandoverId: null,
        },
      });
      if (ignored.count !== 1)
        throw new ConflictException(
          'The statement entry changed. Reload before ignoring it.',
        );
      await this.log(tx, employeeId, 'BANK_STATEMENT_ENTRY_IGNORED', {
        entryId: id,
        importId: entry.importId,
        fundId: entry.fundId,
        reason: dto.reason,
      });
      return tx.bankStatementEntry.findUniqueOrThrow({
        where: { id },
        include: this.entryRelations,
      });
    });
  }

  private async reconcileEntry(candidate: { id: string }, employeeId: string) {
    try {
      await runSerializableTransaction(this.prisma, async (tx) => {
        const entry = await tx.bankStatementEntry.findUniqueOrThrow({
          where: { id: candidate.id },
        });
        if (
          entry.matchStatus !== BankStatementMatchStatus.UNMATCHED &&
          entry.matchStatus !== BankStatementMatchStatus.MISMATCH
        )
          return;
        if (!entry.bankReference) {
          await this.markUnmatched(tx, entry.id);
          return;
        }
        const handover = await tx.cashHandover.findFirst({
          where: {
            destinationFundId: entry.fundId,
            bankReference: entry.bankReference,
          },
          select: {
            id: true,
            status: true,
            settlementStatus: true,
            transferAmount: true,
            evidenceReference: true,
            bankStatementEntry: { select: { id: true } },
          },
        });
        if (!handover) {
          await this.markUnmatched(tx, entry.id);
          return;
        }
        if (!handover.transferAmount.equals(entry.amount)) {
          await this.markMismatch(
            tx,
            entry.id,
            `Amount does not match handover ${handover.id}.`,
          );
          return;
        }
        if (
          handover.status !== CashHandoverStatus.APPROVED ||
          (handover.settlementStatus !== CashHandoverSettlementStatus.PENDING &&
            handover.settlementStatus !== CashHandoverSettlementStatus.SETTLED)
        ) {
          await this.markMismatch(
            tx,
            entry.id,
            `Handover ${handover.id} is not eligible for bank settlement.`,
          );
          return;
        }
        if (
          handover.bankStatementEntry &&
          handover.bankStatementEntry.id !== entry.id
        ) {
          await this.markMismatch(
            tx,
            entry.id,
            `Handover ${handover.id} is already matched to another statement entry.`,
          );
          return;
        }
        if (!handover.evidenceReference) {
          await this.markMismatch(
            tx,
            entry.id,
            `Handover ${handover.id} has no registered deposit evidence.`,
          );
          return;
        }
        // Settlement, the statement link and audit must commit or roll back together.
        if (
          handover.settlementStatus === CashHandoverSettlementStatus.PENDING
        ) {
          await this.cashHandoversService.settleInTransaction(
            tx,
            handover.id,
            employeeId,
            {
              bankReference: entry.bankReference,
              evidenceReference: handover.evidenceReference,
            },
          );
        }
        const linked = await tx.bankStatementEntry.updateMany({
          where: {
            id: entry.id,
            matchStatus: {
              in: [
                BankStatementMatchStatus.UNMATCHED,
                BankStatementMatchStatus.MISMATCH,
              ],
            },
          },
          data: {
            matchStatus: BankStatementMatchStatus.MATCHED,
            mismatchReason: null,
            matchedAt: new Date(),
            ignoredAt: null,
            matchedHandoverId: handover.id,
          },
        });
        if (linked.count !== 1)
          throw new ConflictException(
            'The statement entry changed during reconciliation.',
          );
        await this.log(tx, employeeId, 'BANK_STATEMENT_ENTRY_MATCHED', {
          entryId: entry.id,
          importId: entry.importId,
          handoverId: handover.id,
          fundId: entry.fundId,
        });
      });
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof ForbiddenException ||
        this.isUniqueViolation(error)
      ) {
        await this.markMismatch(
          this.prisma,
          candidate.id,
          'Automatic settlement could not be confirmed; manual review is required.',
        );
        return;
      }
      throw error;
    }
  }

  private markUnmatched(tx: ExtendedPrismaTransactionClient, entryId: string) {
    return tx.bankStatementEntry.updateMany({
      where: {
        id: entryId,
        matchStatus: BankStatementMatchStatus.MISMATCH,
      },
      data: {
        matchStatus: BankStatementMatchStatus.UNMATCHED,
        mismatchReason: null,
      },
    });
  }

  private markMismatch(
    tx: ExtendedPrismaTransactionClient,
    entryId: string,
    reason: string,
  ) {
    return tx.bankStatementEntry.updateMany({
      where: {
        id: entryId,
        matchStatus: {
          in: [
            BankStatementMatchStatus.UNMATCHED,
            BankStatementMatchStatus.MISMATCH,
          ],
        },
      },
      data: {
        matchStatus: BankStatementMatchStatus.MISMATCH,
        mismatchReason: reason.slice(0, 500),
        matchedAt: null,
        ignoredAt: null,
        matchedHandoverId: null,
      },
    });
  }

  private async getSummary(importId: string) {
    const groups = await this.prisma.bankStatementEntry.groupBy({
      by: ['matchStatus'],
      where: { importId },
      _count: { _all: true },
      _sum: { amount: true },
    });
    const summary = Object.fromEntries(
      Object.values(BankStatementMatchStatus).map((status) => [
        status,
        { count: 0, amount: '0' },
      ]),
    );
    for (const group of groups) {
      summary[group.matchStatus] = {
        count: group._count._all,
        amount: group._sum.amount?.toString() ?? '0',
      };
    }
    return summary;
  }

  private createChecksum(dto: CreateBankStatementImportDto) {
    const canonicalEntries = dto.entries
      .map((entry) => ({
        externalId: entry.externalId,
        direction: entry.direction,
        amount: new Prisma.Decimal(entry.amount).toFixed(2),
        transactionDate: entry.transactionDate.toISOString(),
        bankReference: entry.bankReference ?? null,
        description: entry.description ?? null,
      }))
      .sort((left, right) => left.externalId.localeCompare(right.externalId));
    return createHash('sha256')
      .update(
        JSON.stringify({
          fundId: dto.fundId,
          statementFrom: dto.statementFrom.toISOString(),
          statementTo: dto.statementTo.toISOString(),
          entries: canonicalEntries,
        }),
      )
      .digest('hex');
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

  private readonly importInclude = {
    fund: { select: { id: true, name: true, type: true } },
    importedBy: { select: { id: true, fullName: true } },
    _count: { select: { entries: true } },
  } as const;

  private readonly entryRelations = {
    fund: { select: { id: true, name: true, type: true } },
    import: {
      select: {
        id: true,
        sourceFileName: true,
        statementFrom: true,
        statementTo: true,
      },
    },
    matchedHandover: {
      select: {
        id: true,
        transferAmount: true,
        settlementStatus: true,
        settledAt: true,
      },
    },
  } as const;
}
