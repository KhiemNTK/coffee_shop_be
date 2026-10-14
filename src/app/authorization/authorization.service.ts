import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
    const [context] = await client.$queryRaw<AuthorizationContext[]>(Prisma.sql`
      SELECT e."id" AS "employeeId", e."email" AS "employeeEmail",
        COALESCE(array_agg(DISTINCT p."key") FILTER (WHERE p."key" IS NOT NULL), ARRAY[]::text[]) AS "permissionKeys",
        COALESCE(array_agg(DISTINCT r."name") FILTER (WHERE r."name" IS NOT NULL), ARRAY[]::text[]) AS "roleNames"
      FROM "Employee" e
      LEFT JOIN "EmployeeRole" er ON er."employeeId" = e."id"
      LEFT JOIN "Role" r ON r."id" = er."roleId" AND r."deletedAt" IS NULL
      LEFT JOIN "RolePermission" rp ON rp."roleId" = r."id"
      LEFT JOIN "Permission" p ON p."id" = rp."permissionId" AND p."deletedAt" IS NULL
      WHERE e."id" = ${employeeId} AND e."isActive" = true AND e."deletedAt" IS NULL
      GROUP BY e."id", e."email"
    `);
    if (!context) {
      throw new UnauthorizedException(AUTH_ERRORS.INACTIVE_EMPLOYEE);
    }
    return {
      ...context,
      permissionKeys: context.permissionKeys.sort(),
      roleNames: context.roleNames.sort(),
    };
  }
}
