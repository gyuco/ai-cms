import nodemailer from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export type Mailer = (mail: Mail) => Promise<void>;

/** SMTP mailer (Mailpit in local development). */
export function smtpMailer(options: { host: string; port: number; from: string }): Mailer {
  const transport = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: false,
  });
  return async (mail) => {
    await transport.sendMail({ from: options.from, ...mail });
  };
}
