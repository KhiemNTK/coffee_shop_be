import type { FormatResponseParams } from '../../types';

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
