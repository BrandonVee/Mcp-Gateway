import { useEffect, useRef, useState } from 'react';
import { Empty, Select, Spin, Tooltip } from 'antd';
import { BarChartOutlined, ClockCircleOutlined, LineChartOutlined, TeamOutlined } from '@ant-design/icons';
import { useI18n } from '@/web/i18n';
import type { UsageSummary } from '@/web/types';

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
    baseline = 116,
    plotHeight = 92;
  const step = (right - left) / Math.max(1, data.length),
    gap = Math.min(3, step * 0.18);
  const spansDays =
    data.length > 1 && new Date(data[0].time).toDateString() !== new Date(data.at(-1)!.time).toDateString();
  const fmt = (time: number) =>
    new Intl.DateTimeFormat(
      language,
      bucket >= 86400000
        ? { month: '2-digit', day: '2-digit' }
        : spansDays
          ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
          : { hour: '2-digit', minute: '2-digit' },
    ).format(time);
  return (
    <div ref={ref} className="usage-chart">
      {data.some((row) => row.calls > 0) ? (
        <svg viewBox={`0 0 ${width} 150`} role="img" aria-label={t('usage.trend')}>
          <title>{t('usage.trend')}</title>
          {[0, Math.ceil(high / 2), high]
            .filter((value, index, values) => values.indexOf(value) === index)
            .map((value) => (
              <g key={value}>
                <line
                  x1={left}
                  x2={right}
                  y1={baseline - (value / high) * plotHeight}
                  y2={baseline - (value / high) * plotHeight}
                />
                <text x={left - 10} y={baseline - (value / high) * plotHeight + 4} textAnchor="end">
                  {value}
                </text>
              </g>
            ))}
          {data.map((row, i) => (
            <g key={row.time}>
              <rect
                x={left + step * i + gap}
                y={baseline - (row.calls / high) * plotHeight}
                width={Math.max(0.5, step - gap * 2)}
                height={(row.calls / high) * plotHeight}
                rx={Math.min(3, step / 4)}
              >
                <title>
                  {fmt(row.time)} · {t('usage.calls')}: {row.calls} · {t('usage.failed')}: {row.failed}
                </title>
              </rect>
              <rect
                className="usage-chart-failed"
                x={left + step * i + gap}
                y={baseline - (row.failed / high) * plotHeight}
                width={Math.max(0.5, step - gap * 2)}
                height={(row.failed / high) * plotHeight}
              >
                <title>
                  {fmt(row.time)} · {t('usage.failed')}: {row.failed}
                </title>
              </rect>
            </g>
          ))}
          <text x={left} y={142}>
            {data[0] ? fmt(data[0].time) : '—'}
          </text>
          <text x={right} y={142} textAnchor="end">
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

interface UsageSummaryCardsProps {
  data: UsageSummary | null;
  dimension: string;
  onDimensionChange: (dimension: string) => void;
  loading: boolean;
}

export function UsageSummaryCards({ data, dimension, onDimensionChange, loading }: UsageSummaryCardsProps) {
  const { t, language } = useI18n();
  const stats = data?.summary;
  const format = (value: number | null | undefined, unit = '') =>
    value == null ? '—' : new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value) + unit;
  const ranking = data?.ranking.filter((row) => row.calls > 0) ?? [];
  const maxCalls = Math.max(1, ...ranking.map((row) => row.calls));
  const results = [
    { key: 'success', label: t('usage.success'), count: stats?.success },
    { key: 'failed', label: t('usage.failed'), count: stats?.failed },
    { key: 'unknown', label: t('usage.unknown'), count: stats?.unknown },
  ];
  const metrics = [
    { label: t('usage.average'), value: format(stats?.avg_ms, ' ms'), icon: <ClockCircleOutlined />, tone: 'blue' },
    {
      label: t('usage.p95'),
      value: format(stats?.p95_ms, ' ms'),
      icon: <ClockCircleOutlined />,
      tone: 'amber',
      hint: t('usage.latencyHint'),
    },
    {
      label: t('usage.users'),
      value: format(stats?.active_users),
      icon: <TeamOutlined />,
      tone: 'purple',
      hint: t('usage.usersHint'),
    },
    { label: t('usage.peak'), value: format(stats?.peak_per_minute), icon: <BarChartOutlined />, tone: 'green' },
  ];

  return (
    <Spin spinning={loading}>
      <div className="usage-dashboard-grid" role="group" aria-label={t('usage.overview')}>
        <section className="monitor-audit-panel usage-dashboard-card" aria-labelledby="usage-outcomes-heading">
          <div className="usage-card-heading">
            <h4 id="usage-outcomes-heading">{t('usage.callOutcomes')}</h4>
            <Tooltip title={t('usage.outcomeShareHint')}>
              <span className="usage-card-hint" tabIndex={0}>
                {t('usage.outcomeShare')}
              </span>
            </Tooltip>
          </div>
          <div className="usage-dashboard-body usage-outcomes-body">
            <div className="usage-outcome-summary">
              <strong>{format(stats?.success_rate, '%')}</strong>
              <Tooltip title={t('usage.successHint')}>
                <span tabIndex={0}>{t('usage.successRate')}</span>
              </Tooltip>
            </div>
            <dl className="usage-outcome-list">
              {results.map((result) => (
                <div key={result.key} className={`usage-outcome-item is-${result.key}`}>
                  <dt>{result.label}</dt>
                  <dd>
                    <strong>{format(result.count)}</strong>
                    <span>{format(stats?.calls ? ((result.count ?? 0) / stats.calls) * 100 : null, '%')}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="monitor-audit-panel usage-dashboard-card" aria-labelledby="usage-performance-heading">
          <div className="usage-card-heading">
            <h4 id="usage-performance-heading">{t('usage.callPerformance')}</h4>
          </div>
          <div className="usage-dashboard-body usage-performance-body">
            <div className="usage-metrics">
              {metrics.map((metric) => (
                <div key={metric.label} className={`usage-metric usage-metric-${metric.tone}`}>
                  <Tooltip title={metric.hint}>
                    <div className="usage-metric-heading" tabIndex={metric.hint ? 0 : undefined}>
                      <span>{metric.label}</span>
                      <span className="usage-metric-icon">{metric.icon}</span>
                    </div>
                  </Tooltip>
                  <strong>{metric.value}</strong>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="monitor-audit-panel usage-dashboard-card" aria-labelledby="usage-calls-heading">
          <div className="usage-card-heading">
            <h4 id="usage-calls-heading">{t('usage.callStatistics')}</h4>
            <Tooltip title={t('usage.callsHint')}>
              <span className="usage-card-total" tabIndex={0}>
                <strong>{format(stats?.calls)}</strong>
                <span>{t('usage.calls')}</span>
              </span>
            </Tooltip>
          </div>
          <div className="usage-dashboard-body usage-trend-body">
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
            <Trend data={data?.trend ?? []} bucket={data?.bucket_ms ?? 3600000} />
          </div>
        </section>

        <section className="monitor-audit-panel usage-dashboard-card" aria-labelledby="usage-ranking-heading">
          <div className="usage-card-heading">
            <h4 id="usage-ranking-heading">{t('usage.ranking')}</h4>
            <Select
              size="small"
              aria-label={t('usage.dimension')}
              value={dimension}
              onChange={onDimensionChange}
              options={[
                { value: 'server', label: t('usage.server') },
                { value: 'tool', label: t('usage.tool') },
                { value: 'user', label: t('usage.user') },
                { value: 'client', label: t('usage.client') },
              ]}
            />
          </div>
          <div className="usage-dashboard-body">
            {ranking.length ? (
              <ol className="usage-ranking-list" tabIndex={0} aria-label={t('usage.rankingDescription')}>
                {ranking.map((row) => (
                  <li key={row.name}>
                    <div className="usage-ranking-label">
                      <span title={row.name} className="usage-ranking-name">
                        {row.name || '—'}
                      </span>
                      <strong>{format(row.calls)}</strong>
                    </div>
                    <div className="usage-ranking-track" aria-hidden="true">
                      <span style={{ width: `${(row.calls / maxCalls) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="usage-dashboard-empty">
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('usage.noRanking')} />
              </div>
            )}
          </div>
        </section>
      </div>
    </Spin>
  );
}
