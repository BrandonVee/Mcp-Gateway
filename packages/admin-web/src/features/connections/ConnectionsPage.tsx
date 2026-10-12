import { MyCallLogs } from '../monitoring/MyCallLogs';
import { useEffect, useMemo, useState } from 'react';
import { App, Button, Card, Empty, Input, Modal, Tag, Typography } from 'antd';
import {
  ApiOutlined,
  CopyOutlined,
  DashboardOutlined,
  DisconnectOutlined,
  KeyOutlined,
  LinkOutlined,
  LogoutOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { ApiError, apiForSession } from '../../api';
import type { ConnectionServer, PlatformSession } from '../../types';
import { DataLoadError } from '../../components/DataLoadState';
import { useI18n } from '../../i18n';
import { ServiceDescription } from '../../components/ServiceDescription';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';
import { ThemeSwitcher } from '../../components/ThemeSwitcher';
import { mcpConfig, mcpServerUrl } from './mcp-config';
import { mutateAndRefresh } from '../../utils/operations';
import { validApiKey } from '../../utils/validation';
import { oauthResultKey } from './oauth-result';
import './connections.css';

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
  const [selected, setSelected] = useState<ConnectionServer | null>(null);
  const [key, setKey] = useState('');
  const [resource, setResource] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

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
    if (!validApiKey(key)) {
      message.error(t('api.invalidApiKey'));
      return;
    }
    setBusy(true);
    try {
      const result = await mutateAndRefresh(() => api.saveApiKey(selected.name, key), load);
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
      <div className="connections-glow" />
      <header className="connections-header">
        <div className="connections-mark">
          <ApiOutlined />
        </div>
        <div>
          <span className="connections-eyebrow">{t('connections.personalAccessEyebrow')}</span>
          <strong>{t('connections.title')}</strong>
        </div>
        <div className="connections-preferences">
          <ThemeSwitcher />
          <LanguageSwitcher />
        </div>
        <div className="connections-user">
          <span>{username}</span>
          {isAdmin && (
            <Button className="connections-admin-link" href="/" icon={<DashboardOutlined />}>
              {t('connections.openAdminConsole')}
            </Button>
          )}
          <Button
            icon={<LogoutOutlined />}
            loading={busy}
            onClick={async () => {
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
            }}
          >
            {t('connections.signOut')}
          </Button>
        </div>
      </header>

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
        <section className="connections-content">
          <div className="connections-intro">
            <div>
              <span className="connections-eyebrow">{t('connections.integrationsEyebrow')}</span>
              <h1>{t('connections.letEveryToolWorkYou')}</h1>
              <p>{t('connections.credentialsUsedRelevantServicePlatform')}</p>
            </div>
            <div className="connections-intro-actions">
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
          {servers.length ? (
            <div className="connections-grid">
              {servers.map((server, index) => (
                <Card key={server.name} className="connection-card" bordered={false}>
                  <div className="connection-top">
                    <span className="connection-index">{String(index + 1).padStart(2, '0')}</span>
                    <Tag
                      color={
                        server.connection_status === 'connected'
                          ? 'success'
                          : server.connection_status === 'expired'
                            ? 'warning'
                            : 'default'
                      }
                    >
                      {t(
                        server.connection_status === 'connected'
                          ? 'status.connected'
                          : server.connection_status === 'not_required'
                            ? 'connections.noConnectionNeeded'
                            : server.connection_status === 'expired'
                              ? 'status.expired'
                              : 'connections.notConnected',
                      )}
                    </Tag>
                  </div>
                  <h2>{server.display_name}</h2>
                  {server.endpoint_display_name && (
                    <Typography.Text type="secondary">{server.endpoint_display_name}</Typography.Text>
                  )}
                  <dl className="connection-details">
                    <div>
                      <dt>{t('connections.serverName')}</dt>
                      <dd>
                        <code>{server.name}</code>
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
                  <ServiceDescription description={server.description} />
                  <div className="connection-bottom">
                    <span>
                      {t(
                        server.auth_mode === 'system_oauth'
                          ? 'serverDialog.systemOauth'
                          : server.auth_mode === 'system_api_key'
                            ? 'serverDialog.systemApiKey'
                            : server.auth_mode === 'api_key'
                              ? 'connections.modeApiKey'
                              : server.auth_mode === 'oauth'
                                ? 'connections.modeOAuth'
                                : 'connections.modePlatform',
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
                          server.connection_status === 'connected'
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
                          server.connection_status === 'connected'
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
                        <Button
                          disabled={busy}
                          danger
                          type="text"
                          icon={<DisconnectOutlined />}
                          onClick={() => disconnect(server)}
                        >
                          {t('connections.disconnectAction')}
                        </Button>
                      )}
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <Empty description={t('connections.noMcpServersBeenAssigned')} />
          )}
          <Typography.Text className="connections-note">
            {t('connections.serversGrantedAdministratorAppearHere')}
          </Typography.Text>
          <Typography.Text className="connections-note">{t('connections.mcpConfigHint')}</Typography.Text>
        </section>
      )}

      <Modal
        title={t('connections.configureApiKeyServer', { server: selected?.display_name ?? '' })}
        open={!!selected}
        okText={t('connections.saveKey')}
        okButtonProps={{ disabled: !validApiKey(key) || busy, loading: busy }}
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
        {key && !validApiKey(key) && <Typography.Text type="danger">{t('api.invalidApiKey')}</Typography.Text>}
      </Modal>
      <MyCallLogs session={session} />
    </main>
  );
}
