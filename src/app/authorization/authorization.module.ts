import { Module } from '@nestjs/common';
import { AuthorizationService } from './authorization.service';
import { PermissionCacheService } from './permission-cache.service';

@Module({
  providers: [AuthorizationService, PermissionCacheService],
  exports: [AuthorizationService],
})
export class AuthorizationModule {}
