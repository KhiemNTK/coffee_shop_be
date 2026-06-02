import {
  ExceptionFilter,
  Catch,
  HttpStatus,
  ArgumentsHost,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ZodExceptionFilter } from './zod-exception/zod-exception.filter';
import { ZodSerializationException, ZodValidationException } from 'nestjs-zod';
import { ApiUtilService } from '../common/utils/api-util/api-util.service';

@Catch()
export class CatchEverythingFilter implements ExceptionFilter {
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly zodFilter: ZodExceptionFilter,
    private apiUtilService: ApiUtilService,
  ) {}

  catch(exception: any, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();

    const exceptionValue: {
      status: number;
      exceptions: any;
    } = {
      status: exception.getStatus?.() ?? HttpStatus.INTERNAL_SERVER_ERROR,
      exceptions: [{ message: exception.message ?? exception.error?.message }],
    };

    if (
      exception instanceof ZodValidationException ||
      exception instanceof ZodSerializationException
    ) {
      const zodErrors = this.zodFilter.catch(exception);
      if (zodErrors) {
        exceptionValue.exceptions = zodErrors;
        exceptionValue.status = HttpStatus.BAD_REQUEST;
      }
    }

    const responseBody = this.apiUtilService.formatResponse({
      errors: exceptionValue.exceptions,
    });

    httpAdapter.reply(ctx.getResponse(), responseBody, exceptionValue.status);
  }
}
