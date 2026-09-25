import {
  InfoCircleOutlined,
  LockOutlined,
  UserAddOutlined,
} from "@ant-design/icons";
import { Alert, Checkbox, Form, Input, Modal, Radio, Select } from "antd";
import type {
  AdminUser,
  CreateUserInput,
  DialogState,
  McpServer,
} from "../../types";

interface UserDialogsProps {
  state: DialogState;
  servers: McpServer[];
  busy: boolean;
  onClose: () => void;
  onCreate: (data: CreateUserInput) => void;
  onAssign: (user: AdminUser, servers: string[]) => void;
  onPassword: (user: AdminUser, password: string) => void;
}

export function UserDialogs(props: UserDialogsProps) {
  if (props.state.type === "create-user") {
    return <CreateUserDialog {...props} />;
  }

  if (props.state.type === "assign-user") {
    return <AssignUserDialog {...props} user={props.state.user} />;
  }

  if (props.state.type === "reset-password") {
    return <ResetPasswordDialog {...props} user={props.state.user} />;
  }

  return null;
}

function CreateUserDialog({
  servers,
  busy,
  onClose,
  onCreate,
}: Pick<UserDialogsProps, "servers" | "busy" | "onClose" | "onCreate">) {
  const [form] = Form.useForm<CreateUserInput & { all_servers?: boolean }>();
  const role = Form.useWatch("role", form) ?? "user";
  const allServers = Form.useWatch("all_servers", form) ?? false;

  return (
    <Modal
      open
      title={
        <ModalTitle
          icon={<UserAddOutlined />}
          eyebrow="IDENTITY PROVISIONING"
          title="创建新身份"
        />
      }
      okText="创建用户"
      cancelText="取消"
      confirmLoading={busy}
      onCancel={onClose}
      onOk={() => form.validateFields().then((values) => onCreate({
        username: values.username,
        password: values.password,
        role: values.role,
        servers: values.all_servers ? ["*"] : values.servers ?? [],
      }))}
    >
      <Form<CreateUserInput & { all_servers?: boolean }>
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{ role: "user", servers: [], all_servers: false }}
      >
        <Form.Item
          name="username"
          label="用户名"
          rules={[
            { required: true, message: "请输入用户名" },
            { min: 2, message: "用户名至少 2 位" },
          ]}
        >
          <Input placeholder="例如 data-agent" autoFocus />
        </Form.Item>
        <Form.Item
          name="password"
          label="初始密码"
          rules={[
            { required: true, message: "请输入初始密码" },
            { min: 6, message: "密码至少 6 位" },
          ]}
        >
          <Input.Password prefix={<LockOutlined />} placeholder="至少 6 位" />
        </Form.Item>
        <Form.Item name="role" label="角色">
          <Radio.Group optionType="button" buttonStyle="solid">
            <Radio.Button value="user">普通用户</Radio.Button>
            <Radio.Button value="admin">管理员</Radio.Button>
          </Radio.Group>
        </Form.Item>
        {role === "user" && (
          <>
            <Form.Item name="all_servers" valuePropName="checked" className="wildcard-grant">
              <Checkbox>全部 Server（*，包括以后新增的 Server）</Checkbox>
            </Form.Item>
            {!allServers && <Form.Item name="servers" label="指定 Server 权限">
              <Checkbox.Group className="permission-grid">
                {servers.map((server) => (
                  <Checkbox key={server.name} value={server.name}>
                    {server.display_name}
                    <code>{server.name}</code>
                  </Checkbox>
                ))}
              </Checkbox.Group>
            </Form.Item>}
          </>
        )}
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
}: Pick<UserDialogsProps, "servers" | "busy" | "onClose" | "onAssign"> & {
  user: AdminUser;
}) {
  const [form] = Form.useForm<{ servers: string[]; all_servers: boolean }>();
  const allServers = Form.useWatch("all_servers", form) ?? user.servers.includes("*");

  return (
    <Modal
      open
      title={
        <ModalTitle
          icon={<InfoCircleOutlined />}
          eyebrow="ACCESS MATRIX"
          title={`分配权限 / ${user.username}`}
        />
      }
      okText="保存访问范围"
      cancelText="取消"
      confirmLoading={busy}
      onCancel={onClose}
      onOk={() =>
        form.validateFields().then((values) => onAssign(user, values.all_servers ? ["*"] : values.servers ?? []))
      }
    >
      <Alert
        type="info"
        showIcon
        message="通配符允许访问当前和未来的全部 Server。新增授权需获取新 Token；收回授权立即生效。"
        className="dialog-alert"
      />
      <Form
        form={form}
        layout="vertical"
        initialValues={{ servers: user.servers.filter((name) => name !== "*"), all_servers: user.servers.includes("*") }}
      >
        <Form.Item name="all_servers" valuePropName="checked" className="wildcard-grant">
          <Checkbox>全部 Server（*，包括以后新增的 Server）</Checkbox>
        </Form.Item>
        {!allServers && <Form.Item name="servers" label="可连接的逻辑 MCP Server">
          <Select
            mode="multiple"
            allowClear
            placeholder="选择 Server"
            options={servers
              .filter((server) => server.enabled)
              .map((server) => ({
                label: server.display_name,
                value: server.name,
              }))}
          />
        </Form.Item>}
      </Form>
    </Modal>
  );
}

function ResetPasswordDialog({
  user,
  busy,
  onClose,
  onPassword,
}: Pick<UserDialogsProps, "busy" | "onClose" | "onPassword"> & {
  user: AdminUser;
}) {
  const [form] = Form.useForm<{ password: string }>();

  return (
    <Modal
      open
      title={
        <ModalTitle
          icon={<LockOutlined />}
          eyebrow="CREDENTIAL ROTATION"
          title={`重置密码 / ${user.username}`}
        />
      }
      okText="确认重置"
      cancelText="取消"
      confirmLoading={busy}
      onCancel={onClose}
      onOk={() =>
        form
          .validateFields()
          .then((values) => onPassword(user, values.password))
      }
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="password"
          label="新密码"
          rules={[
            { required: true, message: "请输入新密码" },
            { min: 6, message: "密码至少 6 位" },
          ]}
        >
          <Input.Password
            prefix={<LockOutlined />}
            placeholder="至少 6 位"
            autoFocus
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
