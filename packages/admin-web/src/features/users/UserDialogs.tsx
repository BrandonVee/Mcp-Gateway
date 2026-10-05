import { useI18n } from '../../i18n';
import { EditOutlined, InfoCircleOutlined, LockOutlined, MailOutlined, UserAddOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Form, Input, Modal, Radio, Select, Switch } from 'antd';
import { submitDialog } from '../../utils/operations';
import type { AdminUser, CreateUserInput, DialogState, McpServer, UpdateUserInput } from '../../types';

interface UserDialogsProps {
  state: DialogState;
  servers: McpServer[];
  busy: boolean;
  onClose: () => void;
  onCreate: (data: CreateUserInput) => void;
  onEdit: (user: AdminUser, data: UpdateUserInput) => void;
  onAssign: (user: AdminUser, servers: string[]) => void;
  onPassword: (user: AdminUser, password: string) => void;
}

export function UserDialogs(props: UserDialogsProps) {
  if (props.state.type === 'create-user') {
    return <CreateUserDialog {...props} />;
  }

  if (props.state.type === 'edit-user') {
    return <EditUserDialog key={props.state.user.id} {...props} user={props.state.user} />;
  }

  if (props.state.type === 'assign-user') {
    return <AssignUserDialog key={props.state.user.id} {...props} user={props.state.user} />;
  }

  if (props.state.type === 'reset-password') {
    return <ResetPasswordDialog key={props.state.user.id} {...props} user={props.state.user} />;
  }

  return null;
}

function CreateUserDialog({
  servers,
  busy,
  onClose,
  onCreate,
}: Pick<UserDialogsProps, 'servers' | 'busy' | 'onClose' | 'onCreate'>) {
  const { t } = useI18n();
  const [form] = Form.useForm<CreateUserInput & { all_servers?: boolean }>();
  const role = Form.useWatch('role', form) ?? 'user';
  const allServers = Form.useWatch('all_servers', form) ?? false;

  return (
    <Modal
      open
      title={
        <ModalTitle
          icon={<UserAddOutlined />}
          eyebrow={t('userDialog.identityProvisioning')}
          title={t('userDialog.createIdentity')}
        />
      }
      okText={t('userDialog.createUser')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      okButtonProps={{ disabled: busy }}
      onCancel={onClose}
      onOk={() =>
        submitDialog(form, (values) =>
          onCreate({
            username: values.username.trim(),
            password: values.password,
            role: values.role,
            email: values.email?.trim() || undefined,
            servers: values.role === 'admin' ? [] : values.all_servers ? ['*'] : (values.servers ?? []),
          }),
        )
      }
    >
      <Form<CreateUserInput & { all_servers?: boolean }>
        form={form}
        disabled={busy}
        layout="vertical"
        requiredMark={false}
        initialValues={{ role: 'user', servers: [], all_servers: false }}
      >
        <Form.Item
          name="username"
          normalize={(value: string) => value.trim()}
          label={t('connections.username')}
          rules={[
            { required: true, message: t('connections.enterUsername') },
            { pattern: /^[a-zA-Z0-9._-]{2,64}$/, message: t('auth.signup.usernameRule') },
          ]}
        >
          <Input placeholder={t('userDialog.exampleDataAgent')} autoFocus />
        </Form.Item>
        <Form.Item
          name="email"
          label={t('userDialog.emailOptional')}
          rules={[{ type: 'email', message: t('auth.signup.emailRule') }]}
        >
          <Input prefix={<MailOutlined />} placeholder={t('auth.signup.emailPlaceholder')} autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="password"
          label={t('userDialog.initialPassword')}
          rules={[
            { required: true, message: t('userDialog.enterInitialPassword') },
            { min: 12, max: 256, message: t('auth.signup.passwordRule') },
          ]}
        >
          <Input.Password
            autoComplete="new-password"
            prefix={<LockOutlined />}
            placeholder={t('userDialog.least12Characters')}
          />
        </Form.Item>
        <Form.Item name="role" label={t('common.role')}>
          <Radio.Group optionType="button" buttonStyle="solid">
            <Radio.Button value="user">{t('common.standardUser')}</Radio.Button>
            <Radio.Button value="admin">{t('common.administrator')}</Radio.Button>
          </Radio.Group>
        </Form.Item>
        {role === 'user' && (
          <>
            <Form.Item name="all_servers" valuePropName="checked" className="wildcard-grant">
              <Checkbox>{t('userDialog.serversIncludingFutureServers')}</Checkbox>
            </Form.Item>
            {!allServers && (
              <>
                <div className="permission-actions">
                  <Button
                    type="link"
                    size="small"
                    disabled={busy || servers.length === 0}
                    onClick={() =>
                      form.setFieldValue(
                        'servers',
                        servers.map((server) => server.name),
                      )
                    }
                  >
                    {t('userDialog.selectAllServers')}
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    disabled={busy || servers.length === 0}
                    onClick={() => form.setFieldValue('servers', [])}
                  >
                    {t('userDialog.clearServerSelection')}
                  </Button>
                </div>
                <Form.Item name="servers" label={t('userDialog.specificServerAccess')}>
                  <Checkbox.Group className="permission-grid">
                    {servers.map((server) => (
                      <Checkbox key={server.name} value={server.name}>
                        {server.display_name}
                        <code>{server.name}</code>
                      </Checkbox>
                    ))}
                  </Checkbox.Group>
                </Form.Item>
              </>
            )}
          </>
        )}
      </Form>
    </Modal>
  );
}

function EditUserDialog({
  user,
  busy,
  onClose,
  onEdit,
}: Pick<UserDialogsProps, 'busy' | 'onClose' | 'onEdit'> & {
  user: AdminUser;
}) {
  const { t } = useI18n();
  const [form] = Form.useForm<{ username: string; email: string; role: 'admin' | 'user'; email_verified: boolean }>();

  return (
    <Modal
      open
      title={
        <ModalTitle
          icon={<EditOutlined />}
          eyebrow={t('userDialog.identityMaintenance')}
          title={t('userDialog.editUserName', { user: user.username })}
        />
      }
      okText={t('userDialog.saveUser')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      okButtonProps={{ disabled: busy }}
      onCancel={onClose}
      onOk={() =>
        submitDialog(form, (values) =>
          onEdit(user, {
            username: values.username.trim(),
            role: values.role,
            email: values.email.trim() || null,
            email_verified: values.email_verified,
          }),
        )
      }
    >
      <Alert type="info" showIcon className="dialog-alert" message={t('userDialog.editUserHelp')} />
      <Form
        form={form}
        disabled={busy}
        layout="vertical"
        requiredMark={false}
        initialValues={{
          username: user.username,
          email: user.email ?? '',
          role: user.role,
          email_verified: user.email_verified,
        }}
      >
        <Form.Item
          name="username"
          normalize={(value: string) => value.trim()}
          label={t('connections.username')}
          rules={[
            { required: true, message: t('connections.enterUsername') },
            { pattern: /^[a-zA-Z0-9._-]{2,64}$/, message: t('auth.signup.usernameRule') },
          ]}
        >
          <Input autoFocus />
        </Form.Item>
        <Form.Item
          name="email"
          label={t('userDialog.emailOptional')}
          extra={t('userDialog.emailChangeHelp')}
          rules={[{ type: 'email', message: t('auth.signup.emailRule') }]}
        >
          <Input prefix={<MailOutlined />} placeholder={t('auth.signup.emailPlaceholder')} allowClear />
        </Form.Item>
        <Form.Item name="role" label={t('common.role')}>
          <Radio.Group optionType="button" buttonStyle="solid">
            <Radio.Button value="user">{t('common.standardUser')}</Radio.Button>
            <Radio.Button value="admin">{t('common.administrator')}</Radio.Button>
          </Radio.Group>
        </Form.Item>
        <Form.Item name="email_verified" label={t('users.emailVerified')} valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function AssignUserDialog({
  user,
  servers,
  busy,
  onClose,
  onAssign,
}: Pick<UserDialogsProps, 'servers' | 'busy' | 'onClose' | 'onAssign'> & {
  user: AdminUser;
}) {
  const { t } = useI18n();
  const [form] = Form.useForm<{ servers: string[]; all_servers: boolean }>();
  const allServers = Form.useWatch('all_servers', form) ?? user.servers.includes('*');

  return (
    <Modal
      open
      title={
        <ModalTitle
          icon={<InfoCircleOutlined />}
          eyebrow={t('userDialog.accessMatrix')}
          title={t('userDialog.assignAccessUser', { user: user.username })}
        />
      }
      okText={t('userDialog.saveAccessScope')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      okButtonProps={{ disabled: busy }}
      onCancel={onClose}
      onOk={() => submitDialog(form, (values) => onAssign(user, values.all_servers ? ['*'] : (values.servers ?? [])))}
    >
      <Alert
        type="info"
        showIcon
        message={t('userDialog.wildcardAccessIncludesCurrentFuture')}
        className="dialog-alert"
      />
      <Form
        form={form}
        disabled={busy}
        layout="vertical"
        initialValues={{
          servers: user.servers.filter((name) => name !== '*'),
          all_servers: user.servers.includes('*'),
        }}
      >
        <Form.Item name="all_servers" valuePropName="checked" className="wildcard-grant">
          <Checkbox>{t('userDialog.serversIncludingFutureServers')}</Checkbox>
        </Form.Item>
        {!allServers && (
          <Form.Item name="servers" label={t('userDialog.availableLogicalMcpServers')}>
            <Select
              mode="multiple"
              allowClear
              placeholder={t('userDialog.selectServers')}
              options={servers.map((server) => ({
                label: server.enabled ? server.display_name : `${server.display_name} (${t('servers.paused')})`,
                value: server.name,
              }))}
            />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

function ResetPasswordDialog({
  user,
  busy,
  onClose,
  onPassword,
}: Pick<UserDialogsProps, 'busy' | 'onClose' | 'onPassword'> & {
  user: AdminUser;
}) {
  const { t } = useI18n();
  const [form] = Form.useForm<{ password: string }>();

  return (
    <Modal
      open
      title={
        <ModalTitle
          icon={<LockOutlined />}
          eyebrow={t('userDialog.credentialRotation')}
          title={t('userDialog.resetPasswordUser', { user: user.username })}
        />
      }
      okText={t('userDialog.resetPassword')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      closable={!busy}
      keyboard={!busy}
      maskClosable={!busy}
      cancelButtonProps={{ disabled: busy }}
      okButtonProps={{ disabled: busy }}
      onCancel={onClose}
      onOk={() => submitDialog(form, (values) => onPassword(user, values.password))}
    >
      <Alert type="warning" showIcon className="dialog-alert" message={t('userDialog.passwordResetHelp')} />
      <Form form={form} disabled={busy} layout="vertical" requiredMark={false}>
        <Form.Item
          name="password"
          label={t('userDialog.newPassword')}
          rules={[
            { required: true, message: t('userDialog.enterNewPassword') },
            { min: 12, max: 256, message: t('auth.signup.passwordRule') },
          ]}
        >
          <Input.Password
            autoComplete="new-password"
            prefix={<LockOutlined />}
            placeholder={t('userDialog.least12Characters')}
            autoFocus
          />
        </Form.Item>
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
