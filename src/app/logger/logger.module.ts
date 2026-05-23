import { Module } from '@nestjs/common';
import {
  WinstonModule,
  utilities as nestWinstonModuleUtilities,
} from 'nest-winston';
import winston from 'winston';

@Module({})
export class LoggerModule {
  private static initLogsFile() {
    const logLevels = ['error', 'warn', 'info'];
    return logLevels.map(
      (level) =>
        new winston.transports.File({
          filename: `logs/${level}s.log`,
          level,
          format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss A' }),
            winston.format.json(),
          ),
        }),
    );
  }
  private static initConsoleLog() {
    const result = new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.ms(),
        nestWinstonModuleUtilities.format.nestLike(process.env.APP_NAME, {
          colors: true,
          prettyPrint: true,
          processId: true,
          appName: true,
        }),
      ),
    });
    return result;
  }
  static createLogger() {
    return WinstonModule.createLogger({
      transports: [this.initConsoleLog(), ...this.initLogsFile()],
    });
  }
}
