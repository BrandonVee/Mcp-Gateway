import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { validWebhookUrl } from '@/web/utils/validation.alert.js';
import { validationRule } from '@/web/utils/validation.js';
import { normalizeSystemSettings } from '@/shared/index.js';
import { canReuseSmtpPassword, smtpTestConfigSchema } from '@/auth/modules/system/smtp-config.js';
import { sendMailWithSettings } from '@/auth/infrastructure/mail/mailer.js';

const smtp = {
  smtp_host: 'smtp.example.com',
  smtp_port: 465,
  smtp_secure: true,
  smtp_username: 'user',
  smtp_from: 'Sender <sender@example.com>',
};
test('optional webhook accepts omitted, empty and whitespace values; invalid populated URLs still fail', async () => {
  const rule = validationRule(validWebhookUrl, 'invalid', true);
  for (const value of [undefined, null, '', '   ', 'https://hooks.example.com/notify']) await rule.validator({}, value);
  for (const value of ['bad', 'ftp://example.com', 'https://user:pass@example.com'])
    await assert.rejects(rule.validator({}, value));
  for (const value of [undefined, '', '   '])
    assert.ok(
      normalizeSystemSettings({ public_url: 'https://example.com', upstream_hosts: [], alert_webhook_url: value }),
    );
});
test('SMTP test validation bounds ports, rejects header injection and never projects unrelated settings', () => {
  assert.equal(smtpTestConfigSchema.safeParse(smtp).success, true);
  for (const patch of [
    { smtp_host: '' },
    { smtp_host: 'https://smtp.example.com' },
    { smtp_port: 0 },
    { smtp_port: 65536 },
    { smtp_port: 1.2 },
    { smtp_from: 'sender@example.com\r\nBcc: victim@example.com' },
  ])
    assert.equal(smtpTestConfigSchema.safeParse({ ...smtp, ...patch }).success, false);
  assert.equal('public_url' in smtpTestConfigSchema.parse({ ...smtp, public_url: 'https://evil.example.com' }), false);
  assert.equal(canReuseSmtpPassword(smtp, smtp), true);
  for (const patch of [
    { smtp_host: 'different.example.com' },
    { smtp_username: 'different' },
    { smtp_port: 587 },
    { smtp_secure: false },
  ])
    assert.equal(canReuseSmtpPassword({ ...smtp, ...patch }, smtp), false);
});
test('SMTP draft test passes draft credentials to transport and closes it on success or failure', async () => {
  const mailer = createRequire(new URL('../packages/auth-server/package.json', import.meta.url))('nodemailer');
  const original = mailer.createTransport;
  let closed = 0;
  let fail = false;
  mailer.createTransport = (options: { host: string; auth: { pass: string } }) => {
    assert.equal(options.host, smtp.smtp_host);
    assert.equal(options.auth.pass, 'draft-password');
    return {
      sendMail: async (mail: { to: string; html?: string }) => {
        assert.equal(mail.to, 'test@example.com');
        assert.equal(mail.html, '<p>012345</p>');
        if (fail) throw new Error('relay rejected');
      },
      close: () => closed++,
    };
  };
  try {
    const config = { ...smtp, public_url: 'https://example.com', upstream_hosts: [] };
    await sendMailWithSettings(config, 'draft-password', 'test@example.com', 'test', 'message', '<p>012345</p>');
    fail = true;
    await assert.rejects(
      sendMailWithSettings(config, 'draft-password', 'test@example.com', 'test', 'message', '<p>012345</p>'),
      /relay rejected/,
    );
    assert.equal(closed, 2);
  } finally {
    mailer.createTransport = original;
  }
});
