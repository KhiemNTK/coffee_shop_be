import {
  context,
  propagation,
  trace,
  isSpanContextValid,
} from '@opentelemetry/api';
import { z } from 'zod';
import { getRequestContext } from '../../common/request-context';
import type { OutboxDeliveryContext } from '../../common/types';

const deliveryContextSchema = z.object({
  requestId: z
    .string()
    .regex(/^[a-zA-Z0-9._:-]{8,128}$/)
    .optional(),
  employeeId: z.string().min(1).max(128).optional(),
  traceId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  traceparent: z.string().max(256).optional(),
  tracestate: z.string().max(512).optional(),
});

export function captureOutboxContext(): OutboxDeliveryContext {
  const request = getRequestContext();
  const span = trace.getActiveSpan()?.spanContext();
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return {
    ...(request
      ? { requestId: request.requestId, employeeId: request.employeeId }
      : {}),
    ...(span && isSpanContextValid(span) ? { traceId: span.traceId } : {}),
    ...(carrier.traceparent ? { traceparent: carrier.traceparent } : {}),
    ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
  };
}

export function readOutboxContext(value: unknown): OutboxDeliveryContext {
  const parsed = deliveryContextSchema.safeParse(value);
  // Telemetry metadata must never prevent delivery of a legacy business event.
  return parsed.success ? parsed.data : {};
}
