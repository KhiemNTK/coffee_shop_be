import { Module } from '@nestjs/common';
import { ExcelUtilService } from './excel-util.service';

@Module({
  providers: [ExcelUtilService],
  exports: [ExcelUtilService],
})
export class ExcelUtilModule {}
