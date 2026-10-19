import { useI18n } from '@/web/i18n';
import {
  ApiOutlined,
  CopyOutlined,
  DeleteOutlined,
  DeploymentUnitOutlined,
  ExportOutlined,
  EditOutlined,
  PlusOutlined,
  PoweroffOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import {
  App,
  Alert,
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
} from 'antd';
import { useMemo, useState } from 'react';
import { ServiceDescription } from '@/web/components/ServiceDescription';
import { PageToolbar } from '@/web/components/PageToolbar';
import type { AdminUser, McpInstance, McpServer, SystemSettings } from '@/web/types';
import { untrustedUpstreamHost } from '@/web/features/servers/upstream-allowlist';
import '@/web/features/servers/servers.css';

interface ServersPageProps {
  servers: McpServer[];
  users: AdminUser[];
  busy: boolean;
  settings: SystemSettings | null;
  onAddUpstreamHost: (host: string) => Promise<void>;
  onOpenSettings: () => void;
  onCreate: () => void;
  onEdit: (server: McpServer) => void;
  onEditInstance: (server: McpServer, instance: McpInstance) => void;
  onAddInstance: (server: McpServer) => void;
  onConfigureAuth: (server: McpServer) => void;
  onSystemOAuth: (instance: McpInstance) => void;
  onConfigureUsers: (server: McpServer) => void;
  onToggle: (server: McpServer) => void;
  onToggleInstance: (server: McpServer, instance: McpInstance) => void;
  onDeleteInstance: (server: McpServer, instance: McpInstance) => void;
  onDelete: (server: McpServer) => void;
}

export function ServersPage(props: ServersPageProps) {
  const { t } = useI18n();
  const { message } = App.useApp();
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<'all' | 'enabled' | 'paused'>('all');

  const filteredServers = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return props.servers.filter((server) => {
      const matchesKeyword =
        !normalizedKeyword ||
        server.name.toLowerCase().includes(normalizedKeyword) ||
        server.display_name.toLowerCase().includes(normalizedKeyword) ||
        (server.description ?? '').toLowerCase().includes(normalizedKeyword) ||
        server.instances.some((instance) => instance.url.toLowerCase().includes(normalizedKeyword));
      const matchesStatus =
        status === 'all' || (status === 'enabled' && server.enabled) || (status === 'paused' && !server.enabled);
      return matchesKeyword && matchesStatus;
    });
  }, [keyword, props.servers, status]);

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      message.success(t('servers.endpointUrlCopied'));
    } catch {
      message.error(t('servers.copyFailed'));
    }
  };

  return (
    <div className="page-stack page-enter server-registry">
      <PageToolbar
        primaryAction={
          <Button disabled={props.busy} type="primary" icon={<PlusOutlined />} onClick={props.onCreate}>
            {t('servers.registerServer')}
          </Button>
        }
        filters={
          <>
            <Input.Search
              allowClear
              className="toolbar-search"
              placeholder={t('servers.searchNameIdEndpoint')}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Segmented
              value={status}
              onChange={(value) => setStatus(value as typeof status)}
              options={[
                { value: 'all', label: t('common.all') },
                { value: 'enabled', label: t('servers.running') },
                { value: 'paused', label: t('servers.paused') },
              ]}
            />
            <Typography.Text type="secondary" className="filter-result-count">
              {t('common.resultCount', { count: filteredServers.length })}
            </Typography.Text>
          </>
        }
      />

      {filteredServers.length ? (
        <Row gutter={[12, 12]}>
          {filteredServers.map((server) => (
            <Col xs={24} xl={12} key={server.name}>
              <Card className="server-card" bordered={false}>
                <header className="server-card-header">
                  <div className="server-heading">
                    <div className="server-title-row">
                      <strong title={server.display_name}>{server.display_name}</strong>
                      <Switch
                        size="small"
                        disabled={props.busy}
                        checked={server.enabled}
                        checkedChildren={t('status.routable')}
                        unCheckedChildren={t('status.paused')}
                        onChange={() => props.onToggle(server)}
                      />
                    </div>
                    <div className="server-route-line">
                      <small>{t('servers.logicalEndpoint')}</small>
                      <code title={`/mcp/${server.name}`}>/mcp/{server.name}</code>
                    </div>
                    <ServiceDescription description={server.description} compact />
                  </div>
                </header>

                {server.enabled &&
                  !server.instances.some(
                    (instance) => instance.enabled && !untrustedUpstreamHost(instance.url, props.settings),
                  ) && (
                    <Alert
                      type="warning"
                      showIcon
                      className="server-availability-alert"
                      message={t(
                        server.instances.some((instance) => instance.enabled)
                          ? 'servers.allInstancesBlocked'
                          : 'servers.noEnabledInstances',
                      )}
                    />
                  )}
                <div className="server-policy">
                  <div className="server-policy-summary">
                    <small>{t('servers.accessGrants')}</small>
                    <strong>{t('servers.countUsers', { count: server.user_count })}</strong>
                    {server.signup_access && <Tag color="blue">{t('servers.signupAccess')}</Tag>}
                  </div>
                  <Button
                    size="small"
                    disabled={props.busy}
                    icon={<TeamOutlined />}
                    onClick={() => props.onConfigureUsers(server)}
                  >
                    {t('servers.assignAccess')}
                  </Button>
                </div>

                <div className="instance-list">
                  {server.instances.length ? (
                    server.instances.map((instance) => {
                      const blockedHost = untrustedUpstreamHost(instance.url, props.settings);
                      return (
                        <div className="instance-row" key={instance.id}>
                          <div className="instance-copy">
                            <Flex align="center" gap={6} wrap>
                              <Badge status={!instance.enabled ? 'default' : blockedHost ? 'warning' : 'success'} />
                              <strong title={instance.id}>{instance.display_name || instance.id}</strong>
                              <Tag bordered={false} color={blockedHost && instance.enabled ? 'warning' : undefined}>
                                {t(
                                  !instance.enabled
                                    ? 'servers.disabled'
                                    : blockedHost
                                      ? 'servers.allowlistBlocked'
                                      : 'servers.instanceEnabled',
                                )}
                              </Tag>
                              <Tag>
                                {t(
                                  instance.auth_mode === 'system_api_key'
                                    ? 'serverDialog.systemApiKey'
                                    : instance.auth_mode === 'system_oauth'
                                      ? 'serverDialog.systemOauth'
                                      : instance.auth_mode === 'api_key'
                                        ? 'serverDialog.userApiKey'
                                        : instance.auth_mode === 'oauth'
                                          ? 'serverDialog.userOauth'
                                          : 'serverDialog.noAdditionalAuth',
                                )}
                              </Tag>
                            </Flex>
                            <Typography.Text>{instance.url}</Typography.Text>
                            {instance.auth_mode === 'system_oauth' && (
                              <Button size="small" type="link" onClick={() => props.onSystemOAuth(instance)}>
                                {t(
                                  instance.system_oauth_connected
                                    ? 'connections.reauthorize'
                                    : 'connections.connectAccount',
                                )}
                              </Button>
                            )}
                            {blockedHost && (
                              <div>
                                <Typography.Text type="warning">
                                  {t('servers.hostNotTrusted', { host: blockedHost })}
                                </Typography.Text>
                                {props.settings?.managed && props.settings.configured ? (
                                  <Button
                                    type="link"
                                    size="small"
                                    disabled={props.busy}
                                    onClick={() =>
                                      void props
                                        .onAddUpstreamHost(blockedHost)
                                        .catch((error) =>
                                          message.error(
                                            error instanceof Error ? error.message : t('common.operationFailed'),
                                          ),
                                        )
                                    }
                                  >
                                    {t('serverDialog.addUpstreamHost')}
                                  </Button>
                                ) : (
                                  <Button type="link" size="small" disabled={props.busy} onClick={props.onOpenSettings}>
                                    {t('settings.title')}
                                  </Button>
                                )}
                              </div>
                            )}
                          </div>
                          <Space className="instance-actions" size={2} wrap>
                            <Tooltip title={t('servers.editInstance')}>
                              <Button
                                type="text"
                                disabled={props.busy}
                                aria-label={t('servers.editInstance')}
                                icon={<EditOutlined />}
                                onClick={() => props.onEditInstance(server, instance)}
                              />
                            </Tooltip>
                            <Tooltip title={t('servers.copyUrl')}>
                              <Button type="text" icon={<CopyOutlined />} onClick={() => copyUrl(instance.url)} />
                            </Tooltip>
                            <Tooltip title={t('servers.openNewTab')}>
                              <Button
                                type="text"
                                icon={<ExportOutlined />}
                                onClick={() => window.open(instance.url, '_blank', 'noopener,noreferrer')}
                              />
                            </Tooltip>
                            <Tooltip
                              title={instance.enabled ? t('servers.disableInstance') : t('servers.enableInstance')}
                            >
                              <Button
                                type="text"
                                disabled={props.busy}
                                icon={<PoweroffOutlined />}
                                onClick={() => props.onToggleInstance(server, instance)}
                              />
                            </Tooltip>
                            <Tooltip title={t('servers.deleteInstance')}>
                              <Button
                                type="text"
                                danger
                                disabled={props.busy}
                                icon={<DeleteOutlined />}
                                onClick={() => props.onDeleteInstance(server, instance)}
                              />
                            </Tooltip>
                          </Space>
                        </div>
                      );
                    })
                  ) : (
                    <Empty image={false} description={t('servers.noUpstreamInstances')} />
                  )}
                </div>

                <footer className="server-card-footer">
                  <span>
                    <TeamOutlined />{' '}
                    {t('servers.adminsAccessDefaultCountIdentities', {
                      count: props.users.filter((user) => user.role === 'admin' || user.servers.includes('*')).length,
                    })}
                  </span>
                  <Space size={4} wrap>
                    <Button
                      size="small"
                      disabled={props.busy}
                      type="link"
                      icon={<EditOutlined />}
                      onClick={() => props.onEdit(server)}
                    >
                      {t('servers.editInfo')}
                    </Button>
                    <Button
                      size="small"
                      disabled={props.busy}
                      type="link"
                      icon={<PlusOutlined />}
                      onClick={() => props.onAddInstance(server)}
                    >
                      {t('servers.addInstance')}
                    </Button>
                    <Button
                      size="small"
                      disabled={props.busy}
                      type="link"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => props.onDelete(server)}
                    >
                      {t('common.delete')}
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
            description={props.servers.length ? t('servers.noMatchingServers') : t('servers.noMcpServersRegistered')}
          >
            {props.servers.length ? (
              <Button
                onClick={() => {
                  setKeyword('');
                  setStatus('all');
                }}
              >
                {t('servers.clearFilters')}
              </Button>
            ) : (
              <Button disabled={props.busy} type="primary" icon={<DeploymentUnitOutlined />} onClick={props.onCreate}>
                {t('servers.registerFirstServer')}
              </Button>
            )}
          </Empty>
        </Card>
      )}
    </div>
  );
}
