import { Injectable } from '@nestjs/common';
import { FormatResponseParams } from './dto/api-util.dto';

export function formatApiResponse({
  errors = null,
  data = null,
  message = 'OK',
  ...params
}: FormatResponseParams) {
  const messageData = data?.message;
  const messageDefault = errors ? 'ERROR' : message;
  const messageResponse = messageData ? messageData : messageDefault;
  return {
    errors,
    data,
    message: messageResponse,
    ...params,
  };
}

@Injectable()
export class ApiUtilService {
  formatResponse(params: FormatResponseParams) {
    return formatApiResponse(params);
  }
}
