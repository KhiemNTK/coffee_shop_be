import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { PRISMA_SERVICE_TOKEN } from '../../common/prisma/prisma.service';
import { AUTH_ERRORS } from '../../common/consts/message';
import type { AuthorizationContext, PermissionKey } from '../../common/types';
import { PermissionCacheService } from './permission-cache.service';

@Injectable()
export class AuthorizationService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
    private readonly permissionCacheService: PermissionCacheService,
  ) {}

  async getAuthorizationContext(
    employeeId: string,
  ): Promise<AuthorizationContext> {
    const cached = await this.permissionCacheService.get(employeeId);
    if (cached) return cached;

    const context = await this.loadAuthorizationContext(employeeId);
    await this.permissionCacheService.set(employeeId, context);
    return context;
  }

  async getPermissionKeys(employeeId: string): Promise<PermissionKey[]> {
    const context = await this.getAuthorizationContext(employeeId);
    return context.permissionKeys;
  }

  async employeeHasPermissions(
    employeeId: string,
    requiredPermissions: PermissionKey[],
  ) {
    if (requiredPermissions.length === 0) return true;

    const permissions = await this.getPermissionKeys(employeeId);
    const permissionSet = new Set(permissions);
    return requiredPermissions.every((permission) =>
      permissionSet.has(permission),
    );
  }

  async invalidateEmployee(employeeId: string) {
    await this.permissionCacheService.invalidateEmployee(employeeId);
  }

  async invalidateAll() {
    await this.permissionCacheService.invalidateAll();
  }

  private async loadAuthorizationContext(
    employeeId: string,
  ): Promise<AuthorizationContext> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        email: true,
        isActive: true,
        employeeRoles: {
          where: {
            role: { deletedAt: null },
          },
          select: {
            role: {
              select: {
                name: true,
                rolePermissions: {
                  where: {
                    permission: { deletedAt: null },
                  },
                  select: {
                    permission: {
                      select: { key: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!employee || !employee.isActive) {
      throw new UnauthorizedException(AUTH_ERRORS.INACTIVE_EMPLOYEE);
    }

    const permissionKeys = new Set<PermissionKey>();
    const roleNames = new Set<string>();

    for (const employeeRole of employee.employeeRoles) {
      roleNames.add(employeeRole.role.name);
      for (const rolePermission of employeeRole.role.rolePermissions) {
        permissionKeys.add(rolePermission.permission.key as PermissionKey);
      }
    }

    return {
      employeeId: employee.id,
      employeeEmail: employee.email,
      permissionKeys: [...permissionKeys].sort(),
      roleNames: [...roleNames].sort(),
    };
  }
}
