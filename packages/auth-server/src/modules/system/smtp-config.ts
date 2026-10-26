import { z } from 'zod';
import { verificationEmailHtmlSchema, verificationEmailSubjectSchema } from '@/shared/verification-email.js';

/** Only SMTP fields are accepted for a transient test; no settings are persisted. */
export const smtpTestConfigSchema = z.object({
  verification_email_subject: verificationEmailSubjectSchema.optional(),
  verification_email_html: verificationEmailHtmlSchema.optional(),
  smtp_host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9][a-z0-9.-]*(\.[a-z0-9][a-z0-9.-]*)+$|^\d{1,3}(\.\d{1,3}){3}$/i),
  smtp_port: z.number().int().min(1).max(65535),
  smtp_secure: z.boolean(),
  smtp_username: z.string().trim().max(254),
  smtp_password: z.string().max(4096).optional(),
  smtp_from: z
    .string()
    .trim()
    .min(1)
    .max(254)
    .refine((value) => !/[\r\n]/.test(value)),
});

/** A retained password may only be sent to the same saved relay and account. */
export function canReuseSmtpPassword(
  draft: z.infer<typeof smtpTestConfigSchema>,
  saved: { smtp_host?: string; smtp_port?: number; smtp_secure?: boolean; smtp_username?: string },
): boolean {
  return (
    draft.smtp_host.toLowerCase() === saved.smtp_host?.toLowerCase() &&
    draft.smtp_port === (saved.smtp_port ?? 465) &&
    draft.smtp_secure === (saved.smtp_secure ?? true) &&
    draft.smtp_username === (saved.smtp_username ?? '')
  );
}
