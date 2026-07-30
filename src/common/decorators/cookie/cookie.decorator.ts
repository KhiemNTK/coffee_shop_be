import { createParamDecorator, ExecutionContext } from '@nestjs/common';
export type { CookiesInfo } from '../../types';

export const Cookies = createParamDecorator(
  (key: string, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    const cookies = req.cookies;
    return key ? cookies?.[key] : cookies;
  },
);
