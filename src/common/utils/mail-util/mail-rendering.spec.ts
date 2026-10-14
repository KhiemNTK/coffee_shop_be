import { MailerModule, MailerService } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/adapters/handlebars.adapter';
import { Test } from '@nestjs/testing';
import { join } from 'node:path';

describe('Password reset email rendering', () => {
  it('renders the real template through the upgraded mailer without network access', async () => {
    const module = await Test.createTestingModule({
      imports: [
        MailerModule.forRoot({
          transport: { jsonTransport: true },
          defaults: { from: 'fixture@example.com' },
          template: {
            dir: join(__dirname, 'templates'),
            adapter: new HandlebarsAdapter(),
            options: { strict: true },
          },
        }),
      ],
    }).compile();
    try {
      const info = (await module.get(MailerService).sendMail({
        to: 'receiver@example.com',
        subject: 'Reset fixture',
        template: './reset-password',
        context: {
          resetLink: 'https://fixture.example/reset-password?token=fixture',
        },
      })) as { message: string };
      const message = JSON.parse(info.message) as {
        html: string;
        subject: string;
      };
      expect(message.html).toContain('Password Reset Request');
      expect(message.html).toContain(
        'https://fixture.example/reset-password?token=fixture',
      );
      expect(message.subject).toBe('Reset fixture');
    } finally {
      await module.close();
    }
  });
});
