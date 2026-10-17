import { Module } from '@nestjs/common';
import { MenuService } from './menu.service';
import { MenuController } from './menu.controller';
import { MenuImagesService } from './menu-images.service';
import { PaginationUtilModule } from '../../common/utils/pagination-util/pagination-util.module';

@Module({
  imports: [PaginationUtilModule],
  controllers: [MenuController],
  providers: [MenuService, MenuImagesService],
})
export class MenuModule {}
