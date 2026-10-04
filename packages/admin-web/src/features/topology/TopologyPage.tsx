import { useEffect, useState } from 'react';
import { Alert, Descriptions, Drawer, Empty, Segmented, Select, Spin, Table, Tag } from 'antd';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import type { TopologyInstance, TopologyServer, TopologySnapshot } from '../../types';
import { TopologyGraph, type TopologyDimension, type TopologySelection } from './TopologyGraph';
import './topology.css';

const WINDOWS = [1, 5, 15, 30];

function findInstance(
  snapshot: TopologySnapshot,
  serverName: string,
  instanceId: string,
): { server: TopologyServer; instance: TopologyInstance } | null {
  const server = snapshot.servers.find((row) => row.name === serverName);
  const instance = server?.instances.find((row) => row.id === instanceId);
  return server && instance ? { server, instance } : null;
}

export function TopologyPage() {
  const { t } = useI18n();
  const [windowMinutes, setWindowMinutes] = useState(5);
  const [dimension, setDimension] = useState<TopologyDimension>('user');
  const [data, setData] = useState<TopologySnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<TopologySelection | null>(null);

  useEffect(() => {
    let active = true,
      fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const snapshot = await api.topologySnapshot(windowMinutes);
        if (!active) return;
        setData(snapshot);
        setError('');
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        fetching = false;
        if (active) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [windowMinutes]);

  const stateLabels = {
    up: t('topology.stateUp'),
    degraded: t('topology.stateDegraded'),
    down: t('topology.stateDown'),
    unknown: t('topology.stateUnknown'),
  } as const;
  const stateColors = { up: 'success', degraded: 'warning', down: 'error', unknown: 'default' } as const;

  const renderDetail = () => {
    if (!data || !selection) return null;
    if (selection.kind === 'server') {
      const server = data.servers.find((row) => row.name === selection.id);
      if (!server) return null;
      const flows = data.flows.filter((row) => row.server === server.name);
      return (
        <>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label={t('topology.detail.state')}>
              <Tag color={server.enabled ? 'success' : 'default'}>
                {server.enabled ? t('topology.detail.enabled') : t('topology.detail.disabled')}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('topology.detail.instances')}>{server.instances.length}</Descriptions.Item>
            <Descriptions.Item label={t('topology.detail.calls')}>
              {flows.reduce((sum, row) => sum + row.calls, 0)}
            </Descriptions.Item>
            <Descriptions.Item label={t('topology.detail.failed')}>
              {flows.reduce((sum, row) => sum + row.failed, 0)}
            </Descriptions.Item>
            <Descriptions.Item label={t('topology.detail.sessions')}>
              {data.sessions.filter((row) => row.server === server.name).reduce((sum, row) => sum + row.count, 0)}
            </Descriptions.Item>
          </Descriptions>
          <h4 className="topology-detail-subheading">{t('topology.detail.topRoutes')}</h4>
          <Table
            size="small"
            rowKey={(row: TopologyInstance) => row.id}
            pagination={false}
            dataSource={server.instances}
            columns={[
              { title: t('topology.detail.url'), dataIndex: 'url', ellipsis: true },
              {
                title: t('topology.detail.state'),
                dataIndex: ['health', 'state'],
                width: 120,
                render: (state: TopologyInstance['health']['state']) => (
                  <Tag color={stateColors[state]}>{stateLabels[state]}</Tag>
                ),
              },
            ]}
          />
        </>
      );
    }
    if (selection.kind === 'instance') {
      const found = findInstance(data, selection.server ?? '', selection.id);
      const flows = data.flows.filter((row) => row.server === selection.server && row.instance === selection.id);
      if (!found)
        return (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label={t('topology.detail.state')}>
              <Tag>{stateLabels.unknown}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('topology.detail.calls')}>
              {flows.reduce((sum, row) => sum + row.calls, 0)}
            </Descriptions.Item>
          </Descriptions>
        );
      const { instance } = found;
      return (
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label={t('topology.detail.url')}>
            <code>{instance.url}</code>
          </Descriptions.Item>
          <Descriptions.Item label={t('topology.detail.state')}>
            <Tag color={stateColors[instance.health.state]}>{stateLabels[instance.health.state]}</Tag>
            {!instance.enabled && <Tag>{t('topology.detail.disabled')}</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label={t('topology.detail.replicas')}>
            {instance.health.replicas_total - instance.health.replicas_down} / {instance.health.replicas_total}
          </Descriptions.Item>
          <Descriptions.Item label={t('topology.detail.lastProbe')}>
            {instance.health.last_probe_age_ms === null
              ? t('topology.detail.never')
              : t('topology.detail.secondsAgo', { seconds: Math.round(instance.health.last_probe_age_ms / 1000) })}
          </Descriptions.Item>
          <Descriptions.Item label={t('topology.detail.calls')}>
            {flows.reduce((sum, row) => sum + row.calls, 0)}
          </Descriptions.Item>
          <Descriptions.Item label={t('topology.detail.failed')}>
            {flows.reduce((sum, row) => sum + row.failed, 0)}
          </Descriptions.Item>
          <Descriptions.Item label={t('topology.detail.sessions')}>
            {data.sessions
              .filter((row) => row.server === selection.server && row.instance === selection.id)
              .reduce((sum, row) => sum + row.count, 0)}
          </Descriptions.Item>
        </Descriptions>
      );
    }
    const participant = selection.id;
    const flows = data.flows.filter((row) =>
      dimension === 'user' ? row.username === participant : row.client_id === participant,
    );
    return (
      <>
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label={t('topology.detail.calls')}>
            {flows.reduce((sum, row) => sum + row.calls, 0)}
          </Descriptions.Item>
          <Descriptions.Item label={t('topology.detail.failed')}>
            {flows.reduce((sum, row) => sum + row.failed, 0)}
          </Descriptions.Item>
          {dimension === 'user' && (
            <Descriptions.Item label={t('topology.detail.sessions')}>
              {data.sessions.filter((row) => row.owner === participant).reduce((sum, row) => sum + row.count, 0)}
            </Descriptions.Item>
          )}
        </Descriptions>
        <h4 className="topology-detail-subheading">{t('topology.detail.topRoutes')}</h4>
        <Table
          size="small"
          rowKey={(row: (typeof flows)[number]) => `${row.server}:${row.instance}`}
          pagination={false}
          dataSource={flows}
          columns={[
            { title: t('topology.detail.serverTitle'), dataIndex: 'server' },
            { title: t('topology.detail.instanceTitle'), dataIndex: 'instance', ellipsis: true },
            { title: t('topology.detail.calls'), dataIndex: 'calls', width: 90 },
            { title: t('topology.detail.failed'), dataIndex: 'failed', width: 90 },
          ]}
        />
      </>
    );
  };

  const drawerTitles = {
    participant: dimension === 'user' ? t('topology.detail.userTitle') : t('topology.detail.clientTitle'),
    server: t('topology.detail.serverTitle'),
    instance: t('topology.detail.instanceTitle'),
  } as const;

  return (
    <div className="page-stack page-enter topology-page">
      <section className="topology-panel">
        <div className="topology-toolbar">
          <Segmented
            value={dimension}
            onChange={(value) => setDimension(value as TopologyDimension)}
            options={[
              { value: 'user', label: t('topology.byUser') },
              { value: 'client', label: t('topology.byClient') },
            ]}
          />
          <Select
            className="topology-window-select"
            value={windowMinutes}
            onChange={setWindowMinutes}
            options={WINDOWS.map((minutes) => ({
              value: minutes,
              label: t('topology.windowMinutes', { minutes }),
            }))}
            prefix={t('topology.window')}
          />
        </div>

        {data?.degraded.health && <Alert type="warning" showIcon message={t('topology.degradedHealth')} />}
        {data?.degraded.sessions && <Alert type="warning" showIcon message={t('topology.degradedSessions')} />}
        {data?.degraded.flows && <Alert type="info" showIcon message={t('topology.degradedFlows')} />}
        {error && <Alert type="error" showIcon message={t('topology.loadFailed')} description={error} />}

        <div className="topology-legend">
          <span>
            <i className="topology-legend-flow" /> {t('topology.legendFlow')}
          </span>
          <span>
            <i className="topology-legend-session" /> {t('topology.legendSession')}
          </span>
          <small>
            {t('topology.legendNote')}
            {dimension === 'client' ? ` ${t('topology.clientSessionsNote')}` : ''}
          </small>
        </div>

        {loading && !data ? (
          <div className="topology-empty">
            <Spin />
          </div>
        ) : data && data.servers.length ? (
          <TopologyGraph snapshot={data} dimension={dimension} onSelect={setSelection} />
        ) : (
          <div className="topology-empty">
            <Empty description={t('topology.empty')}>
              <p className="topology-empty-help">{t('topology.emptyHelp')}</p>
            </Empty>
          </div>
        )}
      </section>

      <Drawer
        open={Boolean(selection)}
        onClose={() => setSelection(null)}
        width={420}
        title={selection ? `${drawerTitles[selection.kind]} · ${selection.id}` : ''}
      >
        {renderDetail()}
      </Drawer>
    </div>
  );
}
