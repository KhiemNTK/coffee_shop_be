import { ConfigService } from '@nestjs/config';
import { SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { initApp } from './init';

describe('OpenAPI contract', () => {
  afterEach(() => jest.restoreAllMocks());

  it('preserves IDs, response data, dates and nested objects', () => {
    const doc: OpenAPIObject = {
      openapi: '3.0.0',
      info: { title: 'test', version: '1' },
      paths: {},
      components: {
        schemas: {
          Response: {
            type: 'object',
            required: ['id', 'data'],
            properties: {
              id: { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' },
              data: {
                type: 'object',
                properties: {
                  table: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    };
    jest.spyOn(SwaggerModule, 'createDocument').mockReturnValue(doc);
    const setup = jest
      .spyOn(SwaggerModule, 'setup')
      .mockImplementation(() => undefined);
    const config = new ConfigService({ SWAGGER_ENABLED: true });
    const app = {
      get: () => config,
      setGlobalPrefix: jest.fn(),
      enableCors: jest.fn(),
      use: jest.fn(),
      set: jest.fn(),
    };
    initApp(app as unknown as NestExpressApplication);
    expect(setup).toHaveBeenCalledWith(
      '/api/v1/docs',
      app,
      expect.objectContaining({ components: doc.components }),
    );
    expect(doc.components?.schemas?.Response).toMatchObject({
      required: ['id', 'data'],
      properties: {
        id: { type: 'string' },
        data: { type: 'object' },
        createdAt: { type: 'string' },
      },
    });
  });
});
