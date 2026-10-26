import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applySystemSettings, normalizeSystemSettings } from '@/shared/index.js';
import { renderVerificationEmail } from '@/shared/verification-email.js';
import { verificationCodeMail } from '@/auth/infrastructure/mail/mailer.js';
import { smtpTestConfigSchema } from '@/auth/modules/system/smtp-config.js';

const base = { public_url: 'https://example.com', upstream_hosts: [] };
test('verification templates survive settings normalization and reach delivery content', () => {
  const settings = normalizeSystemSettings({
    ...base,
    verification_email_subject: 'Code {{code}}',
    verification_email_html: '<h1>{{code}}</h1><p>{{expires_minutes}} minutes</p>',
  });
  assert.ok(settings);
  applySystemSettings(settings);
  const mail = verificationCodeMail('012345');
  assert.equal(mail.subject, 'Code 012345');
  assert.equal(mail.html, '<h1>012345</h1><p>10 minutes</p>');
  assert.ok(mail.text.includes('012345'));
  applySystemSettings(base);
});

test('template validation rejects missing code, excess size and subject header injection', () => {
  for (const patch of [
    { verification_email_subject: 'Hello\r\nBcc: other@example.com' },
    { verification_email_subject: 'x'.repeat(201) },
    { verification_email_html: '<p>Missing code</p>' },
    { verification_email_html: '{{code}}' + 'x'.repeat(100000) },
  ])
    assert.equal(normalizeSystemSettings({ ...base, ...patch }), null);
  assert.ok(normalizeSystemSettings({ ...base, verification_email_html: '' }));
});

test('empty templates use defaults and dynamic HTML values are escaped', () => {
  const mail = renderVerificationEmail('012345', { verification_email_html: '  ', verification_email_subject: '' });
  assert.ok(mail.html.includes('012345'));
  assert.ok(!mail.html.includes('{{'));
  assert.equal(
    renderVerificationEmail('<img>', { verification_email_html: '<p>{{code}}</p>' }).html,
    '<p>&lt;img&gt;</p>',
  );
});

test('SMTP drafts validate and preserve the current template', () => {
  const smtp = {
    smtp_host: 'smtp.example.com',
    smtp_port: 465,
    smtp_secure: true,
    smtp_username: '',
    smtp_from: 'a@example.com',
  };
  const template = { verification_email_subject: 'Draft', verification_email_html: '<b>{{code}}</b>' };
  assert.deepEqual(smtpTestConfigSchema.parse({ ...smtp, ...template }), { ...smtp, ...template });
  assert.equal(smtpTestConfigSchema.safeParse({ ...smtp, verification_email_html: 'No code' }).success, false);
});
