import { cleanupOpenApiDoc } from 'nestjs-zod';
import { INestApplication } from '@nestjs/common';
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

const initOpenAPI = (app: INestApplication) => {
  const { APP_NAME, APP_PREFIX = '' } = process.env;
  let openApiDoc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(`${APP_NAME} API`)
      .setDescription(`${APP_NAME} API description`)
      .setVersion('1.0.0')
      .build(),
  );
  openApiDoc = removeFieldsAndRelations(openApiDoc);
  SwaggerModule.setup(APP_PREFIX, app, cleanupOpenApiDoc(openApiDoc));
};

const initBodyParser = (app: INestApplication) => {
  app.use((req: Request, res: Response, next: NextFunction) => {
    json()(req, res, (err: unknown) => {
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

  app.use(urlencoded({ extended: true }));
};

const initApp = (app: NestExpressApplication) => {
  const { APP_PREFIX = '/api', FE_URL } = process.env;
  app.setGlobalPrefix(APP_PREFIX);
  app.enableCors({
    origin: FE_URL ? FE_URL : ['*'],
  });
  initBodyParser(app);
  applyMiddlewares(app);
  initOpenAPI(app);
  app.enableShutdownHooks();
  app.set('trust proxy', 'loopback');
  return app;
};
export { initApp };
