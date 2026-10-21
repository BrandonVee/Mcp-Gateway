import { MyCallLogs } from '@/web/features/monitoring/MyCallLogs';
import { UserApiKeys } from '@/web/features/connections/UserApiKeys';
import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Dropdown, Empty, Input, Select, Tag, Typography } from 'antd';
import {
  ApiOutlined,
  CopyOutlined,
  DashboardOutlined,
  DownOutlined,
  DisconnectOutlined,
  FileTextOutlined,
  KeyOutlined,
  LinkOutlined,
  LogoutOutlined,
  MoreOutlined,
  ReloadOutlined,
  SearchOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { ApiError, apiForSession } from '@/web/api';
import type { ConnectionServer, PlatformSession, UpstreamTestResult } from '@/web/types';
import { UpstreamTestDetails } from '@/web/features/servers/UpstreamTestDetails';
import { DataLoadError } from '@/web/components/DataLoadState';
import { BrandMark } from '@/web/components/BrandMark';
import { useI18n } from '@/web/i18n';
import { ServiceDescription } from '@/web/components/ServiceDescription';
import { FormModal } from '@/web/components/FormModal';
import { LanguageSwitcher } from '@/web/components/LanguageSwitcher';
import { ThemeSwitcher } from '@/web/components/ThemeSwitcher';
import { mcpConfig, mcpServerUrl } from '@/web/features/connections/mcp-config';
import { mutateAndRefresh } from '@/web/utils/operations';
import { isValidApiKey } from '@/shared/security/credentials.js';
import { oauthResultKey } from '@/web/features/connections/oauth-result';
import { upstreamTestMessages } from '@/web/features/servers/upstream-test-messages';
import '@/web/features/connections/connections.css';

export function ConnectionsPage({
  session,
  onLogout,
  onSessionExpired,
}: {
  session: PlatformSession;
  onLogout: () => Promise<void>;
  onSessionExpired: () => Promise<void>;
}) {
  const api = useMemo(() => apiForSession(session), [session.user_id, session.auth_version]);
  const { message, modal } = App.useApp();
  const { t } = useI18n();
  const username = session.username;
  const isAdmin = session.role === 'admin';
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [servers, setServers] = useState<ConnectionServer[]>([]);
  const [activeTab, setActiveTab] = useState<'services' | 'logs' | 'keys'>('services');
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<ConnectionServer['connection_status'] | 'all'>('all');
  const [selected, setSelected] = useState<ConnectionServer | null>(null);
  const [key, setKey] = useState('');
  const [resource, setResource] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, UpstreamTestResult>>({});
  const filteredServers = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return servers.filter(
      (server) =>
        (status === 'all' || server.connection_status === status) &&
        (!query ||
          [server.display_name, server.name, server.endpoint_display_name, server.description]
            .join(' ')
            .toLowerCase()
            .includes(query)),
    );
  }, [servers, keyword, status]);

  const checkSession = (error: unknown) => {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.code === 'session_changed'))
      void onSessionExpired();
  };

  const load = async () => {
    setLoadError(null);
    try {
      const [list, gateway] = await Promise.all([
        api.myServers(),
        api.gatewayResource().catch(() => ({ resource: '' })),
      ]);
      setResource(gateway.resource);
      setServers(list.servers);
    } catch (error) {
      checkSession(error);
      setLoadError(error instanceof Error ? error.message : t('common.refreshFailed'));
      throw error;
    }
  };

  useEffect(() => {
    load()
      .catch(() => undefined)
      .finally(() => setLoading(false));
    const result = new URLSearchParams(window.location.search).get('result');
    if (result) {
      if (result === 'connected') message.success(t('connections.oauthConnectionEstablished'));
      else message.error(t(oauthResultKey(result)));
      const query = new URLSearchParams(window.location.search);
      query.delete('result');
      query.delete('server');
      window.history.replaceState(
        null,
        '',
        window.location.pathname + (query.size ? `?${query}` : '') + window.location.hash,
      );
    }
  }, []);

  const saveKey = async () => {
    if (!selected || busy) return;
    if (!isValidApiKey(key)) {
      message.error(t('api.invalidApiKey'));
      return;
    }
    setBusy(true);
    try {
      const target = selected;
      const result = await mutateAndRefresh(async () => {
        await api.saveApiKey(target.name, key);
        setKey('');
        setSelected(null);
        setTestResults((previous) => {
          const next = { ...previous };
          delete next[target.name];
          return next;
        });
        try {
          const test = await api.testMyConnection(target.name);
          setTestResults((previous) => ({ ...previous, [target.name]: test }));
          if (!test.ok) message.warning(t('connections.savedNeedsAttention'));
        } catch (error) {
          checkSession(error);
          message.warning(t('connections.savedTestUnavailable'));
        }
      }, load);
      setKey('');
      setSelected(null);
      message.success(t('connections.apiKeySaved'));
      if (result.refreshError) message.warning(t('common.savedRefreshFailed'));
    } catch (error) {
      checkSession(error);
      message.error(error instanceof Error ? error.message : t('connections.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async (server: ConnectionServer) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await mutateAndRefresh(async () => {
        const test = await api.testMyConnection(server.name);
        setTestResults((previous) => ({ ...previous, [server.name]: test }));
      }, load);
      if (result.refreshError) message.warning(t('common.savedRefreshFailed'));
    } catch (error) {
      checkSession(error);
      message.error(error instanceof Error ? error.message : t('common.operationFailed'));
    } finally {
      setBusy(false);
    }
  };

  const connectOAuth = async (server: ConnectionServer) => {
    if (busy) return;
    setBusy(true);
    try {
      const { authorization_url } = await api.startOAuth(server.name);
      window.location.assign(authorization_url);
    } catch (error) {
      checkSession(error);
      message.error(error instanceof Error ? error.message : t('connections.couldNotStartOauth'));
      setBusy(false);
    }
  };

  const disconnect = (server: ConnectionServer) =>
    modal.confirm({
      title: t('connections.disconnectServer', { server: server.display_name }),
      content: t('connections.storedCredentialsDeletedReconnectionRequired'),
      okText: t('connections.disconnect'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        setBusy(true);
        try {
          const result = await mutateAndRefresh(() => api.removeCredential(server.name), load);
          message.success(t('connections.connectionDisconnected'));
          setTestResults((previous) => {
            const next = { ...previous };
            delete next[server.name];
            return next;
          });
          if (result.refreshError) message.warning(t('common.savedRefreshFailed'));
        } catch (error) {
          checkSession(error);
          message.error(error instanceof Error ? error.message : t('common.operationFailed'));
          throw error;
        } finally {
          setBusy(false);
        }
      },
    });

  const copyMcpConfig = async (selectedServers: ConnectionServer[]) => {
    try {
      const { resource } = await api.gatewayResource();
      await navigator.clipboard.writeText(mcpConfig(selectedServers, resource));
      message.success(t('connections.mcpConfigCopied'));
    } catch {
      message.error(t('connections.mcpConfigCopyFailed'));
    }
  };

  if (loading) return <div className="connections-loading">{t('connections.loadingConnections')}</div>;

  return (
    <main className="connections-page">
      <aside className="connections-sidebar">
        <div className="connections-brand">
          <BrandMark className="connections-mark" />
          <div>
            <strong>{t('app.documentTitle')}</strong>
            <small>{t('connections.title')}</small>
          </div>
        </div>
        <nav className="connections-nav-group" aria-label={t('nav.workspace')}>
          <button
            type="button"
            className={`connections-sidebar-item ${activeTab === 'services' ? 'is-active' : ''}`}
            aria-current={activeTab === 'services' ? 'page' : undefined}
            onClick={() => setActiveTab('services')}
          >
            <ApiOutlined />
            <span>{t('connections.tabServices')}</span>
          </button>
          <button
            type="button"
            className={`connections-sidebar-item ${activeTab === 'logs' ? 'is-active' : ''}`}
            aria-current={activeTab === 'logs' ? 'page' : undefined}
            onClick={() => setActiveTab('logs')}
          >
            <FileTextOutlined />
            <span>{t('connections.tabLogs')}</span>
          </button>
          <button
            type="button"
            className={`connections-sidebar-item ${activeTab === 'keys' ? 'is-active' : ''}`}
            aria-current={activeTab === 'keys' ? 'page' : undefined}
            onClick={() => setActiveTab('keys')}
          >
            <KeyOutlined />
            <span>{t('keys.title')}</span>
          </button>
        </nav>
        <div className="connections-sidebar-footer">
          {isAdmin && (
            <Button
              type="text"
              block
              href="/"
              icon={<DashboardOutlined />}
              className="connections-console-link"
              aria-label={t('connections.openAdminConsole')}
              title={t('connections.openAdminConsole')}
            >
              {t('connections.openAdminConsole')}
            </Button>
          )}
          <div className="connections-sidebar-preferences">
            <ThemeSwitcher />
            <LanguageSwitcher />
          </div>
          <Dropdown
            trigger={['click']}
            placement="topLeft"
            menu={{
              items: [
                {
                  key: 'logout',
                  icon: <LogoutOutlined />,
                  label: t('connections.signOut'),
                  danger: true,
                  disabled: busy,
                  onClick: async () => {
                    setBusy(true);
                    try {
                      await onLogout();
                      setServers([]);
                      setSelected(null);
                      setKey('');
                    } catch {
                      message.error(t('auth.logoutFailed'));
                    } finally {
                      setBusy(false);
                    }
                  },
                },
              ],
            }}
          >
            <Button
              type="text"
              block
              className="connections-account"
              icon={<UserOutlined />}
              loading={busy}
              aria-label={username}
              title={username}
            >
              <span className="connections-account-name">{username}</span>
              <DownOutlined />
            </Button>
          </Dropdown>
        </div>
      </aside>

      <section className="connections-content">
        {loadError ? (
          <DataLoadError
            message={loadError}
            loading={busy}
            onRetry={() => {
              setBusy(true);
              void load()
                .catch(() => undefined)
                .finally(() => setBusy(false));
            }}
          />
        ) : (
          <section className="connections-main">
            <div className="connections-tab-panel" hidden={activeTab !== 'services'}>
              <div className="connections-tab-toolbar">
                <div className="connections-tab-meta">
                  <h1>{t('connections.tabServices')}</h1>
                </div>
                <div className="connections-tab-actions">
                  <Button
                    icon={<ReloadOutlined />}
                    loading={busy}
                    onClick={() => {
                      setBusy(true);
                      void load()
                        .catch(() => message.error(t('common.refreshFailed')))
                        .finally(() => setBusy(false));
                    }}
                  >
                    {t('connections.refreshStatus')}
                  </Button>
                  <Button
                    type="primary"
                    icon={<CopyOutlined />}
                    disabled={!servers.length}
                    onClick={() => copyMcpConfig(servers)}
                  >
                    {t('connections.copyAllMcpConfig')}
                  </Button>
                </div>
              </div>
              <div className="connections-filters">
                <Input
                  prefix={<SearchOutlined />}
                  allowClear
                  placeholder={t('connections.searchServices')}
                  aria-label={t('connections.searchServices')}
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                />
                <Select
                  value={status}
                  onChange={setStatus}
                  aria-label={t('connections.filterStatus')}
                  options={[
                    { value: 'all', label: t('connections.allStatuses') },
                    { value: 'connected', label: t('status.connected') },
                    { value: 'not_connected', label: t('connections.notConnected') },
                    { value: 'not_required', label: t('connections.noConnectionNeeded') },
                    { value: 'saved', label: t('connections.saved') },
                    { value: 'expired', label: t('status.expired') },
                    { value: 'rejected', label: t('connections.rejected') },
                  ]}
                />
              </div>
              <div
                className="connections-scroll-region"
                role="region"
                aria-label={t('connections.tabServices')}
                tabIndex={0}
              >
                {filteredServers.length ? (
                  <div className="connections-grid">
                    {filteredServers.map((server) => (
                      <Card key={server.name} className="connection-card" bordered={false}>
                        <div className="connection-info">
                          <div className="connection-heading">
                            <h2>{server.display_name}</h2>
                            <Tag
                              color={
                                server.connection_status === 'rejected'
                                  ? 'error'
                                  : server.connection_status === 'saved'
                                    ? 'processing'
                                    : server.connection_status === 'connected'
                                      ? 'success'
                                      : server.connection_status === 'expired'
                                        ? 'warning'
                                        : 'default'
                              }
                            >
                              {t(
                                server.connection_status === 'rejected'
                                  ? 'connections.rejected'
                                  : server.connection_status === 'saved'
                                    ? 'connections.saved'
                                    : server.connection_status === 'connected'
                                      ? 'status.connected'
                                      : server.connection_status === 'not_required'
                                        ? 'connections.noConnectionNeeded'
                                        : server.connection_status === 'expired'
                                          ? 'status.expired'
                                          : 'connections.notConnected',
                              )}
                            </Tag>
                          </div>
                          {server.endpoint_display_name && server.endpoint_display_name !== server.display_name && (
                            <Typography.Text type="secondary" className="connection-endpoint">
                              {server.endpoint_display_name}
                            </Typography.Text>
                          )}
                          <dl className="connection-details">
                            <div>
                              <dt>{t('serverDialog.gatewayAuth')}</dt>
                              <dd>
                                {server.access_auth_mode === 'none'
                                  ? t('serverDialog.gatewayNone')
                                  : server.access_auth_mode === 'api_key'
                                    ? t('serverDialog.gatewayApiKey')
                                    : 'OAuth'}
                              </dd>
                            </div>
                            <div>
                              <dt>{t('connections.mcpUrl')}</dt>
                              <dd>
                                <code>
                                  {resource
                                    ? mcpServerUrl(server.endpoint_name ?? server.name, resource)
                                    : t('connections.urlUnavailable')}
                                </code>
                              </dd>
                            </div>
                          </dl>
                          <ServiceDescription description={server.description} compact />
                          {testResults[server.name] && (
                            <Alert
                              showIcon
                              type={testResults[server.name].ok ? 'success' : 'warning'}
                              message={t(upstreamTestMessages[testResults[server.name].reason], {
                                status: testResults[server.name].http_status ?? '—',
                              })}
                              description={<UpstreamTestDetails result={testResults[server.name]} />}
                            />
                          )}
                        </div>
                        <div className="connection-bottom">
                          <span>
                            {t('connectionsAdmin.upstreamAuth')}:{' '}
                            {t(
                              server.auth_mode === 'system_oauth'
                                ? 'serverDialog.systemOauth'
                                : server.auth_mode === 'system_api_key'
                                  ? 'serverDialog.systemApiKey'
                                  : server.auth_mode === 'api_key'
                                    ? 'connections.modeApiKey'
                                    : server.auth_mode === 'oauth'
                                      ? 'connections.modeOAuth'
                                      : 'connectionsAdmin.noAuthRequired',
                            )}
                          </span>
                          <Button icon={<CopyOutlined />} onClick={() => copyMcpConfig([server])}>
                            {t('connections.copyMcpConfig')}
                          </Button>
                          {server.auth_mode === 'api_key' && (
                            <Button
                              disabled={busy}
                              type="primary"
                              icon={<KeyOutlined />}
                              onClick={() => {
                                setKey('');
                                setSelected(server);
                              }}
                            >
                              {t(
                                server.connection_status !== 'not_connected'
                                  ? 'connections.updateKey'
                                  : 'connections.configureKey',
                              )}
                            </Button>
                          )}
                          {(server.auth_mode === 'oauth' || (server.auth_mode === 'system_oauth' && isAdmin)) && (
                            <Button
                              type="primary"
                              icon={<LinkOutlined />}
                              loading={busy}
                              onClick={() => connectOAuth(server)}
                            >
                              {t(
                                server.connection_status !== 'not_connected'
                                  ? 'connections.reauthorize'
                                  : 'connections.connectAccount',
                              )}
                            </Button>
                          )}
                          {(server.auth_mode === 'oauth' ||
                            server.auth_mode === 'api_key' ||
                            (server.auth_mode === 'system_oauth' && isAdmin)) &&
                            server.connection_status !== 'not_required' &&
                            server.connection_status !== 'not_connected' && (
                              <Dropdown
                                trigger={['click']}
                                menu={{
                                  items: [
                                    {
                                      key: 'verify',
                                      icon: <ReloadOutlined />,
                                      label: t('connections.testConnection'),
                                      onClick: () => void testConnection(server),
                                      disabled: busy,
                                    },
                                    {
                                      key: 'disconnect',
                                      icon: <DisconnectOutlined />,
                                      label: t('connections.disconnectAction'),
                                      onClick: () => {
                                        disconnect(server);
                                      },
                                      danger: true,
                                      disabled: busy,
                                    },
                                  ],
                                }}
                              >
                                <Button
                                  icon={<MoreOutlined />}
                                  disabled={busy}
                                  aria-label={t('common.actions')}
                                  title={t('common.actions')}
                                />
                              </Dropdown>
                            )}
                        </div>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <Empty
                    description={t(
                      servers.length ? 'servers.noMatchingServers' : 'connections.noMcpServersBeenAssigned',
                    )}
                  >
                    {servers.length > 0 && (
                      <Button
                        onClick={() => {
                          setKeyword('');
                          setStatus('all');
                        }}
                      >
                        {t('servers.clearFilters')}
                      </Button>
                    )}
                  </Empty>
                )}
                <Typography.Text className="connections-note">
                  {t('connections.serversGrantedAdministratorAppearHere')}
                </Typography.Text>
                <Typography.Text className="connections-note">{t('connections.mcpConfigHint')}</Typography.Text>
              </div>
            </div>

            <div className="connections-tab-panel connections-tab-panel--logs" hidden={activeTab !== 'logs'}>
              <div className="connections-tab-toolbar">
                <div className="connections-tab-meta">
                  <h1>{t('connections.tabLogs')}</h1>
                </div>
              </div>
              <MyCallLogs session={session} />
            </div>
            {activeTab === 'keys' && (
              <div className="connections-tab-panel">
                <UserApiKeys api={api} onError={checkSession} />
              </div>
            )}
          </section>
        )}
      </section>

      <FormModal
        title={t('connections.configureApiKeyServer', { server: selected?.display_name ?? '' })}
        open={!!selected}
        okText={t('connections.saveAndVerify')}
        okButtonProps={{ disabled: !isValidApiKey(key) || busy, loading: busy }}
        cancelButtonProps={{ disabled: busy }}
        closable={!busy}
        keyboard={!busy}
        maskClosable={!busy}
        onOk={saveKey}
        onCancel={() => {
          setSelected(null);
          setKey('');
        }}
        destroyOnHidden
      >
        <p>{t('connections.keyStoredEncryptedNotShown')}</p>
        <Input.Password
          autoComplete="off"
          placeholder={t('connections.pasteApiKey')}
          value={key}
          disabled={busy}
          maxLength={4096}
          onChange={(event) => setKey(event.target.value)}
        />
        {key && !isValidApiKey(key) && <Typography.Text type="danger">{t('api.invalidApiKey')}</Typography.Text>}
      </FormModal>
    </main>
  );
}
