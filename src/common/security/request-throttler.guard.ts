import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';
import { IS_SKIP_AUTH } from '../../app/auth/auth.decorator';
import type { AuthenticatedStaffRequest } from '../types';

function isPublicRoute(reflector: Reflector, context: ExecutionContext) {
  return (
    reflector.getAllAndOverride<boolean>(IS_SKIP_AUTH, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}

@Injectable()
export class IngressThrottlerGuard extends ThrottlerGuard {
  protected handleRequest(request: ThrottlerRequest) {
    if (isPublicRoute(this.reflector, request.context))
      return super.handleRequest(request);
    // Coarse IP protection runs before authentication; staff share the shop's NAT.
    return super.handleRequest({
      ...request,
      limit: request.limit * 10,
      generateKey: (context, tracker, name) =>
        this.generateKey(context, tracker, `ingress-${name}`),
    });
  }
}

@Injectable()
export class EmployeeThrottlerGuard extends ThrottlerGuard {
  canActivate(context: ExecutionContext) {
    if (isPublicRoute(this.reflector, context)) return Promise.resolve(true);
    return super.canActivate(context);
  }

  protected getTracker(request: AuthenticatedStaffRequest): Promise<string> {
    if (!request.employee?.employeeId) throw new UnauthorizedException();
    return Promise.resolve(`employee:${request.employee.employeeId}`);
  }
}
