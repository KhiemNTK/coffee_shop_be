import { Module } from '@nestjs/common';
import { PositionsService } from './positions.service';
import { PositionsController } from './positions.controller';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';

@Module({
  controllers: [PositionsController],
  providers: [PositionsService, PaginationUtilService],
  exports: [PositionsService],
})
export class PositionsModule {}
