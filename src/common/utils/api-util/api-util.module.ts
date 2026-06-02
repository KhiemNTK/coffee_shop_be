import { Module } from '@nestjs/common';
import { ApiUtilService } from './api-util.service';

@Module({
  providers: [ApiUtilService],
  exports: [ApiUtilService],
})
export class ApiUtilModule {}
