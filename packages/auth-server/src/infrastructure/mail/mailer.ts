import { currentSystemSettings, smtpConfigured, systemOptionDefaults, type SystemSettings } from '@mcp/shared';
import nodemailer from 'nodemailer';
import { renderVerificationEmail } from '@/shared/verification-email.js';
import { decryptCredential } from '@/auth/infrastructure/security/credential-crypto.js';

export function mailConfigured(): boolean {
  return smtpConfigured(currentSystemSettings());
}

/**
 * Delivers one message through the administrator-configured relay. Throws when
 * SMTP is not configured or the relay rejects the hand-off; callers decide
 * whether a mail failure should fail the surrounding operation.
 */
export async function sendMail(to: string, subject: string, text: string, html?: string): Promise<void> {
  const settings = currentSystemSettings();
  if (!smtpConfigured(settings)) throw new Error('smtp_not_configured');
  const stored = settings.smtp_password ?? '';
  await sendMailWithSettings(settings, stored ? decryptCredential(stored) : '', to, subject, text, html);
}

/** Password is plaintext and used only for this delivery. */
export async function sendMailWithSettings(
  settings: SystemSettings,
  password: string,
  to: string,
  subject: string,
  text: string,
  html?: string,
): Promise<void> {
  if (!smtpConfigured(settings)) throw new Error('smtp_not_configured');
  const username = settings.smtp_username ?? '';
  const transport = nodemailer.createTransport({
    host: settings.smtp_host,
    port: settings.smtp_port ?? systemOptionDefaults.smtp_port,
    secure: settings.smtp_secure ?? systemOptionDefaults.smtp_secure,
    auth: username ? { user: username, pass: password } : undefined,
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await transport.sendMail({ from: settings.smtp_from, to, subject, text, html });
  } finally {
    transport.close();
  }
}

export function verificationCodeMail(
  code: string,
  settings = currentSystemSettings(),
): { subject: string; text: string; html: string } {
  return {
    ...renderVerificationEmail(code, settings),
    text: [
      `你的验证码是 / Your verification code is: ${code}`,
      '',
      '验证码 10 分钟内有效。如果这不是你的操作，请忽略本邮件。',
      'The code expires in 10 minutes. Ignore this message if you did not request it.',
    ].join('\n'),
  };
}
