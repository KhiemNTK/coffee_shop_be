import { Module } from '@nestjs/common';
import { SystemSettingsService } from './system-settings.service';
import { SystemSettingsController } from './system-settings.controller';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';

@Module({
  imports: [PaginationUtilModule],
  controllers: [SystemSettingsController],
  providers: [SystemSettingsService],
})
export class SystemSettingsModule {}
