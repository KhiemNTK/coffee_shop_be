import { Injectable } from '@nestjs/common';
import { ZodSerializationException, ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';

export type ZodErrorItem = {
  message: string;
  fields: string[];
};

@Injectable()
export class ZodExceptionService {
  private convertZodExceptions(zodError: ZodError): ZodErrorItem[] {
    const groupedIssues = zodError.issues.reduce<Record<string, string[]>>(
      (acc, issue) => {
        const message = issue.message;
        const field = issue.path.length > 0 ? issue.path.join('.') : undefined;

        const currentFields = acc[message] ?? [];

        if (field !== undefined) {
          currentFields.push(field);
        }

        acc[message] = currentFields;

        return acc;
      },
      {},
    );

    return Object.entries(groupedIssues).map(([message, fields]) => ({
      message,
      fields,
    }));
  }

  parseError(
    exception: ZodValidationException | ZodSerializationException,
  ): ZodErrorItem[] | null {
    const zodError = exception.getZodError();

    if (!(zodError instanceof ZodError)) {
      return null;
    }

    return this.convertZodExceptions(zodError);
  }
}
