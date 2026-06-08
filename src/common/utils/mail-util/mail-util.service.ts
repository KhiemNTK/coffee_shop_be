import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { SendMailPayload } from './mail-util.interface';

@Injectable()
export class MailUtilService {
  private readonly logger = new Logger(MailUtilService.name);

  constructor(private readonly mailerService: MailerService) {}

  async sendMail(payload: SendMailPayload): Promise<boolean> {
    try {
      await this.mailerService.sendMail({
        to: payload.to,
        subject: payload.subject,
        template: `./${payload.template}`,
        context: payload.context,
      });

      this.logger.log(`[Success] Email sent to: ${payload.to}`);
      return true;
    } catch (error) {
      const isErrorInstance = error instanceof Error;
      const errorMessage = isErrorInstance ? error.message : String(error);
      const errorStack = isErrorInstance ? error.stack : undefined;

      this.logger.error(
        `[Failed] Could not send email to ${payload.to}- Reason: ${errorMessage}`,
        errorStack,
      );
      return false;
    }
  }
}
