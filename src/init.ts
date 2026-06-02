import { cleanupOpenApiDoc } from 'nestjs-zod';
import { INestApplication, VersioningType } from '@nestjs/common';
import { applyMiddlewares } from './common/middlewares/common.middleware';
import { DocumentBuilder, SwaggerModule, OpenAPIObject } from '@nestjs/swagger';

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

const initApp = (app: INestApplication) => {
  const { APP_PREFIX = '/api', FE_URL } = process.env;
  app.setGlobalPrefix(APP_PREFIX);
  app.enableCors({
    origin: FE_URL ? FE_URL : ['*'],
  });
  applyMiddlewares(app);
  initOpenAPI(app);
  app.enableShutdownHooks();
  return app;
};
export { initApp };
