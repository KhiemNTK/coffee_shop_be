import { Module } from '@nestjs/common';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';
import { ExcelUtilModule } from '../../common/utils/excel-util/excel-util.module';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';
import { DateUtilModule } from '../../common/utils/date-util/date-util.module';
@Module({
  imports: [ExcelUtilModule, DateUtilModule],
  controllers: [RolesController],
  providers: [RolesService, PaginationUtilService],
})
export class RolesModule {}
