import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, Space, Typography } from 'antd';
import { useI18n } from '../../i18n';
import type { SystemSettings } from '../../types';

export function SettingsPage({ settings, onSave }: {
  settings: SystemSettings;
  onSave: (body: { public_url: string; upstream_hosts: string[] }) => Promise<void>;
}) {
  const { t } = useI18n();
  const [form] = Form.useForm<{ public_url: string; upstream_hosts: string }>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    form.setFieldsValue({ public_url: settings.public_url ?? '', upstream_hosts: settings.upstream_hosts.join('\n') });
  }, [form, settings]);
  return (
    <div className="page-stack">
      {!settings.managed ? <Alert type="info" message={t('settings.environmentManaged')} />
        : !settings.configured && <Alert type="warning" showIcon message={t('settings.setupRequired')} description={t('settings.setupDetail')} />}
      <Card>
        <Form form={form} layout="vertical" disabled={!settings.managed} onFinish={async (values) => {
          setSaving(true);
          try {
            await onSave({ public_url: values.public_url.trim(), upstream_hosts: values.upstream_hosts.split(/[\s,]+/).filter(Boolean) });
          } finally { setSaving(false); }
        }}>
          <Form.Item name="public_url" label={t('settings.publicUrl')} extra={t('settings.publicUrlHelp')}
            rules={[{ required: true, message: t('settings.addressRequired') }, { type: 'url', message: t('settings.invalid') }]}>
            <Input placeholder="https://mcp.example.com" />
          </Form.Item>
          <Form.Item name="upstream_hosts" label={t('settings.upstreamHosts')} extra={t('settings.upstreamHelp')}>
            <Input.TextArea rows={4} />
          </Form.Item>
          <Space direction="vertical">
            <Button type="primary" htmlType="submit" loading={saving}>{t('settings.save')}</Button>
            <Typography.Text type="secondary">{t('settings.reauthorize')}</Typography.Text>
          </Space>
        </Form>
      </Card>
    </div>
  );
}
