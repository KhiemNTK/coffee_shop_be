import { Module } from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { EmployeesController } from './employees.controller';
import { PaginationUtilService } from '../../common/utils/pagination-util/pagination-util.service';

@Module({
  controllers: [EmployeesController],
  providers: [EmployeesService, PaginationUtilService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
