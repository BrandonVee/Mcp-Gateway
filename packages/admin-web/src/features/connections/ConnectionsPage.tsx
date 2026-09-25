import { useEffect, useState } from "react";
import { App, Button, Card, Empty, Form, Input, Modal, Tag, Typography } from "antd";
import { ApiOutlined, DashboardOutlined, DisconnectOutlined, KeyOutlined, LinkOutlined, LogoutOutlined, ReloadOutlined } from "@ant-design/icons";
import { api } from "../../api";
import type { ConnectionServer } from "../../types";
import { useI18n } from "../../i18n";
import { LanguageSwitcher } from "../../components/LanguageSwitcher";

export function ConnectionsPage() {
  const { message, modal } = App.useApp();
  const { t } = useI18n();
  const [username, setUsername] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [servers, setServers] = useState<ConnectionServer[]>([]);
  const [selected, setSelected] = useState<ConnectionServer | null>(null);
  const [key, setKey] = useState("");

  const load = async () => {
    const [session, list] = await Promise.all([api.mySession(), api.myServers()]);
    setUsername(session.username);
    setIsAdmin(session.role === "admin");
    setServers(list.servers);
  };

  useEffect(() => {
    load().catch(() => setUsername(null)).finally(() => setLoading(false));
    const result = new URLSearchParams(window.location.search).get("result");
    if (result) {
      if (result === "connected") message.success(t("connections.oauthConnectionEstablished"));
      else message.error(t("connections.oauthConnectionNotCompletedResult", { result }));
      window.history.replaceState(null, "", "/connections");
    }
  }, []);

  const login = async (values: { username: string; password: string }) => {
    setBusy(true);
    try {
      await api.myLogin(values.username, values.password);
      await load();
      message.success(t("connections.signed"));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("connections.signFailed"));
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async () => {
    if (!selected || !key) return;
    setBusy(true);
    try {
      await api.saveApiKey(selected.name, key);
      await load();
      setKey("");
      setSelected(null);
      message.success(t("connections.apiKeySaved"));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("connections.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const connectOAuth = async (server: ConnectionServer) => {
    setBusy(true);
    try {
      const { authorization_url } = await api.startOAuth(server.name);
      window.location.assign(authorization_url);
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("connections.couldNotStartOauth"));
      setBusy(false);
    }
  };

  const disconnect = (server: ConnectionServer) => modal.confirm({
    title: t("connections.disconnectServer", { server: server.display_name }),
    content: t("connections.storedCredentialsDeletedReconnectionRequired"),
    okText: t("connections.disconnect"), okButtonProps: { danger: true }, cancelText: t("common.cancel"),
    onOk: async () => {
      await api.removeCredential(server.name);
      await load();
      message.success(t("connections.connectionDisconnected"));
    },
  });

  if (loading) return <div className="connections-loading">{t("connections.loadingConnections")}</div>;

  return <main className="connections-page">
    <div className="connections-glow" />
    <header className="connections-header">
      <div className="connections-mark"><ApiOutlined /></div>
      <div><span className="connections-eyebrow">{t("connections.personalAccessEyebrow")}</span><strong>{t("connections.title")}</strong></div>
      <LanguageSwitcher />
      {username && (
        <div className="connections-user">
          <span>{username}</span>
          {isAdmin && (
            <Button className="connections-admin-link" href="/" icon={<DashboardOutlined />}>
              {t("connections.openAdminConsole")}
            </Button>
          )}
          <Button icon={<LogoutOutlined />} onClick={async () => {
            await api.myLogout();
            setUsername(null);
            setIsAdmin(false);
            setServers([]);
          }}>{t("connections.signOut")}</Button>
        </div>
      )}
    </header>

    {!username ? <section className="connections-login">
      <div className="connections-eyebrow">{t("connections.identityRequired")}</div>
      <h1>{t("connections.connectExternalServices")}</h1>
      <p>{t("connections.signPlatformAccountConfigureOwn")}</p>
      <Card bordered={false}>
        <Form layout="vertical" onFinish={login} requiredMark={false}>
          <Form.Item label={t("connections.username")} name="username" rules={[{ required: true, message: t("connections.enterUsername") }]}><Input autoComplete="username" /></Form.Item>
          <Form.Item label={t("connections.password")} name="password" rules={[{ required: true, message: t("connections.enterPassword") }]}><Input.Password autoComplete="current-password" /></Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>{t("connections.login.submit")}</Button>
        </Form>
      </Card>
    </section> : <section className="connections-content">
      <div className="connections-intro"><div><span className="connections-eyebrow">{t("connections.integrationsEyebrow")}</span><h1>{t("connections.letEveryToolWorkYou")}</h1>
        <p>{t("connections.credentialsUsedRelevantServicePlatform")}</p></div>
        <Button icon={<ReloadOutlined />} onClick={() => load().catch(() => message.error(t("common.refreshFailed")))}>{t("connections.refreshStatus")}</Button>
      </div>
      {servers.length ? <div className="connections-grid">{servers.map((server, index) => <Card key={server.name} className="connection-card" bordered={false}>
        <div className="connection-top"><span className="connection-index">{String(index + 1).padStart(2, "0")}</span>
          <Tag color={server.connection_status === "connected" ? "success" : server.connection_status === "expired" ? "warning" : "default"}>
            {t(server.connection_status === "connected" ? "status.connected" : server.connection_status === "not_required" ? "connections.noConnectionNeeded" : server.connection_status === "expired" ? "status.expired" : "connections.notConnected")}
          </Tag></div>
        <h2>{server.display_name}</h2><code>/mcp/{server.name}</code>
        <div className="connection-bottom"><span>{t(server.auth_mode === "api_key" ? "connections.modeApiKey" : server.auth_mode === "oauth" ? "connections.modeOAuth" : "connections.modePlatform")}</span>
          {server.auth_mode === "api_key" && <Button type="primary" icon={<KeyOutlined />} onClick={() => setSelected(server)}>{t(server.connection_status === "connected" ? "connections.updateKey" : "connections.configureKey")}</Button>}
          {server.auth_mode === "oauth" && <Button type="primary" icon={<LinkOutlined />} loading={busy} onClick={() => connectOAuth(server)}>{t(server.connection_status === "connected" ? "connections.reauthorize" : "connections.connectAccount")}</Button>}
          {server.connection_status !== "not_required" && server.connection_status !== "not_connected" && <Button danger type="text" icon={<DisconnectOutlined />} onClick={() => disconnect(server)}>{t("connections.disconnectAction")}</Button>}
        </div>
      </Card>)}</div> : <Empty description={t("connections.noMcpServersBeenAssigned")} />}
      <Typography.Text className="connections-note">{t("connections.serversGrantedAdministratorAppearHere")}</Typography.Text>
    </section>}

    <Modal title={t("connections.configureApiKeyServer", { server: selected?.display_name ?? "" })} open={!!selected} okText={t("connections.saveKey")} okButtonProps={{ disabled: !key, loading: busy }}
      onOk={saveKey} onCancel={() => { setSelected(null); setKey(""); }} destroyOnHidden>
      <p>{t("connections.keyStoredEncryptedNotShown")}</p>
      <Input.Password autoComplete="off" placeholder={t("connections.pasteApiKey")} value={key} onChange={(event) => setKey(event.target.value)} />
    </Modal>
  </main>;
}
