import {
  ApiOutlined,
  CopyOutlined,
  DeleteOutlined,
  DeploymentUnitOutlined,
  ExportOutlined,
  PlusOutlined,
  PoweroffOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  App,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Input,
  Row,
  Segmented,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useMemo, useState } from "react";
import { PageToolbar } from "../../components/PageToolbar";
import type { McpInstance, McpServer } from "../../types";

interface ServersPageProps {
  servers: McpServer[];
  onCreate: () => void;
  onAddInstance: (server: McpServer) => void;
  onToggle: (server: McpServer) => void;
  onToggleInstance: (server: McpServer, instance: McpInstance) => void;
  onDeleteInstance: (server: McpServer, instance: McpInstance) => void;
  onDelete: (server: McpServer) => void;
}

export function ServersPage(props: ServersPageProps) {
  const { message } = App.useApp();
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<"all" | "enabled" | "paused">("all");

  const filteredServers = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return props.servers.filter((server) => {
      const matchesKeyword =
        !normalizedKeyword ||
        server.name.toLowerCase().includes(normalizedKeyword) ||
        server.display_name.toLowerCase().includes(normalizedKeyword) ||
        server.instances.some((instance) =>
          instance.url.toLowerCase().includes(normalizedKeyword),
        );
      const matchesStatus =
        status === "all" ||
        (status === "enabled" && server.enabled) ||
        (status === "paused" && !server.enabled);
      return matchesKeyword && matchesStatus;
    });
  }, [keyword, props.servers, status]);

  const copyUrl = async (url: string) => {
    await navigator.clipboard.writeText(url);
    message.success("Endpoint URL 已复制");
  };

  return (
    <div className="page-stack page-enter">
      <PageToolbar
        eyebrow="ROUTE REGISTRY"
        title="内部与外部 Server，一处接入"
        description="注册 Streamable HTTP Endpoint，Gateway 自动发现并热更新。"
        primaryAction={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={props.onCreate}
          >
            注册 Server
          </Button>
        }
        filters={
          <>
            <Input.Search
              allowClear
              className="toolbar-search"
              placeholder="搜索名称、标识或 Endpoint"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Segmented
              value={status}
              onChange={(value) => setStatus(value as typeof status)}
              options={[
                { value: "all", label: "全部" },
                { value: "enabled", label: "运行中" },
                { value: "paused", label: "已暂停" },
              ]}
            />
            <Typography.Text type="secondary" className="filter-result-count">
              {filteredServers.length} 条结果
            </Typography.Text>
          </>
        }
      />

      {filteredServers.length ? (
        <Row gutter={[16, 16]}>
          {filteredServers.map((server, index) => (
            <Col xs={24} xl={12} key={server.name}>
              <Card className="server-card" bordered={false}>
                <header className="server-card-header">
                  <span className="server-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="server-heading">
                    <small>LOGICAL ENDPOINT</small>
                    <strong>{server.display_name}</strong>
                    <code>/mcp/{server.name}</code>
                  </span>
                  <Switch
                    checked={server.enabled}
                    checkedChildren="ROUTABLE"
                    unCheckedChildren="PAUSED"
                    onChange={() => props.onToggle(server)}
                  />
                </header>

                <div className="instance-list">
                  {server.instances.length ? (
                    server.instances.map((instance) => (
                      <div className="instance-row" key={instance.id}>
                        <div className="instance-copy">
                          <Flex align="center" gap={8}>
                            <Badge
                              status={instance.enabled ? "success" : "default"}
                            />
                            <strong>{instance.id}</strong>
                            <Tag bordered={false}>
                              {instance.enabled ? "在线" : "已停用"}
                            </Tag>
                          </Flex>
                          <Typography.Text ellipsis>
                            {instance.url}
                          </Typography.Text>
                        </div>
                        <Space size={2}>
                          <Tooltip title="复制 URL">
                            <Button
                              type="text"
                              icon={<CopyOutlined />}
                              onClick={() => copyUrl(instance.url)}
                            />
                          </Tooltip>
                          <Tooltip title="在新窗口打开">
                            <Button
                              type="text"
                              icon={<ExportOutlined />}
                              onClick={() =>
                                window.open(
                                  instance.url,
                                  "_blank",
                                  "noopener,noreferrer",
                                )
                              }
                            />
                          </Tooltip>
                          <Tooltip
                            title={instance.enabled ? "停用实例" : "启用实例"}
                          >
                            <Button
                              type="text"
                              icon={<PoweroffOutlined />}
                              onClick={() =>
                                props.onToggleInstance(server, instance)
                              }
                            />
                          </Tooltip>
                          <Tooltip title="删除实例">
                            <Button
                              type="text"
                              danger
                              icon={<DeleteOutlined />}
                              onClick={() =>
                                props.onDeleteInstance(server, instance)
                              }
                            />
                          </Tooltip>
                        </Space>
                      </div>
                    ))
                  ) : (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="暂无上游实例"
                    />
                  )}
                </div>

                <footer className="server-card-footer">
                  <span>
                    <TeamOutlined /> {server.user_count} 个用户授权
                  </span>
                  <Space size={4}>
                    <Button
                      type="link"
                      icon={<PlusOutlined />}
                      onClick={() => props.onAddInstance(server)}
                    >
                      添加实例
                    </Button>
                    <Button
                      type="link"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => props.onDelete(server)}
                    >
                      删除
                    </Button>
                  </Space>
                </footer>
              </Card>
            </Col>
          ))}
        </Row>
      ) : (
        <Card className="empty-card" bordered={false}>
          <Empty
            image={<ApiOutlined className="empty-server-icon" />}
            description={
              props.servers.length
                ? "未找到匹配的 Server"
                : "尚未注册 MCP Server"
            }
          >
            {props.servers.length ? (
              <Button
                onClick={() => {
                  setKeyword("");
                  setStatus("all");
                }}
              >
                清除筛选
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<DeploymentUnitOutlined />}
                onClick={props.onCreate}
              >
                注册第一个 Server
              </Button>
            )}
          </Empty>
        </Card>
      )}
    </div>
  );
}
