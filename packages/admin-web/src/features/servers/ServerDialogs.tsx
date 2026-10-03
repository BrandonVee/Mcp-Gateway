import { useI18n } from '../../i18n';
import {
  ApiOutlined,
  CloudServerOutlined,
  DeploymentUnitOutlined,
  LinkOutlined,
  LockOutlined,
  SearchOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Alert, Button, Checkbox, Empty, Form, Input, Modal, Segmented, Select, Switch } from 'antd';
import { useMemo, useState } from 'react';
import type {
  AddInstanceInput,
  AdminUser,
  CreateServerInput,
  DialogState,
  McpServer,
  McpInstance,
  ServerAuthInput,
  SystemSettings,
} from '../../types';
import { submitDialog } from '../../utils/operations';
import { isEndpointUrl, isOAuthUrl, validationRule } from '../../utils/validation';
import { untrustedUpstreamHost } from './upstream-allowlist';

interface UpstreamAllowlistProps {
  settings: SystemSettings | null;
  onAddUpstreamHost: (host: string) => Promise<void>;
}

interface ServerDialogsProps extends UpstreamAllowlistProps {
  state: DialogState;
  users: AdminUser[];
  busy: boolean;
  onClose: () => void;
  onCreate: (data: CreateServerInput) => void;
  onEdit: (server: McpServer, data: { name: string; display_name: string; description: string }) => void;
  onEditInstance: (server: McpServer, instance: McpInstance, data: { url: string }) => void;
  onAddInstance: (server: McpServer, data: AddInstanceInput) => void;
  onConfigureAuth: (server: McpServer, data: ServerAuthInput) => void;
  onConfigureUsers: (server: McpServer, userIds: number[], signupAccess: boolean) => void;
}

interface ServerFormValues {
  name: string;
  displayName?: string;
  description?: string;
  signup_access: boolean;
  instanceId?: string;
  url: string;
  auth_mode: 'none' | 'api_key' | 'oauth';
  api_key_header?: string;
  api_key_prefix?: string;
  oauth_authorize_url?: string;
  oauth_token_url?: string;
  oauth_client_id?: string;
  oauth_client_secret?: string;
  oauth_scopes?: string | null;
  oauth_resource?: string | null;
  oauth_issuer?: string | null;
  oauth_client_auth_method?: 'none' | 'client_secret_basic' | 'client_secret_post';
}

export function ServerDialogs(props: ServerDialogsProps) {
  if (props.state.type === 'edit-server')
    return <EditServerDialog key={props.state.server.name} {...props} server={props.state.server} />;
  if (props.state.type === 'edit-instance')
    return (
      <EditInstanceDialog
        key={props.state.instance.id}
        {...props}
        server={props.state.server}
        instance={props.state.instance}
      />
    );
  if (props.state.type === 'create-server') {
    return <CreateServerDialog {...props} />;
  }

  if (props.state.type === 'add-instance') {
    return <AddInstanceDialog key={props.state.server.name} {...props} server={props.state.server} />;
  }

  if (props.state.type === 'configure-server-auth')
    return <ConfigureAuthDialog key={props.state.server.name} {...props} server={props.state.server} />;

  if (props.state.type === 'configure-server-users')
    return <ConfigureUsersDialog key={props.state.server.name} {...props} server={props.state.server} />;

  return null;
}

function CreateServerDialog({
  busy,
  onClose,
  onCreate,
  ...allowlist
}: Pick<ServerDialogsProps, 'busy' | 'onClose' | 'onCreate'> & UpstreamAllowlistProps) {
  const { t } = useI18n();
  const [form] = Form.useForm<ServerFormValues>();

  const submit = async () => {
    await submitDialog(form, (values) =>
      onCreate({
        name: values.name,
        display_name: values.displayName || values.name,
        description: values.description?.trim() ?? '',
        signup_access: values.signup_access,
        instances: [{ id: values.instanceId || undefined, url: values.url }],
        ...authFields(values),
      }),
    );
  };

  return (
    <Modal
      open
      width={560}
      title={
        <ModalTitle
          icon={<CloudServerOutlined />}
          eyebrow={t('serverDialog.routeOnboarding')}
          title={t('serverDialog.registerMcpServer')}
        />
      }
      okText={t('serverDialog.registerSync')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      onCancel={onClose}
      onOk={submit}
    >
      <Alert
        type="info"
        showIcon
        icon={<ApiOutlined />}
        message={t('serverDialog.useHttpHttpsStreamableMcp')}
        className="dialog-alert"
      />
      <Form
        form={form}
        disabled={busy}
        layout="vertical"
        requiredMark={false}
        initialValues={{
          signup_access: false,
          auth_mode: 'none',
          api_key_header: 'authorization',
          api_key_prefix: 'Bearer ',
        }}
      >
        <Form.Item
          name="name"
          label={t('serverDialog.serverId')}
          rules={[
            { required: true, message: t('serverDialog.enterServerId') },
            {
              pattern: /^(?!\.{1,2}$)[a-zA-Z0-9._-]{1,64}$/,
              message: t('serverDialog.useLettersNumbersPeriodsUnderscores'),
            },
          ]}
        >
          <Input prefix={<DeploymentUnitOutlined />} placeholder="external-search" autoFocus />
        </Form.Item>
        <Form.Item name="displayName" label={t('serverDialog.displayName')}>
          <Input placeholder={t('serverDialog.exampleExternalSearch')} />
        </Form.Item>
        <DescriptionField />
        <Form.Item
          name="signup_access"
          label={t('serverDialog.signupAccess')}
          valuePropName="checked"
          extra={t('serverDialog.signupAccessHelp')}
        >
          <Switch />
        </Form.Item>
        <Form.Item
          name="instanceId"
          label={t('serverDialog.instanceIdOptional')}
          rules={[{ max: 256, message: t('api.invalidInstancePayload') }]}
        >
          <Input placeholder={t('serverDialog.leaveBlankGenerateUuid')} />
        </Form.Item>
        <Form.Item
          name="url"
          label={t('serverDialog.mcpEndpointUrl')}
          rules={[
            { required: true, message: t('serverDialog.enterEndpointUrl') },
            endpointUrlRule(t('serverDialog.enterValidHttpHttpsUrl')),
          ]}
        >
          <Input prefix={<LinkOutlined />} placeholder="https://mcp.example.com/mcp" />
        </Form.Item>
        <UpstreamAllowlistHint {...allowlist} busy={busy} />
        <AuthFormFields />
      </Form>
    </Modal>
  );
}

/**
 * antd's built-in `url` rule requires a dotted hostname, so it rejects container
 * and internal names like http://fx-app-1:8765/mcp. Match the backend instead:
 * any absolute http(s) URL with a host is accepted.
 */
export function endpointUrlRule(message: string) {
  return validationRule(isEndpointUrl, message);
}

function UpstreamAllowlistHint({ settings, onAddUpstreamHost, busy }: UpstreamAllowlistProps & { busy: boolean }) {
  const { t } = useI18n();
  const value = Form.useWatch('url');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<{ host: string; message: string } | null>(null);
  const host = untrustedUpstreamHost(value, settings);
  if (!host || !settings) return null;

  const addHost = async () => {
    setAdding(true);
    setError(null);
    try {
      await onAddUpstreamHost(host);
    } catch (cause) {
      setError({ host, message: cause instanceof Error ? cause.message : t('common.operationFailed') });
    } finally {
      setAdding(false);
    }
  };

  return (
    <Alert
      type="warning"
      showIcon
      className="dialog-alert"
      message={t('serverDialog.upstreamHostBlocked', { host })}
      description={
        (error?.host === host ? error.message : null) ??
        t(
          !settings.managed
            ? 'settings.environmentManaged'
            : !settings.configured
              ? 'settings.setupRequired'
              : 'serverDialog.upstreamQuickAddHelp',
        )
      }
      action={
        settings.managed && settings.configured ? (
          <Button size="small" loading={adding} disabled={busy} onClick={() => void addHost()}>
            {t('serverDialog.addUpstreamHost')}
          </Button>
        ) : undefined
      }
    />
  );
}

function DescriptionField() {
  const { t } = useI18n();
  return (
    <Form.Item
      name="description"
      label={t('serverDialog.description')}
      extra={t('serverDialog.descriptionHelp')}
      rules={[{ max: 2000, message: t('serverDialog.descriptionMax') }]}
    >
      <Input.TextArea rows={3} maxLength={2000} showCount placeholder={t('serverDialog.descriptionPlaceholder')} />
    </Form.Item>
  );
}

function EditServerDialog({
  server,
  busy,
  onClose,
  onEdit,
}: Pick<ServerDialogsProps, 'busy' | 'onClose' | 'onEdit'> & { server: McpServer }) {
  const { t } = useI18n();
  const [form] = Form.useForm<{ name: string; display_name: string; description: string }>();
  return (
    <Modal
      open
      width={560}
      title={t('serverDialog.editServer')}
      okText={t('serverDialog.saveSettings')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      onCancel={onClose}
      onOk={() =>
        submitDialog(form, (values) =>
          onEdit(server, {
            name: values.name.trim(),
            display_name: values.display_name.trim(),
            description: values.description.trim(),
          }),
        )
      }
    >
      <Form
        form={form}
        disabled={busy}
        layout="vertical"
        requiredMark={false}
        initialValues={{ name: server.name, display_name: server.display_name, description: server.description ?? '' }}
      >
        <Form.Item
          name="name"
          label={t('serverDialog.serverId')}
          extra={t('serverDialog.serverIdEditable')}
          rules={[
            { required: true, message: t('serverDialog.enterServerId') },
            { pattern: /^(?!\.{1,2}$)[a-zA-Z0-9._-]{1,64}$/, message: t('serverDialog.serverIdFormat') },
          ]}
        >
          <Input prefix={<DeploymentUnitOutlined />} maxLength={64} />
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(previous, next) => previous.name !== next.name}>
          {({ getFieldValue }) => (
            <div className="server-route-preview">
              <span>{t('serverDialog.routePreview')}</span>
              <code>{`/mcp/${getFieldValue('name') || ''}`}</code>
              {getFieldValue('name')?.trim() !== server.name && (
                <Alert
                  type="warning"
                  showIcon
                  message={t('serverDialog.renameHelp')}
                  description={server.auth_mode === 'oauth' ? t('serverDialog.renameOAuthHelp') : undefined}
                />
              )}
            </div>
          )}
        </Form.Item>
        <Form.Item
          name="display_name"
          label={t('serverDialog.displayName')}
          rules={[{ required: true, whitespace: true, message: t('serverDialog.enterDisplayName') }]}
        >
          <Input autoFocus />
        </Form.Item>
        <DescriptionField />
      </Form>
    </Modal>
  );
}

function EditInstanceDialog({
  server,
  instance,
  busy,
  onClose,
  onEditInstance,
  ...allowlist
}: Pick<ServerDialogsProps, 'busy' | 'onClose' | 'onEditInstance'> &
  UpstreamAllowlistProps & { server: McpServer; instance: McpInstance }) {
  const { t } = useI18n();
  const [form] = Form.useForm<{ url: string }>();
  return (
    <Modal
      open
      width={560}
      title={t('serverDialog.editInstance')}
      okText={t('serverDialog.saveSettings')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      onCancel={onClose}
      onOk={() => submitDialog(form, (values) => onEditInstance(server, instance, { url: values.url.trim() }))}
    >
      <Form form={form} disabled={busy} layout="vertical" requiredMark={false} initialValues={{ url: instance.url }}>
        <Form.Item label={t('serverDialog.instanceId')}>
          <Input value={instance.id} disabled />
        </Form.Item>
        <Form.Item
          name="url"
          label={t('serverDialog.endpointUrl')}
          extra={t('serverDialog.endpointChangeHelp')}
          rules={[
            { required: true, message: t('serverDialog.enterEndpointUrl') },
            endpointUrlRule(t('serverDialog.enterValidHttpHttpsUrl')),
          ]}
        >
          <Input prefix={<LinkOutlined />} autoFocus />
        </Form.Item>
        <UpstreamAllowlistHint {...allowlist} busy={busy} />
      </Form>
    </Modal>
  );
}

export function authFields(values: ServerFormValues): ServerAuthInput {
  return {
    auth_mode: values.auth_mode,
    ...(values.auth_mode === 'api_key'
      ? { api_key_header: values.api_key_header, api_key_prefix: values.api_key_prefix }
      : {}),
    ...(values.auth_mode === 'oauth'
      ? {
          oauth_authorize_url: values.oauth_authorize_url?.trim(),
          oauth_token_url: values.oauth_token_url?.trim(),
          oauth_client_id: values.oauth_client_id?.trim(),
          oauth_client_secret:
            values.oauth_client_auth_method === 'none' ? undefined : values.oauth_client_secret || undefined,
          oauth_scopes: values.oauth_scopes?.trim() ?? '',
          oauth_resource: values.oauth_resource?.trim() ?? '',
          oauth_issuer: values.oauth_issuer?.trim() ?? '',
          oauth_client_auth_method: values.oauth_client_auth_method,
        }
      : {}),
  };
}

function AuthFormFields({ server }: { server?: McpServer } = {}) {
  const { t } = useI18n();
  return (
    <>
      <Form.Item name="auth_mode" label={t('serverDialog.userConnectionMethod')}>
        <Select
          options={[
            { value: 'none', label: t('serverDialog.noAdditionalAuth') },
            { value: 'api_key', label: t('serverDialog.userApiKey') },
            { value: 'oauth', label: t('serverDialog.userOauth') },
          ]}
        />
      </Form.Item>
      <Form.Item noStyle shouldUpdate={(prev, next) => prev.auth_mode !== next.auth_mode}>
        {({ getFieldValue }) =>
          getFieldValue('auth_mode') === 'api_key' ? (
            <>
              <Form.Item
                name="api_key_header"
                label={t('serverDialog.upstreamHeader')}
                rules={[
                  { required: true, message: t('serverDialog.enterUpstreamHeader') },
                  { pattern: /^(authorization|x-[a-z0-9-]{1,60})$/i, message: t('api.invalidKeyHeader') },
                ]}
              >
                <Input placeholder={t('serverDialog.authorizationXApiKey')} />
              </Form.Item>
              <Form.Item
                name="api_key_prefix"
                label={t('serverDialog.valuePrefix')}
                rules={[
                  validationRule(
                    (value) => value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value),
                    t('api.invalidKeyPrefix'),
                    true,
                  ),
                ]}
              >
                <Input placeholder={t('serverDialog.bearerOptional')} />
              </Form.Item>
              <Alert type="info" showIcon message={t('serverDialog.usersEnterOwnKeyConnections')} />
            </>
          ) : getFieldValue('auth_mode') === 'oauth' ? (
            <>
              <Form.Item
                name="oauth_authorize_url"
                label={t('serverDialog.authorizationEndpoint')}
                rules={[
                  { required: true, message: t('api.invalidOAuthUrl') },
                  validationRule(isOAuthUrl, t('api.invalidOAuthUrl')),
                ]}
              >
                <Input placeholder="https://provider.example/authorize" />
              </Form.Item>
              <Form.Item
                name="oauth_token_url"
                label={t('serverDialog.tokenEndpoint')}
                rules={[
                  { required: true, message: t('api.invalidOAuthUrl') },
                  validationRule(isOAuthUrl, t('api.invalidOAuthUrl')),
                ]}
              >
                <Input placeholder="https://provider.example/token" />
              </Form.Item>
              <Form.Item
                name="oauth_client_id"
                label={t('serverDialog.clientId')}
                rules={[{ required: true, whitespace: true, message: t('api.oauthClientIdRequired') }]}
              >
                <Input />
              </Form.Item>
              <Form.Item
                name="oauth_client_auth_method"
                label={t('serverDialog.tokenEndpointClientAuth')}
                initialValue="none"
              >
                <Select
                  options={[
                    { value: 'none', label: t('serverDialog.nonePublicClient') },
                    { value: 'client_secret_basic', label: t('serverDialog.clientSecretBasic') },
                    { value: 'client_secret_post', label: t('serverDialog.clientSecretPost') },
                  ]}
                />
              </Form.Item>
              <Form.Item
                noStyle
                shouldUpdate={(previous, next) => previous.oauth_client_auth_method !== next.oauth_client_auth_method}
              >
                {({ getFieldValue }) =>
                  getFieldValue('oauth_client_auth_method') !== 'none' && (
                    <Form.Item
                      name="oauth_client_secret"
                      label={t('serverDialog.clientSecret')}
                      extra={t(
                        server?.oauth_client_secret_configured
                          ? 'serverDialog.secretRetained'
                          : 'api.oauthSecretRequired',
                      )}
                      rules={[
                        { required: !server?.oauth_client_secret_configured, message: t('api.oauthSecretRequired') },
                        { max: 4096, message: t('api.invalidOAuthSecret') },
                      ]}
                    >
                      <Input.Password autoComplete="new-password" />
                    </Form.Item>
                  )
                }
              </Form.Item>
              <Form.Item
                name="oauth_scopes"
                label={t('serverDialog.scopes')}
                rules={[{ max: 1000, message: t('api.invalidOAuthScopes') }]}
              >
                <Input placeholder="read write" />
              </Form.Item>
              <Form.Item
                name="oauth_resource"
                label={t('serverDialog.resourceUrlOptional')}
                rules={[validationRule(isOAuthUrl, t('api.invalidOAuthResource'), true)]}
              >
                <Input placeholder="https://mcp.example.com/mcp" />
              </Form.Item>
              <Form.Item
                name="oauth_issuer"
                label={t('serverDialog.responseIssuerOptionalUseWhen')}
                rules={[validationRule(isOAuthUrl, t('api.invalidOAuthIssuer'), true)]}
              >
                <Input placeholder="https://provider.example" />
              </Form.Item>
              <Alert type="info" showIcon message={t('serverDialog.registerCallbackProviderHttpsAuth')} />
            </>
          ) : null
        }
      </Form.Item>
    </>
  );
}

function ConfigureAuthDialog({
  server,
  busy,
  onClose,
  onConfigureAuth,
}: Pick<ServerDialogsProps, 'busy' | 'onClose' | 'onConfigureAuth'> & { server: McpServer }) {
  const { t } = useI18n();
  const [form] = Form.useForm<ServerFormValues>();
  return (
    <Modal
      open
      width={600}
      title={t('serverDialog.configureUserConnectionServer', { server: server.display_name })}
      okText={t('serverDialog.saveSettings')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      onCancel={onClose}
      onOk={() => submitDialog(form, (values) => onConfigureAuth(server, authFields(values)))}
    >
      <Form
        form={form}
        disabled={busy}
        layout="vertical"
        requiredMark={false}
        initialValues={{
          auth_mode: server.auth_mode,
          api_key_header: server.api_key_header,
          api_key_prefix: server.api_key_prefix,
          oauth_authorize_url: server.oauth_authorize_url,
          oauth_token_url: server.oauth_token_url,
          oauth_client_id: server.oauth_client_id,
          oauth_scopes: server.oauth_scopes,
          oauth_resource: server.oauth_resource,
          oauth_issuer: server.oauth_issuer,
          oauth_client_auth_method: server.oauth_client_auth_method,
        }}
      >
        <Alert type="warning" showIcon className="dialog-alert" message={t('serverDialog.authChangeHelp')} />
        <AuthFormFields server={server} />
      </Form>
    </Modal>
  );
}

function ConfigureUsersDialog({
  server,
  users,
  busy,
  onClose,
  onConfigureUsers,
}: Pick<ServerDialogsProps, 'users' | 'busy' | 'onClose' | 'onConfigureUsers'> & { server: McpServer }) {
  const { t } = useI18n();
  const [keyword, setKeyword] = useState('');
  const [filter, setFilter] = useState<'all' | 'granted' | 'ungranted'>('all');
  const initialIds = useMemo(
    () =>
      users
        .filter((user) => user.role === 'user' && !user.servers.includes('*') && user.servers.includes(server.name))
        .map((user) => user.id),
    [server.name, users],
  );
  const [selectedIds, setSelectedIds] = useState<number[]>(initialIds);
  const [signupAccess, setSignupAccess] = useState(server.signup_access ?? false);
  const selected = new Set(selectedIds);
  const fixedUsers = users.filter((user) => user.role === 'admin' || user.servers.includes('*'));
  const ordinaryUsers = users.filter((user) => user.role === 'user' && !user.servers.includes('*'));
  const normalizedKeyword = keyword.trim().toLocaleLowerCase();
  const visibleUsers = [...fixedUsers, ...ordinaryUsers]
    .filter((user) => user.username.toLocaleLowerCase().includes(normalizedKeyword))
    .filter(
      (user) =>
        filter === 'all' ||
        (filter === 'granted'
          ? user.role === 'admin' || user.servers.includes('*') || selected.has(user.id)
          : user.role === 'user' && !user.servers.includes('*') && !selected.has(user.id)),
    );
  const visibleEditableIds = visibleUsers
    .filter((user) => user.role === 'user' && !user.servers.includes('*'))
    .map((user) => user.id);
  const changed =
    signupAccess !== (server.signup_access ?? false) ||
    selectedIds.length !== initialIds.length ||
    initialIds.some((id) => !selected.has(id));

  const toggleUser = (id: number, checked: boolean) => {
    setSelectedIds((current) => (checked ? [...current, id] : current.filter((item) => item !== id)));
  };
  const setVisible = (checked: boolean) => {
    setSelectedIds((current) =>
      checked
        ? [...new Set([...current, ...visibleEditableIds])]
        : current.filter((id) => !visibleEditableIds.includes(id)),
    );
  };

  return (
    <Modal
      open
      width={660}
      title={
        <ModalTitle
          icon={<TeamOutlined />}
          eyebrow={t('serverDialog.accessManagement')}
          title={t('serverDialog.assignServerAccessServer', { server: server.display_name })}
        />
      }
      okText={t('serverDialog.saveGrants')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: busy || !changed }}
      confirmLoading={busy}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      onCancel={onClose}
      onOk={() => onConfigureUsers(server, selectedIds, signupAccess)}
    >
      <div className="signup-access-setting">
        <div>
          <strong>{t('serverDialog.signupAccess')}</strong>
          <p>{t('serverDialog.signupAccessHelp')}</p>
        </div>
        <Switch
          disabled={busy}
          checked={signupAccess}
          onChange={setSignupAccess}
          aria-label={t('serverDialog.signupAccess')}
        />
      </div>
      <div className="access-summary">
        <div>
          <strong>{selectedIds.length}</strong>
          <span>{t('serverDialog.directGrants')}</span>
        </div>
        <div>
          <strong>{fixedUsers.length}</strong>
          <span>{t('serverDialog.inheritedGrants')}</span>
        </div>
        <p>{t('serverDialog.grantChangesHint')}</p>
      </div>
      <div className="access-toolbar">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={t('serverDialog.searchUsers')}
          aria-label={t('serverDialog.searchUsers')}
        />
        <Segmented
          value={filter}
          onChange={(value) => setFilter(value as typeof filter)}
          options={[
            { value: 'all', label: t('common.all') },
            { value: 'granted', label: t('serverDialog.granted') },
            { value: 'ungranted', label: t('serverDialog.ungranted') },
          ]}
        />
      </div>
      <div className="access-list-heading">
        <span>{t('serverDialog.userResults', { count: visibleUsers.length })}</span>
        {visibleEditableIds.length > 0 && (
          <span className="access-bulk-actions">
            {visibleEditableIds.some((id) => !selected.has(id)) && (
              <Button disabled={busy} type="link" size="small" onClick={() => setVisible(true)}>
                {t('serverDialog.grantVisible')}
              </Button>
            )}
            {visibleEditableIds.some((id) => selected.has(id)) && (
              <Button disabled={busy} type="link" size="small" onClick={() => setVisible(false)}>
                {t('serverDialog.revokeVisible')}
              </Button>
            )}
          </span>
        )}
      </div>
      <div className="access-user-list">
        {visibleUsers.length ? (
          visibleUsers.map((user) => {
            const inherited = user.role === 'admin' || user.servers.includes('*');
            const accessType =
              user.role === 'admin'
                ? t('serverDialog.adminAccess')
                : user.servers.includes('*')
                  ? t('serverDialog.wildcardAccess')
                  : t('common.standardUser');
            const identity = (
              <span className="access-user-detail">
                <span className="access-user-avatar" aria-hidden="true">
                  {user.username.slice(0, 1).toLocaleUpperCase()}
                </span>
                <span className="access-user-name">
                  <strong>{user.username}</strong>
                  <small>
                    {accessType}
                    {user.disabled ? t('serverDialog.signDisabled') : ''}
                  </small>
                </span>
                <span
                  className={`access-user-state ${inherited ? 'is-inherited' : selected.has(user.id) ? 'is-granted' : ''}`}
                >
                  {inherited
                    ? t('serverDialog.inherited')
                    : selected.has(user.id)
                      ? t('serverDialog.granted')
                      : t('serverDialog.ungranted')}
                </span>
              </span>
            );
            return inherited ? (
              <div className="access-user-row is-fixed" key={user.id}>
                <LockOutlined className="access-user-lock" />
                {identity}
              </div>
            ) : (
              <Checkbox
                className="access-user-row"
                key={user.id}
                disabled={busy}
                checked={selected.has(user.id)}
                onChange={(event) => toggleUser(user.id, event.target.checked)}
              >
                {identity}
              </Checkbox>
            );
          })
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('serverDialog.noMatchingUsers')} />
        )}
      </div>
    </Modal>
  );
}

function AddInstanceDialog({
  server,
  busy,
  onClose,
  onAddInstance,
  ...allowlist
}: Pick<ServerDialogsProps, 'busy' | 'onClose' | 'onAddInstance'> &
  UpstreamAllowlistProps & {
    server: McpServer;
  }) {
  const { t } = useI18n();
  const [form] = Form.useForm<AddInstanceInput>();

  return (
    <Modal
      open
      title={
        <ModalTitle
          icon={<DeploymentUnitOutlined />}
          eyebrow={t('serverDialog.upstreamCapacity')}
          title={t('serverDialog.addInstanceServer', { server: server.name })}
        />
      }
      okText={t('serverDialog.addPool')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      onCancel={onClose}
      onOk={() =>
        submitDialog(form, (values) =>
          onAddInstance(server, {
            id: values.id || undefined,
            url: values.url,
          }),
        )
      }
    >
      <Form form={form} disabled={busy} layout="vertical" requiredMark={false}>
        <Form.Item
          name="id"
          label={t('serverDialog.instanceIdOptional')}
          rules={[{ max: 256, message: t('api.invalidInstancePayload') }]}
        >
          <Input placeholder={t('serverDialog.leaveBlankGenerateUuid')} autoFocus />
        </Form.Item>
        <Form.Item
          name="url"
          label={t('serverDialog.endpointUrl')}
          rules={[
            { required: true, message: t('serverDialog.enterEndpointUrl') },
            endpointUrlRule(t('serverDialog.enterValidHttpHttpsUrl')),
          ]}
        >
          <Input prefix={<LinkOutlined />} placeholder="https://host.example/mcp" />
        </Form.Item>
        <UpstreamAllowlistHint {...allowlist} busy={busy} />
      </Form>
    </Modal>
  );
}

function ModalTitle({ icon, eyebrow, title }: { icon: React.ReactNode; eyebrow: string; title: string }) {
  return (
    <span className="modal-title">
      <span>{icon}</span>
      <span>
        <small>{eyebrow}</small>
        <strong>{title}</strong>
      </span>
    </span>
  );
}
