import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Form, Input, InputNumber, Switch, Tag } from 'antd';
import {
  BarChartOutlined,
  BellOutlined,
  CheckCircleOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  ReloadOutlined,
  SaveOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useI18n } from '../../i18n';
import type { SystemSettings, SystemSettingsInput } from '../../types';
import './settings.css';

type SettingsFormValues = Omit<SystemSettingsInput, 'upstream_hosts'> & { upstream_hosts: string };
type ToggleName =
  'upstream_allowlist_enabled' | 'registration_enabled' | 'monitoring_enabled' | 'monitoring_logs_enabled';

function SettingsModule({
  id,
  icon,
  title,
  description,
  number,
  tone,
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  description: string;
  number: string;
  tone: string;
  children: ReactNode;
}) {
  return (
    <section className={`settings-module settings-module-${tone}`} aria-labelledby={id}>
      <header className="settings-module-heading">
        <span className="settings-module-icon" aria-hidden>
          {icon}
        </span>
        <div>
          <h3 id={id}>{title}</h3>
          <p>{description}</p>
        </div>
        <span className="settings-module-number" aria-hidden>
          {number}
        </span>
      </header>
      <div className="settings-module-body">{children}</div>
    </section>
  );
}

function SettingToggle({ name, label, description }: { name: ToggleName; label: string; description: string }) {
  const { t } = useI18n();
  return (
    <div className="settings-toggle-row">
      <div>
        <label htmlFor={name}>{label}</label>
        <p id={`${name}-help`}>{description}</p>
      </div>
      <Form.Item name={name} valuePropName="checked" noStyle>
        <Switch
          id={name}
          aria-label={label}
          aria-describedby={`${name}-help`}
          checkedChildren={t('settings.on')}
          unCheckedChildren={t('settings.off')}
        />
      </Form.Item>
    </div>
  );
}

export function SettingsPage({
  settings,
  onSave,
}: {
  settings: SystemSettings;
  onSave: (body: SystemSettingsInput) => Promise<void>;
}) {
  const { t } = useI18n();
  const [form] = Form.useForm<SettingsFormValues>();
  const allowlistEnabled = Form.useWatch('upstream_allowlist_enabled', form) ?? true;
  const [saving, setSaving] = useState(false),
    [dirty, setDirty] = useState(false);
  const initialValues = useMemo<SettingsFormValues>(
    () => ({
      public_url: settings.public_url ?? '',
      upstream_allowlist_enabled: settings.upstream_allowlist_enabled ?? true,
      registration_enabled: settings.registration_enabled ?? true,
      monitoring_enabled: settings.monitoring_enabled ?? true,
      monitoring_logs_enabled: settings.monitoring_logs_enabled ?? true,
      monitoring_retention_days: settings.monitoring_retention_days ?? 14,
      monitoring_summary_days: settings.monitoring_summary_days ?? 365,
      monitoring_error_rate: settings.monitoring_error_rate ?? 5,
      monitoring_slow_ms: settings.monitoring_slow_ms ?? 2000,
      upstream_hosts: settings.upstream_hosts.join('\n'),
    }),
    [settings],
  );

  useEffect(() => {
    form.setFieldsValue(initialValues);
    setDirty(false);
  }, [form, initialValues]);
  const reset = () => {
    form.resetFields();
    form.setFieldsValue(initialValues);
    setDirty(false);
  };

  return (
    <div className="page-stack page-enter settings-page">
      {!settings.managed ? (
        <Alert type="info" showIcon message={t('settings.environmentManaged')} />
      ) : (
        !settings.configured && (
          <Alert
            type="warning"
            showIcon
            message={t('settings.setupRequired')}
            description={t('settings.setupDetail')}
          />
        )
      )}
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={initialValues}
        disabled={!settings.managed || saving}
        onValuesChange={(_, values: SettingsFormValues) =>
          setDirty(
            Object.entries(initialValues).some(([key, value]) => values[key as keyof SettingsFormValues] !== value),
          )
        }
        onFinish={async (values) => {
          setSaving(true);
          try {
            await onSave({
              ...values,
              public_url: values.public_url.trim(),
              upstream_hosts: values.upstream_hosts.split(/[\s,]+/).filter(Boolean),
            });
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="settings-module-grid">
          <SettingsModule
            id="settings-public"
            icon={<GlobalOutlined />}
            title={t('settings.accessModule')}
            description={t('settings.accessDescription')}
            number="01"
            tone="blue"
          >
            <Form.Item
              name="public_url"
              label={t('settings.publicUrl')}
              extra={t('settings.publicUrlHelp')}
              rules={[
                { required: true, message: t('settings.addressRequired') },
                { type: 'url', message: t('settings.invalid') },
              ]}
            >
              <Input prefix={<LinkOutlined />} placeholder="https://mcp.example.com" />
            </Form.Item>
            <div className="settings-inline-note">
              <InfoCircleOutlined />
              <p>{t('settings.addressChangeHelp')}</p>
            </div>
          </SettingsModule>

          <SettingsModule
            id="settings-registration"
            icon={<TeamOutlined />}
            title={t('settings.registrationModule')}
            description={t('settings.registrationDescription')}
            number="02"
            tone="purple"
          >
            <SettingToggle
              name="registration_enabled"
              label={t('settings.registrationEnabled')}
              description={t('settings.registrationHelp')}
            />
            <div className="settings-inline-note">
              <InfoCircleOutlined />
              <p>{t('settings.registrationScope')}</p>
            </div>
          </SettingsModule>

          <SettingsModule
            id="settings-upstream"
            icon={<SafetyCertificateOutlined />}
            title={t('settings.upstreamModule')}
            description={t('settings.upstreamDescription')}
            number="03"
            tone="cyan"
          >
            <SettingToggle
              name="upstream_allowlist_enabled"
              label={t('settings.upstreamAllowlistEnabled')}
              description={t('settings.upstreamAllowlistHelp')}
            />
            <div className={`settings-hosts-field ${!allowlistEnabled ? 'is-inactive' : ''}`}>
              <Form.Item
                name="upstream_hosts"
                label={
                  <span className="settings-hosts-label">
                    {t('settings.upstreamHosts')}
                    <Tag variant="filled" color={allowlistEnabled ? 'cyan' : undefined}>
                      {t(allowlistEnabled ? 'settings.allowlistActive' : 'settings.allowlistInactive')}
                    </Tag>
                  </span>
                }
                extra={t('settings.upstreamHelp')}
              >
                <Input.TextArea
                  autoSize={{ minRows: 4, maxRows: 8 }}
                  disabled={!settings.managed || saving || !allowlistEnabled}
                  placeholder={t('settings.hostsPlaceholder')}
                />
              </Form.Item>
            </div>
          </SettingsModule>

          <SettingsModule
            id="settings-monitoring"
            icon={<BarChartOutlined />}
            title={t('settings.collectionModule')}
            description={t('settings.collectionDescription')}
            number="04"
            tone="green"
          >
            <SettingToggle
              name="monitoring_enabled"
              label={t('settings.monitoringEnabled')}
              description={t('settings.monitoringHelp')}
            />
            <SettingToggle
              name="monitoring_logs_enabled"
              label={t('settings.monitoringLogs')}
              description={t('settings.monitoringPrivacy')}
            />
            <div className="settings-subsection-heading">
              <span>{t('settings.retentionTitle')}</span>
              <small>{t('settings.retentionDescription')}</small>
            </div>
            <div className="settings-field-grid">
              <Form.Item
                name="monitoring_retention_days"
                label={t('settings.logRetentionLabel')}
                extra={t('settings.logRetentionHelp')}
                rules={[{ required: true }]}
              >
                <InputNumber min={1} max={90} precision={0} suffix={t('settings.daysUnit')} />
              </Form.Item>
              <Form.Item
                name="monitoring_summary_days"
                label={t('settings.summaryRetentionLabel')}
                extra={t('settings.summaryRetentionHelp')}
                rules={[{ required: true }]}
              >
                <InputNumber min={1} max={730} precision={0} suffix={t('settings.daysUnit')} />
              </Form.Item>
            </div>
          </SettingsModule>

          <div className="settings-module-wide">
            <SettingsModule
              id="settings-alerts"
              icon={<BellOutlined />}
              title={t('settings.alertModule')}
              description={t('settings.alertDescription')}
              number="05"
              tone="amber"
            >
              <div className="settings-alert-layout">
                <div className="settings-rule-note">
                  <span className="settings-rule-icon">
                    <BellOutlined />
                  </span>
                  <div>
                    <strong>{t('settings.alertWindow')}</strong>
                    <p>{t('settings.alertSamples')}</p>
                  </div>
                </div>
                <div className="settings-field-grid">
                  <Form.Item
                    name="monitoring_error_rate"
                    label={t('settings.errorThresholdLabel')}
                    extra={t('settings.errorThresholdHelp')}
                    rules={[{ required: true }]}
                  >
                    <InputNumber min={1} max={100} precision={0} suffix="%" />
                  </Form.Item>
                  <Form.Item
                    name="monitoring_slow_ms"
                    label={t('settings.slowThresholdLabel')}
                    extra={t('settings.slowThresholdHelp')}
                    rules={[{ required: true }]}
                  >
                    <InputNumber min={1} max={3600000} precision={0} suffix={t('settings.millisecondsUnit')} />
                  </Form.Item>
                </div>
              </div>
            </SettingsModule>
          </div>
        </div>
        <footer className={`settings-save-bar ${dirty ? 'has-changes' : ''}`}>
          <div className="settings-save-status">
            <span className="settings-save-status-icon">
              {dirty ? <Badge status="warning" /> : <CheckCircleOutlined />}
            </span>
            <div>
              <strong>
                {t(
                  !settings.managed ? 'settings.readOnly' : dirty ? 'settings.unsavedChanges' : 'settings.configLoaded',
                )}
              </strong>
              <p>{t(settings.managed ? 'settings.saveHelp' : 'settings.readOnlyHelp')}</p>
            </div>
          </div>
          <div className="settings-save-actions">
            <Button icon={<ReloadOutlined />} onClick={reset} disabled={!settings.managed || !dirty || saving}>
              {t('settings.restore')}
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SaveOutlined />}
              loading={saving}
              disabled={!settings.managed}
            >
              {t('settings.save')}
            </Button>
          </div>
        </footer>
      </Form>
    </div>
  );
}
