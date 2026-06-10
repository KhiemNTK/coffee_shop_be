import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Decimal } from '@prisma/client/runtime/library';
import { Workbook } from 'exceljs';

@Injectable()
export class DecimalInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(map((data) => this.convertDecimalToNumber(data)));
  }

  private convertDecimalToNumber(data: any): any {
    if (data === null || data === undefined || typeof data !== 'object') {
      return data;
    }

    if (data instanceof Decimal) {
      return data.toNumber();
    }

    // Bypass binary/stream objects to preserve their prototype chain
    if (data instanceof StreamableFile || data instanceof Workbook) {
      return data;
    }

    // handle array
    if (Array.isArray(data)) {
      return data.map((item) => this.convertDecimalToNumber(item));
    }

    if (data instanceof Date) {
      return data;
    }

    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(
      data as Record<string, unknown>,
    )) {
      result[key] = this.convertDecimalToNumber(value);
    }
    return result;
  }
}
