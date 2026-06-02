import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Decimal } from '@prisma/client/runtime/library';

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
