import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../../common/types';

export const REQUIRED_PERMISSIONS_KEY = 'REQUIRED_PERMISSIONS_KEY';

export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
