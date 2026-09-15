import { Module } from '@nestjs/common';
import {
  utilities as nestWinstonModuleUtilities,
  WinstonModule,
} from 'nest-winston';
import winston from 'winston';
import { redactLogValue } from './log-redaction';

const redactSensitiveData = winston.format((info) => {
  for (const [key, value] of Object.entries(info)) {
    info[key] = redactLogValue(value, key);
  }
  return info;
});

@Module({})
export class LoggerModule {
  static createLogger() {
    const production = process.env.NODE_ENV === 'production';
    const format = production
      ? winston.format.combine(
          winston.format.errors({ stack: true }),
          redactSensitiveData(),
          winston.format.timestamp(),
          winston.format.json(),
        )
      : winston.format.combine(
          winston.format.errors({ stack: true }),
          redactSensitiveData(),
          winston.format.timestamp(),
          winston.format.ms(),
          nestWinstonModuleUtilities.format.nestLike(process.env.APP_NAME, {
            colors: true,
            prettyPrint: true,
            processId: true,
            appName: true,
          }),
        );

    return WinstonModule.createLogger({
      transports: [new winston.transports.Console({ format })],
    });
  }
}
