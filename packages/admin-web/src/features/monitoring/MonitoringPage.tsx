import { useI18n, type Language } from '../../i18n';
import { Alert, Badge, Button, Empty, Input, Select, Spin, Tag } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { UsageMonitoring } from './UsageMonitoring';
import type { AuditEvent, AuthHealth, GatewayHealth } from '../../types';
import './monitoring.css';

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

function StatusCell({ label, good, detail }: { label: string; good: boolean; detail: string }) {
  const { t } = useI18n();
  return (
    <div className={`monitor-status-cell ${good ? 'is-good' : 'is-bad'}`}>
      <div className="monitor-status-top">
        <span>{label}</span>
        <Badge status={good ? 'success' : 'error'} />
      </div>
      <strong>{good ? t('monitoring.healthy') : t('monitoring.needsAttention')}</strong>
      <small>{detail}</small>
    </div>
  );
}

export function MonitoringPage() {
  const { t, language } = useI18n();
  const [auth, setAuth] = useState<AuthHealth | null>(null);
  const [gateway, setGateway] = useState<GatewayHealth | null>(null);
  const [draftActor, setDraftActor] = useState('');
  const [actor, setActor] = useState('');
  const [method, setMethod] = useState('');
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [healthCheckedAt, setHealthCheckedAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const identity = JSON.stringify([actor, method, revision, language]);
  const current = useRef(identity);
  current.current = identity;
  const healthLoading = useRef(false);
  const activeHealth = useRef(true);

  const loadHealth = useCallback(async () => {
    if (healthLoading.current) return;
    healthLoading.current = true;
    const [authResult, gatewayResult] = await Promise.allSettled([api.authHealth(), api.gatewayHealth()]);
    healthLoading.current = false;
    if (!activeHealth.current) return;
    setAuth(authResult.status === 'fulfilled' ? authResult.value : null);
    setGateway(gatewayResult.status === 'fulfilled' ? gatewayResult.value : null);
    setHealthCheckedAt(Date.now());
  }, []);

  useEffect(() => {
    let active = true;
    activeHealth.current = true;
    const tick = async () => {
      if (!active) return;
      await loadHealth();
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 10_000);
    return () => {
      active = false;
      activeHealth.current = false;
      window.clearInterval(timer);
    };
  }, [loadHealth]);

  const recheck = async () => {
    setChecking(true);
    try {
      await loadHealth();
    } finally {
      setChecking(false);
    }
  };

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
      <section className="monitor-overview">
        <div className="monitor-section-heading">
          <div>
            <span className="section-eyebrow">{t('monitoring.pulseEyebrow')}</span>
            <h3>{t('monitoring.servicePulse')}</h3>
          </div>
          <div className="monitor-checked-row">
            <span className="monitor-checked">
              {t('monitoring.checksEvery10SecondsTime', {
                time: healthCheckedAt ? timestamp(healthCheckedAt, language) : t('monitoring.checking'),
              })}
            </span>
            <Button size="small" icon={<ReloadOutlined />} loading={checking} onClick={recheck}>
              {t('monitoring.recheck')}
            </Button>
          </div>
        </div>
        <div className="monitor-status-grid">
          <StatusCell
            label={t('monitoring.authApiLabel')}
            good={Boolean(auth?.ok)}
            detail={t('monitoring.authenticationService')}
          />
          <StatusCell label="PostgreSQL" good={Boolean(auth?.postgres)} detail={t('monitoring.primaryDataStore')} />
          <StatusCell
            label={t('monitoring.gatewayLabel')}
            good={Boolean(gateway?.ok)}
            detail={t('monitoring.mcpGateway')}
          />
          <StatusCell label="Redis" good={Boolean(gateway?.redis)} detail={t('monitoring.stickySessions')} />
          <StatusCell
            label={t('monitoring.registryLabel')}
            good={Boolean(gateway?.registry?.lastSuccessAt && !gateway?.registry?.lastError)}
            detail={
              gateway?.registry?.lastError ? t('monitoring.registrySyncFailed') : t('monitoring.databaseRouteSync')
            }
          />
        </div>
      </section>

      <UsageMonitoring gateway={gateway} />
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
