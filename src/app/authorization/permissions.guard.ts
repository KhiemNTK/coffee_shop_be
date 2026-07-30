import { Request } from 'express';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_SKIP_AUTH } from '../auth/auth.decorator';
import type { EmployeeInfo, PermissionKey } from '../../common/types';
import { AUTHORIZATION_ERRORS } from '../../common/consts/message';
import { AuthorizationService } from './authorization.service';
import { REQUIRED_PERMISSIONS_KEY } from './authorization.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorizationService: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isSkipAuth = this.reflector.getAllAndOverride<boolean>(IS_SKIP_AUTH, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isSkipAuth) return true;

    const requiredPermissions =
      this.reflector.getAllAndOverride<PermissionKey[]>(
        REQUIRED_PERMISSIONS_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? [];

    if (requiredPermissions.length === 0) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { employee?: EmployeeInfo }>();
    const employeeId = req.employee?.employeeId;
    if (!employeeId) {
      throw new ForbiddenException(AUTHORIZATION_ERRORS.PERMISSION_DENIED);
    }

    const contextData =
      await this.authorizationService.getAuthorizationContext(employeeId);
    req.employee = {
      ...req.employee,
      permissionKeys: contextData.permissionKeys,
      roleNames: contextData.roleNames,
    } as EmployeeInfo;

    const permissionSet = new Set(contextData.permissionKeys);
    const hasPermissions = requiredPermissions.every((permission) =>
      permissionSet.has(permission),
    );

    if (!hasPermissions) {
      throw new ForbiddenException(AUTHORIZATION_ERRORS.PERMISSION_DENIED);
    }

    return true;
  }
}
