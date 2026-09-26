import { smtpMailer, type Mailer } from '@ai-cms/auth';

let mailer: Mailer | undefined;

export function mail(): Mailer {
  mailer ??= smtpMailer({
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
    from: process.env.MAIL_FROM ?? 'AI-CMS <cms@localhost>',
  });
  return mailer;
}
