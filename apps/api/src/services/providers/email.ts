import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import type { EmailMessage, EmailProvider, EmailSendResult } from './types.js';

/**
 * Transactional email over SMTP.
 *
 * SMTP rather than a vendor SDK on purpose: the organisation can point this at
 * Google Workspace, a shared host, Postmark, SES or anything else without a
 * code change, and moving provider is a change to four environment variables.
 * That is the whole argument against vendor lock-in, applied to the channel
 * most likely to be switched.
 */

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      // A hung SMTP connection must not hold a job worker open indefinitely.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transport;
}

export const smtpEmailProvider: EmailProvider = {
  name: 'smtp',
  enabled: env.EMAIL_PROVIDER === 'smtp' && Boolean(env.SMTP_HOST),

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const info = await getTransport().sendMail({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: message.replyTo ?? env.EMAIL_REPLY_TO,
    });
    return { provider: 'smtp', providerMessageId: info.messageId };
  },
};

/** Verifies the SMTP connection without sending. Used by /api/ops/health. */
export async function verifySmtp(): Promise<{ ok: boolean; detail: string }> {
  if (!smtpEmailProvider.enabled) return { ok: false, detail: 'SMTP not configured' };
  try {
    await getTransport().verify();
    return { ok: true, detail: `${env.SMTP_HOST}:${env.SMTP_PORT}` };
  } catch (err) {
    logger.error({ err }, 'SMTP verification failed');
    return { ok: false, detail: (err as Error).message };
  }
}
