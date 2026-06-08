import { MailTemplate } from './mail-util.const';

export interface SendMailPayload {
  to: string;
  subject: string;
  template: MailTemplate;
  context: Record<string, any>;
}
