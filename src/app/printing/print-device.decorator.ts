import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedPrintDevice } from '../../common/types';

export const CurrentPrintDevice = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const request = context
      .switchToHttp()
      .getRequest<Request & { printDevice?: AuthenticatedPrintDevice }>();
    if (!request.printDevice) {
      throw new InternalServerErrorException(
        'Authenticated print device context is missing.',
      );
    }
    return request.printDevice;
  },
);
