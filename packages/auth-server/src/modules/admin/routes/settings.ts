import {
  allowedUpstreamHosts,
  databaseSettingsEnabled,
  normalizeEmail,
  normalizeSystemSettings,
  normalizeUpstreamHost,
  registrationEnabled,
  smtpConfigured,
  systemConfigured,
  systemOptionDefaults,
  upstreamAllowlistEnabled,
} from '@mcp/shared';
import {
  mailConfigured,
  sendMail,
  sendMailWithSettings,
  verificationCodeMail,
} from '@/auth/infrastructure/mail/mailer.js';
import { decryptCredential, encryptCredential } from '@/auth/infrastructure/security/credential-crypto.js';
import { addUpstreamHost, currentSystemSettings, saveSystemSettings } from '@/auth/modules/system/settings.js';
import { canReuseSmtpPassword, smtpTestConfigSchema } from '@/auth/modules/system/smtp-config.js';

import type { AdminDeps, AdminRouter } from '@/auth/modules/admin/context.js';
/** Registers settings routes under the shared administrator guard. */
export function registerSettingsRoutes(router: AdminRouter, deps: AdminDeps) {
  router.get('/admin/system-settings', (c) => {
    c.header('Cache-Control', 'no-store');
    const stored = databaseSettingsEnabled()
      ? currentSystemSettings()
      : {
          public_url: deps.issuer,
          upstream_allowlist_enabled: upstreamAllowlistEnabled(),
          upstream_hosts: [...allowedUpstreamHosts()],
        };
    // The stored password is an encrypted envelope; browsers only learn whether one exists.
    const { smtp_password: configuredPassword, ...visible } = {
      ...systemOptionDefaults,
      registration_enabled: registrationEnabled(),
      ...stored,
    };
    return c.json({
      managed: process.env.SYSTEM_CONFIG_MODE !== 'file',
      configured: systemConfigured(),
      public_url_requires_https: process.env.NODE_ENV === 'production',
      ...visible,
      smtp_password: '',
      smtp_password_configured: Boolean(configuredPassword),
    });
  });

  router.put('/admin/system-settings', async (c) => {
    if (process.env.SYSTEM_CONFIG_MODE === 'file')
      return c.json({ error: 'system_settings_managed_by_environment' }, 409);
    const raw = await c.req.json().catch(() => null);
    const settings = normalizeSystemSettings(raw);
    if (!settings) return c.json({ error: 'invalid_system_settings' }, 400);
    if (settings.registration_email_verification && !smtpConfigured({ ...currentSystemSettings(), ...settings }))
      return c.json({ error: 'verification_unavailable' }, 400);
    // Password semantics: a non-empty value replaces the stored secret, an empty
    // string clears it, and an absent field keeps the current envelope.
    const plaintext =
      raw && typeof raw === 'object' && typeof (raw as { smtp_password?: unknown }).smtp_password === 'string'
        ? ((raw as { smtp_password: string }).smtp_password as string)
        : undefined;
    settings.smtp_password =
      plaintext === undefined
        ? (currentSystemSettings().smtp_password ?? '')
        : plaintext
          ? encryptCredential(plaintext)
          : '';
    await saveSystemSettings(settings);
    return c.json({
      managed: true,
      configured: true,
      public_url_requires_https: process.env.NODE_ENV === 'production',
      ...systemOptionDefaults,
      ...settings,
      smtp_password: '',
      smtp_password_configured: Boolean(settings.smtp_password),
    });
  });

  /** Test a transient SMTP draft or the saved relay without changing configuration. */
  router.post('/admin/system-settings/test-email', async (c) => {
    const body = await c.req.json().catch(() => null);
    const to = normalizeEmail((body as { to?: unknown } | null)?.to);
    if (!to) return c.json({ error: 'invalid_email' }, 400);
    const smtp = (body as { smtp?: unknown } | null)?.smtp;
    const parsed = smtp === undefined ? null : smtpTestConfigSchema.safeParse(smtp);
    if (parsed && !parsed.success) return c.json({ error: 'invalid_smtp_settings' }, 400);
    if (!parsed && !mailConfigured()) return c.json({ error: 'smtp_not_configured' }, 409);
    const mail = verificationCodeMail('123456', {
      ...currentSystemSettings(),
      ...(parsed?.success ? parsed.data : {}),
    });
    const subject = `[TEST] ${mail.subject}`;
    const text = `测试邮件 / Test email\n${mail.text}`;
    try {
      if (parsed?.success) {
        const saved = currentSystemSettings();
        const config = parsed.data;
        if (
          config.smtp_username &&
          config.smtp_password === undefined &&
          saved.smtp_password &&
          !canReuseSmtpPassword(config, saved)
        )
          return c.json({ error: 'smtp_test_password_required' }, 400);
        // A blank form password retains the stored envelope; explicit empty clears it for this test.
        const password =
          config.smtp_password === undefined
            ? config.smtp_username && saved.smtp_password
              ? decryptCredential(saved.smtp_password)
              : ''
            : config.smtp_password;
        await sendMailWithSettings({ ...saved, ...config }, password, to, subject, text, mail.html);
      } else {
        await sendMail(to, subject, text, mail.html);
      }
      return c.json({ ok: true });
    } catch (error) {
      console.error('[smtp] test email failed', error instanceof Error ? error.name : 'UnknownError');
      return c.json({ error: 'smtp_send_failed' }, 502);
    }
  });

  router.post('/admin/system-settings/upstream-hosts', async (c) => {
    if (process.env.SYSTEM_CONFIG_MODE === 'file')
      return c.json({ error: 'system_settings_managed_by_environment' }, 409);
    const body = await c.req.json().catch(() => null);
    const host = normalizeUpstreamHost(body?.host);
    if (!host) return c.json({ error: 'invalid_upstream_host' }, 400);
    if (!systemConfigured()) return c.json({ error: 'system_settings_required' }, 409);
    const settings = await addUpstreamHost(host);
    if (!settings) return c.json({ error: 'upstream_host_limit_reached' }, 400);
    return c.json({
      managed: true,
      configured: true,
      public_url_requires_https: process.env.NODE_ENV === 'production',
      ...systemOptionDefaults,
      ...settings,
    });
  });
}
