import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  type ExtendedPrismaClient,
  PRISMA_SERVICE_TOKEN,
} from '../../common/prisma/prisma.service';
import { AUTH_ERRORS, AUTHORIZATION_ERRORS } from '../../common/consts/message';
import type {
  AuthorizationContext,
  ExtendedPrismaTransactionClient,
  PermissionKey,
} from '../../common/types';

@Injectable()
export class AuthorizationService {
  constructor(
    @Inject(PRISMA_SERVICE_TOKEN)
    private readonly prisma: ExtendedPrismaClient,
  ) {}

  async getAuthorizationContext(
    employeeId: string,
  ): Promise<AuthorizationContext> {
    // Grants are authoritative in PostgreSQL; an in-flight cache fill can undo revocation.
    return this.getFreshAuthorizationContext(employeeId);
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

  canGrantPermissions(context: AuthorizationContext, keys: readonly string[]) {
    const granted = new Set<string>(context.permissionKeys);
    return keys.every((key) => granted.has(key));
  }

  assertCanGrantPermissions(
    context: AuthorizationContext,
    keys: readonly string[],
  ) {
    if (!this.canGrantPermissions(context, keys)) {
      throw new ForbiddenException(AUTHORIZATION_ERRORS.GRANT_OUTSIDE_SCOPE);
    }
  }

  async getFreshAuthorizationContext(
    employeeId: string,
    client: ExtendedPrismaTransactionClient = this.prisma,
  ): Promise<AuthorizationContext> {
    const employee = await client.employee.findUnique({
      where: { id: employeeId, deletedAt: null },
      select: {
        id: true,
        email: true,
        isActive: true,
        deletedAt: true,
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

    if (!employee || !employee.isActive || employee.deletedAt) {
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
