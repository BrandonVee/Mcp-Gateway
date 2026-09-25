import { useI18n } from "../../i18n";
import {
  ApiOutlined,
  CloudServerOutlined,
  DeploymentUnitOutlined,
  LinkOutlined,
} from "@ant-design/icons";
import { Alert, Form, Input, Modal, Select } from "antd";
import type {
  AddInstanceInput,
  AdminUser,
  CreateServerInput,
  DialogState,
  McpServer,
  ServerAuthInput,
} from "../../types";

interface ServerDialogsProps {
  state: DialogState;
  users: AdminUser[];
  busy: boolean;
  onClose: () => void;
  onCreate: (data: CreateServerInput) => void;
  onAddInstance: (server: McpServer, data: AddInstanceInput) => void;
  onConfigureAuth: (server: McpServer, data: ServerAuthInput) => void;
  onConfigureUsers: (server: McpServer, userIds: number[]) => void;
}

interface ServerFormValues {
  name: string;
  displayName?: string;
  instanceId?: string;
  url: string;
  auth_mode: "none" | "api_key" | "oauth";
  api_key_header?: string;
  api_key_prefix?: string;
  oauth_authorize_url?: string;
  oauth_token_url?: string;
  oauth_client_id?: string;
  oauth_client_secret?: string;
  oauth_scopes?: string;
  oauth_resource?: string;
  oauth_issuer?: string;
  oauth_client_auth_method?: "none" | "client_secret_basic" | "client_secret_post";
}

export function ServerDialogs(props: ServerDialogsProps) {
  if (props.state.type === "create-server") {
    return <CreateServerDialog {...props} />;
  }

  if (props.state.type === "add-instance") {
    return <AddInstanceDialog {...props} server={props.state.server} />;
  }

  if (props.state.type === "configure-server-auth") return <ConfigureAuthDialog {...props} server={props.state.server} />;

  if (props.state.type === "configure-server-users") return <ConfigureUsersDialog {...props} server={props.state.server} />;

  return null;
}

function CreateServerDialog({
  busy,
  onClose,
  onCreate,
}: Pick<ServerDialogsProps, "busy" | "onClose" | "onCreate">) {
  const { t } = useI18n();
  const [form] = Form.useForm<ServerFormValues>();

  const submit = async () => {
    const values = await form.validateFields();
    onCreate({
      name: values.name,
      display_name: values.displayName || values.name,
      instances: [{ id: values.instanceId || undefined, url: values.url }],
      ...authFields(values),
    });
  };

  return (
    <Modal
      open
      width={560}
      title={
        <ModalTitle
          icon={<CloudServerOutlined />}
          eyebrow="ROUTE ONBOARDING"
          title={t("serverDialog.registerMcpServer")}
        />
      }
      okText={t("serverDialog.registerSync")}
      cancelText={t("common.cancel")}
      confirmLoading={busy}
      onCancel={onClose}
      onOk={submit}
    >
      <Alert
        type="info"
        showIcon
        icon={<ApiOutlined />}
        message={t("serverDialog.useHttpHttpsStreamableMcp")}
        className="dialog-alert"
      />
      <Form form={form} layout="vertical" requiredMark={false} initialValues={{ auth_mode: "none", api_key_header: "authorization", api_key_prefix: "Bearer " }}>
        <Form.Item
          name="name"
          label={t("serverDialog.serverId")}
          rules={[
            { required: true, message: t("serverDialog.enterServerId") },
            {
              pattern: /^[a-zA-Z0-9._-]+$/,
              message: t("serverDialog.useLettersNumbersPeriodsUnderscores"),
            },
          ]}
        >
          <Input
            prefix={<DeploymentUnitOutlined />}
            placeholder="external-search"
            autoFocus
          />
        </Form.Item>
        <Form.Item name="displayName" label={t("serverDialog.displayName")}>
          <Input placeholder="External Search" />
        </Form.Item>
        <Form.Item name="instanceId" label={t("serverDialog.instanceIdOptional")}>
          <Input placeholder={t("serverDialog.leaveBlankGenerateUuid")} />
        </Form.Item>
        <Form.Item
          name="url"
          label="MCP Endpoint URL"
          rules={[
            { required: true, message: t("serverDialog.enterEndpointUrl") },
            { type: "url", message: t("serverDialog.enterValidHttpHttpsUrl") },
          ]}
        >
          <Input
            prefix={<LinkOutlined />}
            placeholder="https://mcp.example.com/mcp"
          />
        </Form.Item>
        <AuthFormFields />
      </Form>
    </Modal>
  );
}

function authFields(values: ServerFormValues): ServerAuthInput {
  return {
    auth_mode: values.auth_mode,
    ...(values.auth_mode === "api_key" ? { api_key_header: values.api_key_header, api_key_prefix: values.api_key_prefix } : {}),
    ...(values.auth_mode === "oauth" ? {
      oauth_authorize_url: values.oauth_authorize_url,
      oauth_token_url: values.oauth_token_url,
      oauth_client_id: values.oauth_client_id,
      oauth_client_secret: values.oauth_client_secret || undefined,
      oauth_scopes: values.oauth_scopes,
      oauth_resource: values.oauth_resource,
      oauth_issuer: values.oauth_issuer,
      oauth_client_auth_method: values.oauth_client_auth_method,
    } : {}),
  };
}

function AuthFormFields() {
  const { t } = useI18n();
  return <>
    <Form.Item name="auth_mode" label={t("serverDialog.userConnectionMethod")}><Select options={[
      { value: "none", label: t("serverDialog.noAdditionalAuth") }, { value: "api_key", label: t("serverDialog.userApiKey") }, { value: "oauth", label: t("serverDialog.userOauth") },
    ]} /></Form.Item>
    <Form.Item noStyle shouldUpdate={(prev, next) => prev.auth_mode !== next.auth_mode}>
      {({ getFieldValue }) => getFieldValue("auth_mode") === "api_key" ? <>
        <Form.Item name="api_key_header" label={t("serverDialog.upstreamHeader")} rules={[{ required: true, message: t("serverDialog.enterUpstreamHeader") }]}><Input placeholder={t("serverDialog.authorizationXApiKey")} /></Form.Item>
        <Form.Item name="api_key_prefix" label={t("serverDialog.valuePrefix")}><Input placeholder={t("serverDialog.bearerOptional")} /></Form.Item>
        <Alert type="info" showIcon message={t("serverDialog.usersEnterOwnKeyConnections")} />
      </> : getFieldValue("auth_mode") === "oauth" ? <>
        <Form.Item name="oauth_authorize_url" label={t("serverDialog.authorizationEndpoint")} rules={[{ required: true }, { type: "url" }]}><Input placeholder="https://provider.example/authorize" /></Form.Item>
        <Form.Item name="oauth_token_url" label={t("serverDialog.tokenEndpoint")} rules={[{ required: true }, { type: "url" }]}><Input placeholder="https://provider.example/token" /></Form.Item>
        <Form.Item name="oauth_client_id" label="Client ID" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="oauth_client_secret" label={t("serverDialog.clientSecretOptionalPublicClients")}><Input.Password autoComplete="off" /></Form.Item>
        <Form.Item name="oauth_client_auth_method" label={t("serverDialog.tokenEndpointClientAuth")} initialValue="none"><Select options={[
          { value: "none", label: t("serverDialog.nonePublicClient") }, { value: "client_secret_basic", label: "Client Secret Basic" },
          { value: "client_secret_post", label: "Client Secret Post" },
        ]} /></Form.Item>
        <Form.Item name="oauth_scopes" label="Scopes"><Input placeholder="read write" /></Form.Item>
        <Form.Item name="oauth_resource" label={t("serverDialog.resourceUrlOptional")}><Input placeholder="https://mcp.example.com/mcp" /></Form.Item>
        <Form.Item name="oauth_issuer" label={t("serverDialog.responseIssuerOptionalUseWhen")}><Input placeholder="https://provider.example" /></Form.Item>
        <Alert type="info" showIcon message={t("serverDialog.registerCallbackProviderHttpsAuth")} />
      </> : null}
    </Form.Item>
  </>;
}

function ConfigureAuthDialog({ server, busy, onClose, onConfigureAuth }: Pick<ServerDialogsProps, "busy" | "onClose" | "onConfigureAuth"> & { server: McpServer }) {
  const { t } = useI18n();
  const [form] = Form.useForm<ServerFormValues>();
  return <Modal open width={600} title={t("serverDialog.configureUserConnectionServer", { server: server.display_name })} okText={t("serverDialog.saveSettings")} cancelText={t("common.cancel")} confirmLoading={busy}
    onCancel={onClose} onOk={() => form.validateFields().then((values) => onConfigureAuth(server, authFields(values)))}>
    <Form form={form} layout="vertical" requiredMark={false} initialValues={{
      auth_mode: server.auth_mode, api_key_header: server.api_key_header, api_key_prefix: server.api_key_prefix,
      oauth_authorize_url: server.oauth_authorize_url, oauth_token_url: server.oauth_token_url,
      oauth_client_id: server.oauth_client_id, oauth_scopes: server.oauth_scopes, oauth_resource: server.oauth_resource,
      oauth_issuer: server.oauth_issuer,
      oauth_client_auth_method: server.oauth_client_auth_method,
    }}><AuthFormFields /></Form>
  </Modal>;
}

function ConfigureUsersDialog({ server, users, busy, onClose, onConfigureUsers }: Pick<ServerDialogsProps, "users" | "busy" | "onClose" | "onConfigureUsers"> & { server: McpServer }) {
  const { t } = useI18n();
  const [form] = Form.useForm<{ user_ids: number[] }>();
  const wildcardUsers = users.filter((user) => user.role === "user" && user.servers.includes("*"));
  const ordinaryUsers = users.filter((user) => user.role === "user" && !user.servers.includes("*"));
  return <Modal open width={560} title={t("serverDialog.assignServerAccessServer", { server: server.display_name })} okText={t("serverDialog.saveGrants")} cancelText={t("common.cancel")} confirmLoading={busy}
    onCancel={onClose} onOk={() => form.validateFields().then(({ user_ids }) => onConfigureUsers(server, user_ids))}>
    <Alert type="info" showIcon className="dialog-alert"
      message={t("serverDialog.selectedUsersAccessServerAdmins", { count: wildcardUsers.length })} />
    <Form form={form} layout="vertical" initialValues={{ user_ids: ordinaryUsers.filter((user) => user.servers.includes(server.name)).map((user) => user.id) }}>
      <Form.Item name="user_ids" label={t("serverDialog.usersAccess")}>
        <Select mode="multiple" allowClear placeholder={t("serverDialog.selectUsers")} options={ordinaryUsers.map((user) => ({
          label: `${user.username}${user.disabled ? t("serverDialog.signDisabled") : ""}`, value: user.id,
        }))} />
      </Form.Item>
    </Form>
  </Modal>;
}

function AddInstanceDialog({
  server,
  busy,
  onClose,
  onAddInstance,
}: Pick<ServerDialogsProps, "busy" | "onClose" | "onAddInstance"> & {
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
          eyebrow="UPSTREAM CAPACITY"
          title={t("serverDialog.addInstanceServer", { server: server.name })}
        />
      }
      okText={t("serverDialog.addPool")}
      cancelText={t("common.cancel")}
      confirmLoading={busy}
      onCancel={onClose}
      onOk={() =>
        form.validateFields().then((values) =>
          onAddInstance(server, {
            id: values.id || undefined,
            url: values.url,
          }),
        )
      }
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="id" label={t("serverDialog.instanceIdOptional")}>
          <Input placeholder={t("serverDialog.leaveBlankGenerateUuid")} autoFocus />
        </Form.Item>
        <Form.Item
          name="url"
          label="Endpoint URL"
          rules={[
            { required: true, message: t("serverDialog.enterEndpointUrl") },
            { type: "url", message: t("serverDialog.enterValidHttpHttpsUrl") },
          ]}
        >
          <Input
            prefix={<LinkOutlined />}
            placeholder="https://host.example/mcp"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function ModalTitle({
  icon,
  eyebrow,
  title,
}: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
}) {
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
