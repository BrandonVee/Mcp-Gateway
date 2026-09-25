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
          title="注册 MCP Server"
        />
      }
      okText="注册并同步"
      cancelText="取消"
      confirmLoading={busy}
      onCancel={onClose}
      onOk={submit}
    >
      <Alert
        type="info"
        showIcon
        icon={<ApiOutlined />}
        message="支持 Gateway 网络可访问的 HTTP/HTTPS Streamable MCP Endpoint。"
        className="dialog-alert"
      />
      <Form form={form} layout="vertical" requiredMark={false} initialValues={{ auth_mode: "none", api_key_header: "authorization", api_key_prefix: "Bearer " }}>
        <Form.Item
          name="name"
          label="Server 标识"
          rules={[
            { required: true, message: "请输入 Server 标识" },
            {
              pattern: /^[a-zA-Z0-9._-]+$/,
              message: "仅支持字母、数字、点、下划线和连字符",
            },
          ]}
        >
          <Input
            prefix={<DeploymentUnitOutlined />}
            placeholder="external-search"
            autoFocus
          />
        </Form.Item>
        <Form.Item name="displayName" label="显示名称">
          <Input placeholder="External Search" />
        </Form.Item>
        <Form.Item name="instanceId" label="实例 ID（可选）">
          <Input placeholder="留空自动生成 UUID" />
        </Form.Item>
        <Form.Item
          name="url"
          label="MCP Endpoint URL"
          rules={[
            { required: true, message: "请输入 Endpoint URL" },
            { type: "url", message: "请输入有效的 HTTP/HTTPS URL" },
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
  return <>
    <Form.Item name="auth_mode" label="用户连接方式"><Select options={[
      { value: "none", label: "无额外认证" }, { value: "api_key", label: "用户 API Key" }, { value: "oauth", label: "用户 OAuth" },
    ]} /></Form.Item>
    <Form.Item noStyle shouldUpdate={(prev, next) => prev.auth_mode !== next.auth_mode}>
      {({ getFieldValue }) => getFieldValue("auth_mode") === "api_key" ? <>
        <Form.Item name="api_key_header" label="上游请求头" rules={[{ required: true, message: "请输入上游请求头" }]}><Input placeholder="authorization 或 x-api-key" /></Form.Item>
        <Form.Item name="api_key_prefix" label="值前缀"><Input placeholder="Bearer （可留空）" /></Form.Item>
        <Alert type="info" showIcon message="用户在连接中心填写自己的 Key，平台按用户注入该请求头。" />
      </> : getFieldValue("auth_mode") === "oauth" ? <>
        <Form.Item name="oauth_authorize_url" label="授权端点" rules={[{ required: true }, { type: "url" }]}><Input placeholder="https://provider.example/authorize" /></Form.Item>
        <Form.Item name="oauth_token_url" label="Token 端点" rules={[{ required: true }, { type: "url" }]}><Input placeholder="https://provider.example/token" /></Form.Item>
        <Form.Item name="oauth_client_id" label="Client ID" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="oauth_client_secret" label="Client Secret（公有客户端可留空；更新时留空保持原值）"><Input.Password autoComplete="off" /></Form.Item>
        <Form.Item name="oauth_client_auth_method" label="Token 端点客户端认证" initialValue="none"><Select options={[
          { value: "none", label: "无（公有客户端）" }, { value: "client_secret_basic", label: "Client Secret Basic" },
          { value: "client_secret_post", label: "Client Secret Post" },
        ]} /></Form.Item>
        <Form.Item name="oauth_scopes" label="Scopes"><Input placeholder="read write" /></Form.Item>
        <Form.Item name="oauth_resource" label="Resource URL（可选）"><Input placeholder="https://mcp.example.com/mcp" /></Form.Item>
        <Form.Item name="oauth_issuer" label="响应 Issuer（可选；提供方返回 iss 时填写）"><Input placeholder="https://provider.example" /></Form.Item>
        <Alert type="info" showIcon message="在提供方注册回调地址：https://你的 Auth 域名/oauth/callback/Server标识" />
      </> : null}
    </Form.Item>
  </>;
}

function ConfigureAuthDialog({ server, busy, onClose, onConfigureAuth }: Pick<ServerDialogsProps, "busy" | "onClose" | "onConfigureAuth"> & { server: McpServer }) {
  const [form] = Form.useForm<ServerFormValues>();
  return <Modal open width={600} title={`配置用户连接 / ${server.display_name}`} okText="保存配置" cancelText="取消" confirmLoading={busy}
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
  const [form] = Form.useForm<{ user_ids: number[] }>();
  const wildcardUsers = users.filter((user) => user.role === "user" && user.servers.includes("*"));
  const ordinaryUsers = users.filter((user) => user.role === "user" && !user.servers.includes("*"));
  return <Modal open width={560} title={`分配 Server 权限 / ${server.display_name}`} okText="保存授权" cancelText="取消" confirmLoading={busy}
    onCancel={onClose} onOk={() => form.validateFields().then(({ user_ids }) => onConfigureUsers(server, user_ids))}>
    <Alert type="info" showIcon className="dialog-alert"
      message={`选中的普通用户可访问此 Server；管理员和 ${wildcardUsers.length} 位通配符用户默认可访问。移除授权将立即阻止已有令牌继续访问。`} />
    <Form form={form} layout="vertical" initialValues={{ user_ids: ordinaryUsers.filter((user) => user.servers.includes(server.name)).map((user) => user.id) }}>
      <Form.Item name="user_ids" label="允许访问的用户">
        <Select mode="multiple" allowClear placeholder="选择用户" options={ordinaryUsers.map((user) => ({
          label: `${user.username}${user.disabled ? "（认证已关闭）" : ""}`, value: user.id,
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
  const [form] = Form.useForm<AddInstanceInput>();

  return (
    <Modal
      open
      title={
        <ModalTitle
          icon={<DeploymentUnitOutlined />}
          eyebrow="UPSTREAM CAPACITY"
          title={`添加实例 / ${server.name}`}
        />
      }
      okText="添加到实例池"
      cancelText="取消"
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
        <Form.Item name="id" label="实例 ID（可选）">
          <Input placeholder="留空自动生成 UUID" autoFocus />
        </Form.Item>
        <Form.Item
          name="url"
          label="Endpoint URL"
          rules={[
            { required: true, message: "请输入 Endpoint URL" },
            { type: "url", message: "请输入有效的 HTTP/HTTPS URL" },
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
