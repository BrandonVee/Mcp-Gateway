import { useI18n } from '@/web/i18n';
import {
  CheckCircleFilled,
  BarChartOutlined,
  ClockCircleOutlined,
  WarningOutlined,
  DeploymentUnitOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Alert, Avatar, Badge, Button, Card, Col, Empty, Flex, List, Row, Statistic, Tag, Typography } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import type { api as platformApi } from '@/web/api';
import type { AdminUser, McpServer, SystemSettings, UsageSummary, View } from '@/web/types';
import { routableInstances } from '@/web/features/servers/upstream-allowlist';
import { initials } from '@/web/utils/format';

interface OverviewPageProps {
  users: AdminUser[];
  servers: McpServer[];
  settings: SystemSettings | null;
  api: Pick<typeof platformApi, 'usageSummary'>;
  onNavigate: (view: View) => void;
}

export function OverviewPage({ users, servers, settings, api, onNavigate }: OverviewPageProps) {
  const { t, language } = useI18n();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [usageError, setUsageError] = useState('');
  useEffect(() => {
    let active = true,
      fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const result = await api.usageSummary({ hours: 24 }, 'server');
        if (active) {
          setUsage(result);
          setUsageError('');
        }
      } catch (error) {
        if (active) setUsageError(error instanceof Error ? error.message : t('common.refreshFailed'));
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [api, t]);
  const stats = usage?.enabled ? usage.summary : null;
  const attentionServers = new Set(
    servers
      .filter((server) => server.enabled && !routableInstances(server, settings).length)
      .map((server) => server.name),
  );
  for (const alert of usage?.alerts ?? [])
    if (servers.some((server) => server.enabled && server.name === alert.server)) attentionServers.add(alert.server);
  const number = (value: number | null | undefined, suffix = '') =>
    value == null ? '—' : new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value) + suffix;
  const callDetail =
    usage?.enabled === false
      ? t('usage.disabled')
      : usage
        ? t('overview.failedCalls24h', { count: number(usage.summary.failed) })
        : t('monitoring.checking');
  const recentUsers = [...users].sort((a, b) => b.created_at - a.created_at).slice(0, 5);

  return (
    <div className="page-stack page-enter">
      {usageError && <Alert type="error" showIcon message={usageError} />}
      <Row gutter={[16, 16]}>
        <MetricCard
          title={t('overview.calls24h')}
          value={number(stats?.calls)}
          icon={<BarChartOutlined />}
          detail={callDetail}
          tone="blue"
          action={t('overview.viewCalls')}
          onClick={() => onNavigate('monitoring')}
        />
        <MetricCard
          title={t('overview.successRate24h')}
          value={number(stats?.success_rate, '%')}
          icon={<CheckCircleFilled />}
          detail={
            stats ? t('overview.knownResults', { count: number(stats.success + stats.failed) }) : t('usage.successHint')
          }
          tone={stats?.failed ? 'amber' : 'green'}
          action={t('overview.viewCalls')}
          onClick={() => onNavigate('monitoring')}
        />
        <MetricCard
          title={t('overview.p95Latency24h')}
          value={number(stats?.p95_ms, ' ms')}
          icon={<ClockCircleOutlined />}
          detail={t('usage.latencyHint')}
          tone="cyan"
          action={t('overview.viewCalls')}
          onClick={() => onNavigate('monitoring')}
        />
        <MetricCard
          title={t('overview.servicesNeedAttention')}
          value={attentionServers.size}
          icon={<WarningOutlined />}
          detail={t('overview.servicesNeedAttentionHelp')}
          tone={attentionServers.size ? 'red' : 'green'}
          action={t('overview.viewServices')}
          onClick={() => onNavigate('servers')}
        />
      </Row>

      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} xl={16}>
          <Card
            className="dashboard-card route-card"
            title={
              <CardTitle
                icon={<DeploymentUnitOutlined />}
                title={t('overview.liveRouteTopology')}
                subtitle={t('overview.routingSubtitle')}
              />
            }
          >
            <div className="route-map">
              <div className="route-origin">
                <SafetyCertificateOutlined />
                <strong>{t('overview.authNode')}</strong>
                <small>{t('auth.unifiedIdentity')}</small>
              </div>
              <div className="route-line" />
              <div className="route-nodes">
                {servers.length ? (
                  servers.map((server) => (
                    <div className="route-node" key={server.name}>
                      <Badge
                        status={
                          !server.enabled
                            ? 'default'
                            : routableInstances(server, settings).length
                              ? 'success'
                              : 'warning'
                        }
                      />
                      <span>
                        <strong>/mcp/{server.name}</strong>
                        <small>
                          {t('overview.instancesInstancesUsersGrants', {
                            instances: server.instances.length,
                            users: server.user_count,
                          })}
                        </small>
                      </span>
                      <Tag
                        color={
                          !server.enabled
                            ? 'default'
                            : routableInstances(server, settings).length
                              ? 'success'
                              : 'warning'
                        }
                        bordered={false}
                      >
                        {t(
                          !server.enabled
                            ? 'status.paused'
                            : routableInstances(server, settings).length
                              ? 'status.routable'
                              : 'overview.routeUnavailable',
                        )}
                      </Tag>
                    </div>
                  ))
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('overview.noServers')} />
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
                title={t('overview.recentUsers')}
                subtitle={t('overview.identitySubtitle')}
              />
            }
          >
            <List
              dataSource={recentUsers}
              locale={{ emptyText: t('overview.noUsers') }}
              renderItem={(user) => (
                <List.Item>
                  <List.Item.Meta
                    avatar={<Avatar className="user-avatar">{initials(user.username)}</Avatar>}
                    title={
                      <Flex align="center" gap={8}>
                        <span>{user.username}</span>
                        <Tag color={user.role === 'admin' ? 'geekblue' : 'default'} bordered={false}>
                          {user.role === 'admin' ? t('common.administrator') : t('common.standardUser')}
                        </Tag>
                      </Flex>
                    }
                    description={user.servers.join(' · ') || t('overview.noServerGrants')}
                  />
                  <Badge status={user.disabled ? 'default' : 'success'} />
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}

function MetricCard({
  title,
  value,
  icon,
  detail,
  tone,
  action,
  onClick,
}: {
  title: string;
  value: string | number;
  icon: ReactNode;
  detail: string;
  tone: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <Col xs={24} sm={12} xl={6}>
      <Card className={`metric-card metric-${tone}`}>
        <Flex justify="space-between" align="flex-start">
          <Statistic title={title} value={value} />
          <span className="metric-icon">{icon}</span>
        </Flex>
        <div className="metric-detail">{detail}</div>
        <Button type="link" size="small" onClick={onClick} style={{ paddingInline: 0, marginTop: 8 }}>
          {action}
        </Button>
      </Card>
    </Col>
  );
}

function CardTitle({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle: string }) {
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
