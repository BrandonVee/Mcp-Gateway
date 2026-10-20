import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, DatePicker, Drawer, Form, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { DownOutlined, ReloadOutlined } from '@ant-design/icons';
import { apiForSession } from '@/web/api';
import { useI18n } from '@/web/i18n';
import type { PlatformSession, UsageCall, UsageFilters } from '@/web/types';

type CallLogForm = Omit<UsageFilters, 'hours' | 'start' | 'end'> & { timeRange: [Dayjs, Dayjs] };

function recentRange(hours = 24): [Dayjs, Dayjs] {
  const end = dayjs();
  return [end.subtract(hours, 'hour'), end];
}

function queryFilters({ timeRange, ...values }: CallLogForm): UsageFilters {
  return { ...values, hours: 24, start: timeRange[0].valueOf(), end: timeRange[1].valueOf() };
}

export function MyCallLogs({ session }: { session: PlatformSession }) {
  const { t, language } = useI18n();
  const [initialRange] = useState(() => recentRange());
  const [form] = Form.useForm<CallLogForm>();
  const [filters, setFilters] = useState<UsageFilters>(() => queryFilters({ timeRange: initialRange }));
  const [rows, setRows] = useState<UsageCall[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<UsageCall | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [advancedFilters, setAdvancedFilters] = useState(false);
  const generation = useRef(0);
  const load = async (more = false) => {
    const version = more ? generation.current : ++generation.current;
    setLoading(true);
    try {
      const page = await apiForSession(session).myUsageCalls(filters, more ? (cursor ?? undefined) : undefined);
      if (version !== generation.current) return;
      setRows((previous) =>
        more ? [...previous, ...page.events.filter((row) => !previous.some((p) => p.id === row.id))] : page.events,
      );
      setCursor(page.next_cursor);
      setError('');
    } catch (cause) {
      if (version === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [JSON.stringify(filters), session.user_id, session.auth_version]);
  return (
    <Card className="my-call-logs-card" bordered={false}>
      <Form
        className="my-call-logs-form"
        form={form}
        layout="vertical"
        initialValues={{ timeRange: initialRange }}
        onFinish={(values) => setFilters(queryFilters(values))}
      >
        <Form.Item name="timeRange" label={t('usage.timeRange')} className="my-call-logs-time-range">
          <DatePicker.RangePicker
            allowClear={false}
            showTime
            format="YYYY-MM-DD HH:mm:ss"
            style={{ width: '100%' }}
            presets={[1, 24, 168, 720, 8760].map((hours) => ({
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
              value: () => recentRange(hours),
            }))}
          />
        </Form.Item>
        {(['server', 'tool', 'method', 'client_id', 'request_id', 'q'] as const).map((key, index) => (
          <Form.Item
            key={key}
            name={key}
            hidden={index > 0 && !advancedFilters}
            label={t(
              key === 'q'
                ? 'usage.contentSearch'
                : key === 'request_id'
                  ? 'monitoring.requestId'
                  : key === 'client_id'
                    ? 'usage.client'
                    : `usage.${key}`,
            )}
          >
            <Input allowClear />
          </Form.Item>
        ))}
        <Form.Item name="outcome" label={t('usage.result')}>
          <Select
            allowClear
            options={(['success', 'failed', 'unknown'] as const).map((value) => ({
              value,
              label: t(`usage.${value}`),
            }))}
          />
        </Form.Item>
        <Space wrap className="my-call-logs-actions">
          <Button htmlType="submit" type="primary">
            {t('monitoring.search')}
          </Button>
          <Button
            onClick={() => {
              form.resetFields();
              const timeRange = recentRange();
              form.setFieldsValue({ timeRange });
              setFilters(queryFilters({ timeRange }));
            }}
          >
            {t('usage.reset')}
          </Button>
          <Button disabled={loading} icon={<ReloadOutlined spin={loading} />} onClick={() => void load()}>
            {t('monitoring.refreshEvents')}
          </Button>
          <Button type="text" aria-expanded={advancedFilters} onClick={() => setAdvancedFilters((value) => !value)}>
            {t(advancedFilters ? 'connections.fewerFilters' : 'connections.moreFilters')}
            <DownOutlined rotate={advancedFilters ? 180 : 0} />
          </Button>
        </Space>
      </Form>
      <div className="my-call-logs-results" role="region" aria-label={t('connections.tabLogs')} tabIndex={0}>
        {error && <Alert type="error" showIcon title={error} />}
        <Table
          sticky
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 850 }}
          onRow={(row) => ({ onClick: () => setDetail(row), style: { cursor: 'pointer' } })}
          columns={[
            {
              title: t('monitoring.time'),
              dataIndex: 'started_at',
              render: (value) => new Date(value).toLocaleString(language),
            },
            { title: t('usage.server'), dataIndex: 'server' },
            { title: t('usage.tool'), render: (_, row) => row.tool || row.method },
            {
              title: t('usage.result'),
              dataIndex: 'outcome',
              render: (value) => (
                <Tag color={value === 'success' ? 'success' : value === 'failed' ? 'error' : 'default'}>
                  {t(value === 'success' ? 'usage.success' : value === 'failed' ? 'usage.failed' : 'usage.unknown')}
                </Tag>
              ),
            },
            {
              title: t('usage.duration'),
              dataIndex: 'duration_ms',
              render: (value) => (value === null ? '—' : `${value} ms`),
            },
            {
              title: t('monitoring.requestId'),
              dataIndex: 'request_id',
              render: (value) => <Typography.Text copyable>{value}</Typography.Text>,
            },
          ]}
        />
        {cursor && (
          <Button disabled={loading} onClick={() => void load(true)}>
            {t('monitoring.loadOlderEvents')}
          </Button>
        )}
        <p>{t('usage.privacy')}</p>
      </div>
      <Drawer open={!!detail} onClose={() => setDetail(null)} title={t('usage.detail')} size="min(680px, 100vw)">
        {detail && (
          <>
            <Typography.Paragraph copyable>{detail.request_id}</Typography.Paragraph>
            <p>
              {detail.server} · {detail.tool || detail.method} · {t('usage.httpStatus')} {detail.http_status} ·{' '}
              {detail.error}
            </p>
            {(['input', 'output'] as const).map((key) => (
              <div key={key}>
                <h4>{t(`usage.${key}`)}</h4>
                <Typography.Paragraph copyable={detail[key] ? { text: detail[key]! } : false}>
                  <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {detail[key] ?? t('usage.contentUnavailable')}
                  </pre>
                </Typography.Paragraph>
              </div>
            ))}
          </>
        )}
      </Drawer>
    </Card>
  );
}
