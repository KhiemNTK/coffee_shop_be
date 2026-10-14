import { cleanupOpenApiDoc } from 'nestjs-zod';
import { INestApplication, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { applyMiddlewares } from './common/middlewares/common.middleware';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded, Request, Response, NextFunction } from 'express';
import { NestExpressApplication } from '@nestjs/platform-express';
import { resolveApiLocale } from './common/i18n/http-locale';
import { localizeApiErrors } from './common/i18n/error-messages';
import { CUSTOMER_SESSION_COOKIE } from './common/consts/customer-auth';
const initOpenAPI = (app: INestApplication, config: ConfigService) => {
  if (!config.get<boolean>('SWAGGER_ENABLED', false)) return;

  const appName = config.get<string>('APP_NAME', 'coffee_shop_be');
  const appPrefix = config.get<string>('APP_PREFIX', '/api/v1');
  const openApiDoc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(`${appName} API`)
      .setDescription(`${appName} API description`)
      .setVersion('1.0.0')
      .addBearerAuth()
      .addCookieAuth('accessToken', undefined, 'accessCookie')
      .addCookieAuth('refreshToken', undefined, 'refreshCookie')
      .addCookieAuth(
        CUSTOMER_SESSION_COOKIE,
        undefined,
        CUSTOMER_SESSION_COOKIE,
      )
      .addApiKey({ type: 'apiKey', in: 'header', name: 'X-CSRF-Token' }, 'csrf')
      .addGlobalParameters({
        in: 'header',
        name: 'Accept-Language',
        required: false,
        schema: { type: 'string', example: 'vi-VN, en;q=0.8' },
        description:
          'Error message language (vi/en); codes and business data are unchanged.',
      })
      .build(),
  );
  SwaggerModule.setup(`${appPrefix}/docs`, app, cleanupOpenApiDoc(openApiDoc));
};

const initBodyParser = (app: INestApplication, config: ConfigService) => {
  const limit = config.get<string>('JSON_BODY_LIMIT', '1mb');
  app.use((req: Request, res: Response, next: NextFunction) => {
    json({ limit })(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof SyntaxError) {
          return res.status(400).json({
            errors: localizeApiErrors(
              [
                {
                  message:
                    'Invalid JSON format. Please check your request body.',
                },
              ],
              resolveApiLocale(req),
              'VALIDATION_ERROR',
            ),
            data: null,
            message: 'ERROR',
          });
        }
        return next(err);
      }
      next();
    });
  });

  app.use(urlencoded({ extended: true, limit }));
};

const initApp = (app: NestExpressApplication) => {
  const config = app.get(ConfigService);
  const appPrefix = config.get<string>('APP_PREFIX', '/api/v1');
  const frontendUrl = config.get<string>('FE_URL', 'http://localhost:3001');
  app.setGlobalPrefix(appPrefix, {
    exclude: [{ path: 'metrics', method: RequestMethod.GET }],
  });
  const allowedOrigins = frontendUrl
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });
  applyMiddlewares(app);
  initBodyParser(app, config);
  initOpenAPI(app, config);
  app.set('trust proxy', config.get<string>('TRUST_PROXY', 'loopback'));
  return app;
};
export { initApp };
