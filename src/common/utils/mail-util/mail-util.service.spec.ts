import { TestingModule } from '@nestjs/testing';
import { MailUtilService } from './mail-util.service';
import { AutoMockingModule } from '../../../../test/auto-mocking/auto-mocking.module';
import { MailUtilModule } from './mail-util.module';
import { MailerService } from '@nestjs-modules/mailer';
import { MailTemplate } from './mail-util.const';

describe('MailUtilService', () => {
  let service: MailUtilService;

  beforeEach(async () => {
    const module: TestingModule = await AutoMockingModule.createTestingModule({
      imports: [MailUtilModule],
    });

    service = module.get<MailUtilService>(MailUtilService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('propagates SMTP failures instead of returning false', async () => {
    const mailer = {
      sendMail: jest.fn().mockRejectedValue(new Error('SMTP unavailable')),
    };
    const mail = new MailUtilService(mailer as unknown as MailerService);
    await expect(
      mail.sendMail({
        to: 'owner@example.test',
        subject: 'Password reset',
        template: MailTemplate.RESET_PASSWORD,
        context: { resetLink: 'https://example.test/reset' },
      }),
    ).rejects.toThrow('SMTP unavailable');
  });
});
