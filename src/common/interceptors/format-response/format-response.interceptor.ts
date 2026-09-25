import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
import { Observable, map } from 'rxjs';
import { Workbook } from 'exceljs';
import { ApiUtilService } from '../../utils/api-util/api-util.service';

@Injectable()
export class FormatResponseInterceptor implements NestInterceptor {
  constructor(private apiUtilService: ApiUtilService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (Reflect.getMetadata(SSE_METADATA, context.getHandler())) {
      return next.handle();
    }
    return next.handle().pipe(
      map((data) => {
        if (data instanceof StreamableFile || data instanceof Workbook) {
          return data;
        }
        return this.apiUtilService.formatResponse({ data });
      }),
    );
  }
}
