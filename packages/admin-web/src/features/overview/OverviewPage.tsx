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
import { Alert, Avatar, Badge, Card, Col, Empty, Flex, List, Row, Statistic, Tag, Tooltip } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import type { api as platformApi } from '@/web/api';
import type { AdminUser, McpServer, SystemSettings, UsageSummary, View } from '@/web/types';
import { routableInstances } from '@/web/features/servers/upstream-allowlist';
import { initials } from '@/web/utils/format';
import { pollWhileVisible } from '@/web/utils/polling';

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
    let active = true;
    const refresh = async () => {
      try {
        const result = await api.usageSummary({ hours: 24 }, 'server');
        if (active) {
          setUsage(result);
          setUsageError('');
        }
      } catch (error) {
        if (active) setUsageError(error instanceof Error ? error.message : t('common.refreshFailed'));
      }
    };
    const stopPolling = pollWhileVisible(refresh, 10000);
    return () => {
      active = false;
      stopPolling();
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
  const recentUsers = [...users].sort((a, b) => b.created_at - a.created_at).slice(0, 5);

  return (
    <div className="page-stack page-enter">
      {usageError && <Alert type="error" showIcon message={usageError} />}
      <Row gutter={[16, 16]}>
        <MetricCard
          title={t('overview.calls24h')}
          value={number(stats?.calls)}
          icon={<BarChartOutlined />}
          detailLabel={t('usage.failed')}
          detailValue={number(stats?.failed)}
          tone="blue"
          onClick={() => onNavigate('monitoring')}
        />
        <MetricCard
          title={t('overview.successRate24h')}
          value={number(stats?.success_rate, '%')}
          icon={<CheckCircleFilled />}
          detailLabel={t('usage.unknown')}
          detailValue={number(stats?.unknown)}
          tone={stats?.failed ? 'amber' : 'green'}
          onClick={() => onNavigate('monitoring')}
        />
        <MetricCard
          title={t('overview.p95Latency24h')}
          value={number(stats?.p95_ms, ' ms')}
          icon={<ClockCircleOutlined />}
          detailLabel={t('usage.average')}
          detailValue={number(stats?.avg_ms, ' ms')}
          tone="cyan"
          onClick={() => onNavigate('monitoring')}
        />
        <MetricCard
          title={t('overview.servicesNeedAttention')}
          value={attentionServers.size}
          icon={<WarningOutlined />}
          detailLabel={t('overview.routableServices')}
          detailValue={number(
            servers.filter((server) => server.enabled && routableInstances(server, settings).length > 0).length,
          )}
          tone={attentionServers.size ? 'red' : 'green'}
          onClick={() => onNavigate('servers')}
        />
      </Row>

      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} xl={16}>
          <Card
            className="dashboard-card route-card"
            title={<CardTitle icon={<DeploymentUnitOutlined />} title={t('overview.liveRouteTopology')} />}
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
            title={<CardTitle icon={<TeamOutlined />} title={t('overview.recentUsers')} />}
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
  detailLabel,
  detailValue,
  tone,
  onClick,
}: {
  title: string;
  value: string | number;
  icon: ReactNode;
  detailLabel: string;
  detailValue: string;
  tone: string;
  onClick: () => void;
}) {
  return (
    <Col xs={24} sm={12} xl={6}>
      <Card
        className={`metric-card metric-card-link metric-${tone}`}
        role="link"
        tabIndex={0}
        aria-label={title}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onClick();
          }
        }}
      >
        <Flex justify="space-between" align="flex-start" gap={12}>
          <Statistic
            title={
              <Tooltip title={title}>
                <span className="metric-title">{title}</span>
              </Tooltip>
            }
            value={value}
          />
          <span className="metric-icon">{icon}</span>
        </Flex>
        <div className="metric-detail metric-parameter">
          <span>{detailLabel}</span>
          <strong>{detailValue}</strong>
        </div>
      </Card>
    </Col>
  );
}

function CardTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <Flex align="center" gap={12}>
      <span className="card-title-icon">{icon}</span>
      <span className="card-title-copy">
        <strong>{title}</strong>
      </span>
    </Flex>
  );
}
