import type { Request, Response, NextFunction } from 'express';
import type { ApiLocale } from '../types';

// Keep English for legacy clients; the frontend sends its selected language explicitly.
export function resolveApiLocale(
  request: Pick<Request, 'acceptsLanguages'>,
): ApiLocale {
  return request.acceptsLanguages('en', 'vi') === 'vi' ? 'vi' : 'en';
}

export function httpLocaleMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  response.setHeader('Content-Language', resolveApiLocale(request));
  response.vary('Accept-Language');
  next();
}
