import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { NodeSDK } from '@opentelemetry/sdk-node';

let telemetrySdk: NodeSDK | undefined;

export function startTelemetry() {
  if (telemetrySdk) return;

  telemetrySdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'coffee_shop_be',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => {
          const path = request.url?.split('?', 1)[0];
          return path === '/metrics' || path?.endsWith('/health/live') === true;
        },
      }),
      new ExpressInstrumentation(),
      new NestInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });
  telemetrySdk.start();
}

export async function shutdownTelemetry() {
  await telemetrySdk?.shutdown();
  telemetrySdk = undefined;
}
