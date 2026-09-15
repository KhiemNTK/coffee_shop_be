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
});
