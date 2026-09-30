import { useI18n } from "../../i18n";
import {
  ApiOutlined,
  CopyOutlined,
  DeleteOutlined,
  DeploymentUnitOutlined,
  ExportOutlined,
  PlusOutlined,
  PoweroffOutlined,
  SafetyCertificateOutlined,
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
import type { AdminUser, McpInstance, McpServer } from "../../types";

interface ServersPageProps {
  servers: McpServer[];
  users: AdminUser[];
  onCreate: () => void;
  onAddInstance: (server: McpServer) => void;
  onConfigureAuth: (server: McpServer) => void;
  onConfigureUsers: (server: McpServer) => void;
  onToggle: (server: McpServer) => void;
  onToggleInstance: (server: McpServer, instance: McpInstance) => void;
  onDeleteInstance: (server: McpServer, instance: McpInstance) => void;
  onDelete: (server: McpServer) => void;
}

export function ServersPage(props: ServersPageProps) {
  const { t } = useI18n();
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
    message.success(t("servers.endpointUrlCopied"));
  };

  return (
    <div className="page-stack page-enter">
      <PageToolbar
        eyebrow="servers.eyebrow"
        title="servers.oneRegistryInternalExternalServers"
        description="servers.registerStreamableHttpEndpointsGateway"
        primaryAction={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={props.onCreate}
          >
            {t("servers.registerServer")}
          </Button>
        }
        filters={
          <>
            <Input.Search
              allowClear
              className="toolbar-search"
              placeholder={t("servers.searchNameIdEndpoint")}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Segmented
              value={status}
              onChange={(value) => setStatus(value as typeof status)}
              options={[
                { value: "all", label: t("common.all") },
                { value: "enabled", label: t("servers.running") },
                { value: "paused", label: t("servers.paused") },
              ]}
            />
            <Typography.Text type="secondary" className="filter-result-count">
              {t("common.resultCount", { count: filteredServers.length })}
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
                    <small>{t("servers.logicalEndpoint")}</small>
                    <strong title={server.display_name}>{server.display_name}</strong>
                    <code title={`/mcp/${server.name}`}>/mcp/{server.name}</code>
                  </span>
                  <Switch
                    checked={server.enabled}
                    checkedChildren={t("status.routable")}
                    unCheckedChildren={t("status.paused")}
                    onChange={() => props.onToggle(server)}
                  />
                </header>

                <div className="server-policy">
                  <div>
                    <small>{t("users.userSign")}</small>
                    <strong>{server.auth_mode === "none" ? t("servers.platformSign") : server.auth_mode === "api_key" ? t("servers.platformSignApiKey") : t("servers.platformSignOauth")}</strong>
                  </div>
                  <Button icon={<SafetyCertificateOutlined />} onClick={() => props.onConfigureAuth(server)}>{t("servers.configureAuth")}</Button>
                  <div>
                    <small>{t("servers.accessGrants")}</small>
                    <strong>{t("servers.countUsers", { count: server.user_count })}</strong>
                    {server.signup_access && <Tag color="blue">{t("servers.signupAccess")}</Tag>}
                  </div>
                  <Button icon={<TeamOutlined />} onClick={() => props.onConfigureUsers(server)}>{t("servers.assignAccess")}</Button>
                </div>

                <div className="instance-list">
                  {server.instances.length ? (
                    server.instances.map((instance) => (
                      <div className="instance-row" key={instance.id}>
                        <div className="instance-copy">
                          <Flex align="center" gap={8}>
                            <Badge
                              status={instance.enabled ? "success" : "default"}
                            />
                            <strong title={instance.id}>{instance.id}</strong>
                            <Tag bordered={false}>
                              {instance.enabled ? t("servers.online") : t("servers.disabled")}
                            </Tag>
                          </Flex>
                          <Typography.Text ellipsis={{ tooltip: instance.url }}>
                            {instance.url}
                          </Typography.Text>
                        </div>
                        <Space size={2}>
                          <Tooltip title={t("servers.copyUrl")}>
                            <Button
                              type="text"
                              icon={<CopyOutlined />}
                              onClick={() => copyUrl(instance.url)}
                            />
                          </Tooltip>
                          <Tooltip title={t("servers.openNewTab")}>
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
                            title={instance.enabled ? t("servers.disableInstance") : t("servers.enableInstance")}
                          >
                            <Button
                              type="text"
                              icon={<PoweroffOutlined />}
                              onClick={() =>
                                props.onToggleInstance(server, instance)
                              }
                            />
                          </Tooltip>
                          <Tooltip title={t("servers.deleteInstance")}>
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
                      description={t("servers.noUpstreamInstances")}
                    />
                  )}
                </div>

                <footer className="server-card-footer">
                  <span><TeamOutlined /> {t("servers.adminsAccessDefaultCountIdentities", { count: props.users.filter((user) => user.role === "admin" || user.servers.includes("*")).length })}</span>
                  <Space size={4}>
                    <Button
                      type="link"
                      icon={<PlusOutlined />}
                      onClick={() => props.onAddInstance(server)}
                    >
                      {t("servers.addInstance")}
                    </Button>
                    <Button
                      type="link"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => props.onDelete(server)}
                    >
                      {t("common.delete")}
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
                ? t("servers.noMatchingServers")
                : t("servers.noMcpServersRegistered")
            }
          >
            {props.servers.length ? (
              <Button
                onClick={() => {
                  setKeyword("");
                  setStatus("all");
                }}
              >
                {t("servers.clearFilters")}
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<DeploymentUnitOutlined />}
                onClick={props.onCreate}
              >
                {t("servers.registerFirstServer")}
              </Button>
            )}
          </Empty>
        </Card>
      )}
    </div>
  );
}
