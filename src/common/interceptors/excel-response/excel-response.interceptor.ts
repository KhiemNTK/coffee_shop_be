import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { DateUtilService } from '../../utils/date-util/date-util.service';
import { switchMap } from 'rxjs/operators';
import { Workbook } from 'exceljs';

@Injectable()
export class ExcelResponseInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ExcelResponseInterceptor.name);

  constructor(private dateUtilService: DateUtilService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const fileName = context
      .getClass()
      .name.replace('Controller', '')
      .toLowerCase();

    const currentDate = this.dateUtilService
      .getCurrentDate('en-CA', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour12: false,
      })
      .replaceAll('-', '_');

    return next.handle().pipe(
      switchMap(async (data) => {
        if (data instanceof Workbook) {
          try {
            const buffer = await data.xlsx.writeBuffer();
            const nodeBuffer = Buffer.from(buffer);
            const fileSize = nodeBuffer.length;

            const fullFileName = `${fileName}_${currentDate}.xlsx`;

            this.logger.log(
              `Excel export: ${fullFileName} (${fileSize} bytes)`,
            );
            return new StreamableFile(Buffer.from(buffer), {
              type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              disposition: `attachment; filename="${fullFileName}"`,
            });
          } catch (error) {
            this.logger.error(
              `Failed to generate Excel buffer: ${error instanceof Error ? error.message : error}`,
            );
            throw error;
          }
        }

        return data;
      }),
    );
  }
}
