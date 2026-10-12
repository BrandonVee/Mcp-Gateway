import { lazy, Suspense, useState, useEffect } from 'react';
import { Alert, App as AntApp, Button, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import { AppShell } from './components/AppShell';
import { BootScreen } from './components/BootScreen';
import { DataLoadError, PageSkeleton } from './components/DataLoadState';
import { useControlPlane } from './hooks/useControlPlane';
import { getAppTheme } from './theme';
import { ThemeProvider, useColorMode } from './color-mode';
import type { DialogState, PlatformSession, SystemSettings, View } from './types';
import { I18nProvider, useI18n } from './i18n';
import { waitForSystemUpdate } from './features/settings/update-task';
import { usePlatformSession } from './features/auth/usePlatformSession';

const LoginPage = lazy(() =>
  import('./features/auth/LoginPage').then((module) => ({
    default: module.LoginPage,
  })),
);
const SettingsPage = lazy(() =>
  import('./features/settings/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);
const OverviewPage = lazy(() =>
  import('./features/overview/OverviewPage').then((module) => ({
    default: module.OverviewPage,
  })),
);
const UsersPage = lazy(() =>
  import('./features/users/UsersPage').then((module) => ({
    default: module.UsersPage,
  })),
);
const UserDialogs = lazy(() =>
  import('./features/users/UserDialogs').then((module) => ({
    default: module.UserDialogs,
  })),
);
const ServersPage = lazy(() =>
  import('./features/servers/ServersPage').then((module) => ({
    default: module.ServersPage,
  })),
);
const ServerDialogs = lazy(() =>
  import('./features/servers/ServerDialogs').then((module) => ({
    default: module.ServerDialogs,
  })),
);
const ConnectionsPage = lazy(() =>
  import('./features/connections/ConnectionsPage').then((module) => ({ default: module.ConnectionsPage })),
);
const ConnectionsAdminPage = lazy(() =>
  import('./features/connections/ConnectionsAdminPage').then((module) => ({ default: module.ConnectionsAdminPage })),
);
const MonitoringPage = lazy(() =>
  import('./features/monitoring/MonitoringPage').then((module) => ({ default: module.MonitoringPage })),
);
const AuditPage = lazy(() =>
  import('./features/monitoring/AuditPage').then((module) => ({ default: module.AuditPage })),
);
const TopologyPage = lazy(() =>
  import('./features/topology/TopologyPage').then((module) => ({ default: module.TopologyPage })),
);

export function App() {
  return (
    <I18nProvider>
      <ThemeProvider>
        <LocalizedApp />
      </ThemeProvider>
    </I18nProvider>
  );
}

function LocalizedApp() {
  const { language } = useI18n();
  const { mode } = useColorMode();
  return (
    <ConfigProvider locale={language === 'zh-CN' ? zhCN : enUS} theme={getAppTheme(mode)}>
      <AntApp>
        <Suspense fallback={<BootScreen />}>
          <SessionRouter />
        </Suspense>
      </AntApp>
    </ConfigProvider>
  );
}

function SessionRouter() {
  const identity = usePlatformSession();
  if (identity.error)
    return (
      <DataLoadError message={identity.error} loading={identity.checking} onRetry={() => void identity.refresh()} />
    );
  if (identity.session === undefined) return <BootScreen />;
  if (!identity.session)
    return (
      <LoginPage
        onSuccess={identity.signedIn}
        registrationEnabled={identity.registrationEnabled}
        emailVerificationRequired={identity.emailVerificationRequired}
      />
    );
  const session = identity.session;
  const key = `${session.user_id}:${session.auth_version}:${session.role}`;
  return (
    <div inert={identity.checking} aria-busy={identity.checking}>
      {session.role === 'admin' && window.location.pathname !== '/connections' ? (
        <ControlPlane key={key} session={session} onLogout={identity.logout} onSessionExpired={identity.refresh} />
      ) : (
        <ConnectionsPage key={key} session={session} onLogout={identity.logout} onSessionExpired={identity.refresh} />
      )}
    </div>
  );
}

function ControlPlane({
  session,
  onLogout,
  onSessionExpired,
}: {
  session: PlatformSession;
  onLogout: () => Promise<void>;
  onSessionExpired: () => Promise<void>;
}) {
  const { message, modal } = AntApp.useApp();
  const { t } = useI18n();
  const controlPlane = useControlPlane(session, onLogout, onSessionExpired);
  const [view, setView] = useState<View>('overview');
  useEffect(() => {
    if (controlPlane.settings?.managed && !controlPlane.settings.configured) setView('settings');
  }, [controlPlane.settings]);
  const [dialog, setDialog] = useState<DialogState>({ type: null });
  const [updating, setUpdating] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);

  const startUpdate = (tag: string) => {
    const before = controlPlane.update?.container_id ?? '';
    modal.confirm({
      title: t('settings.updateConfirmTitle'),
      content: t('settings.updateConfirmBody', {
        version: tag === 'latest' ? controlPlane.update?.target_image || t('settings.updateLatest') : tag,
      }),
      okText: t('settings.updateOk'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        setUpdating(true);
        try {
          const started = await controlPlane.api.startSystemUpdate(tag);
          message.success(t('settings.updateRunning'));
          const outcome = await waitForSystemUpdate(
            {
              systemUpdate: () => controlPlane.api.systemUpdate(false, true),
              systemUpdateTask: controlPlane.api.systemUpdateTask,
            },
            started.container_id || before,
            started.updater_id,
          );
          if (outcome !== 'completed') {
            message.error(t(outcome === 'failed' ? 'settings.updateTaskFailed' : 'settings.updateTimeout'));
            return;
          }
          message.success(t('settings.updateReloading'));
          window.location.reload();
        } catch (error) {
          message.error(error instanceof Error ? error.message : t('common.operationFailed'));
        } finally {
          setUpdating(false);
        }
      },
    });
  };

  const execute = async (operation: () => Promise<unknown>, success: string) => {
    try {
      const result = await controlPlane.execute(operation);
      message.success(success);
      if (result.refreshError) message.warning(t('common.savedRefreshFailed'));
      setDialog({ type: null });
      return true;
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('common.operationFailed'));
      return false;
    }
  };
  const confirmResult = async (result: Promise<boolean>) => {
    if (!(await result)) throw new Error('Operation failed');
  };
  const addUpstreamHost = async (host: string) => {
    const result = await controlPlane.execute(() => controlPlane.addUpstreamHost(host));
    message.success(t('serverDialog.upstreamHostAdded', { host }));
    if (result.refreshError) message.warning(t('common.savedRefreshFailed'));
  };
  const navigate = (next: View) => {
    if (next === view || controlPlane.busy) return;
    if (settingsDirty) {
      modal.confirm({
        title: t('settings.discardTitle'),
        content: t('settings.discardHelp'),
        okText: t('settings.discard'),
        cancelText: t('common.cancel'),
        onOk: () => {
          setSettingsDirty(false);
          setView(next);
        },
      });
    } else setView(next);
  };

  const refresh = async () => {
    try {
      await controlPlane.refresh();
      message.success(t('common.dataRefreshed'));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t('common.refreshFailed'));
    }
  };

  const dataUnavailable =
    Boolean(controlPlane.loadError) && controlPlane.users.length === 0 && controlPlane.servers.length === 0;

  return (
    <AppShell
      currentView={view}
      userCount={controlPlane.users.length}
      serverCount={controlPlane.servers.length}
      refreshing={controlPlane.busy}
      loggingOut={controlPlane.loggingOut}
      onNavigate={navigate}
      onRefresh={refresh}
      onLogout={async () => {
        try {
          await controlPlane.logout();
        } catch {
          message.error(t('auth.logoutFailed'));
        }
      }}
    >
      {controlPlane.initializing ? (
        <PageSkeleton />
      ) : dataUnavailable ? (
        <DataLoadError
          message={controlPlane.loadError ?? t('common.unknownError')}
          loading={controlPlane.busy}
          onRetry={refresh}
        />
      ) : (
        <>
          {controlPlane.loadError && (
            <Alert
              type="warning"
              showIcon
              message={t('common.dataMayBeStale')}
              description={controlPlane.loadError}
              action={
                <Button onClick={() => void refresh()} loading={controlPlane.busy}>
                  {t('common.refresh')}
                </Button>
              }
            />
          )}
          {view === 'settings' && controlPlane.settings && (
            <SettingsPage
              settings={controlPlane.settings}
              update={controlPlane.update}
              updating={updating}
              onSave={async (body) => {
                let saved: SystemSettings | null = null;
                const success = await execute(async () => {
                  saved = await controlPlane.saveSystemSettings(body);
                }, t('settings.saved'));
                return success ? saved : null;
              }}
              onDirtyChange={setSettingsDirty}
              onUpdate={startUpdate}
              onCheckUpdate={controlPlane.refreshUpdate}
              onTestEmail={async (to, smtp) => {
                await controlPlane.api.testEmail(to, smtp);
              }}
            />
          )}
          {view === 'overview' && (
            <OverviewPage
              api={controlPlane.api}
              onNavigate={navigate}
              users={controlPlane.users}
              servers={controlPlane.servers}
              health={controlPlane.health}
              authHealth={controlPlane.authHealth}
              settings={controlPlane.settings}
            />
          )}

          {view === 'users' && (
            <UsersPage
              users={controlPlane.users}
              busy={controlPlane.busy}
              onCreate={() => setDialog({ type: 'create-user' })}
              onEdit={(user) => setDialog({ type: 'edit-user', user })}
              onAssign={(user) => setDialog({ type: 'assign-user', user })}
              onPassword={(user) => setDialog({ type: 'reset-password', user })}
              onToggle={(user) => {
                const update = () =>
                  execute(
                    () => controlPlane.api.updateUser(user.id, { disabled: !user.disabled }),
                    user.disabled ? t('app.userSignEnabled') : t('app.userSignDisabled'),
                  );
                if (user.disabled) void update();
                else
                  modal.confirm({
                    title: t('app.disableSignName', { name: user.username }),
                    content: t('app.userLoseSignMcpAccess'),
                    okText: t('app.disableSign'),
                    okButtonProps: { danger: true },
                    cancelText: t('common.cancel'),
                    onOk: () => confirmResult(update()),
                  });
              }}
              onDelete={(user) =>
                modal.confirm({
                  title: t('app.deleteUserName', { name: user.username }),
                  content: t('app.deleteUserRemovesServerGrants'),
                  okText: t('app.delete'),
                  okButtonProps: { danger: true },
                  cancelText: t('common.cancel'),
                  onOk: () => confirmResult(execute(() => controlPlane.api.deleteUser(user.id), t('app.userDeleted'))),
                })
              }
            />
          )}

          {view === 'servers' && (
            <ServersPage
              servers={controlPlane.servers}
              users={controlPlane.users}
              busy={controlPlane.busy}
              settings={controlPlane.settings}
              onAddUpstreamHost={addUpstreamHost}
              onOpenSettings={() => navigate('settings')}
              onCreate={() => setDialog({ type: 'create-server' })}
              onEdit={(server) => setDialog({ type: 'edit-server', server })}
              onEditInstance={(server, instance) => setDialog({ type: 'edit-instance', server, instance })}
              onAddInstance={(server) => setDialog({ type: 'add-instance', server })}
              onSystemOAuth={(instance) => {
                void controlPlane.api
                  .startOAuth(instance.id)
                  .then((result) => window.location.assign(result.authorization_url))
                  .catch((error) =>
                    message.error(error instanceof Error ? error.message : t('common.operationFailed')),
                  );
              }}
              onConfigureAuth={(server) => setDialog({ type: 'configure-server-auth', server })}
              onConfigureUsers={(server) => setDialog({ type: 'configure-server-users', server })}
              onToggle={(server) =>
                execute(
                  () =>
                    controlPlane.api.updateServer(server.name, {
                      enabled: !server.enabled,
                    }),
                  server.enabled ? t('app.serverPaused') : t('app.serverEnabled'),
                )
              }
              onToggleInstance={(server, instance) =>
                execute(
                  () =>
                    controlPlane.api.updateInstance(server.name, instance.id, {
                      enabled: !instance.enabled,
                    }),
                  t('app.instanceStatusUpdated'),
                )
              }
              onDeleteInstance={(server, instance) =>
                modal.confirm({
                  title: t('app.deleteInstanceId', { id: instance.id }),
                  content: t('app.gatewayStopForwardingRequestsInstance'),
                  okText: t('app.delete'),
                  okButtonProps: { danger: true },
                  cancelText: t('common.cancel'),
                  onOk: () =>
                    confirmResult(
                      execute(
                        () => controlPlane.api.deleteInstance(server.name, instance.id),
                        t('app.instanceDeleted'),
                      ),
                    ),
                })
              }
              onDelete={(server) =>
                modal.confirm({
                  title: t('app.deleteServerName', { name: server.name }),
                  content: t('app.instancesUserGrantsDeletedCannot'),
                  okText: t('app.delete'),
                  okButtonProps: { danger: true },
                  cancelText: t('common.cancel'),
                  onOk: () =>
                    confirmResult(execute(() => controlPlane.api.deleteServer(server.name), t('app.serverDeleted'))),
                })
              }
            />
          )}

          {view === 'credentials' && (
            <ConnectionsAdminPage
              users={controlPlane.users}
              servers={controlPlane.servers}
              connections={controlPlane.connections}
              busy={controlPlane.busy}
              onRevoke={(user, server) =>
                modal.confirm({
                  title: t('app.revokeUserServerConnection', { user: user.username, server: server.display_name }),
                  content: t('app.storedApiKeyOauthToken'),
                  okText: t('app.revokeConnection'),
                  okButtonProps: { danger: true },
                  cancelText: t('common.cancel'),
                  onOk: () =>
                    confirmResult(
                      execute(
                        () => controlPlane.api.revokeConnection(user.id, server.name, server.upstream_id),
                        t('app.connectionRevoked'),
                      ),
                    ),
                })
              }
            />
          )}

          {view === 'topology' && <TopologyPage />}

          {view === 'monitoring' && <MonitoringPage />}
          {view === 'audit' && <AuditPage />}

          <UserDialogs
            state={dialog}
            servers={controlPlane.servers}
            busy={controlPlane.busy}
            onClose={() => setDialog({ type: null })}
            onCreate={(data) => execute(() => controlPlane.api.createUser(data), t('app.userCreated'))}
            onEdit={(user, data) => execute(() => controlPlane.api.updateUser(user.id, data), t('app.userUpdated'))}
            onAssign={(user, servers) =>
              execute(() => controlPlane.api.setUserServers(user.id, servers), t('app.accessGrantsUpdated'))
            }
            onPassword={(user, password) =>
              execute(() => controlPlane.api.updateUser(user.id, { password }), t('app.passwordReset'))
            }
          />

          <ServerDialogs
            state={dialog}
            users={controlPlane.users}
            settings={controlPlane.settings}
            onAddUpstreamHost={addUpstreamHost}
            onTestUpstream={controlPlane.api.testUpstream}
            busy={controlPlane.busy}
            onClose={() => setDialog({ type: null })}
            onCreate={(data) => execute(() => controlPlane.api.createServer(data), t('app.mcpServerRegistered'))}
            onEdit={(server, data) =>
              execute(() => controlPlane.api.updateServer(server.name, data), t('servers.infoSaved'))
            }
            onEditInstance={(server, instance, data) =>
              execute(() => controlPlane.api.updateInstance(server.name, instance.id, data), t('servers.instanceSaved'))
            }
            onAddInstance={(server, data) =>
              execute(() => controlPlane.api.addInstance(server.name, data), t('app.instanceAdded'))
            }
            onConfigureAuth={(server, data) =>
              execute(() => controlPlane.api.updateServer(server.name, data), t('app.authenticationSettingsUpdated'))
            }
            onConfigureUsers={(server, userIds, signupAccess) =>
              execute(
                () => controlPlane.api.setServerUsers(server.name, userIds, signupAccess),
                t('app.userGrantsUpdated'),
              )
            }
          />
        </>
      )}
    </AppShell>
  );
}
