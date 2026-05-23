import { Module } from '@nestjs/common';
import { StringUtilService } from './string-util.service';

@Module({
  providers: [StringUtilService],
  exports: [StringUtilService],
})
export class StringUtilModule {}
