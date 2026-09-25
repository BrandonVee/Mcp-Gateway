import { DisconnectOutlined, LinkOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Button, Card, Flex, Input, Select, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMemo, useState } from "react";
import { PageToolbar } from "../../components/PageToolbar";
import type { AdminConnection, AdminUser, McpServer } from "../../types";

type ConnectionStatus = "connected" | "pending" | "expired" | "disabled" | "stale";

interface ConnectionRow {
  key: string;
  user: AdminUser;
  server: McpServer;
  credential?: AdminConnection;
  status: ConnectionStatus;
}

interface ConnectionsAdminPageProps {
  users: AdminUser[];
  servers: McpServer[];
  connections: AdminConnection[];
  onRevoke: (user: AdminUser, server: McpServer) => void;
}

const statusMeta: Record<ConnectionStatus, { label: string; color: string }> = {
  connected: { label: "已连接", color: "success" },
  pending: { label: "待用户连接", color: "warning" },
  expired: { label: "已过期", color: "error" },
  disabled: { label: "用户已禁用", color: "default" },
  stale: { label: "需重新连接", color: "processing" },
};

function formatDate(value: number | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(value);
}

export function ConnectionsAdminPage({ users, servers, connections, onRevoke }: ConnectionsAdminPageProps) {
  const [keyword, setKeyword] = useState("");
  const [filter, setFilter] = useState<"all" | ConnectionStatus>("all");

  const rows = useMemo(() => {
    const byKey = new Map(connections.map((item) => [`${item.user_id}:${item.server_name}`, item]));
    const result: ConnectionRow[] = [];
    for (const user of users) {
      for (const server of servers) {
        const key = `${user.id}:${server.name}`;
        const credential = byKey.get(key);
        const hasAccess = user.role === "admin" || user.servers.includes("*") || user.servers.includes(server.name);
        if ((!hasAccess || server.auth_mode === "none") && !credential) continue;
        let status: ConnectionStatus;
        if (user.disabled) status = "disabled";
        else if (!hasAccess || server.auth_mode === "none" || (credential && credential.mode !== server.auth_mode)) status = "stale";
        else if (!credential) status = "pending";
        else if (credential.expires_at && credential.expires_at <= Date.now() && !credential.has_refresh_token) status = "expired";
        else status = "connected";
        result.push({ key, user, server, credential, status });
      }
    }
    return result.sort((a, b) => a.user.username.localeCompare(b.user.username) || a.server.name.localeCompare(b.server.name));
  }, [users, servers, connections]);

  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return rows.filter((row) =>
      (filter === "all" || row.status === filter) &&
      (!query || `${row.user.username} ${row.server.name} ${row.server.display_name}`.toLowerCase().includes(query)),
    );
  }, [rows, keyword, filter]);

  const columns: ColumnsType<ConnectionRow> = [
    { title: "用户", dataIndex: ["user", "username"], key: "user", render: (_, row) => <span className="identity-copy"><strong>{row.user.username}</strong><small>ID / {row.user.id}</small></span> },
    { title: "MCP Server", key: "server", render: (_, row) => <span className="identity-copy"><strong>{row.server.display_name}</strong><small>{row.server.name}</small></span> },
    { title: "上游认证", key: "mode", width: 126, render: (_, row) => <Tag bordered={false} color={row.server.auth_mode === "oauth" ? "blue" : row.server.auth_mode === "api_key" ? "cyan" : "default"}>{row.server.auth_mode === "oauth" ? "OAuth" : row.server.auth_mode === "api_key" ? "API Key" : "无需认证"}</Tag> },
    { title: "连接状态", key: "status", width: 150, render: (_, row) => <Tag color={statusMeta[row.status].color}>{statusMeta[row.status].label}</Tag> },
    { title: "更新时间", key: "updated", width: 190, render: (_, row) => <Typography.Text type="secondary">{formatDate(row.credential?.updated_at)}</Typography.Text> },
    { title: "操作", key: "actions", width: 130, align: "right", render: (_, row) => row.credential ? <Button type="link" danger icon={<DisconnectOutlined />} onClick={() => onRevoke(row.user, row.server)}>撤销连接</Button> : <Typography.Text type="secondary">由用户连接</Typography.Text> },
  ];

  const connected = rows.filter((row) => row.status === "connected").length;
  const pending = rows.filter((row) => row.status === "pending").length;
  const attention = rows.length - connected - pending;

  return <div className="page-stack page-enter">
    <PageToolbar
      eyebrow="USER CREDENTIALS"
      title="外部服务二次认证"
      description="管理员查看用户与外部 MCP Server 的连接状态、撤销失效凭据；API Key 和 OAuth Token 不在管理后台显示。"
      primaryAction={<Button href="/connections" icon={<LinkOutlined />}>打开个人连接中心</Button>}
      filters={<>
        <Input.Search allowClear className="toolbar-search" placeholder="搜索用户或 Server" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
        <Select className="toolbar-select" value={filter} onChange={setFilter} options={[
          { value: "all", label: "全部状态" },
          ...Object.entries(statusMeta).map(([value, item]) => ({ value, label: item.label })),
        ]} />
        <Typography.Text type="secondary" className="filter-result-count">{filtered.length} 条结果</Typography.Text>
      </>}
    />
    <div className="connection-admin-summary" aria-label="二次认证概览">
      <div><span>需认证的授权关系</span><strong>{rows.length}</strong></div>
      <div><span>已连接</span><strong>{connected}</strong></div>
      <div><span>待用户连接</span><strong>{pending}</strong></div>
      <div><span>需要处理</span><strong>{attention}</strong></div>
    </div>
    <Card className="data-card" bordered={false}>
      <Table<ConnectionRow> rowKey="key" columns={columns} dataSource={filtered} pagination={{ pageSize: 10, hideOnSinglePage: true }} scroll={{ x: 860 }} locale={{ emptyText: "暂无需要二次认证的用户连接" }} />
      <div className="table-summary"><Flex gap={8} align="center"><SafetyCertificateOutlined /> 用户自行在连接中心配置 API Key 或完成 OAuth 授权；管理员只管理状态与撤销。</Flex></div>
    </Card>
  </div>;
}
