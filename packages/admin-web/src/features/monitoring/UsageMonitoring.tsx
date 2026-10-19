import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Empty, Form, Input, Select, Spin, Table, Tabs, Tag, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  FileTextOutlined,
  FilterOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { api } from '@/web/api';
import { UsageSummaryCards } from '@/web/features/monitoring/UsageSummaryCards';
import { useI18n } from '@/web/i18n';
import type { AlertEvent, UsageCall, UsageFilters, UsageSummary } from '@/web/types';

export function UsageMonitoring() {
  const { t, language } = useI18n();
  const [form] = Form.useForm<UsageFilters>();
  const [filters, setFilters] = useState<UsageFilters>({ hours: 24 });
  const [dimension, setDimension] = useState('tool'),
    [tab, setTab] = useState('logs');
  const [showAdvanced, setShowAdvanced] = useState(false);
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
        const [summary, calls, alerts] = await Promise.allSettled([
          api.usageSummary(filters, dimension),
          tab === 'logs' && !paged.current ? api.usageCalls(filters) : Promise.resolve(null),
          api.usageAlerts(),
        ]);
        if (!active) return;
        const errors: string[] = [];
        if (summary.status === 'fulfilled') setData(summary.value);
        else errors.push(summary.reason instanceof Error ? summary.reason.message : String(summary.reason));
        if (calls.status === 'fulfilled') {
          if (calls.value && !paged.current) {
            setEvents(calls.value.events);
            setCursor(calls.value.next_cursor);
          }
        } else {
          errors.push(calls.reason instanceof Error ? calls.reason.message : String(calls.reason));
        }
        if (alerts.status === 'fulfilled') setAlertEvents(alerts.value.events);
        setError([...new Set(errors)].join('; '));
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
  }, [filtersKey, dimension, tab, revision]);

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
  const collectionProblem = Boolean(data?.collection.lastError);
  const logsDisabled = tab === 'logs' && data?.enabled && data.logs_enabled === false;
  const advancedFilterCount = [
    filters.user_id,
    filters.client_id,
    filters.q,
    filters.method,
    filters.request_id,
  ].filter(Boolean).length;
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

  return (
    <section className="usage-panel usage-workspace">
      <UsageSummaryCards data={data} dimension={dimension} onDimensionChange={setDimension} loading={loading} />
      <section className="monitor-audit-panel usage-log-workspace">
        <Form
          form={form}
          layout="inline"
          labelAlign="left"
          colon={false}
          size="small"
          initialValues={{ hours: 24 }}
          onFinish={(values) => {
            setFilters(values);
            setRevision((value) => value + 1);
          }}
          className="usage-filters"
        >
          <div className="usage-primary-filters">
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
            <Form.Item name="outcome" label={t('usage.result')}>
              <Select
                allowClear
                placeholder={t('usage.allResults')}
                aria-label={t('usage.result')}
                options={Object.entries(outcomes).map(([value, label]) => ({ value, label }))}
              />
            </Form.Item>
            <div className="usage-filter-actions">
              <Button type="primary" htmlType="submit" icon={<SearchOutlined />} loading={loading}>
                {t('monitoring.search')}
              </Button>
              <Button onClick={resetFilters}>{t('usage.reset')}</Button>
              <Button
                type="text"
                icon={<FilterOutlined />}
                aria-expanded={showAdvanced}
                aria-controls="usage-advanced-filters"
                onClick={() => setShowAdvanced((value) => !value)}
              >
                {t(showAdvanced ? 'usage.lessFilters' : 'usage.moreFilters')}
                {advancedFilterCount > 0 && <span className="usage-filter-count">{advancedFilterCount}</span>}
              </Button>
            </div>
          </div>
          <div id="usage-advanced-filters" className="usage-advanced-filters" hidden={!showAdvanced}>
            <Form.Item name="user_id" label={t('usage.userId')}>
              <Input allowClear inputMode="numeric" maxLength={16} placeholder={t('usage.userPlaceholder')} />
            </Form.Item>
            <Form.Item name="client_id" label={t('usage.client')}>
              <Input allowClear maxLength={128} placeholder={t('usage.clientPlaceholder')} />
            </Form.Item>
            <Form.Item name="q" label={t('usage.contentSearch')}>
              <Input allowClear maxLength={256} />
            </Form.Item>
            <Form.Item name="method" label={t('usage.method')}>
              <Input allowClear maxLength={128} />
            </Form.Item>
            <Form.Item name="request_id" label={t('monitoring.requestId')}>
              <Input allowClear maxLength={128} />
            </Form.Item>
            <p className="usage-filter-help">{t('usage.logFiltersHelp')}</p>
          </div>
        </Form>
        {(error || (data && !data.enabled) || collectionProblem || logsDisabled) && (
          <div className="usage-notices">
            {error && <Alert type="error" showIcon message={error} />}
            {data && !data.enabled && <Alert type="info" showIcon message={t('usage.disabled')} />}
            {logsDisabled && <Alert type="info" showIcon message={t('usage.logsDisabled')} />}
            {collectionProblem && <Alert type="warning" showIcon message={t('usage.collectionError')} />}
          </div>
        )}
        <Tabs
          className="usage-tabs"
          activeKey={tab}
          onChange={setTab}
          tabBarExtraContent={
            <Tooltip title={t('usage.reload')}>
              <Button
                size="small"
                className="usage-refresh-button"
                aria-label={t('usage.reload')}
                icon={<ReloadOutlined />}
                loading={loading}
                onClick={() => setRevision((value) => value + 1)}
              />
            </Tooltip>
          }
          items={[
            {
              key: 'logs',
              label: (
                <span className="usage-tab-label">
                  <FileTextOutlined />
                  {t('usage.logs')}
                </span>
              ),
              children: (
                <div className="usage-tab-content usage-logs-content">
                  <section className="usage-content-card">
                    <div className="usage-log-toolbar">
                      <span className="usage-row-count">{t('usage.loadedRecords', { count: events.length })}</span>
                      <span className="usage-row-count">
                        {t('usage.requests')} {format(stats?.requests ?? 0)}
                      </span>
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
                    </section>
                    {alertEvents.length > 0 && (
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
                          {!data.enabled || collectionProblem || error ? (
                            <InfoCircleOutlined />
                          ) : (
                            <CheckCircleOutlined />
                          )}
                        </span>
                        <h4>
                          {t(
                            error || !data.enabled || collectionProblem ? 'usage.alertsUnavailable' : 'usage.noAlerts',
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
          ]}
        />
      </section>
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
