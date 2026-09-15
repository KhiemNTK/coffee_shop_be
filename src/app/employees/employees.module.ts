import { Module } from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { EmployeesController } from './employees.controller';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { StringUtilModule } from '../../common/utils/string-util/string-util.module';

@Module({
  imports: [AuthorizationModule, PaginationUtilModule, StringUtilModule],
  controllers: [EmployeesController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
