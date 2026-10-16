import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { App, Alert, Badge, Button, Checkbox, Flex, Form, Input, InputNumber, Select, Switch, Tabs, Tag } from 'antd';
import {
  BarChartOutlined,
  BellOutlined,
  CheckCircleOutlined,
  CloudUploadOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  MailOutlined,
  ReloadOutlined,
  SaveOutlined,
  SafetyCertificateOutlined,
  SendOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useI18n } from '@/web/i18n';
import type { SmtpSettingsInput, SystemSettings, SystemSettingsInput, SystemUpdateStatus } from '@/web/types';
import '@/web/features/settings/settings.css';
import { isPublicOrigin, upstreamHosts, validUpstreamHosts, validationRule } from '@/web/utils/validation';
import { validWebhookUrl } from '@/web/utils/validation.alert';
import { mergeDraft } from '@/web/utils/operations';

type SettingsFormValues = Omit<SystemSettingsInput, 'upstream_hosts'> & { upstream_hosts: string };
type ToggleName =
  | 'upstream_allowlist_enabled'
  | 'registration_enabled'
  | 'registration_email_verification'
  | 'monitoring_enabled'
  | 'monitoring_logs_enabled';

function SettingsModule({
  id,
  hidden,
  icon,
  title,
  description,
  number,
  tone,
  children,
}: {
  id: string;
  hidden?: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  number: string;
  tone: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`settings-module settings-module-${tone}`}
      aria-labelledby={id}
      style={hidden ? { display: 'none' } : undefined}
    >
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

function SettingToggle({
  name,
  label,
  description,
  disabled,
}: {
  name: ToggleName;
  label: string;
  description: string;
  disabled?: boolean;
}) {
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
          disabled={disabled}
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
  update,
  updating,
  onSave,
  onUpdate,
  onCheckUpdate,
  onTestEmail,
  onDirtyChange,
}: {
  settings: SystemSettings;
  update: SystemUpdateStatus | null;
  updating: boolean;
  onSave: (body: SystemSettingsInput) => Promise<SystemSettings | null>;
  onUpdate: (tag: string) => void;
  onCheckUpdate: () => Promise<void>;
  onTestEmail: (to: string, smtp?: SmtpSettingsInput) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const { message } = App.useApp();
  const [category, setCategory] = useState('public');
  const [targetTag, setTargetTag] = useState('latest');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const checkUpdate = async () => {
    setCheckingUpdate(true);
    try {
      await onCheckUpdate();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('common.operationFailed'));
    } finally {
      setCheckingUpdate(false);
    }
  };
  const [form] = Form.useForm<SettingsFormValues>();
  const allowlistEnabled = Form.useWatch('upstream_allowlist_enabled', form) ?? true;
  const smtpHost = Form.useWatch('smtp_host', form) ?? '';
  const [saving, setSaving] = useState(false),
    [dirty, setDirty] = useState(false);
  const [clearSmtpPassword, setClearSmtpPassword] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testingEmail, setTestingEmail] = useState(false);
  const smtpFrom = Form.useWatch('smtp_from', form) ?? '';
  const mailReady = Boolean(smtpHost.trim() && smtpFrom.trim());
  const sendTestEmail = async () => {
    setTestingEmail(true);
    try {
      await form.validateFields([
        'smtp_host',
        'smtp_port',
        'smtp_username',
        'smtp_password',
        'smtp_from',
        'smtp_secure',
      ]);
      const draft = form.getFieldsValue(true);
      await onTestEmail(testTo.trim(), {
        smtp_host: draft.smtp_host?.trim(),
        smtp_port: draft.smtp_port,
        smtp_secure: draft.smtp_secure,
        smtp_username: draft.smtp_username?.trim(),
        smtp_from: draft.smtp_from?.trim(),
        ...(draft.smtp_password
          ? { smtp_password: draft.smtp_password }
          : clearSmtpPassword
            ? { smtp_password: '' }
            : {}),
      });
      message.success(t('settings.smtpTestSuccess'));
    } catch (error) {
      if (!error || typeof error !== 'object' || !('errorFields' in error))
        message.error(error instanceof Error ? error.message : t('common.operationFailed'));
    } finally {
      setTestingEmail(false);
    }
  };
  const initialValues = useMemo<SettingsFormValues>(
    () => ({
      public_url: settings.public_url ?? '',
      upstream_allowlist_enabled: settings.upstream_allowlist_enabled ?? true,
      registration_enabled: settings.registration_enabled ?? true,
      registration_email_verification: settings.registration_email_verification ?? false,
      monitoring_enabled: settings.monitoring_enabled ?? true,
      monitoring_logs_enabled: settings.monitoring_logs_enabled ?? true,
      monitoring_retention_days: settings.monitoring_retention_days ?? 14,
      monitoring_summary_days: settings.monitoring_summary_days ?? 365,
      monitoring_error_rate: settings.monitoring_error_rate ?? 5,
      monitoring_slow_ms: settings.monitoring_slow_ms ?? 2000,
      alert_email_recipients: settings.alert_email_recipients ?? [],
      alert_webhook_url: settings.alert_webhook_url ?? '',
      upstream_hosts: settings.upstream_hosts.join('\n'),
      smtp_host: settings.smtp_host ?? '',
      smtp_port: settings.smtp_port ?? 465,
      smtp_secure: settings.smtp_secure ?? true,
      smtp_username: settings.smtp_username ?? '',
      smtp_password: '',
      smtp_from: settings.smtp_from ?? '',
    }),
    [settings],
  );
  const baseline = useRef(initialValues);
  const draftDirty = useRef(dirty);
  draftDirty.current = dirty;

  useEffect(() => {
    const values = draftDirty.current
      ? mergeDraft(baseline.current, initialValues, form.getFieldsValue(true))
      : initialValues;
    baseline.current = initialValues;
    form.setFieldsValue(values);
    setDirty(Object.entries(initialValues).some(([key, value]) => values[key as keyof SettingsFormValues] !== value));
  }, [form, initialValues]);
  useEffect(() => {
    onDirtyChange(dirty);
    const protectDraft = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', protectDraft);
    return () => {
      window.removeEventListener('beforeunload', protectDraft);
      onDirtyChange(false);
    };
  }, [dirty, onDirtyChange]);
  const reset = () => {
    form.resetFields();
    form.setFieldsValue(initialValues);
    setClearSmtpPassword(false);
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
      <Tabs
        className="settings-category-tabs"
        activeKey={category}
        onChange={setCategory}
        items={[
          { key: 'public', label: t('settings.accessModule') },
          { key: 'registration', label: t('settings.registrationModule') },
          { key: 'smtp', label: t('settings.smtpModule') },
          { key: 'upstream', label: t('settings.upstreamModule') },
          { key: 'monitoring', label: t('settings.collectionModule') },
          { key: 'alerts', label: t('settings.alertModule') },
          ...(update?.enabled ? [{ key: 'update', label: t('settings.updateModule') }] : []),
        ]}
      />
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={initialValues}
        disabled={!settings.managed || saving || updating}
        onValuesChange={(_, values: SettingsFormValues) =>
          setDirty(
            Object.entries(baseline.current).some(([key, value]) => values[key as keyof SettingsFormValues] !== value),
          )
        }
        onFinishFailed={({ errorFields }) => {
          const key = String(errorFields[0]?.name[0] ?? '');
          setCategory(
            key.startsWith('smtp_')
              ? 'smtp'
              : key.startsWith('alert_') || ['monitoring_error_rate', 'monitoring_slow_ms'].includes(key)
                ? 'alerts'
                : key.startsWith('monitoring_')
                  ? 'monitoring'
                  : key.startsWith('upstream_')
                    ? 'upstream'
                    : key.startsWith('registration_')
                      ? 'registration'
                      : 'public',
          );
        }}
        onFinish={async (values) => {
          setSaving(true);
          try {
            // Password semantics: typed value replaces, explicit clear empties,
            // otherwise the stored secret stays untouched server-side.
            const { smtp_password, alert_email_recipients, alert_webhook_url, ...rest } = values;
            const saved = await onSave({
              ...rest,
              public_url: values.public_url.trim(),
              upstream_hosts: upstreamHosts(values.upstream_hosts),
              alert_email_recipients,
              monitoring_error_rate: values.monitoring_error_rate ?? settings.monitoring_error_rate ?? 5,
              monitoring_slow_ms: values.monitoring_slow_ms ?? settings.monitoring_slow_ms ?? 2000,
              alert_webhook_url: (alert_webhook_url ?? '').trim(),
              ...(smtp_password
                ? { smtp_password }
                : clearSmtpPassword
                  ? { smtp_password: '' }
                  : { smtp_password: undefined }),
            });
            if (saved) {
              const normalized = {
                ...values,
                public_url: saved.public_url ?? '',
                upstream_hosts: saved.upstream_hosts.join('\n'),
                smtp_password: '',
              };
              baseline.current = normalized;
              form.setFieldsValue(normalized);
              setClearSmtpPassword(false);
              setDirty(false);
            }
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="settings-module-grid">
          <SettingsModule
            id="settings-public"
            hidden={category !== 'public'}
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
                validationRule(
                  (value) => isPublicOrigin(value, settings.public_url_requires_https ?? true),
                  t('settings.invalidPublicUrl'),
                ),
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
            hidden={category !== 'registration'}
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
            <SettingToggle
              name="registration_email_verification"
              label={t('settings.emailVerification')}
              description={t('settings.emailVerificationHelp')}
              disabled={!settings.registration_email_verification && (!settings.smtp_host || !settings.smtp_from)}
            />
            {(!settings.smtp_host || !settings.smtp_from) && (
              <Alert type="info" showIcon message={t('settings.emailVerificationRequiresMail')} />
            )}
            <div className="settings-inline-note">
              <InfoCircleOutlined />
              <p>{t('settings.registrationScope')}</p>
            </div>
          </SettingsModule>

          <SettingsModule
            id="settings-smtp"
            hidden={category !== 'smtp'}
            icon={<MailOutlined />}
            title={t('settings.smtpModule')}
            description={t('settings.smtpDescription')}
            number="03"
            tone="orange"
          >
            <div className="settings-field-grid">
              <Form.Item name="smtp_host" label={t('settings.smtpHost')} extra={t('settings.smtpHostHelp')}>
                <Input placeholder="smtp.example.com" allowClear autoComplete="off" />
              </Form.Item>
              <Form.Item name="smtp_port" label={t('settings.smtpPort')} rules={[{ required: true }]}>
                <InputNumber min={1} max={65535} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </div>
            <div className="settings-field-grid">
              <Form.Item name="smtp_username" label={t('settings.smtpUsername')} extra={t('settings.smtpUsernameHelp')}>
                <Input allowClear autoComplete="off" />
              </Form.Item>
              <Form.Item
                name="smtp_password"
                label={t('settings.smtpPassword')}
                extra={
                  settings.smtp_password_configured
                    ? t('settings.smtpPasswordConfigured')
                    : t('settings.smtpPasswordHelp')
                }
              >
                <Input.Password autoComplete="new-password" disabled={clearSmtpPassword} />
              </Form.Item>
            </div>
            {settings.smtp_password_configured && (
              <Checkbox
                checked={clearSmtpPassword}
                disabled={!settings.managed || saving || updating}
                onChange={(event) => {
                  setClearSmtpPassword(event.target.checked);
                  if (event.target.checked) form.setFieldValue('smtp_password', '');
                  setDirty(true);
                }}
              >
                {t('settings.smtpClearPassword')}
              </Checkbox>
            )}
            <Form.Item
              name="smtp_from"
              label={t('settings.smtpFrom')}
              extra={t('settings.smtpFromHelp')}
              rules={[
                {
                  validator: (_, value) =>
                    !smtpHost.trim() || (typeof value === 'string' && value.trim())
                      ? Promise.resolve()
                      : Promise.reject(new Error(t('settings.smtpFromRequired'))),
                },
              ]}
            >
              <Input placeholder={t('settings.smtpFromPlaceholder')} allowClear autoComplete="off" />
            </Form.Item>
            <div className="settings-toggle-row">
              <div>
                <label htmlFor="smtp_secure">{t('settings.smtpSecure')}</label>
                <p id="smtp_secure-help">{t('settings.smtpSecureHelp')}</p>
              </div>
              <Form.Item name="smtp_secure" valuePropName="checked" noStyle>
                <Switch
                  id="smtp_secure"
                  aria-label={t('settings.smtpSecure')}
                  aria-describedby="smtp_secure-help"
                  checkedChildren={t('settings.on')}
                  unCheckedChildren={t('settings.off')}
                />
              </Form.Item>
            </div>
            <div className="settings-inline-note">
              <InfoCircleOutlined />
              <p>{t(mailReady ? 'settings.smtpReady' : 'settings.smtpNotConfigured')}</p>
            </div>
            <Flex gap={8} align="center">
              <Input
                value={testTo}
                onChange={(event) => setTestTo(event.target.value)}
                placeholder={t('settings.smtpTestTo')}
                style={{ maxWidth: 320 }}
                disabled={!settings.managed}
              />
              <Button
                icon={<SendOutlined />}
                loading={testingEmail}
                disabled={!mailReady || !settings.managed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testTo.trim())}
                onClick={() => void sendTestEmail()}
              >
                {t('settings.smtpTest')}
              </Button>
            </Flex>
            <p className="settings-test-hint">{t('settings.smtpTestDraft')}</p>
          </SettingsModule>

          <SettingsModule
            id="settings-upstream"
            hidden={category !== 'upstream'}
            icon={<SafetyCertificateOutlined />}
            title={t('settings.upstreamModule')}
            description={t('settings.upstreamDescription')}
            number="04"
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
                rules={[validationRule(validUpstreamHosts, t('settings.invalidHosts'))]}
              >
                <Input.TextArea
                  autoSize={{ minRows: 4, maxRows: 8 }}
                  disabled={!settings.managed || saving || updating || !allowlistEnabled}
                  placeholder={t('settings.hostsPlaceholder')}
                />
              </Form.Item>
            </div>
          </SettingsModule>

          <SettingsModule
            id="settings-monitoring"
            hidden={category !== 'monitoring'}
            icon={<BarChartOutlined />}
            title={t('settings.collectionModule')}
            description={t('settings.collectionDescription')}
            number="05"
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

          <div className="settings-module-wide" style={category !== 'alerts' ? { display: 'none' } : undefined}>
            <SettingsModule
              id="settings-alerts"
              hidden={category !== 'alerts'}
              icon={<BellOutlined />}
              title={t('settings.alertModule')}
              description={t('settings.alertDescription')}
              number="06"
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
                  >
                    <InputNumber min={1} max={100} precision={0} suffix="%" />
                  </Form.Item>
                  <Form.Item
                    name="monitoring_slow_ms"
                    label={t('settings.slowThresholdLabel')}
                    extra={t('settings.slowThresholdHelp')}
                  >
                    <InputNumber min={1} max={3600000} precision={0} suffix={t('settings.millisecondsUnit')} />
                  </Form.Item>
                  <Form.Item name="alert_email_recipients" label={t('settings.alertEmailRecipients')}>
                    <Select
                      mode="tags"
                      open={false}
                      tokenSeparators={[',', ' ', ';']}
                      placeholder={t('settings.alertEmailPlaceholder')}
                    />
                  </Form.Item>
                </div>
                <Form.Item
                  name="alert_webhook_url"
                  label={
                    <span>
                      {t('settings.alertWebhook')} <Tag>{t('settings.optional')}</Tag>
                    </span>
                  }
                  extra={t('settings.alertWebhookHelp')}
                  rules={[validationRule(validWebhookUrl, t('settings.invalidWebhook'), true)]}
                >
                  <Input placeholder="https://hooks.example.com/..." allowClear />
                </Form.Item>
              </div>
            </SettingsModule>
          </div>

          {update?.enabled && (
            <div className="settings-module-wide" style={category !== 'update' ? { display: 'none' } : undefined}>
              <SettingsModule
                id="settings-update"
                hidden={category !== 'update'}
                icon={<CloudUploadOutlined />}
                title={t('settings.updateModule')}
                description={t('settings.updateDescription')}
                number="07"
                tone="slate"
              >
                <div className="settings-alert-layout">
                  <div className="settings-update-note">
                    <CloudUploadOutlined />
                    <div>
                      <strong>
                        {update.version
                          ? t('settings.updateVersion', { version: update.version })
                          : t('settings.updateVersionUnknown')}
                      </strong>
                      <p>
                        {update.latest_version
                          ? t(
                              update.release_check_error
                                ? 'settings.updateCachedVersion'
                                : 'settings.updateLatestVersion',
                              { version: update.latest_version },
                            )
                          : t('settings.updateLatestUnknown')}
                      </p>
                      <Tag
                        color={
                          update.update_available === true
                            ? 'blue'
                            : update.update_available === false
                              ? 'green'
                              : 'default'
                        }
                      >
                        {t(
                          !update.releases_supported
                            ? 'settings.updateCustomMirror'
                            : update.release_check_error
                              ? 'settings.updateCheckFailed'
                              : update.update_available === true
                                ? 'settings.updateAvailable'
                                : update.update_available === false
                                  ? 'settings.updateCurrent'
                                  : 'settings.updateComparisonUnknown',
                        )}
                      </Tag>
                      {update.release_check_error &&
                        update.release_check_failures?.map((failure) => (
                          <p key={failure.source}>
                            {t('settings.updateSourceFailure', {
                              source: {
                                github: 'GitHub',
                                dockerhub: 'Docker Hub',
                                docker_registry: 'Docker Registry',
                              }[failure.source],
                              reason: t(`settings.updateFailure.${failure.reason}`),
                            })}
                            {failure.http_status ? ` (HTTP ${failure.http_status})` : ''}
                          </p>
                        ))}
                      <p>{t('settings.updateImage', { image: update.image || '—' })}</p>
                      <p>{t('settings.updateContainer', { container: update.container_name || '—' })}</p>
                    </div>
                  </div>
                  <div className="settings-update-action">
                    <Button
                      icon={<ReloadOutlined />}
                      loading={checkingUpdate}
                      disabled={updating || !update.releases_supported}
                      onClick={() => void checkUpdate()}
                    >
                      {t('settings.updateCheck')}
                    </Button>
                    <label htmlFor="update-target">{t('settings.updateTarget')}</label>
                    <Select
                      id="update-target"
                      aria-label={t('settings.updateTarget')}
                      value={targetTag}
                      onChange={setTargetTag}
                      disabled={updating || checkingUpdate}
                      style={{ width: '100%' }}
                      options={[
                        {
                          value: 'latest',
                          label: update.target_image.endsWith(':latest')
                            ? t('settings.updateLatest')
                            : t('settings.updateDefault', { image: update.target_image }),
                        },
                        ...update.releases.map((release) => ({ value: release.tag, label: release.tag })),
                      ]}
                    />
                    <p>
                      {t('settings.updateTargetImage', {
                        image: targetTag === 'latest' ? update.target_image : targetTag,
                      })}
                    </p>
                    <Button
                      icon={<CloudUploadOutlined />}
                      onClick={() => onUpdate(targetTag)}
                      loading={updating}
                      disabled={
                        !update.socket_available ||
                        !update.container_id ||
                        dirty ||
                        saving ||
                        checkingUpdate ||
                        (targetTag !== 'latest' && !update.releases.some((release) => release.tag === targetTag))
                      }
                    >
                      {t('settings.updateButton')}
                    </Button>
                    <p>
                      {t(
                        !update.socket_available
                          ? 'api.updateUnavailable'
                          : dirty
                            ? 'settings.updateSaveFirst'
                            : 'settings.updateHelp',
                      )}
                    </p>
                  </div>
                </div>
              </SettingsModule>
            </div>
          )}
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
            <Button
              icon={<ReloadOutlined />}
              onClick={reset}
              disabled={!settings.managed || !dirty || saving || updating}
            >
              {t('settings.restore')}
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SaveOutlined />}
              loading={saving}
              disabled={!settings.managed || updating || (settings.configured && !dirty)}
            >
              {t('settings.save')}
            </Button>
          </div>
        </footer>
      </Form>
    </div>
  );
}
