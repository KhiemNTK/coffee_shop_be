import type { MailTemplate } from '../utils/mail-util/mail-util.const';

export interface SendMailPayload {
  to: string;
  subject: string;
  template: MailTemplate;
  context: Record<string, any>;
}
