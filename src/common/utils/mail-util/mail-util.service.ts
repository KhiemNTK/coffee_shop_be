import { Injectable } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { SendMailPayload } from './mail-util.interface';

@Injectable()
export class MailUtilService {
  constructor(private readonly mailerService: MailerService) {}

  async sendMail(payload: SendMailPayload): Promise<void> {
    await this.mailerService.sendMail({
      to: payload.to,
      subject: payload.subject,
      template: `./${payload.template}`,
      context: payload.context,
    });
  }
}
