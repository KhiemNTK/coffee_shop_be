import type { IncomingMessage } from 'node:http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { shutdownTelemetry, startTelemetry } from './instrumentation';

jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

it('does not put the payOS return capability into HTTP trace attributes', async () => {
  try {
    startTelemetry();
    const options = jest.mocked(NodeSDK).mock.calls[0][0];
    const http = options?.instrumentations?.find(
      (item) => item instanceof HttpInstrumentation,
    );
    if (!(http instanceof HttpInstrumentation))
      throw new Error('HTTP instrumentation missing');
    const hook = http.getConfig().ignoreIncomingRequestHook;
    if (!hook) throw new Error('HTTP privacy hook missing');
    expect(
      hook({
        url: '/api/v1/payments/payos/return?state=private-capability',
      } as IncomingMessage),
    ).toBe(true);
    expect(
      hook({ url: '/api/v1/orders?state=public-filter' } as IncomingMessage),
    ).toBe(false);
  } finally {
    await shutdownTelemetry();
  }
});
