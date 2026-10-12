import { useI18n, type Language, type MessageKey } from '../../i18n';
import { DisconnectOutlined, LinkOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Button, Card, Flex, Input, Select, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { PageToolbar } from '../../components/PageToolbar';
import type { AdminConnection, AdminUser, McpServer } from '../../types';

type ConnectionStatus = 'connected' | 'pending' | 'expired' | 'disabled' | 'stale' | 'paused';

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
  busy: boolean;
  onRevoke: (user: AdminUser, server: McpServer) => void;
}

const statusMeta: Record<ConnectionStatus, { label: MessageKey; color: string }> = {
  connected: { label: 'status.connected', color: 'success' },
  pending: { label: 'connectionsAdmin.waitingUser', color: 'warning' },
  expired: { label: 'status.expired', color: 'error' },
  disabled: { label: 'connectionsAdmin.userDisabled', color: 'default' },
  stale: { label: 'connectionsAdmin.reconnectRequired', color: 'processing' },
  paused: { label: 'connectionsAdmin.serverPaused', color: 'default' },
};

function formatDate(value: number | null | undefined, language: Language) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(value);
}

export function ConnectionsAdminPage({ users, servers, connections, busy, onRevoke }: ConnectionsAdminPageProps) {
  const { t, language } = useI18n();
  const [keyword, setKeyword] = useState('');
  const [filter, setFilter] = useState<'all' | ConnectionStatus>('all');

  const rows = useMemo(() => {
    const byKey = new Map(connections.map((item) => [`${item.user_id}:${item.server_name}`, item]));
    const result: ConnectionRow[] = [];
    for (const user of users) {
      for (const server of servers) {
        const key = `${user.id}:${server.name}`;
        const credential = byKey.get(key);
        const hasAccess = user.role === 'admin' || user.servers.includes('*') || user.servers.includes(server.name);
        if ((!hasAccess || server.auth_mode === 'none' || server.auth_mode === 'system_api_key') && !credential)
          continue;
        let status: ConnectionStatus;
        if (user.disabled) status = 'disabled';
        else if (!server.enabled) status = 'paused';
        else if (
          !hasAccess ||
          server.auth_mode === 'none' ||
          server.auth_mode === 'system_api_key' ||
          (credential && credential.mode !== server.auth_mode)
        )
          status = 'stale';
        else if (!credential) status = 'pending';
        else if (credential.expires_at && credential.expires_at <= Date.now() && !credential.has_refresh_token)
          status = 'expired';
        else status = 'connected';
        result.push({ key, user, server, credential, status });
      }
    }
    return result.sort(
      (a, b) => a.user.username.localeCompare(b.user.username) || a.server.name.localeCompare(b.server.name),
    );
  }, [users, servers, connections]);

  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return rows.filter(
      (row) =>
        (filter === 'all' || row.status === filter) &&
        (!query || `${row.user.username} ${row.server.name} ${row.server.display_name}`.toLowerCase().includes(query)),
    );
  }, [rows, keyword, filter]);

  const columns: ColumnsType<ConnectionRow> = [
    {
      title: t('common.user'),
      dataIndex: ['user', 'username'],
      key: 'user',
      render: (_, row) => (
        <span className="identity-copy">
          <strong>{row.user.username}</strong>
          <small>
            {t('common.identifier')} / {row.user.id}
          </small>
        </span>
      ),
    },
    {
      title: t('common.mcpService'),
      key: 'server',
      render: (_, row) => (
        <span className="identity-copy">
          <strong>{row.server.display_name}</strong>
          <small>{row.server.name}</small>
        </span>
      ),
    },
    {
      title: t('connectionsAdmin.upstreamAuth'),
      key: 'mode',
      width: 126,
      render: (_, row) => (
        <Tag
          bordered={false}
          color={row.server.auth_mode === 'oauth' ? 'blue' : row.server.auth_mode === 'api_key' ? 'cyan' : 'default'}
        >
          {row.server.auth_mode === 'oauth'
            ? 'OAuth'
            : row.server.auth_mode === 'system_api_key'
              ? t('serverDialog.systemApiKey')
              : row.server.auth_mode === 'api_key'
                ? t('connections.modeApiKey')
                : t('connectionsAdmin.noAuthRequired')}
        </Tag>
      ),
    },
    {
      title: t('connectionsAdmin.connectionStatus'),
      key: 'status',
      width: 150,
      render: (_, row) => <Tag color={statusMeta[row.status].color}>{t(statusMeta[row.status].label)}</Tag>,
    },
    {
      title: t('connectionsAdmin.updated'),
      key: 'updated',
      width: 190,
      render: (_, row) => (
        <Typography.Text type="secondary">{formatDate(row.credential?.updated_at, language)}</Typography.Text>
      ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 130,
      align: 'right',
      render: (_, row) =>
        row.credential ? (
          <Button
            disabled={busy}
            type="link"
            danger
            icon={<DisconnectOutlined />}
            onClick={() => onRevoke(row.user, row.server)}
          >
            {t('app.revokeConnection')}
          </Button>
        ) : (
          <Typography.Text type="secondary">{t('connectionsAdmin.connectedUser')}</Typography.Text>
        ),
    },
  ];

  const connected = rows.filter((row) => row.status === 'connected').length;
  const pending = rows.filter((row) => row.status === 'pending').length;
  const attention = rows.length - connected - pending;

  return (
    <div className="page-stack page-enter">
      <PageToolbar
        eyebrow="connectionsAdmin.eyebrow"
        title="connectionsAdmin.externalServiceConnections"
        description="connectionsAdmin.reviewUserConnectionsExternalMcp"
        primaryAction={
          <Button href="/connections" icon={<LinkOutlined />}>
            {t('connectionsAdmin.openPersonalConnections')}
          </Button>
        }
        filters={
          <>
            <Input.Search
              allowClear
              className="toolbar-search"
              placeholder={t('connectionsAdmin.searchUsersServers')}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Select
              className="toolbar-select"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: t('connectionsAdmin.statuses') },
                ...Object.entries(statusMeta).map(([value, item]) => ({ value, label: t(item.label) })),
              ]}
            />
            <Typography.Text type="secondary" className="filter-result-count">
              {t('common.resultCount', { count: filtered.length })}
            </Typography.Text>
          </>
        }
      />
      <div className="connection-admin-summary" aria-label={t('connectionsAdmin.connectionOverview')}>
        <div>
          <span>{t('connectionsAdmin.grantsRequiringAuth')}</span>
          <strong>{rows.length}</strong>
        </div>
        <div>
          <span>{t('status.connected')}</span>
          <strong>{connected}</strong>
        </div>
        <div>
          <span>{t('connectionsAdmin.waitingUser')}</span>
          <strong>{pending}</strong>
        </div>
        <div>
          <span>{t('connectionsAdmin.needsAttention')}</span>
          <strong>{attention}</strong>
        </div>
      </div>
      <Card className="data-card" bordered={false}>
        <Table<ConnectionRow>
          rowKey="key"
          columns={columns}
          dataSource={filtered}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          scroll={{ x: 860 }}
          locale={{
            emptyText: rows.length ? (
              <span>
                {t('connectionsAdmin.noMatchingConnections')}{' '}
                <Button
                  type="link"
                  onClick={() => {
                    setKeyword('');
                    setFilter('all');
                  }}
                >
                  {t('servers.clearFilters')}
                </Button>
              </span>
            ) : (
              t('connectionsAdmin.noUserConnectionsRequireAdditional')
            ),
          }}
        />
        <div className="table-summary">
          <Flex gap={8} align="center">
            <SafetyCertificateOutlined /> {t('connectionsAdmin.usersConfigureOwnApiKeys')}
          </Flex>
        </div>
      </Card>
    </div>
  );
}
