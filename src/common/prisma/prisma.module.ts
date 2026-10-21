import { Global, Module, Provider } from '@nestjs/common';
import { PRISMA_SERVICE_TOKEN, PrismaService } from './prisma.service';

const extendedPrismaProvider: Provider = {
  provide: PRISMA_SERVICE_TOKEN,
  inject: [PrismaService],
  useFactory: (prismaService: PrismaService) => {
    return prismaService.getExtendedClient();
  },
};
@Global()
@Module({
  providers: [PrismaService, extendedPrismaProvider],
  exports: [PRISMA_SERVICE_TOKEN],
})
export class PrismaModule {}
