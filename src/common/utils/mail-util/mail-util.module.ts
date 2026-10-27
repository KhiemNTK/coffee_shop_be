import { Global, Module } from '@nestjs/common';
import { MailerModule } from '@nestjs-modules/mailer';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { MailUtilService } from './mail-util.service';

export function smtpTransportOptions(config: ConfigService) {
  const port = config.get<number>('MAIL_PORT');
  return {
    host: config.get<string>('MAIL_HOST'),
    port,
    secure: port === 465,
    requireTLS:
      (config.get<string>('NODE_ENV') ?? process.env.NODE_ENV) === 'production',
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: {
      user: config.get<string>('MAIL_USER'),
      pass: config.get<string>('MAIL_PASS'),
    },
  };
}

export async function createMailOptions(config: ConfigService) {
  const nodeEnvironment =
    config.get<string>('NODE_ENV') ?? process.env.NODE_ENV;
  if (nodeEnvironment === 'test') {
    return { transport: { jsonTransport: true } };
  }

  const { HandlebarsAdapter } =
    await import('@nestjs-modules/mailer/adapters/handlebars.adapter');
  return {
    transport: smtpTransportOptions(config),
    defaults: {
      from: `"Coffee Shop" <${config.get('MAIL_FROM')}>`,
    },
    template: {
      dir: join(__dirname, 'templates'),
      adapter: new HandlebarsAdapter(),
      options: { strict: true },
    },
  };
}

@Global()
@Module({
  imports: [
    MailerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: createMailOptions,
    }),
  ],
  providers: [MailUtilService],
  exports: [MailUtilService],
})
export class MailUtilModule {}
