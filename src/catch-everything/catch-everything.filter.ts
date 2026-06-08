import {
  ExceptionFilter,
  Catch,
  HttpStatus,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ZodExceptionService } from './zod-exception/zod-exception.service';
import { ZodSerializationException, ZodValidationException } from 'nestjs-zod';
import { ApiUtilService } from '../common/utils/api-util/api-util.service';
import { Prisma } from '@prisma/client';

interface ErrorItem {
  message: string;
  fields?: (string | number)[];
}

const PRISMA_ERROR_MAP: Record<
  string,
  { status: HttpStatus; message: string }
> = {
  P2002: {
    status: HttpStatus.CONFLICT,
    message: 'Data already exists in the system.',
  },
  P2025: { status: HttpStatus.NOT_FOUND, message: 'Requested data not found.' },
  P2003: { status: HttpStatus.BAD_REQUEST, message: 'Invalid related data.' },
  P2014: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Operation violates data constraints.',
  },
};

@Catch()
export class CatchEverythingFilter implements ExceptionFilter {
  private readonly logger = new Logger(CatchEverythingFilter.name);

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly zodExceptionService: ZodExceptionService,
    private readonly apiUtilService: ApiUtilService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest();

    const response = ctx.getResponse();
    const method = httpAdapter.getRequestMethod(request);
    const url = httpAdapter.getRequestUrl(request);
    const reqContext = `${method} ${url}`;

    const { status, errors } = this.resolveException(exception, reqContext);
    const responseBody = this.apiUtilService.formatResponse({ errors });

    httpAdapter.reply(response, responseBody, status);
  }

  private resolveException(
    exception: unknown,
    reqContext: string,
  ): { status: HttpStatus; errors: ErrorItem[] } {
    if (exception instanceof ZodValidationException) {
      return {
        status: HttpStatus.BAD_REQUEST,
        errors: this.zodExceptionService.parseError(exception) ?? [
          { message: 'Validation error.' },
        ],
      };
    }

    if (exception instanceof ZodSerializationException) {
      this.logger.error(
        `[ZodSerializationException] ${reqContext}`,
        exception.getZodError(),
      );
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        errors: [{ message: 'Internal Server Error.' }],
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.resolvePrismaKnownError(exception, reqContext);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      this.logger.warn(
        `[PrismaClientValidationError] ${reqContext}: ${exception.message}`,
      );
      return {
        status: HttpStatus.BAD_REQUEST,
        errors: [{ message: 'Invalid database query parameters.' }],
      };
    }

    if (
      exception instanceof Prisma.PrismaClientInitializationError ||
      exception instanceof Prisma.PrismaClientRustPanicError
    ) {
      this.logger.error(
        `[Prisma DB Infrastructure Error] ${reqContext}`,
        exception.message,
      );
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        errors: [{ message: 'Database connection error.' }],
      };
    }

    if (exception instanceof HttpException) {
      return this.resolveHttpException(exception, reqContext);
    }

    if (exception instanceof Error) {
      this.logger.error(
        `[Unhandled Exception] ${reqContext} - ${exception.message}`,
        exception.stack,
      );
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        errors: [{ message: 'Internal Server Error.' }],
      };
    }

    this.logger.error(`[Unknown Exception] ${reqContext}`, exception);

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      errors: [{ message: 'Internal Server Error.' }],
    };
  }

  private resolvePrismaKnownError(
    exception: Prisma.PrismaClientKnownRequestError,
    reqContext: string,
  ): { status: HttpStatus; errors: ErrorItem[] } {
    const mapped = PRISMA_ERROR_MAP[exception.code];

    if (!mapped) {
      this.logger.warn(
        `Unhandled Prisma error [${exception.code}] at ${reqContext}: ${exception.message}`,
      );
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        errors: [{ message: 'An unexpected database error occurred.' }],
      };
    }

    this.logger.warn(
      `[Prisma ${exception.code}] ${reqContext} - Target: ${JSON.stringify(exception.meta?.target)}`,
    );

    return {
      status: mapped.status,
      errors: [{ message: this.buildPrismaMessage(exception, mapped.message) }],
    };
  }

  private resolveHttpException(
    exception: HttpException,
    reqContext: string,
  ): {
    status: HttpStatus;
    errors: ErrorItem[];
  } {
    const status = exception.getStatus();

    if (status >= 500) {
      this.logger.error(
        `[HttpException 5xx] ${reqContext} - ${exception.message}`,
        exception.stack,
      );
      return {
        status,
        errors: [{ message: 'Internal Server Error.' }],
      };
    }

    const response = exception.getResponse();

    if (typeof response === 'string') {
      return { status, errors: [{ message: response }] };
    }

    if (
      typeof response === 'object' &&
      response !== null &&
      'message' in response
    ) {
      const message = (response as any).message;

      return {
        status,
        errors: Array.isArray(message)
          ? message.map((m: string) => ({ message: m }))
          : [
              {
                message:
                  typeof message === 'string' ? message : exception.message,
              },
            ],
      };
    }

    return { status, errors: [{ message: exception.message }] };
  }

  private buildPrismaMessage(
    exception: Prisma.PrismaClientKnownRequestError,
    baseMessage: string,
  ): string {
    const meta = exception.meta;

    if (!meta || !meta.target) return baseMessage;

    const target = meta.target;

    if (Array.isArray(target) && target.length > 0) {
      return `${baseMessage} (Field: ${target.join(', ')})`;
    }

    if (typeof target === 'string') {
      return `${baseMessage} (Field: ${target})`;
    }

    return baseMessage;
  }
}
