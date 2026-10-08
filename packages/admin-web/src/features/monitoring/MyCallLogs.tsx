import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Drawer, Form, Input, Select, Space, Table, Typography } from 'antd';
import { apiForSession } from '../../api';
import { useI18n } from '../../i18n';
import type { PlatformSession, UsageCall, UsageFilters } from '../../types';

export function MyCallLogs({ session }: { session: PlatformSession }) {
  const { t, language } = useI18n();
  const [form] = Form.useForm<UsageFilters>();
  const [filters, setFilters] = useState<UsageFilters>({ hours: 24 });
  const [rows, setRows] = useState<UsageCall[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<UsageCall | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
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
    <Card title={t('usage.logs')}>
      <Form
        style={{ rowGap: 12, marginBottom: 20 }}
        form={form}
        layout="inline"
        initialValues={{ hours: 24 }}
        onFinish={setFilters}
      >
        <Form.Item name="hours" label={t('usage.period')}>
          <Select
            style={{ width: 100 }}
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
        {(['server', 'tool', 'method', 'client_id', 'request_id', 'q'] as const).map((key) => (
          <Form.Item
            key={key}
            name={key}
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
            style={{ width: 110 }}
            options={(['success', 'failed', 'unknown'] as const).map((value) => ({
              value,
              label: t(`usage.${value}`),
            }))}
          />
        </Form.Item>
        <Space>
          <Button htmlType="submit" type="primary">
            {t('monitoring.search')}
          </Button>
          <Button
            onClick={() => {
              form.resetFields();
              setFilters({ hours: 24 });
            }}
          >
            {t('usage.reset')}
          </Button>
          <Button disabled={loading} onClick={() => void load()}>
            {t('monitoring.refreshEvents')}
          </Button>
        </Space>
      </Form>
      {error && <Alert type="error" showIcon title={error} />}
      <Table
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
          { title: t('usage.user'), dataIndex: 'username' },
          { title: t('usage.server'), dataIndex: 'server' },
          { title: t('usage.tool'), render: (_, row) => row.tool || row.method },
          {
            title: t('usage.result'),
            dataIndex: 'outcome',
            render: (value) =>
              t(value === 'success' ? 'usage.success' : value === 'failed' ? 'usage.failed' : 'usage.unknown'),
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
