import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Select,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from 'antd';
import {
  BarChartOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
  LineChartOutlined,
  ReloadOutlined,
  SearchOutlined,
  TeamOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { api } from '@/web/api';
import { useI18n } from '@/web/i18n';
import type { AlertEvent, UsageCall, UsageCollectionStatus, UsageFilters, UsageSummary } from '@/web/types';

function Trend({ data, bucket }: { data: UsageSummary['trend']; bucket: number }) {
  const { t, language } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(260, element.clientWidth)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const high = Math.max(2, ...data.map((row) => row.calls));
  const left = 40,
    right = width - 12,
    baseline = 180;
  const step = (right - left) / Math.max(1, data.length),
    gap = Math.min(3, step * 0.18);
  const fmt = (time: number) =>
    new Intl.DateTimeFormat(
      language,
      bucket >= 86400000 ? { month: '2-digit', day: '2-digit' } : { hour: '2-digit', minute: '2-digit' },
    ).format(time);
  return (
    <div ref={ref} className="usage-chart">
      {data.some((row) => row.calls > 0) ? (
        <svg viewBox={`0 0 ${width} 218`} role="img" aria-label={t('usage.trend')}>
          <title>{t('usage.trend')}</title>
          {[0, Math.ceil(high / 2), high]
            .filter((value, index, values) => values.indexOf(value) === index)
            .map((value) => (
              <g key={value}>
                <line x1={left} x2={right} y1={baseline - (value / high) * 150} y2={baseline - (value / high) * 150} />
                <text x={left - 10} y={baseline - (value / high) * 150 + 4} textAnchor="end">
                  {value}
                </text>
              </g>
            ))}
          {data.map((row, i) => (
            <g key={row.time}>
              <rect
                x={left + step * i + gap}
                y={baseline - (row.calls / high) * 150}
                width={Math.max(0.5, step - gap * 2)}
                height={(row.calls / high) * 150}
                rx={Math.min(3, step / 4)}
              >
                <title>
                  {fmt(row.time)} · {t('usage.calls')}: {row.calls} · {t('usage.failed')}: {row.failed}
                </title>
              </rect>
              <rect
                className="usage-chart-failed"
                x={left + step * i + gap}
                y={baseline - (row.failed / high) * 150}
                width={Math.max(0.5, step - gap * 2)}
                height={(row.failed / high) * 150}
              >
                <title>
                  {fmt(row.time)} · {t('usage.failed')}: {row.failed}
                </title>
              </rect>
            </g>
          ))}
          <text x={left} y={207}>
            {data[0] ? fmt(data[0].time) : '—'}
          </text>
          <text x={right} y={207} textAnchor="end">
            {data.at(-1) ? fmt(data.at(-1)!.time) : ''}
          </text>
        </svg>
      ) : (
        <div className="usage-chart-empty">
          <LineChartOutlined aria-hidden />
          <strong>{t('usage.noTrend')}</strong>
          <p>{t('usage.noTrendHelp')}</p>
        </div>
      )}
    </div>
  );
}

export function UsageMonitoring({
  mode,
  collectionStatus,
  onCollectionStatus,
}: {
  mode: 'overview' | 'logs';
  collectionStatus?: UsageCollectionStatus | null;
  onCollectionStatus?: (status: UsageCollectionStatus) => void;
}) {
  const { t, language } = useI18n();
  const [form] = Form.useForm<UsageFilters>();
  const [filters, setFilters] = useState<UsageFilters>({ hours: 24 });
  const [dimension, setDimension] = useState('server'),
    [tab, setTab] = useState(mode === 'logs' ? 'logs' : 'overview');
  const [data, setData] = useState<UsageSummary | null>(null),
    [events, setEvents] = useState<UsageCall[]>([]);
  const [cursor, setCursor] = useState<string | null>(null),
    [detail, setDetail] = useState<UsageCall | null>(null);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [loadingMore, setLoadingMore] = useState(false);
  const [revision, setRevision] = useState(0),
    [services, setServices] = useState<string[]>([]);
  const [alertEvents, setAlertEvents] = useState<AlertEvent[]>([]);
  const [historical, setHistorical] = useState(false);
  const filtersKey = JSON.stringify(filters),
    identity = filtersKey + dimension + tab + revision;
  const current = useRef(identity),
    paged = useRef(false);
  current.current = identity;

  useEffect(() => {
    void api
      .servers()
      .then((result) => setServices(result.servers.map((server) => server.name)))
      .catch(() => {});
  }, []);
  useEffect(() => {
    let active = true,
      fetching = false;
    paged.current = false;
    setHistorical(false);
    setLoading(true);
    setLoadingMore(false);
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        if (mode === 'overview') {
          const summary = await api.usageSummary(filters, dimension);
          if (!active) return;
          setData(summary);
          onCollectionStatus?.(summary);
          api
            .usageAlerts()
            .then((result) => active && setAlertEvents(result.events))
            .catch(() => {});
        }
        if (tab === 'logs' && !paged.current) {
          const calls = await api.usageCalls(filters);
          if (active && !paged.current) {
            setEvents(calls.events);
            setCursor(calls.next_cursor);
          }
        }
        if (active) setError('');
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        fetching = false;
        if (active) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [filtersKey, dimension, tab, revision, mode, onCollectionStatus]);

  const loadMore = async () => {
    if (!cursor || loadingMore || loading) return;
    const snapshot = current.current;
    paged.current = true;
    setHistorical(true);
    setLoadingMore(true);
    try {
      const page = await api.usageCalls(filters, cursor);
      if (current.current === snapshot) {
        setEvents((rows) => [...rows, ...page.events.filter((event) => !rows.some((row) => row.id === event.id))]);
        setCursor(page.next_cursor);
      }
    } catch (cause) {
      if (current.current === snapshot) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current.current === snapshot) setLoadingMore(false);
    }
  };
  const resetFilters = () => {
    form.resetFields();
    setFilters({ hours: 24 });
    setRevision((value) => value + 1);
  };
  const acknowledge = async (id: number) => {
    try {
      await api.acknowledgeAlert(id);
      setAlertEvents((rows) =>
        rows.map((row) => (row.id === id ? { ...row, acknowledged_at: Date.now(), acknowledged_by: 'admin' } : row)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const format = (value: number | null, unit = '') =>
    value === null ? '—' : new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value) + unit;
  const time = (value: number) =>
    new Intl.DateTimeFormat(language, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(value);
  const outcomes: Record<string, string> = {
    success: t('usage.success'),
    failed: t('usage.failed'),
    unknown: t('usage.unknown'),
  };
  const outcomeTag = (value: string) => (
    <Tag variant="filled" color={value === 'success' ? 'success' : value === 'failed' ? 'error' : 'warning'}>
      {outcomes[value] ?? value}
    </Tag>
  );
  const stats = data?.summary;
  const hasFilters = Boolean(
    filters.server ||
    filters.tool ||
    filters.user_id ||
    filters.client_id ||
    filters.outcome ||
    filters.q ||
    filters.method ||
    filters.request_id,
  );
  const status = mode === 'overview' ? data : collectionStatus;
  const collectionProblem = Boolean(status?.collection.lastError);
  const logsDisabled = mode === 'logs' && status?.enabled && status.logs_enabled === false;
  const emptyTable = (title: string) => (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <div className="usage-empty-copy">
          <strong>{title}</strong>
          <p>{t(hasFilters ? 'usage.emptyFilterHelp' : 'usage.emptyHelp')}</p>
          {hasFilters && (
            <Button size="small" onClick={resetFilters}>
              {t('usage.reset')}
            </Button>
          )}
        </div>
      }
    />
  );
  const metrics = [
    {
      label: t('usage.calls'),
      value: format(stats?.calls ?? 0),
      icon: <BarChartOutlined />,
      hint: t('usage.callsHint'),
      tone: 'blue',
    },
    {
      label: t('usage.successRate'),
      value: format(stats?.success_rate ?? null, '%'),
      icon: <CheckCircleOutlined />,
      hint: t('usage.successHint'),
      tone: 'green',
    },
    {
      label: t('usage.p95'),
      value: format(stats?.p95_ms ?? null, ' ms'),
      icon: <ClockCircleOutlined />,
      hint: t('usage.latencyHint'),
      tone: 'amber',
    },
    {
      label: t('usage.users'),
      value: format(stats?.active_users ?? 0),
      icon: <TeamOutlined />,
      hint: t('usage.usersHint'),
      tone: 'purple',
    },
  ];

  return (
    <section className={`monitor-audit-panel usage-panel usage-${mode}-panel`}>
      {mode === 'overview' && (
        <Spin spinning={loading}>
          <div className="usage-top-metrics">
            <div className="usage-metrics">
              {metrics.map((metric) => (
                <div key={metric.label} className={`usage-metric usage-metric-${metric.tone}`}>
                  <div className="usage-metric-heading">
                    <span>{metric.label}</span>
                    <span className="usage-metric-icon">{metric.icon}</span>
                  </div>
                  <strong>{metric.value}</strong>
                  <small>{metric.hint}</small>
                </div>
              ))}
            </div>
          </div>
        </Spin>
      )}
      <div className="monitor-section-heading">
        <div>
          <span className="section-eyebrow">{t(mode === 'overview' ? 'usage.eyebrow' : 'usage.logs')}</span>
          <h3>{t(mode === 'overview' ? 'usage.overview' : 'usage.logQuery')}</h3>
          <p className="usage-description">{t(mode === 'overview' ? 'usage.description' : 'usage.logsDescription')}</p>
        </div>
        <div className="usage-heading-actions">
          <span className="usage-refresh-status">
            <Badge status="processing" />
            {t('usage.refresh')}
          </span>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => setRevision((value) => value + 1)}>
            {t('usage.reload')}
          </Button>
        </div>
      </div>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ hours: 24 }}
        onFinish={(values) => {
          setFilters({ ...values, outcome: filters.outcome });
          setRevision((value) => value + 1);
        }}
        className="usage-filters"
      >
        <Form.Item name="hours" label={t('usage.period')}>
          <Select
            aria-label={t('usage.period')}
            options={[1, 24, 168, 720, 8760].map((hours) => ({
              value: hours,
              label: t(
                hours === 1
                  ? 'usage.hour'
                  : hours === 24
                    ? 'usage.day'
                    : hours === 168
                      ? 'usage.week'
                      : hours === 720
                        ? 'usage.month'
                        : 'usage.year',
              ),
            }))}
          />
        </Form.Item>
        <Form.Item name="server" label={t('usage.server')}>
          <Select
            allowClear
            showSearch
            placeholder={t('usage.allServers')}
            aria-label={t('usage.allServers')}
            options={services.map((value) => ({ value, label: value }))}
          />
        </Form.Item>
        <Form.Item name="tool" label={t('usage.tool')}>
          <Input allowClear maxLength={128} placeholder={t('usage.toolPlaceholder')} />
        </Form.Item>
        <Form.Item name="user_id" label={t('usage.userId')}>
          <Input allowClear inputMode="numeric" maxLength={16} placeholder={t('usage.userPlaceholder')} />
        </Form.Item>
        {mode === 'logs' && (
          <>
            <Form.Item name="q" label={t('usage.contentSearch')}>
              <Input allowClear />
            </Form.Item>
            <Form.Item name="method" label={t('usage.method')}>
              <Input allowClear />
            </Form.Item>
            <Form.Item name="request_id" label={t('monitoring.requestId')}>
              <Input allowClear />
            </Form.Item>
          </>
        )}
        <Form.Item name="client_id" label={t('usage.client')}>
          <Input allowClear maxLength={128} placeholder={t('usage.clientPlaceholder')} />
        </Form.Item>
        <div className="usage-filter-actions">
          <Button type="primary" htmlType="submit" icon={<SearchOutlined />} loading={loading}>
            {t('monitoring.search')}
          </Button>
          <Button onClick={resetFilters}>{t('usage.reset')}</Button>
        </div>
      </Form>
      {mode === 'overview' && (
        <div className="usage-collection-strip">
          <span className="usage-collection-status">
            <Badge status={!data ? 'default' : !data.enabled ? 'default' : collectionProblem ? 'error' : 'success'} />
            {t(
              !data
                ? 'monitoring.checking'
                : !data.enabled
                  ? 'usage.collectionPaused'
                  : collectionProblem
                    ? 'usage.collectionIssue'
                    : 'usage.collectionActive',
            )}
          </span>
          <span>
            {t('usage.queue')}
            <strong>{data ? format(data.collection.queued) : '—'}</strong>
          </span>
          <span>
            {t('usage.dropped')}
            <strong className={data?.collection.dropped ? 'usage-value-warning' : ''}>
              {data ? format(data.collection.dropped) : '—'}
            </strong>
          </span>
          <span className="usage-last-collected">
            {t('usage.lastCollected')}
            <strong>{data?.collection.lastProcessedAt ? time(data.collection.lastProcessedAt) : '—'}</strong>
          </span>
        </div>
      )}
      {(error || (status && !status.enabled) || collectionProblem || logsDisabled) && (
        <div className="usage-notices">
          {error && <Alert type="error" showIcon message={error} />}
          {status && !status.enabled && <Alert type="info" showIcon message={t('usage.disabled')} />}
          {logsDisabled && <Alert type="info" showIcon message={t('usage.logsDisabled')} />}
          {collectionProblem && <Alert type="warning" showIcon message={t('usage.collectionError')} />}
        </div>
      )}
      <Tabs
        className="usage-tabs"
        tabBarStyle={mode === 'logs' ? { display: 'none' } : undefined}
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'overview',
            label: (
              <span className="usage-tab-label">
                <BarChartOutlined />
                {t('usage.overview')}
              </span>
            ),
            children: (
              <Spin spinning={loading}>
                {!stats ? (
                  <div className="usage-loading" />
                ) : (
                  <div className="usage-tab-content">
                    <div className="usage-secondary-metrics">
                      {[
                        [t('usage.requests'), format(stats.requests)],
                        [t('usage.peak'), format(stats.peak_per_minute)],
                        [t('usage.unknown'), format(stats.unknown)],
                        [t('usage.average'), format(stats.avg_ms, ' ms')],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <span>{label}</span>
                          <strong>{value}</strong>
                        </div>
                      ))}
                    </div>
                    <div className="usage-analysis-grid">
                      <section className="usage-content-card">
                        <div className="usage-card-heading">
                          <div>
                            <h4>{t('usage.trend')}</h4>
                            <p>{t('usage.trendDescription')}</p>
                          </div>
                          <div className="usage-chart-legend">
                            <span>
                              <i />
                              {t('usage.calls')}
                            </span>
                            <span>
                              <i className="is-failed" />
                              {t('usage.failed')}
                            </span>
                          </div>
                        </div>
                        <Trend data={data!.trend} bucket={data!.bucket_ms} />
                      </section>
                      <section className="usage-content-card usage-ranking-card">
                        <div className="usage-card-heading">
                          <div>
                            <h4>{t('usage.ranking')}</h4>
                            <p>{t('usage.rankingDescription')}</p>
                          </div>
                          <Select
                            aria-label={t('usage.dimension')}
                            value={dimension}
                            onChange={setDimension}
                            options={['server', 'tool', 'user', 'client'].map((value) => ({
                              value,
                              label: t(
                                value === 'server'
                                  ? 'usage.server'
                                  : value === 'tool'
                                    ? 'usage.tool'
                                    : value === 'user'
                                      ? 'usage.user'
                                      : 'usage.client',
                              ),
                            }))}
                          />
                        </div>
                        <Table
                          className="usage-table"
                          size="small"
                          rowKey="name"
                          pagination={false}
                          dataSource={data!.ranking}
                          scroll={{ x: 520 }}
                          locale={{ emptyText: emptyTable(t('usage.noRanking')) }}
                          columns={[
                            { title: t('usage.name'), dataIndex: 'name', ellipsis: true, width: 180 },
                            {
                              title: t('usage.calls'),
                              dataIndex: 'calls',
                              align: 'right',
                              width: 100,
                              render: (value) => format(value),
                            },
                            { title: t('usage.failed'), dataIndex: 'failed', align: 'right', width: 65 },
                            { title: t('usage.unknown'), dataIndex: 'unknown', align: 'right', width: 85 },
                            {
                              title: t('usage.p95'),
                              dataIndex: 'p95_ms',
                              align: 'right',
                              width: 120,
                              render: (value) => format(value, ' ms'),
                            },
                          ]}
                        />
                      </section>
                    </div>
                    <div className="usage-info-note">
                      <InfoCircleOutlined />
                      <p>{t('usage.semantics')}</p>
                    </div>
                  </div>
                )}
              </Spin>
            ),
          },
          {
            key: 'logs',
            label: (
              <span className="usage-tab-label">
                <FileTextOutlined />
                {t('usage.logs')}
              </span>
            ),
            children: (
              <div className="usage-tab-content">
                <section className="usage-content-card">
                  <div className="usage-card-heading">
                    <div>
                      <h4>{t('usage.logs')}</h4>
                      <p>{t('usage.logsDescription')}</p>
                    </div>
                    <div className="usage-log-actions">
                      <span className="usage-row-count">{t('usage.loadedRecords', { count: events.length })}</span>
                      <Select
                        aria-label={t('usage.result')}
                        value={filters.outcome ?? ''}
                        onChange={(outcome) => setFilters({ ...filters, outcome })}
                        options={[
                          { value: '', label: t('usage.allResults') },
                          ...Object.entries(outcomes).map(([value, label]) => ({ value, label })),
                        ]}
                      />
                    </div>
                  </div>
                  <Table
                    className="usage-table"
                    loading={loading}
                    size="small"
                    rowKey="id"
                    pagination={false}
                    dataSource={events}
                    scroll={{ x: 950 }}
                    locale={{ emptyText: emptyTable(t('usage.noLogs')) }}
                    columns={[
                      {
                        title: t('monitoring.time'),
                        dataIndex: 'started_at',
                        render: (value) => <time>{time(value)}</time>,
                        width: 160,
                      },
                      {
                        title: t('usage.user'),
                        dataIndex: 'username',
                        width: 125,
                        ellipsis: true,
                        render: (value, row) => value || String(row.user_id || '—'),
                      },
                      { title: t('usage.server'), dataIndex: 'server', ellipsis: true, width: 160 },
                      {
                        title: t('usage.tool'),
                        width: 180,
                        ellipsis: true,
                        render: (_, row) => <code>{row.tool || row.method}</code>,
                      },
                      { title: t('usage.result'), dataIndex: 'outcome', render: outcomeTag, width: 100 },
                      {
                        title: t('usage.duration'),
                        dataIndex: 'duration_ms',
                        align: 'right',
                        render: (value) => format(value, ' ms'),
                        width: 110,
                      },
                      {
                        title: t('monitoring.requestId'),
                        dataIndex: 'request_id',
                        width: 115,
                        render: (value, row) => (
                          <Tooltip title={t('usage.viewDetail')}>
                            <Button className="usage-request-link" type="link" onClick={() => setDetail(row)}>
                              {value.slice(0, 8)}
                            </Button>
                          </Tooltip>
                        ),
                      },
                    ]}
                  />
                  {cursor && (
                    <div className="usage-table-footer">
                      <Button loading={loadingMore} onClick={() => void loadMore()}>
                        {t('monitoring.loadOlderEvents')}
                      </Button>
                    </div>
                  )}
                </section>
                {historical && <Alert type="info" showIcon message={t('usage.historyPaused')} />}
                <div className="usage-info-note">
                  <InfoCircleOutlined />
                  <p>{t('usage.privacy')}</p>
                </div>
              </div>
            ),
          },
          {
            key: 'alerts',
            label: (
              <span className="usage-tab-label">
                <WarningOutlined />
                {t('usage.alertHistory')}
                {Boolean(data?.alerts.length || alertEvents.length) && (
                  <span className="usage-alert-count">{alertEvents.length || data!.alerts.length}</span>
                )}
              </span>
            ),
            children: (
              <Spin spinning={loading}>
                <div className="usage-tab-content">
                  <section className="usage-alert-rules">
                    <span className="usage-rule-icon">
                      <ClockCircleOutlined />
                    </span>
                    <div>
                      <h4>{t('usage.alertWindow')}</h4>
                      <p>{t('usage.alertRules')}</p>
                    </div>
                    <Tag variant="filled">{t('usage.liveRules')}</Tag>
                  </section>
                  {mode === 'overview' && alertEvents.length > 0 && (
                    <section className="usage-alert-list" aria-label={t('usage.alertHistory')}>
                      {alertEvents.map((event) => (
                        <article className="usage-alert-card" key={event.id}>
                          <div className="usage-alert-card-heading">
                            <span className="usage-rule-icon">
                              <WarningOutlined />
                            </span>
                            <div>
                              <h4>{t(event.type === 'error_rate' ? 'usage.errorRateAlert' : 'usage.slowAlert')}</h4>
                              <code>{event.server}</code>
                            </div>
                            <Tag color={event.resolved_at ? 'success' : 'warning'} variant="filled">
                              {t(event.resolved_at ? 'usage.alertResolved' : 'usage.alertOpen')}
                            </Tag>
                            {!event.acknowledged_at && !event.resolved_at && (
                              <Button size="small" onClick={() => void acknowledge(event.id)}>
                                {t('usage.alertAcknowledge')}
                              </Button>
                            )}
                          </div>
                          <div className="usage-alert-values">
                            <div>
                              <span>{t('usage.observedValue')}</span>
                              <strong>{format(event.value, event.type === 'error_rate' ? '%' : ' ms')}</strong>
                            </div>
                            <div>
                              <span>{t('usage.threshold')}</span>
                              <strong>{format(event.threshold, event.type === 'error_rate' ? '%' : ' ms')}</strong>
                            </div>
                            <div>
                              <span>{t('usage.alertFirstSeen')}</span>
                              <strong>{time(event.first_seen_at)}</strong>
                            </div>
                            <div>
                              <span>{t('usage.alertLastSeen')}</span>
                              <strong>{time(event.last_seen_at)}</strong>
                            </div>
                          </div>
                          {(event.acknowledged_by || event.notification_error) && (
                            <p className="usage-alert-meta">
                              {event.acknowledged_by &&
                                t('usage.alertAcknowledged', {
                                  actor: event.acknowledged_by,
                                })}
                              {event.notification_error &&
                                t('usage.alertNotificationError', { error: event.notification_error })}
                            </p>
                          )}
                        </article>
                      ))}
                    </section>
                  )}
                  {!data ? (
                    <div className="usage-loading" />
                  ) : data.alerts.length ? (
                    <div className="usage-alert-list">
                      {data.alerts.map((alert) => (
                        <article className="usage-alert-card" key={alert.server + alert.type}>
                          <div className="usage-alert-card-heading">
                            <span className="usage-rule-icon">
                              <WarningOutlined />
                            </span>
                            <div>
                              <h4>{t(alert.type === 'error_rate' ? 'usage.errorRateAlert' : 'usage.slowAlert')}</h4>
                              <code>{alert.server}</code>
                            </div>
                            <Tag color="warning" variant="filled">
                              {t('monitoring.needsAttention')}
                            </Tag>
                          </div>
                          <div className="usage-alert-values">
                            <div>
                              <span>{t('usage.observedValue')}</span>
                              <strong>{format(alert.value, alert.type === 'error_rate' ? '%' : ' ms')}</strong>
                            </div>
                            <div>
                              <span>{t('usage.threshold')}</span>
                              <strong>{format(alert.threshold, alert.type === 'error_rate' ? '%' : ' ms')}</strong>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="usage-alert-empty">
                      <span
                        className={`usage-alert-empty-icon ${!data.enabled || collectionProblem || error ? 'is-paused' : ''}`}
                      >
                        {!data.enabled || collectionProblem || error ? <InfoCircleOutlined /> : <CheckCircleOutlined />}
                      </span>
                      <h4>
                        {t(
                          error
                            ? 'usage.alertsUnavailable'
                            : !data.enabled
                              ? 'usage.collectionPaused'
                              : collectionProblem
                                ? 'usage.collectionIssue'
                                : 'usage.noAlerts',
                        )}
                      </h4>
                      <p>
                        {t(
                          error || !data.enabled || collectionProblem
                            ? 'usage.alertsUnavailableHelp'
                            : 'usage.noAlertsHelp',
                        )}
                      </p>
                    </div>
                  )}
                </div>
              </Spin>
            ),
          },
        ].filter((item) => (mode === 'logs' ? item.key === 'logs' : item.key !== 'logs'))}
      />
      <Drawer
        className="usage-detail-drawer"
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={t('usage.detail')}
        size="min(560px, 100vw)"
      >
        {detail && (
          <>
            <div className="usage-detail-summary">
              {outcomeTag(detail.outcome)}
              <strong>{detail.tool || detail.method}</strong>
              <span>{format(detail.duration_ms, ' ms')}</span>
            </div>
            <Descriptions
              bordered
              column={1}
              size="small"
              items={[
                { key: 'id', label: t('monitoring.requestId'), children: <code>{detail.request_id}</code> },
                { key: 'time', label: t('monitoring.time'), children: time(detail.started_at) },
                {
                  key: 'user',
                  label: t('usage.user'),
                  children: (detail.username || '—') + ' (#' + detail.user_id + ')',
                },
                { key: 'server', label: t('usage.server'), children: detail.server },
                { key: 'client', label: t('usage.client'), children: detail.client_id || '—' },
                { key: 'method', label: t('usage.method'), children: detail.method },
                { key: 'tool', label: t('usage.tool'), children: detail.tool || '—' },
                { key: 'http', label: 'HTTP', children: detail.http_status || '—' },
                { key: 'error', label: t('usage.error'), children: detail.error || '—' },
                { key: 'instance', label: t('usage.instance'), children: detail.instance || '—' },
                {
                  key: 'input',
                  label: t('usage.input'),
                  children: (
                    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto' }}>
                      {detail.input ?? t('usage.contentUnavailable')}
                    </pre>
                  ),
                },
                {
                  key: 'output',
                  label: t('usage.output'),
                  children: (
                    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto' }}>
                      {detail.output ?? t('usage.contentUnavailable')}
                    </pre>
                  ),
                },
                { key: 'attempts', label: t('usage.attempts'), children: detail.attempts },
              ]}
            />
            <div className="usage-info-note">
              <InfoCircleOutlined />
              <p>{t('usage.privacy')}</p>
            </div>
          </>
        )}
      </Drawer>
    </section>
  );
}
