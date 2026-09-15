import { cleanupOpenApiDoc } from 'nestjs-zod';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { applyMiddlewares } from './common/middlewares/common.middleware';
import { DocumentBuilder, SwaggerModule, OpenAPIObject } from '@nestjs/swagger';
import { json, urlencoded, Request, Response, NextFunction } from 'express';
import { NestExpressApplication } from '@nestjs/platform-express';
interface LocalSchemaObject {
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
  [key: string]: any;
}

const removeFieldsAndRelations = (document: OpenAPIObject): OpenAPIObject => {
  const auditFields = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt']);

  const schemas = document?.components?.schemas;
  if (!schemas) return document;

  for (const schema of Object.values(schemas) as LocalSchemaObject[]) {
    const props = schema.properties;
    if (!props) continue;

    const newProps: Record<string, LocalSchemaObject> = {};
    for (const [propName, prop] of Object.entries(props) as [
      string,
      LocalSchemaObject,
    ][]) {
      if (auditFields.has(propName) || propName === 'data') continue;

      const isRelation = prop?.type === 'object';
      if (!isRelation) {
        newProps[propName] = prop;
        continue;
      }

      if (!propName.endsWith('s')) {
        newProps[`${propName}ID`] = { type: 'string' };
      }
    }
    schema.properties = newProps;

    const schemaRequired = schema.required;
    if (Array.isArray(schemaRequired)) {
      schema.required = schemaRequired.filter(
        (field) => !auditFields.has(field) && field !== 'data',
      );
    }
  }
  return document;
};

const initOpenAPI = (app: INestApplication, config: ConfigService) => {
  if (!config.get<boolean>('SWAGGER_ENABLED', false)) return;

  const appName = config.get<string>('APP_NAME', 'coffee_shop_be');
  const appPrefix = config.get<string>('APP_PREFIX', '/api/v1');
  let openApiDoc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(`${appName} API`)
      .setDescription(`${appName} API description`)
      .setVersion('1.0.0')
      .addBearerAuth()
      .addCookieAuth('accessToken', undefined, 'accessCookie')
      .addCookieAuth('refreshToken', undefined, 'refreshCookie')
      .addApiKey({ type: 'apiKey', in: 'header', name: 'X-CSRF-Token' }, 'csrf')
      .build(),
  );
  openApiDoc = removeFieldsAndRelations(openApiDoc);
  SwaggerModule.setup(`${appPrefix}/docs`, app, cleanupOpenApiDoc(openApiDoc));
};

const initBodyParser = (app: INestApplication, config: ConfigService) => {
  const limit = config.get<string>('JSON_BODY_LIMIT', '1mb');
  app.use((req: Request, res: Response, next: NextFunction) => {
    json({ limit })(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof SyntaxError) {
          return res.status(400).json({
            errors: [
              {
                message: 'Invalid JSON format. Please check your request body.',
              },
            ],
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
  app.setGlobalPrefix(appPrefix);
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
  app.enableShutdownHooks();
  app.set('trust proxy', config.get<string>('TRUST_PROXY', 'loopback'));
  return app;
};
export { initApp };
