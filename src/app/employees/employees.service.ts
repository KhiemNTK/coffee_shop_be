import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import {
  type ExtendedPrismaClient,
  PRISMA_SERVICE_TOKEN,
} from '../../common/prisma/prisma.service';
import { AUTH_ERRORS, AUTHORIZATION_ERRORS } from '../../common/consts/message';
import { AuthorizationService } from '../authorization/authorization.service';
import {
  PermissionKeys,
  SYSTEM_ROLE_NAMES,
} from '../../common/consts/permission-keys';
import type {
  AuthorizationContext,
  ExtendedPrismaTransactionClient,
} from '../../common/types';
import { runSerializableTransaction } from '../../common/prisma/transaction.util';
import { StringUtilService } from '../../common/utils/string-util/string-util.service';
import {
  CreateEmployeeDto,
  GetEmployeesPaginationDto,
  ReplaceEmployeeRolesDto,
  UpdateEmployeeDto,
} from './dto';

const EMPLOYEE_PUBLIC_SELECT = {
  id: true,
  email: true,
  avatarUrl: true,
  fullName: true,
  address: true,
  phoneNumber: true,
  username: true,
  salary: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  positionId: true,
} satisfies Prisma.EmployeeSelect;

const EMPLOYEE_PUBLIC_FIELDS = new Set(Object.keys(EMPLOYEE_PUBLIC_SELECT));
const EMPLOYEE_ACCESS_SELECT = {
  id: true,
  email: true,
  fullName: true,
  isActive: true,
  deletedAt: true,
  employeeRoles: {
    where: { role: { deletedAt: null } },
    select: {
      role: {
        select: {
          id: true,
          name: true,
          description: true,
          isSystemRole: true,
          rolePermissions: {
            where: { permission: { deletedAt: null } },
            select: { permission: { select: { key: true } } },
          },
        },
      },
    },
  },
} satisfies Prisma.EmployeeSelect;

@Injectable()
export class EmployeesService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private paginationUtilService: PaginationUtilService,
    private authorizationService: AuthorizationService,
    private readonly stringUtilService: StringUtilService,
  ) {}

  async createEmployee(createEmployeeDto: CreateEmployeeDto) {
    const password = await this.stringUtilService.hash(
      createEmployeeDto.password,
    );
    return this.prisma.employee.create({
      data: { ...createEmployeeDto, password },
      select: EMPLOYEE_PUBLIC_SELECT,
    });
  }

  async getEmployee(where: Prisma.EmployeeWhereUniqueInput) {
    const data = await this.prisma.employee.findUnique({
      where,
    });
    return data;
  }

  async getEmployees({
    page,
    itemPerPage,
    select,
    search,
    isActive,
    positionId,
  }: GetEmployeesPaginationDto) {
    const fieldsSelect = this.getPublicSelect(select);
    const searchQuery: Prisma.EmployeeWhereInput = {
      deletedAt: null,
      ...(isActive === undefined ? {} : { isActive }),
      ...(positionId ? { positionId } : {}),
      ...(search
        ? {
            OR: ['fullName', 'username', 'email'].map((field) => ({
              [field]: { contains: search, mode: 'insensitive' },
            })),
          }
        : {}),
    };
    const totalItems = await this.prisma.employee.count({
      where: searchQuery,
    });
    const paging = this.paginationUtilService.paging({
      page,
      itemPerPage,
      totalItems,
    });
    const employee = this.prisma
      .employee as unknown as PrismaClient['employee'];
    const list = await employee.findMany({
      select: fieldsSelect,
      skip: paging.skip,
      take: paging.itemPerPage,
      where: searchQuery,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });

    const data = paging.format(list);
    return data;
  }

  async getEmployeeById(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      select: {
        ...EMPLOYEE_PUBLIC_SELECT,
        position: true,
        employeeRoles: {
          include: { role: true },
        },
      },
    });

    if (!employee) {
      throw new NotFoundException(AUTH_ERRORS.USER_NOT_FOUND);
    }

    return employee;
  }

  async updateEmployee(
    id: string,
    updateEmployeeDto: UpdateEmployeeDto,
    actorId: string,
  ) {
    const password = updateEmployeeDto.password
      ? await this.stringUtilService.hash(updateEmployeeDto.password)
      : undefined;

    const employee = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const actor =
          await this.authorizationService.getFreshAuthorizationContext(
            actorId,
            tx,
          );
        this.authorizationService.assertCanGrantPermissions(actor, [
          PermissionKeys.EMPLOYEES_UPDATE,
        ]);
        const before = await this.loadManagedEmployee(tx, id, actor);
        if (updateEmployeeDto.isActive === false) {
          if (id === actorId)
            throw new ForbiddenException(
              AUTHORIZATION_ERRORS.SELF_ACCESS_CHANGE,
            );
          await this.assertOwnerRemains(tx, before);
        }
        const updated = await tx.employee.update({
          where: { id, deletedAt: null },
          data: {
            ...updateEmployeeDto,
            ...(password ? { password } : {}),
          },
          select: EMPLOYEE_PUBLIC_SELECT,
        });
        const credentialsChanged =
          Boolean(password) ||
          (updateEmployeeDto.email !== undefined &&
            updateEmployeeDto.email !== before.email);
        if (updateEmployeeDto.isActive === false || credentialsChanged) {
          await tx.authSession.updateMany({
            where: { employeeId: id, revokedAt: null },
            data: {
              revokedAt: new Date(),
              revokeReason:
                updateEmployeeDto.isActive === false
                  ? 'EMPLOYEE_DISABLED'
                  : 'CREDENTIALS_CHANGED',
            },
          });
          await tx.passwordResetToken.updateMany({
            where: { employeeId: id, usedAt: null },
            data: { usedAt: new Date() },
          });
        }
        await tx.actionLog.create({
          data: {
            employeeId: actorId,
            actionType: 'EMPLOYEE_UPDATED',
            details: {
              employeeId: id,
              changedFields: Object.keys(updateEmployeeDto),
              before: { isActive: before.isActive },
              after: { isActive: updated.isActive },
            },
          },
        });
        return updated;
      },
    );
    return employee;
  }

  async deleteEmployee(id: string, actorId: string) {
    await runSerializableTransaction(this.prisma, async (tx) => {
      const actor =
        await this.authorizationService.getFreshAuthorizationContext(
          actorId,
          tx,
        );
      this.authorizationService.assertCanGrantPermissions(actor, [
        PermissionKeys.EMPLOYEES_DELETE,
      ]);
      if (id === actorId)
        throw new ForbiddenException(AUTHORIZATION_ERRORS.SELF_ACCESS_CHANGE);
      const before = await this.loadManagedEmployee(tx, id, actor);
      await this.assertOwnerRemains(tx, before);
      await tx.authSession.updateMany({
        where: { employeeId: id, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokeReason: 'EMPLOYEE_DELETED',
        },
      });
      await tx.passwordResetToken.updateMany({
        where: { employeeId: id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.employeeRole.deleteMany({ where: { employeeId: id } });
      await tx.employee.update({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date(), isActive: false },
      });
      await tx.actionLog.create({
        data: {
          employeeId: actorId,
          actionType: 'EMPLOYEE_DELETED',
          details: {
            employeeId: id,
            beforeRoleIds: before.employeeRoles.map((item) => item.role.id),
          },
        },
      });
    });

    return {
      success: true,
      message: `Employee #${id} has been deleted successfully`,
    };
  }

  async getEmployeeRoles(id: string, actorId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id, deletedAt: null },
      select: EMPLOYEE_ACCESS_SELECT,
    });
    if (!employee) throw new NotFoundException(AUTH_ERRORS.USER_NOT_FOUND);
    const actor =
      await this.authorizationService.getFreshAuthorizationContext(actorId);
    const currentKeys = employee.employeeRoles.flatMap((item) =>
      item.role.rolePermissions.map((entry) => entry.permission.key),
    );
    const canManageRoles =
      employee.isActive &&
      id !== actorId &&
      this.authorizationService.canGrantPermissions(actor, [
        PermissionKeys.EMPLOYEE_ROLES_UPDATE,
        ...currentKeys,
      ]);
    const roles = canManageRoles
      ? await this.prisma.role.findMany({
          where: { deletedAt: null },
          select: {
            id: true,
            rolePermissions: {
              where: { permission: { deletedAt: null } },
              select: { permission: { select: { key: true } } },
            },
          },
        })
      : [];
    return {
      id: employee.id,
      email: employee.email,
      fullName: employee.fullName,
      isActive: employee.isActive,
      employeeRoles: employee.employeeRoles.map(({ role }) => ({
        role: {
          id: role.id,
          name: role.name,
          description: role.description,
          isSystemRole: role.isSystemRole,
        },
      })),
      canManageRoles,
      assignableRoleIds: roles
        .filter((role) =>
          this.authorizationService.canGrantPermissions(
            actor,
            role.rolePermissions.map((entry) => entry.permission.key),
          ),
        )
        .map((role) => role.id),
    };
  }

  async replaceEmployeeRoles(
    id: string,
    { roleIds }: ReplaceEmployeeRolesDto,
    actorId: string,
  ) {
    const uniqueRoleIds = [...new Set(roleIds)];
    if (uniqueRoleIds.length !== roleIds.length) {
      throw new BadRequestException(AUTHORIZATION_ERRORS.DUPLICATE_ROLE_IDS);
    }

    await runSerializableTransaction(this.prisma, async (tx) => {
      const actor =
        await this.authorizationService.getFreshAuthorizationContext(
          actorId,
          tx,
        );
      this.authorizationService.assertCanGrantPermissions(actor, [
        PermissionKeys.EMPLOYEE_ROLES_UPDATE,
      ]);
      if (id === actorId)
        throw new ForbiddenException(AUTHORIZATION_ERRORS.SELF_ACCESS_CHANGE);
      const employee = await this.loadManagedEmployee(tx, id, actor);
      if (!employee.isActive)
        throw new BadRequestException(AUTH_ERRORS.INACTIVE_EMPLOYEE);
      const roles = await tx.role.findMany({
        where: { id: { in: uniqueRoleIds }, deletedAt: null },
        select: {
          id: true,
          name: true,
          isSystemRole: true,
          rolePermissions: {
            where: { permission: { deletedAt: null } },
            select: { permission: { select: { key: true } } },
          },
        },
      });
      if (roles.length !== uniqueRoleIds.length) {
        throw new BadRequestException(AUTHORIZATION_ERRORS.INVALID_ROLE_IDS);
      }
      this.authorizationService.assertCanGrantPermissions(
        actor,
        roles.flatMap((role) =>
          role.rolePermissions.map((entry) => entry.permission.key),
        ),
      );
      const beforeIds = employee.employeeRoles
        .map((item) => item.role.id)
        .sort();
      if (
        beforeIds.length === uniqueRoleIds.length &&
        beforeIds.every((roleId) => uniqueRoleIds.includes(roleId))
      )
        return;
      if (
        !roles.some(
          (role) => role.isSystemRole && role.name === SYSTEM_ROLE_NAMES.OWNER,
        )
      ) {
        await this.assertOwnerRemains(tx, employee);
      }
      await tx.employeeRole.deleteMany({ where: { employeeId: id } });
      if (uniqueRoleIds.length > 0) {
        await tx.employeeRole.createMany({
          data: uniqueRoleIds.map((roleId) => ({ employeeId: id, roleId })),
          skipDuplicates: true,
        });
      }
      await tx.actionLog.create({
        data: {
          employeeId: actorId,
          actionType: 'EMPLOYEE_ROLES_REPLACED',
          details: {
            employeeId: id,
            beforeRoleIds: beforeIds,
            afterRoleIds: [...uniqueRoleIds].sort(),
          },
        },
      });
    });

    return this.getEmployeeRoles(id, actorId);
  }

  private async loadManagedEmployee(
    tx: ExtendedPrismaTransactionClient,
    id: string,
    actor: AuthorizationContext,
  ) {
    const employee = await tx.employee.findUnique({
      where: { id, deletedAt: null },
      select: EMPLOYEE_ACCESS_SELECT,
    });
    if (!employee) throw new NotFoundException(AUTH_ERRORS.USER_NOT_FOUND);
    this.authorizationService.assertCanGrantPermissions(
      actor,
      employee.employeeRoles.flatMap((item) =>
        item.role.rolePermissions.map((entry) => entry.permission.key),
      ),
    );
    return employee;
  }

  private async assertOwnerRemains(
    tx: ExtendedPrismaTransactionClient,
    employee: Prisma.EmployeeGetPayload<{
      select: typeof EMPLOYEE_ACCESS_SELECT;
    }>,
  ) {
    if (
      !employee.isActive ||
      !employee.employeeRoles.some(
        (item) =>
          item.role.isSystemRole && item.role.name === SYSTEM_ROLE_NAMES.OWNER,
      )
    )
      return;
    const others = await tx.employee.count({
      where: {
        id: { not: employee.id },
        isActive: true,
        deletedAt: null,
        employeeRoles: {
          some: {
            role: {
              name: SYSTEM_ROLE_NAMES.OWNER,
              isSystemRole: true,
              deletedAt: null,
            },
          },
        },
      },
    });
    if (others === 0)
      throw new ForbiddenException(AUTHORIZATION_ERRORS.LAST_OWNER);
  }

  private getPublicSelect(select?: string): Prisma.EmployeeSelect {
    if (!select?.trim()) return EMPLOYEE_PUBLIC_SELECT;

    const fields = [
      ...new Set(
        select
          .split(',')
          .map((field) => field.trim())
          .filter((field) => EMPLOYEE_PUBLIC_FIELDS.has(field)),
      ),
    ];
    if (fields.length === 0) {
      throw new BadRequestException('No selectable employee fields requested.');
    }

    return Object.fromEntries(fields.map((field) => [field, true]));
  }
}
