import { useI18n, type Language } from '@/web/i18n';
import { Alert, Button, Empty, Input, Select, Spin, Tag } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/web/api';
import type { AuditEvent } from '@/web/types';
import '@/web/features/monitoring/monitoring.css';

const PAGE_SIZE = 50;
const timestamp = (value: number, language: Language) =>
  new Intl.DateTimeFormat(language, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));

export function AuditPage() {
  const { t, language } = useI18n();
  const [draftActor, setDraftActor] = useState('');
  const [actor, setActor] = useState('');
  const [method, setMethod] = useState('');
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const identity = JSON.stringify([actor, method, revision, language]);
  const current = useRef(identity);
  current.current = identity;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    void api
      .auditEvents({ limit: PAGE_SIZE, actor: actor || undefined, method: method || undefined })
      .then((page) => {
        if (!active) return;
        setEvents(page.events);
        setNextBefore(page.next_before);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : t('monitoring.couldNotLoadAuditEvents'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [actor, method, revision, t]);

  const loadMore = async () => {
    if (!nextBefore || loadingMore || loading) return;
    const snapshot = current.current;
    setLoadingMore(true);
    try {
      const page = await api.auditEvents({
        limit: PAGE_SIZE,
        before: nextBefore,
        actor: actor || undefined,
        method: method || undefined,
      });
      if (current.current !== snapshot) return;
      setEvents((rows) => [...rows, ...page.events.filter((event) => !rows.some((row) => row.id === event.id))]);
      setNextBefore(page.next_before);
    } catch (cause) {
      if (current.current === snapshot)
        setError(cause instanceof Error ? cause.message : t('monitoring.couldNotLoadOlderEvents'));
    } finally {
      if (current.current === snapshot) setLoadingMore(false);
    }
  };

  return (
    <div className="page-stack page-enter monitor-page">
      <section className="monitor-audit-panel">
        <div className="monitor-section-heading">
          <div>
            <span className="section-eyebrow">{t('monitoring.auditEyebrow')}</span>
            <h3>{t('monitoring.auditTrail')}</h3>
          </div>
          <Tag color="cyan" variant="filled">
            {t('monitoring.metadata90DayDefaultRetention')}
          </Tag>
        </div>
        <div className="monitor-toolbar">
          <Input
            className="monitor-actor-input"
            prefix={<SearchOutlined />}
            value={draftActor}
            maxLength={64}
            placeholder={t('monitoring.filterActor')}
            onChange={(event) => setDraftActor(event.target.value)}
            onPressEnter={() => setActor(draftActor.trim())}
            allowClear
          />
          <Button onClick={() => setActor(draftActor.trim())}>{t('monitoring.search')}</Button>
          <Select
            value={method}
            onChange={setMethod}
            options={[
              { value: '', label: t('monitoring.methods') },
              { value: 'POST', label: t('monitoring.createSign') },
              { value: 'PUT', label: t('monitoring.replace') },
              { value: 'PATCH', label: t('monitoring.update') },
              { value: 'DELETE', label: t('monitoring.deleteSignOut') },
            ]}
            className="monitor-method-select"
          />
          <Button icon={<ReloadOutlined />} onClick={() => setRevision((value) => value + 1)} loading={loading}>
            {t('monitoring.refreshEvents')}
          </Button>
        </div>

        {error && <Alert type="error" showIcon message={error} className="monitor-error" />}
        <div className="monitor-log-head">
          <span>{t('monitoring.time')}</span>
          <span>{t('monitoring.actor')}</span>
          <span>{t('monitoring.request')}</span>
          <span>{t('monitoring.result')}</span>
          <span>{t('monitoring.requestId')}</span>
        </div>
        <div className="monitor-log-body">
          {loading ? (
            <div className="monitor-empty">
              <Spin />
            </div>
          ) : events.length ? (
            events.map((event) => (
              <div className="monitor-log-row" key={event.id}>
                <time>{timestamp(event.created_at, language)}</time>
                <strong>{event.actor}</strong>
                <div className="monitor-operation">
                  <Tag
                    color={event.method === 'DELETE' ? 'red' : event.method === 'POST' ? 'blue' : 'gold'}
                    variant="filled"
                  >
                    {event.method}
                  </Tag>
                  <code title={event.path}>{event.path}</code>
                </div>
                <Tag color={event.status_code < 400 ? 'success' : 'error'} variant="filled">
                  {event.status_code}
                </Tag>
                <code className="monitor-request-id" title={event.request_id}>
                  {event.request_id.slice(0, 8)}
                </code>
              </div>
            ))
          ) : (
            <div className="monitor-empty">
              <Empty description={t('monitoring.noMatchingAuditEvents')} />
            </div>
          )}
        </div>
        {nextBefore !== null && (
          <div className="monitor-footer">
            <Button onClick={() => void loadMore()} loading={loadingMore}>
              {t('monitoring.loadOlderEvents')}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
