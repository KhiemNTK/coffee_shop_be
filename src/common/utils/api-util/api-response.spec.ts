import { formatApiResponse } from './api-response';

describe('formatApiResponse', () => {
  it('keeps the default response for empty results', () => {
    expect(formatApiResponse({})).toEqual({
      errors: null,
      data: null,
      message: 'OK',
    });
  });

  it.each([false, 0, '', [], { id: 'order-id' }].map((data) => ({ data })))(
    'preserves data without coercion (%#)',
    ({ data }) => {
      expect(formatApiResponse({ data })).toEqual({
        errors: null,
        data,
        message: 'OK',
      });
    },
  );

  it('preserves explicit messages and the existing data-message precedence', () => {
    expect(formatApiResponse({ message: 'Accepted' }).message).toBe('Accepted');
    expect(
      formatApiResponse({ data: { message: 'Created' }, message: 'OK' })
        .message,
    ).toBe('Created');
    expect(
      formatApiResponse({ data: { message: '' }, message: 'Fallback' }).message,
    ).toBe('Fallback');
  });

  it('keeps error codes, request IDs and error details unchanged', () => {
    const errors = [{ message: 'Not enough stock.', fields: ['quantity'] }];
    expect(
      formatApiResponse({
        errors,
        code: 'INVENTORY_INSUFFICIENT_STOCK',
        requestId: 'request-id',
      }),
    ).toEqual({
      errors,
      data: null,
      message: 'ERROR',
      code: 'INVENTORY_INSUFFICIENT_STOCK',
      requestId: 'request-id',
    });
  });
});
