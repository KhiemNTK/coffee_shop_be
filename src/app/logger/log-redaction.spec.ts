import { redactLogValue } from './log-redaction';

describe('redactLogValue', () => {
  it('redacts nested credentials and payment data by key', () => {
    expect(
      redactLogValue({
        employeeId: 'employee-1',
        password: 'plain-text',
        headers: { authorization: 'Bearer credential', cookie: 'session=abc' },
        paymentDetails: { cardNumber: '4111111111111111' },
      }),
    ).toEqual({
      employeeId: 'employee-1',
      password: '[REDACTED]',
      headers: {
        authorization: '[REDACTED]',
        cookie: '[REDACTED]',
      },
      paymentDetails: '[REDACTED]',
    });
  });

  it('redacts credentials embedded in error text', () => {
    expect(
      redactLogValue('Request failed: refresh_token=abc123 password: hunter2'),
    ).toBe('Request failed: refresh_token=[REDACTED] password: [REDACTED]');
  });

  it.each([
    'Authorization: Bearer fixture-credential',
    'Authorization: Basic fixture-credential',
    'Bearer fixture-credential',
    '{"password":"fixture-credential with spaces","accessToken":"fixture-credential"}',
    "request failed: api_key='fixture-credential with spaces'",
    'connect postgresql://operator:fixture-credential@localhost/shop',
    'https://api.telegram.org/botfixture-credential/sendMessage',
    'Cookie: session=fixture-credential; next=fixture-credential',
    'GOOGLE_CLIENT_SECRET=fixture-credential',
    'SUPABASE_SERVICE_ROLE_KEY=fixture-credential',
    'checksumKey=fixture-credential',
  ])('removes complete credentials from %s', (input) => {
    const result = redactLogValue(input);
    expect(result).not.toContain('fixture-credential');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts API and device keys, and preserves useful Error fields', () => {
    const error = Object.assign(new Error('api_key=fixture-credential'), {
      code: 'ECONNRESET',
      apiKey: 'fixture-credential',
      headers: { 'x-print-device-key': 'fixture-credential' },
    });
    const result = redactLogValue(error);
    expect(result).toEqual(
      expect.objectContaining({
        name: 'Error',
        code: 'ECONNRESET',
        apiKey: '[REDACTED]',
        message: 'api_key=[REDACTED]',
        stack: expect.stringContaining('api_key=[REDACTED]'),
        headers: { 'x-print-device-key': '[REDACTED]' },
      }),
    );
    expect(JSON.stringify(result)).not.toContain('fixture-credential');
  });

  it('handles circular objects without dropping ordinary operational fields', () => {
    const value = { requestId: 'request-id', self: {} };
    value.self = value;
    expect(redactLogValue(value)).toEqual({
      requestId: 'request-id',
      self: '[CIRCULAR]',
    });
  });
});
