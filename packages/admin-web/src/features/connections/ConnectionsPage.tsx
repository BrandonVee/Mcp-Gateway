import { useEffect, useState } from "react";
import { App, Button, Card, Empty, Form, Input, Modal, Tag, Typography } from "antd";
import { ApiOutlined, DisconnectOutlined, KeyOutlined, LinkOutlined, LogoutOutlined, ReloadOutlined } from "@ant-design/icons";
import { api } from "../../api";
import type { ConnectionServer } from "../../types";

export function ConnectionsPage() {
  const { message, modal } = App.useApp();
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [servers, setServers] = useState<ConnectionServer[]>([]);
  const [selected, setSelected] = useState<ConnectionServer | null>(null);
  const [key, setKey] = useState("");

  const load = async () => {
    const [session, list] = await Promise.all([api.mySession(), api.myServers()]);
    setUsername(session.username);
    setServers(list.servers);
  };

  useEffect(() => {
    load().catch(() => setUsername(null)).finally(() => setLoading(false));
    const result = new URLSearchParams(window.location.search).get("result");
    if (result) {
      if (result === "connected") message.success("OAuth 连接已建立");
      else message.error(`OAuth 连接未完成：${result}`);
      window.history.replaceState(null, "", "/connections");
    }
  }, []);

  const login = async (values: { username: string; password: string }) => {
    setBusy(true);
    try {
      await api.myLogin(values.username, values.password);
      await load();
      message.success("登录成功");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "登录失败");
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
      message.success("API Key 已保存");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "保存失败");
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
      message.error(error instanceof Error ? error.message : "启动 OAuth 失败");
      setBusy(false);
    }
  };

  const disconnect = (server: ConnectionServer) => modal.confirm({
    title: `断开 ${server.display_name}？`,
    content: "该用户的凭据会从平台删除，之后需要重新连接。",
    okText: "断开连接", okButtonProps: { danger: true }, cancelText: "取消",
    onOk: async () => {
      await api.removeCredential(server.name);
      await load();
      message.success("连接已断开");
    },
  });

  if (loading) return <div className="connections-loading">正在加载连接中心…</div>;

  return <main className="connections-page">
    <div className="connections-glow" />
    <header className="connections-header">
      <div className="connections-mark"><ApiOutlined /></div>
      <div><span className="connections-eyebrow">MCP / PERSONAL ACCESS</span><strong>连接中心</strong></div>
      {username && <div className="connections-user"><span>{username}</span><Button icon={<LogoutOutlined />} onClick={async () => {
        await api.myLogout(); setUsername(null); setServers([]);
      }}>退出</Button></div>}
    </header>

    {!username ? <section className="connections-login">
      <div className="connections-eyebrow">IDENTITY REQUIRED</div>
      <h1>连接你的外部服务</h1>
      <p>使用平台账号登录，然后为已授权的 MCP Server 配置你自己的 API Key 或完成 OAuth 授权。</p>
      <Card bordered={false}>
        <Form layout="vertical" onFinish={login} requiredMark={false}>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: "请输入用户名" }]}><Input autoComplete="username" /></Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: "请输入密码" }]}><Input.Password autoComplete="current-password" /></Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>登录连接中心</Button>
        </Form>
      </Card>
    </section> : <section className="connections-content">
      <div className="connections-intro"><div><span className="connections-eyebrow">YOUR INTEGRATIONS</span><h1>让每个工具用你的身份工作。</h1>
        <p>你的密钥仅用于对应服务的请求；平台登录凭据不会转发给外部服务。</p></div>
        <Button icon={<ReloadOutlined />} onClick={() => load().catch(() => message.error("刷新失败"))}>刷新状态</Button>
      </div>
      {servers.length ? <div className="connections-grid">{servers.map((server, index) => <Card key={server.name} className="connection-card" bordered={false}>
        <div className="connection-top"><span className="connection-index">{String(index + 1).padStart(2, "0")}</span>
          <Tag color={server.connection_status === "connected" ? "success" : server.connection_status === "expired" ? "warning" : "default"}>
            {server.connection_status === "connected" ? "已连接" : server.connection_status === "not_required" ? "无需连接" : server.connection_status === "expired" ? "已过期" : "待连接"}
          </Tag></div>
        <h2>{server.display_name}</h2><code>/mcp/{server.name}</code>
        <div className="connection-bottom"><span>{server.auth_mode === "api_key" ? "API KEY" : server.auth_mode === "oauth" ? "OAUTH 2.0" : "PLATFORM AUTH"}</span>
          {server.auth_mode === "api_key" && <Button type="primary" icon={<KeyOutlined />} onClick={() => setSelected(server)}>{server.connection_status === "connected" ? "更新密钥" : "配置密钥"}</Button>}
          {server.auth_mode === "oauth" && <Button type="primary" icon={<LinkOutlined />} loading={busy} onClick={() => connectOAuth(server)}>{server.connection_status === "connected" ? "重新授权" : "连接账号"}</Button>}
          {server.connection_status !== "not_required" && server.connection_status !== "not_connected" && <Button danger type="text" icon={<DisconnectOutlined />} onClick={() => disconnect(server)}>断开</Button>}
        </div>
      </Card>)}</div> : <Empty description="当前没有已授权的 MCP Server" />}
      <Typography.Text className="connections-note">只显示管理员授予你访问权限的 Server。连接凭据按用户隔离保存。</Typography.Text>
    </section>}

    <Modal title={`配置 API Key / ${selected?.display_name ?? ""}`} open={!!selected} okText="保存密钥" okButtonProps={{ disabled: !key, loading: busy }}
      onOk={saveKey} onCancel={() => { setSelected(null); setKey(""); }} destroyOnHidden>
      <p>密钥保存后将加密存储；页面不会再次显示完整密钥。</p>
      <Input.Password autoComplete="off" placeholder="粘贴你的 API Key" value={key} onChange={(event) => setKey(event.target.value)} />
    </Modal>
  </main>;
}
