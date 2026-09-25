import { lazy, Suspense, useState } from "react";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { AppShell } from "./components/AppShell";
import { BootScreen } from "./components/BootScreen";
import { DataLoadError, PageSkeleton } from "./components/DataLoadState";
import { useControlPlane } from "./hooks/useControlPlane";
import { appTheme } from "./theme";
import type { DialogState, View } from "./types";

const LoginPage = lazy(() =>
  import("./features/auth/LoginPage").then((module) => ({
    default: module.LoginPage,
  })),
);
const OverviewPage = lazy(() =>
  import("./features/overview/OverviewPage").then((module) => ({
    default: module.OverviewPage,
  })),
);
const UsersPage = lazy(() =>
  import("./features/users/UsersPage").then((module) => ({
    default: module.UsersPage,
  })),
);
const UserDialogs = lazy(() =>
  import("./features/users/UserDialogs").then((module) => ({
    default: module.UserDialogs,
  })),
);
const ServersPage = lazy(() =>
  import("./features/servers/ServersPage").then((module) => ({
    default: module.ServersPage,
  })),
);
const ServerDialogs = lazy(() =>
  import("./features/servers/ServerDialogs").then((module) => ({
    default: module.ServerDialogs,
  })),
);
const ConnectionsPage = lazy(() => import("./features/connections/ConnectionsPage").then((module) => ({ default: module.ConnectionsPage })));
const ConnectionsAdminPage = lazy(() => import("./features/connections/ConnectionsAdminPage").then((module) => ({ default: module.ConnectionsAdminPage })));
const MonitoringPage = lazy(() => import("./features/monitoring/MonitoringPage").then((module) => ({ default: module.MonitoringPage })));

export function App() {
  return (
    <ConfigProvider locale={zhCN} theme={appTheme}>
      <AntApp>
        <Suspense fallback={<BootScreen />}>
          {window.location.pathname === "/connections" ? <ConnectionsPage /> : <ControlPlane />}
        </Suspense>
      </AntApp>
    </ConfigProvider>
  );
}

function ControlPlane() {
  const { message, modal } = AntApp.useApp();
  const controlPlane = useControlPlane();
  const [view, setView] = useState<View>("overview");
  const [dialog, setDialog] = useState<DialogState>({ type: null });

  const execute = async (
    operation: () => Promise<unknown>,
    success: string,
  ) => {
    try {
      await controlPlane.execute(operation);
      message.success(success);
      setDialog({ type: null });
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
    }
  };

  const refresh = async () => {
    try {
      await controlPlane.refresh();
      message.success("数据已刷新");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "刷新失败");
    }
  };

  if (controlPlane.authenticated === null) {
    return <BootScreen />;
  }

  if (!controlPlane.authenticated) {
    return <LoginPage onSuccess={controlPlane.markAuthenticated} />;
  }

  const dataUnavailable =
    Boolean(controlPlane.loadError) &&
    controlPlane.users.length === 0 &&
    controlPlane.servers.length === 0;

  return (
    <AppShell
      currentView={view}
      userCount={controlPlane.users.length}
      serverCount={controlPlane.servers.length}
      refreshing={controlPlane.busy}
      lastUpdatedAt={controlPlane.lastUpdatedAt}
      onNavigate={setView}
      onRefresh={refresh}
      onLogout={controlPlane.logout}
    >
      {controlPlane.initializing ? (
        <PageSkeleton />
      ) : dataUnavailable ? (
        <DataLoadError
          message={controlPlane.loadError ?? "未知错误"}
          loading={controlPlane.busy}
          onRetry={refresh}
        />
      ) : (
        <>
          {view === "overview" && (
            <OverviewPage
              users={controlPlane.users}
              servers={controlPlane.servers}
              health={controlPlane.health}
            />
          )}

          {view === "users" && (
            <UsersPage
              users={controlPlane.users}
              onCreate={() => setDialog({ type: "create-user" })}
              onAssign={(user) => setDialog({ type: "assign-user", user })}
              onPassword={(user) => setDialog({ type: "reset-password", user })}
              onToggle={(user) => {
                const update = () => execute(
                  () => controlPlane.api.updateUser(user.id, { disabled: !user.disabled }),
                  user.disabled ? "用户认证已开启" : "用户认证已关闭",
                );
                if (user.disabled) void update();
                else modal.confirm({
                  title: `关闭 ${user.username} 的用户认证？`,
                  content: "该用户将不能登录或使用 MCP Server，现有登录会话和刷新令牌会被撤销。",
                  okText: "关闭认证",
                  okButtonProps: { danger: true },
                  cancelText: "取消",
                  onOk: update,
                });
              }}
              onDelete={(user) =>
                modal.confirm({
                  title: `删除用户 ${user.username}？`,
                  content: "用户的 Server 授权关系也会被移除，此操作不可撤销。",
                  okText: "确认删除",
                  okButtonProps: { danger: true },
                  cancelText: "取消",
                  onOk: () =>
                    execute(
                      () => controlPlane.api.deleteUser(user.id),
                      "用户已删除",
                    ),
                })
              }
            />
          )}

          {view === "servers" && (
            <ServersPage
              servers={controlPlane.servers}
              users={controlPlane.users}
              onCreate={() => setDialog({ type: "create-server" })}
              onAddInstance={(server) =>
                setDialog({ type: "add-instance", server })
              }
              onConfigureAuth={(server) => setDialog({ type: "configure-server-auth", server })}
              onConfigureUsers={(server) => setDialog({ type: "configure-server-users", server })}
              onToggle={(server) =>
                execute(
                  () =>
                    controlPlane.api.updateServer(server.name, {
                      enabled: !server.enabled,
                    }),
                  server.enabled ? "Server 已停用" : "Server 已启用",
                )
              }
              onToggleInstance={(server, instance) =>
                execute(
                  () =>
                    controlPlane.api.updateInstance(server.name, instance.id, {
                      enabled: !instance.enabled,
                    }),
                  "实例状态已更新",
                )
              }
              onDeleteInstance={(server, instance) =>
                modal.confirm({
                  title: `删除实例 ${instance.id}？`,
                  content: "Gateway 将立即停止向该实例转发请求。",
                  okText: "确认删除",
                  okButtonProps: { danger: true },
                  cancelText: "取消",
                  onOk: () =>
                    execute(
                      () =>
                        controlPlane.api.deleteInstance(
                          server.name,
                          instance.id,
                        ),
                      "实例已删除",
                    ),
                })
              }
              onDelete={(server) =>
                modal.confirm({
                  title: `删除 Server ${server.name}？`,
                  content: "全部实例和用户授权都将被删除，此操作不可撤销。",
                  okText: "确认删除",
                  okButtonProps: { danger: true },
                  cancelText: "取消",
                  onOk: () =>
                    execute(
                      () => controlPlane.api.deleteServer(server.name),
                      "Server 已删除",
                    ),
                })
              }
            />
          )}

          {view === "credentials" && (
            <ConnectionsAdminPage
              users={controlPlane.users}
              servers={controlPlane.servers}
              connections={controlPlane.connections}
              onRevoke={(user, server) => modal.confirm({
                title: `撤销 ${user.username} 的 ${server.display_name} 连接？`,
                content: "平台保存的 API Key 或 OAuth Token 将被删除，该用户需要重新连接后才能使用此服务。",
                okText: "撤销连接",
                okButtonProps: { danger: true },
                cancelText: "取消",
                onOk: () => execute(() => controlPlane.api.revokeConnection(user.id, server.name), "连接已撤销"),
              })}
            />
          )}

          {view === "monitoring" && <MonitoringPage />}

          <UserDialogs
            state={dialog}
            servers={controlPlane.servers}
            busy={controlPlane.busy}
            onClose={() => setDialog({ type: null })}
            onCreate={(data) =>
              execute(() => controlPlane.api.createUser(data), "用户已创建")
            }
            onAssign={(user, servers) =>
              execute(
                () => controlPlane.api.setUserServers(user.id, servers),
                "访问权限已更新",
              )
            }
            onPassword={(user, password) =>
              execute(
                () => controlPlane.api.updateUser(user.id, { password }),
                "密码已重置",
              )
            }
          />

          <ServerDialogs
            state={dialog}
            users={controlPlane.users}
            busy={controlPlane.busy}
            onClose={() => setDialog({ type: null })}
            onCreate={(data) =>
              execute(
                () => controlPlane.api.createServer(data),
                "MCP Server 已注册",
              )
            }
            onAddInstance={(server, data) =>
              execute(
                () => controlPlane.api.addInstance(server.name, data),
                "实例已添加",
              )
            }
            onConfigureAuth={(server, data) => execute(() => controlPlane.api.updateServer(server.name, data), "认证配置已更新")}
            onConfigureUsers={(server, userIds) => execute(() => controlPlane.api.setServerUsers(server.name, userIds), "用户授权已更新")}
          />
        </>
      )}
    </AppShell>
  );
}
