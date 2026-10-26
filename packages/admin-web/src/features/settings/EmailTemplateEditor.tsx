import { useDeferredValue, useState } from 'react';
import { Button, Form, Input, Popconfirm, Segmented } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import {
  DEFAULT_VERIFICATION_EMAIL_HTML,
  DEFAULT_VERIFICATION_EMAIL_SUBJECT,
  renderVerificationEmail,
  verificationEmailHtmlSchema,
  verificationEmailSubjectSchema,
} from '@/shared/verification-email';
import { useI18n } from '@/web/i18n';

export function EmailTemplateEditor({ disabled, onChange }: { disabled: boolean; onChange: () => void }) {
  const { t } = useI18n();
  const form = Form.useFormInstance();
  const html = Form.useWatch('verification_email_html', form) ?? '';
  const subject = Form.useWatch('verification_email_subject', form) ?? '';
  const [device, setDevice] = useState('desktop');
  const preview = renderVerificationEmail('123456', {
    verification_email_html: useDeferredValue(html),
    verification_email_subject: useDeferredValue(subject),
  });
  // An opaque sandbox plus CSP blocks scripts and automatic remote requests.
  const previewDocument = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'">${preview.html.replace(/<!doctype[^>]*>/gi, '')}`;
  return (
    <div className="settings-email-template">
      <div className="settings-template-heading">
        <div>
          <h4>{t('settings.emailTemplate')}</h4>
          <p>{t('settings.emailTemplateHelp')}</p>
        </div>
        <Popconfirm
          title={t('settings.emailTemplateResetConfirm')}
          onConfirm={() => {
            form.setFieldsValue({
              verification_email_subject: DEFAULT_VERIFICATION_EMAIL_SUBJECT,
              verification_email_html: DEFAULT_VERIFICATION_EMAIL_HTML,
            });
            onChange();
          }}
          disabled={disabled}
        >
          <Button icon={<ReloadOutlined />} disabled={disabled}>
            {t('settings.emailTemplateReset')}
          </Button>
        </Popconfirm>
      </div>
      <div className="settings-template-layout">
        <div className="settings-template-fields">
          <Form.Item
            name="verification_email_subject"
            label={t('settings.emailTemplateSubject')}
            rules={[
              {
                validator: (_, value) =>
                  verificationEmailSubjectSchema.safeParse(value ?? '').success
                    ? Promise.resolve()
                    : Promise.reject(new Error(t('settings.emailTemplateSubjectInvalid'))),
              },
            ]}
          >
            <Input maxLength={200} placeholder={DEFAULT_VERIFICATION_EMAIL_SUBJECT} />
          </Form.Item>
          <Form.Item
            name="verification_email_html"
            label={t('settings.emailTemplateHtml')}
            extra={t('settings.emailTemplateVariables')}
            rules={[
              {
                validator: (_, value) =>
                  verificationEmailHtmlSchema.safeParse(value ?? '').success
                    ? Promise.resolve()
                    : Promise.reject(new Error(t('settings.emailTemplateHtmlInvalid'))),
              },
            ]}
          >
            <Input.TextArea className="settings-template-code" rows={22} spellCheck={false} maxLength={100000} />
          </Form.Item>
        </div>
        <div className="settings-template-preview">
          <div className="settings-template-heading">
            <h4>{t('settings.emailTemplatePreview')}</h4>
            <Segmented
              aria-label={t('settings.emailTemplatePreviewSize')}
              value={device}
              onChange={setDevice}
              options={[
                { value: 'desktop', label: t('settings.emailTemplateDesktop') },
                { value: 'mobile', label: t('settings.emailTemplateMobile') },
              ]}
            />
          </div>
          <p className="settings-template-subject">{preview.subject}</p>
          <div className="settings-template-preview-canvas">
            <iframe
              className={device === 'mobile' ? 'is-mobile' : undefined}
              title={t('settings.emailTemplatePreview')}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={previewDocument}
            />
          </div>
          <p className="settings-template-note">{t('settings.emailTemplatePreviewHelp')}</p>
        </div>
      </div>
    </div>
  );
}
