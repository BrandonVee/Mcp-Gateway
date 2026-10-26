import { z } from 'zod';

/** Inline styles and presentation tables keep the message usable in email clients. */
export const DEFAULT_VERIFICATION_EMAIL_SUBJECT = 'MCP Gateway 邮箱验证码 / Email verification code';
export const DEFAULT_VERIFICATION_EMAIL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MCP Gateway · 邮箱验证</title>
</head>
<body style="margin:0;padding:0;background-color:#eef2f7;color:#162033;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">请使用邮件中的验证码完成邮箱验证，{{expires_minutes}} 分钟内有效。Your verification code expires in {{expires_minutes}} minutes.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#eef2f7;table-layout:fixed;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;table-layout:fixed;">
        <tr><td style="padding:0 8px 20px;font-size:18px;font-weight:700;color:#101a2d;">MCP<span style="color:#0b6bcb;"> Gateway</span></td></tr>
        <tr><td style="background-color:#ffffff;border:1px solid #dce3ed;border-top:4px solid #0b6bcb;border-radius:12px;padding:32px 24px;">
          <p style="margin:0 0 12px;color:#0b6bcb;font-size:13px;font-weight:600;">邮箱验证 · EMAIL VERIFICATION</p>
          <h1 style="margin:0 0 16px;font-size:26px;line-height:1.4;font-weight:700;">验证你的邮箱</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.8;color:#526078;">请在验证页面输入以下验证码，以完成邮箱验证。</p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr><td align="center" style="padding:24px 8px;background-color:#f0f6fd;border:1px solid #d6e6f8;border-radius:8px;">
              <p style="margin:0 0 10px;font-size:12px;color:#526078;">你的验证码 / Your verification code</p>
              <p dir="ltr" style="margin:0;font-family:'Courier New',Courier,monospace;font-size:36px;line-height:1.4;font-weight:700;letter-spacing:6px;color:#101a2d;">{{code}}</p>
            </td></tr>
          </table>
          <p style="margin:16px 0 24px;font-size:13px;line-height:1.8;color:#526078;">验证码 <strong style="color:#162033;">{{expires_minutes}} 分钟内有效</strong>，请勿向他人透露。重新发送后，请使用最新的验证码。</p>
          <p lang="en" style="margin:0 0 24px;font-size:13px;line-height:1.8;color:#687386;">Enter this code on the verification page. It expires in {{expires_minutes}} minutes. Keep it private and use the latest code if you request a new one.</p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="border-top:1px solid #e5eaf1;padding-top:20px;">
            <p style="margin:0;font-size:12px;line-height:1.8;color:#687386;">如果这不是你的操作，请忽略本邮件。<br><span lang="en">If you didn't request this code, you can ignore this email.</span></p>
          </td></tr></table>
        </td></tr>
        <tr><td align="center" style="padding:20px 8px 0;font-size:12px;line-height:1.8;color:#687386;">MCP Gateway · 账号安全 / Account security<br>此邮件由系统自动发送，请勿直接回复。<br><span lang="en">This is an automated message. Please do not reply.</span></td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

export const verificationEmailSubjectSchema = z
  .string()
  .trim()
  .max(200)
  .refine((value) => !/[\r\n]/.test(value));
export const verificationEmailHtmlSchema = z
  .string()
  .max(100_000)
  .refine((value) => !value.trim() || value.includes('{{code}}'));

/** Substitute known variables once, escaping dynamic values for HTML content. */
export function renderVerificationEmail(
  code: string,
  settings: { verification_email_subject?: string; verification_email_html?: string } = {},
): { subject: string; html: string } {
  const replace = (value: string, html: boolean) =>
    value.replace(/\{\{(code|expires_minutes)\}\}/g, (_, key: string) => {
      const token = key === 'code' ? code : '10';
      return html
        ? token.replace(
            /[&<>"']/g,
            (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
          )
        : token.replace(/[\r\n]/g, '');
    });
  return {
    subject: replace(settings.verification_email_subject?.trim() || DEFAULT_VERIFICATION_EMAIL_SUBJECT, false),
    html: replace(
      settings.verification_email_html?.trim() ? settings.verification_email_html : DEFAULT_VERIFICATION_EMAIL_HTML,
      true,
    ),
  };
}
