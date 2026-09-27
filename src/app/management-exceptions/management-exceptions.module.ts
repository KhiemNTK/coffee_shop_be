import { Module } from '@nestjs/common';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { ManagementExceptionsController } from './management-exceptions.controller';
import { ManagementExceptionsService } from './management-exceptions.service';

@Module({
  imports: [PaginationUtilModule],
  controllers: [ManagementExceptionsController],
  providers: [ManagementExceptionsService],
})
export class ManagementExceptionsModule {}
