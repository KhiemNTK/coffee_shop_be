import { Global, Module } from '@nestjs/common';
import { QueryUtilService } from './query-util.service';

@Global()
@Module({
  providers: [QueryUtilService],
  exports: [QueryUtilService],
})
export class QueryUtilModule {}
