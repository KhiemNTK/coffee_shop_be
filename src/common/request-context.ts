import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
  requestId: string;
  employeeId?: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  callback: () => T,
) {
  return requestContext.run(context, callback);
}

export function setRequestEmployee(employeeId: string) {
  const context = requestContext.getStore();
  if (context) context.employeeId = employeeId;
}

export function getRequestContext() {
  return requestContext.getStore();
}
