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
          title="身份总数"
          value={users.length}
          icon={<TeamOutlined />}
          detail={`${activeUsers} 个可用身份`}
          tone="blue"
        />
        <MetricCard
          title="逻辑 Server"
          value={servers.length}
          icon={<CloudServerOutlined />}
          detail={`${routableServers} 个正在路由`}
          tone="cyan"
        />
        <MetricCard
          title="在线实例"
          value={enabledInstances}
          icon={<DeploymentUnitOutlined />}
          detail="动态上游实例池"
          tone="amber"
        />
        <MetricCard
          title="状态存储"
          value={health?.redis ? "正常" : "异常"}
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
                title="实时路由拓扑"
                subtitle="LIVE ROUTING FABRIC"
              />
            }
            extra={<Badge status="processing" text="实时同步" />}
          >
            <div className="route-map">
              <div className="route-origin">
                <SafetyCertificateOutlined />
                <strong>AUTH</strong>
                <small>统一身份签发</small>
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
                          {server.instances.length} 个实例 · {server.user_count}{" "}
                          个授权
                        </small>
                      </span>
                      <Tag
                        color={server.enabled ? "success" : "default"}
                        bordered={false}
                      >
                        {server.enabled ? "ROUTABLE" : "PAUSED"}
                      </Tag>
                    </div>
                  ))
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="暂无 Server"
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
                title="最近用户"
                subtitle="IDENTITY LEDGER"
              />
            }
          >
            <List
              dataSource={recentUsers}
              locale={{ emptyText: "暂无用户" }}
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
                          {user.role}
                        </Tag>
                      </Flex>
                    }
                    description={user.servers.join(" · ") || "尚未授权 Server"}
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
              <strong>基础设施状态</strong>
              <small>INFRASTRUCTURE STATUS</small>
            </span>
          </div>
          <InfraStatus
            label="Registry Sync"
            value={formatTime(health?.registry?.lastSuccessAt)}
            healthy={!health?.registry?.lastError}
          />
          <InfraStatus
            label="Redis"
            value={health?.redis ? "已连接" : "离线"}
            healthy={health?.redis}
          />
          <InfraStatus label="PostgreSQL" value="Drizzle 托管" healthy />
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
