import { useI18n } from "../../i18n";
import {
  ApiOutlined,
  CheckCircleFilled,
  CloudServerOutlined,
  DatabaseOutlined,
  DeploymentUnitOutlined,
  SafetyCertificateOutlined,
  SyncOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  Avatar,
  Badge,
  Card,
  Col,
  Empty,
  Flex,
  List,
  Progress,
  Row,
  Statistic,
  Tag,
  Typography,
} from "antd";
import type { ReactNode } from "react";
import type { AdminUser, GatewayHealth, McpServer } from "../../types";
import { formatTime, initials } from "../../utils/format";

interface OverviewPageProps {
  users: AdminUser[];
  servers: McpServer[];
  health: GatewayHealth | null;
}

export function OverviewPage({ users, servers, health }: OverviewPageProps) {
  const { t, language } = useI18n();
  const activeUsers = users.filter((user) => !user.disabled).length;
  const routableServers = servers.filter((server) => server.enabled).length;
  const enabledInstances = servers.reduce(
    (total, server) =>
      total + server.instances.filter((instance) => instance.enabled).length,
    0,
  );
  const recentUsers = [...users]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 5);

  return (
    <div className="page-stack page-enter">
      <Row gutter={[16, 16]}>
        <MetricCard
          title={t("overview.totalIdentities")}
          value={users.length}
          icon={<TeamOutlined />}
          detail={t("overview.countActiveIdentities", { count: activeUsers })}
          tone="blue"
        />
        <MetricCard
          title={t("overview.logicalServers")}
          value={servers.length}
          icon={<CloudServerOutlined />}
          detail={t("overview.countRoutable", { count: routableServers })}
          tone="cyan"
        />
        <MetricCard
          title={t("overview.onlineInstances")}
          value={enabledInstances}
          icon={<DeploymentUnitOutlined />}
          detail={t("overview.dynamicUpstreamPool")}
          tone="amber"
        />
        <MetricCard
          title={t("overview.stateStores")}
          value={health?.redis ? t("status.healthy") : t("status.degraded")}
          icon={<DatabaseOutlined />}
          detail="PostgreSQL + Redis"
          tone={health?.redis ? "green" : "red"}
        />
      </Row>

      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} xl={16}>
          <Card
            className="dashboard-card route-card"
            title={
              <CardTitle
                icon={<DeploymentUnitOutlined />}
                title={t("overview.liveRouteTopology")}
                subtitle={t("overview.routingSubtitle")}
              />
            }
            extra={<Badge status="processing" text={t("overview.liveSync")} />}
          >
            <div className="route-map">
              <div className="route-origin">
                <SafetyCertificateOutlined />
                <strong>{t("overview.authNode")}</strong>
                <small>{t("auth.unifiedIdentity")}</small>
              </div>
              <div className="route-line" />
              <div className="route-nodes">
                {servers.length ? (
                  servers.map((server) => (
                    <div className="route-node" key={server.name}>
                      <Badge status={server.enabled ? "success" : "default"} />
                      <span>
                        <strong>/mcp/{server.name}</strong>
                        <small>
                          {t("overview.instancesInstancesUsersGrants", { instances: server.instances.length, users: server.user_count })}
                        </small>
                      </span>
                      <Tag
                        color={server.enabled ? "success" : "default"}
                        bordered={false}
                      >
                        {server.enabled ? t("status.routable") : t("status.paused")}
                      </Tag>
                    </div>
                  ))
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={t("overview.noServers")}
                  />
                )}
              </div>
            </div>
          </Card>
        </Col>

        <Col xs={24} xl={8}>
          <Card
            className="dashboard-card identity-card"
            title={
              <CardTitle
                icon={<TeamOutlined />}
                title={t("overview.recentUsers")}
                subtitle={t("overview.identitySubtitle")}
              />
            }
          >
            <List
              dataSource={recentUsers}
              locale={{ emptyText: t("overview.noUsers") }}
              renderItem={(user) => (
                <List.Item>
                  <List.Item.Meta
                    avatar={
                      <Avatar className="user-avatar">
                        {initials(user.username)}
                      </Avatar>
                    }
                    title={
                      <Flex align="center" gap={8}>
                        <span>{user.username}</span>
                        <Tag
                          color={user.role === "admin" ? "geekblue" : "default"}
                          bordered={false}
                        >
                          {user.role === "admin" ? t("common.administrator") : t("common.standardUser")}
                        </Tag>
                      </Flex>
                    }
                    description={user.servers.join(" · ") || t("overview.noServerGrants")}
                  />
                  <Badge status={user.disabled ? "default" : "success"} />
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>

      <Card className="infrastructure-card">
        <Flex align="center" gap={20} wrap>
          <div className="infra-heading">
            <SyncOutlined spin={Boolean(health?.ok)} />
            <span>
              <strong>{t("overview.infrastructureStatus")}</strong>
              <small>{t("overview.infrastructureSubtitle")}</small>
            </span>
          </div>
          <InfraStatus
            label={t("overview.registrySync")}
            value={formatTime(health?.registry?.lastSuccessAt, language)}
            healthy={!health?.registry?.lastError}
          />
          <InfraStatus
            label="Redis"
            value={health?.redis ? t("status.connected") : t("status.offline")}
            healthy={health?.redis}
          />
          <InfraStatus label="PostgreSQL" value={t("overview.managedDrizzle")} healthy />
          <Progress
            className="health-progress"
            percent={health?.ok ? 100 : 68}
            showInfo={false}
            strokeColor="#13a06f"
            trailColor="#e5eaf1"
          />
        </Flex>
      </Card>
    </div>
  );
}

function MetricCard({
  title,
  value,
  icon,
  detail,
  tone,
}: {
  title: string;
  value: string | number;
  icon: ReactNode;
  detail: string;
  tone: string;
}) {
  return (
    <Col xs={24} sm={12} xl={6}>
      <Card className={`metric-card metric-${tone}`}>
        <Flex justify="space-between" align="flex-start">
          <Statistic title={title} value={value} />
          <span className="metric-icon">{icon}</span>
        </Flex>
        <div className="metric-detail">
          <CheckCircleFilled /> {detail}
        </div>
      </Card>
    </Col>
  );
}

function CardTitle({
  icon,
  title,
  subtitle,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <Flex align="center" gap={12}>
      <span className="card-title-icon">{icon}</span>
      <span className="card-title-copy">
        <strong>{title}</strong>
        <small>{subtitle}</small>
      </span>
    </Flex>
  );
}

function InfraStatus({
  label,
  value,
  healthy,
}: {
  label: string;
  value: string;
  healthy?: boolean;
}) {
  return (
    <div className="infra-status">
      <Badge status={healthy ? "success" : "error"} />
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
      </span>
    </div>
  );
}
