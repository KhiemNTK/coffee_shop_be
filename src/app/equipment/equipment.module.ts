import { Module } from '@nestjs/common';
import { EquipmentService } from './equipment.service';
import { EquipmentController } from './equipment.controller';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';

@Module({
  imports: [PaginationUtilModule],
  controllers: [EquipmentController],
  providers: [EquipmentService],
})
export class EquipmentModule {}
