import { Global, Module } from '@nestjs/common';
import { MailerModule } from '@nestjs-modules/mailer';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { MailUtilService } from './mail-util.service';

@Global()
@Module({
  imports: [
    MailerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const nodeEnvironment =
          config.get<string>('NODE_ENV') ?? process.env.NODE_ENV;
        if (nodeEnvironment === 'test') {
          return { transport: { jsonTransport: true } };
        }

        const { HandlebarsAdapter } =
          await import('@nestjs-modules/mailer/adapters/handlebars.adapter');
        return {
          transport: {
            host: config.get<string>('MAIL_HOST'),
            port: config.get<number>('MAIL_PORT'),
            secure: false,
            auth: {
              user: config.get<string>('MAIL_USER'),
              pass: config.get<string>('MAIL_PASS'),
            },
          },
          defaults: {
            from: `"Coffee Shop" <${config.get('MAIL_FROM')}>`,
          },
          template: {
            dir: join(__dirname, 'templates'),
            adapter: new HandlebarsAdapter(),
            options: {
              strict: true,
            },
          },
        };
      },
    }),
  ],
  providers: [MailUtilService],
  exports: [MailUtilService],
})
export class MailUtilModule {}
