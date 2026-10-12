import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, SettingValueType } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { ONLINE_ORDER_INTAKE_SETTING_KEY } from '../../common/consts/online-order-settings';
import {
  PRISMA_SERVICE_TOKEN,
  type ExtendedPrismaClient,
} from '../../common/prisma/prisma.service';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
import type { ExtendedPrismaTransactionClient } from '../../common/types';
import {
  OnlineOrderIntakeValueSchema,
  UpdateOnlineOrderIntakeDto,
} from './dto';

@Injectable()
export class OnlineOrderIntakeService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN) private readonly prisma: ExtendedPrismaClient,
    private readonly config: ConfigService,
  ) {}

  async getStatus(
    db: ExtendedPrismaClient | ExtendedPrismaTransactionClient = this.prisma,
  ) {
    const setting = await db.systemSetting.findUnique({
      where: {
        key: ONLINE_ORDER_INTAKE_SETTING_KEY,
        __includeDeleted: true,
      } as Prisma.SystemSettingWhereUniqueInput & { __includeDeleted: true },
      select: { value: true, valueType: true, version: true, deletedAt: true },
    });
    const value = OnlineOrderIntakeValueSchema.safeParse(
      setting ? setting.value : { pausedUntil: null, reason: null },
    );
    if (
      !value.success ||
      (setting &&
        (setting.deletedAt || setting.valueType !== SettingValueType.JSON))
    ) {
      throw new ServiceUnavailableException(
        'Online intake configuration is invalid.',
      );
    }
    const paused = Boolean(
      value.data.pausedUntil && new Date(value.data.pausedUntil) > new Date(),
    );
    return {
      ...value.data,
      acceptingOrders: !paused,
      version: setting?.version ?? 0,
    };
  }

  async getAvailability() {
    const { acceptingOrders, pausedUntil, reason } = await this.getStatus();
    return {
      acceptingOrders,
      acceptingAsap: acceptingOrders && this.isAsapOpen(),
      asapOpenLocal: this.config.get<string>('ONLINE_ASAP_OPEN_LOCAL', '07:00'),
      asapCloseLocal: this.config.get<string>(
        'ONLINE_ASAP_CLOSE_LOCAL',
        '22:00',
      ),
      timeZone: 'Asia/Ho_Chi_Minh',
      pausedUntil: acceptingOrders ? null : pausedUntil,
      reason: acceptingOrders ? null : reason,
    };
  }

  async assertAccepting(
    tx: ExtendedPrismaTransactionClient,
    scheduled = false,
  ) {
    const status = await this.getStatus(tx);
    if (!status.acceptingOrders) {
      throw new ConflictException('Online ordering is temporarily paused.');
    }
    if (!scheduled && !this.isAsapOpen()) {
      throw new ConflictException({
        code: 'ONLINE_ASAP_CLOSED',
        message:
          'Immediate pickup is outside opening hours. Choose a scheduled slot.',
      });
    }
  }

  private isAsapOpen() {
    const minute = (time: string) =>
      Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const now = new Date();
    const localMinute =
      (now.getUTCHours() * 60 + now.getUTCMinutes() + 420) % 1440;
    return (
      localMinute >=
        minute(this.config.get<string>('ONLINE_ASAP_OPEN_LOCAL', '07:00')) &&
      localMinute <
        minute(this.config.get<string>('ONLINE_ASAP_CLOSE_LOCAL', '22:00'))
    );
  }

  update(employeeId: string, dto: UpdateOnlineOrderIntakeDto) {
    return runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const employee = await tx.employee.findFirst({
          where: { id: employeeId, isActive: true, deletedAt: null },
          select: { id: true },
        });
        if (!employee)
          throw new UnauthorizedException('Employee is inactive or not found.');
        const { expectedVersion, ...value } =
          UpdateOnlineOrderIntakeDto.schema.parse(dto);
        if (value.pausedUntil) {
          const delay = new Date(value.pausedUntil).getTime() - Date.now();
          if (delay <= 0 || delay > 24 * 60 * 60_000) {
            throw new BadRequestException(
              'Pause must expire within the next 24 hours.',
            );
          }
        }
        const before = await this.getStatus(tx);
        if (before.version !== expectedVersion) {
          throw new ConflictException(
            'Online intake was modified by another request.',
          );
        }
        const data = { value, updatedById: employeeId };
        if (expectedVersion === 0) {
          await tx.systemSetting.create({
            data: {
              ...data,
              key: ONLINE_ORDER_INTAKE_SETTING_KEY,
              valueType: SettingValueType.JSON,
              isSystem: true,
              isPublic: false,
            },
          });
        } else {
          const changed = await tx.systemSetting.updateMany({
            where: {
              key: ONLINE_ORDER_INTAKE_SETTING_KEY,
              version: expectedVersion,
              deletedAt: null,
            },
            data: { ...data, version: { increment: 1 } },
          });
          if (changed.count !== 1)
            throw new ConflictException(
              'Online intake was modified by another request.',
            );
        }
        const setting = await tx.systemSetting.findUniqueOrThrow({
          where: { key: ONLINE_ORDER_INTAKE_SETTING_KEY },
        });
        await tx.systemSettingRevision.create({
          data: {
            settingId: setting.id,
            employeeId,
            version: setting.version,
            value,
            valueType: setting.valueType,
            isPublic: setting.isPublic,
          },
        });
        await tx.actionLog.create({
          data: {
            employeeId,
            actionType: 'ONLINE_ORDER_INTAKE_UPDATED',
            details: { before, after: value, version: setting.version },
          },
        });
        return this.getStatus(tx);
      },
      {
        loggerContext: 'Online intake transaction',
        retryUniqueViolations: true,
      },
    );
  }
}
