import {
  ApiOutlined,
  CloudServerOutlined,
  DeploymentUnitOutlined,
  LinkOutlined,
} from "@ant-design/icons";
import { Alert, Form, Input, Modal } from "antd";
import type {
  AddInstanceInput,
  CreateServerInput,
  DialogState,
  McpServer,
} from "../../types";

interface ServerDialogsProps {
  state: DialogState;
  busy: boolean;
  onClose: () => void;
  onCreate: (data: CreateServerInput) => void;
  onAddInstance: (server: McpServer, data: AddInstanceInput) => void;
}

interface ServerFormValues {
  name: string;
  displayName?: string;
  instanceId?: string;
  url: string;
}

export function ServerDialogs(props: ServerDialogsProps) {
  if (props.state.type === "create-server") {
    return <CreateServerDialog {...props} />;
  }

  if (props.state.type === "add-instance") {
    return <AddInstanceDialog {...props} server={props.state.server} />;
  }

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
      <Form form={form} layout="vertical" requiredMark={false}>
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
      </Form>
    </Modal>
  );
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
