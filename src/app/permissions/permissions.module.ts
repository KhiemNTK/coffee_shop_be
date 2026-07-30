import { Module } from '@nestjs/common';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';

@Module({
  imports: [AuthorizationModule, PaginationUtilModule],
  controllers: [PermissionsController],
  providers: [PermissionsService],
})
export class PermissionsModule {}
