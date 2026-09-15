import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiExtension } from '@nestjs/swagger';
import type { PermissionKey } from '../../common/types';

export const REQUIRED_PERMISSIONS_KEY = 'REQUIRED_PERMISSIONS_KEY';

export const RequirePermissions = (...permissions: PermissionKey[]) =>
  applyDecorators(
    SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions),
    ApiBearerAuth(),
    ApiCookieAuth('accessCookie'),
    ApiExtension('x-required-permissions', permissions),
  );
