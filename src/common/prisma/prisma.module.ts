import { Global, Module, Provider } from '@nestjs/common';
import { PRISMA_SERVICE_TOKEN, PrismaService } from './prisma.service';
import { DateUtilModule } from '../utils/date-util/date-util.module';
import { StringUtilModule } from '../utils/string-util/string-util.module';

const extendedPrismaProvider: Provider = {
  provide: PRISMA_SERVICE_TOKEN,
  inject: [PrismaService],
  useFactory: (prismaService: PrismaService) => {
    return prismaService.getExtendedClient();
  },
};
@Global()
@Module({
  imports: [DateUtilModule, StringUtilModule],
  providers: [PrismaService, extendedPrismaProvider],
  exports: [PRISMA_SERVICE_TOKEN],
})
export class PrismaModule {}
