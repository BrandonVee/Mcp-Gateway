import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, InputNumber, Space, Switch, Typography } from 'antd';
import { useI18n } from '../../i18n';
import type { SystemSettings, SystemSettingsInput } from '../../types';

export function SettingsPage({ settings, onSave }: {
  settings: SystemSettings;
  onSave: (body: SystemSettingsInput) => Promise<void>;
}) {
  const { t } = useI18n();
  const [form] = Form.useForm<Omit<SystemSettingsInput, 'upstream_hosts'> & { upstream_hosts: string }>();
  const allowlistEnabled = Form.useWatch('upstream_allowlist_enabled', form) ?? true;
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    form.setFieldsValue({ public_url: settings.public_url ?? '', upstream_allowlist_enabled: settings.upstream_allowlist_enabled ?? true,
      registration_enabled: settings.registration_enabled ?? true, monitoring_enabled: settings.monitoring_enabled ?? true,
      monitoring_logs_enabled: settings.monitoring_logs_enabled ?? true, monitoring_retention_days: settings.monitoring_retention_days ?? 14,
      monitoring_summary_days: settings.monitoring_summary_days ?? 365, monitoring_error_rate: settings.monitoring_error_rate ?? 5,
      monitoring_slow_ms: settings.monitoring_slow_ms ?? 2000,
      upstream_hosts: settings.upstream_hosts.join('\n') });
  }, [form, settings]);
  return (
    <div className="page-stack">
      {!settings.managed ? <Alert type="info" message={t('settings.environmentManaged')} />
        : !settings.configured && <Alert type="warning" showIcon message={t('settings.setupRequired')} description={t('settings.setupDetail')} />}
      <Card>
        <Form form={form} layout="vertical" disabled={!settings.managed} onFinish={async (values) => {
          setSaving(true);
          try {
            await onSave({ ...values, public_url: values.public_url.trim(), upstream_allowlist_enabled: values.upstream_allowlist_enabled,
              upstream_hosts: values.upstream_hosts.split(/[\s,]+/).filter(Boolean) });
          } finally { setSaving(false); }
        }}>
          <Form.Item name="public_url" label={t('settings.publicUrl')} extra={t('settings.publicUrlHelp')}
            rules={[{ required: true, message: t('settings.addressRequired') }, { type: 'url', message: t('settings.invalid') }]}>
            <Input placeholder="https://mcp.example.com" />
          </Form.Item>
          <Form.Item name="upstream_allowlist_enabled" label={t('settings.upstreamAllowlistEnabled')}
            valuePropName="checked" extra={t('settings.upstreamAllowlistHelp')}>
            <Switch />
          </Form.Item>
          <Form.Item name="upstream_hosts" label={t('settings.upstreamHosts')} extra={t('settings.upstreamHelp')}>
            <Input.TextArea rows={4} disabled={!settings.managed || !allowlistEnabled} />
          </Form.Item>
          <Form.Item name="registration_enabled" label={t('settings.registrationEnabled')} valuePropName="checked" extra={t('settings.registrationHelp')}><Switch /></Form.Item>
          <Typography.Title level={5}>{t('settings.monitoring')}</Typography.Title>
          <Form.Item name="monitoring_enabled" label={t('settings.monitoringEnabled')} valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="monitoring_logs_enabled" label={t('settings.monitoringLogs')} valuePropName="checked" extra={t('settings.monitoringPrivacy')}><Switch /></Form.Item>
          <Form.Item name="monitoring_retention_days" label={t('settings.logRetention')} rules={[{ required: true }]}><InputNumber min={1} max={90} /></Form.Item>
          <Form.Item name="monitoring_summary_days" label={t('settings.summaryRetention')} rules={[{ required: true }]}><InputNumber min={1} max={730} /></Form.Item>
          <Form.Item name="monitoring_error_rate" label={t('settings.errorThreshold')} rules={[{ required: true }]}><InputNumber min={1} max={100} /></Form.Item>
          <Form.Item name="monitoring_slow_ms" label={t('settings.slowThreshold')} rules={[{ required: true }]}><InputNumber min={1} max={3600000} /></Form.Item>
          <Space direction="vertical">
            <Button type="primary" htmlType="submit" loading={saving}>{t('settings.save')}</Button>
            <Typography.Text type="secondary">{t('settings.reauthorize')}</Typography.Text>
          </Space>
        </Form>
      </Card>
    </div>
  );
}
