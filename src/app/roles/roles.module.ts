import { Module } from '@nestjs/common';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';
import { ExcelUtilModule } from '../../common/utils/excel-util/excel-util.module';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { DateUtilModule } from '../../common/utils/date-util/date-util.module';
import { AuthorizationModule } from '../authorization/authorization.module';
@Module({
  imports: [
    AuthorizationModule,
    ExcelUtilModule,
    DateUtilModule,
    PaginationUtilModule,
  ],
  controllers: [RolesController],
  providers: [RolesService],
})
export class RolesModule {}
