export interface RequestContext {
  requestId: string;
  employeeId?: string;
  traceId?: string;
  outboxEventId?: string;
  aggregateId?: string;
  eventName?: string;
}
