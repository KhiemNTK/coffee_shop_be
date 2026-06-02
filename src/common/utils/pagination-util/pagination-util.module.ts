import { Module } from '@nestjs/common';
import { PaginationUtilService } from './pagination-util.service';

@Module({
  providers: [PaginationUtilService],
  exports: [PaginationUtilService],
})
export class PaginationUtilModule {}
