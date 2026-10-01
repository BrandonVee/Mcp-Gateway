import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Form, Input, Select, Spin, Table, Tabs, Tag } from 'antd';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import type { GatewayHealth, UsageCall, UsageFilters, UsageSummary } from '../../types';

function Trend({data,bucket}:{data:UsageSummary['trend'];bucket:number}) {
  const {t,language}=useI18n(),ref=useRef<HTMLDivElement>(null);
  const [width,setWidth]=useState(600);
  useEffect(() => {const element=ref.current;if (!element) return;const observer=new ResizeObserver(() => setWidth(Math.max(260,element.clientWidth)));observer.observe(element);return () => observer.disconnect();},[]);
  const high=Math.max(1,...data.map(row => row.calls)),left=48,plot=width-left-10,step=plot/Math.max(1,data.length),gap=Math.min(2,step*.15);
  const fmt=(time:number) => new Intl.DateTimeFormat(language,bucket>=86400000?{month:'2-digit',day:'2-digit'}:{hour:'2-digit',minute:'2-digit'}).format(time);
  return <div ref={ref} className="usage-chart"><svg viewBox={`0 0 ${width} 170`} role="img" aria-label={t('usage.trend')}>
    <title>{t('usage.trend')}</title>
    {[0,.5,1].map(value => <g key={value}><line x1={left} x2={width-10} y1={125-value*100} y2={125-value*100} /><text x={left-8} y={129-value*100} textAnchor="end">{Math.round(value*high)}</text></g>)}
    {data.map((row,i) => <rect key={row.time} x={left+step*i+gap} y={125-row.calls/high*100} width={Math.max(.5,step-gap*2)} height={row.calls/high*100}><title>{fmt(row.time)}: {row.calls}</title></rect>)}
    <text x={left} y={151}>{data[0]?fmt(data[0].time):'—'}</text><text x={width-10} y={151} textAnchor="end">{data.at(-1)?fmt(data.at(-1)!.time):''}</text><text x={0} y={14}>{t('usage.calls')}</text>
  </svg></div>;
}
export function UsageMonitoring({gateway}:{gateway:GatewayHealth|null}) {
  const {t,language}=useI18n();
  const [form]=Form.useForm<UsageFilters>(),[filters,setFilters]=useState<UsageFilters>({hours:24});
  const [dimension,setDimension]=useState('server'),[tab,setTab]=useState('overview');
  const [data,setData]=useState<UsageSummary|null>(null),[events,setEvents]=useState<UsageCall[]>([]);
  const [cursor,setCursor]=useState<string|null>(null),[detail,setDetail]=useState<UsageCall|null>(null);
  const [error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0),[services,setServices]=useState<string[]>([]);
  const filtersKey=JSON.stringify(filters),identity=filtersKey+dimension+tab+revision,current=useRef(identity),paged=useRef(false);current.current=identity;
  useEffect(() => {void api.servers().then(result => setServices(result.servers.map(server => server.name))).catch(() => {});},[]);
  useEffect(() => {
    let active=true,fetching=false;
    paged.current=false;
    const refresh=async () => {
      if (fetching) return;fetching=true;
      try {const summary=await api.usageSummary(filters,dimension);if (!active) return;setData(summary);setError('');if (tab==='logs'&&!paged.current) {const calls=await api.usageCalls(filters);if (active&&!paged.current) {setEvents(calls.events);setCursor(calls.next_cursor);}}}
      catch (error) {if (active) setError(error instanceof Error?error.message:String(error));}finally{fetching=false;}
    };
    void refresh();const timer=window.setInterval(() => void refresh(),10000);return () => {active=false;window.clearInterval(timer);};
  },[filtersKey,dimension,tab,revision]);
  const format=(value:number|null,unit='') => value===null?'—':new Intl.NumberFormat(language,{maximumFractionDigits:1}).format(value)+unit;
  const time=(value:number) => new Intl.DateTimeFormat(language,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(value);
  const outcomes:Record<string,string>={success:t('usage.success'),failed:t('usage.failed'),unknown:t('usage.unknown')},stats=data?.summary;
  return <section className="monitor-audit-panel usage-panel">
    <div className="monitor-section-heading"><h3>{t('usage.title')}</h3><span className="monitor-checked">{t('usage.refresh')}</span></div>
    <Form form={form} layout="inline" initialValues={{hours:24}} onFinish={values=>setFilters({...values,outcome:filters.outcome})} className="usage-filters">
      <Form.Item name="hours"><Select aria-label={t('usage.period')} options={[1,24,168,720,8760].map(hours => ({value:hours,label:t(hours===1?'usage.hour':hours===24?'usage.day':hours===168?'usage.week':hours===720?'usage.month':'usage.year')}))} /></Form.Item>
      <Form.Item name="server"><Select allowClear placeholder={t('usage.allServers')} aria-label={t('usage.allServers')} options={services.map(value => ({value,label:value}))} /></Form.Item>
      <Form.Item name="tool"><Input maxLength={128} placeholder={t('usage.tool')} aria-label={t('usage.tool')} /></Form.Item>
      <Form.Item name="user_id"><Input inputMode="numeric" maxLength={16} placeholder={t('usage.userId')} aria-label={t('usage.userId')} /></Form.Item>
      <Form.Item name="client_id"><Input maxLength={128} placeholder={t('usage.client')} aria-label={t('usage.client')} /></Form.Item>
      <Button htmlType="submit">{t('monitoring.search')}</Button><Button onClick={() => setRevision(value => value+1)}>{t('usage.reload')}</Button>
    </Form>
    {error&&<Alert type="error" showIcon message={error} />}
    {data&&!data.enabled&&<Alert type="info" message={t('usage.disabled')} />}
    {data?.collection.lastError&&<Alert type="warning" message={t('usage.collectionError')} />}
    {Boolean(gateway?.monitoring?.dropped)&&<Alert type="warning" message={t('usage.gatewayDropped',{count:gateway!.monitoring!.dropped})} />}
    {Boolean(gateway?.upstreams?.unavailable)&&<Alert type="warning" message={t('usage.upstreamUnavailable',{count:gateway!.upstreams!.unavailable})} />}
    {data&&<div className="usage-collection">{t('usage.queue')}: {data.collection.queued??'—'} · {t('usage.dropped')}: {data.collection.dropped??'—'} · {t('usage.lastCollected')}: {data.collection.lastProcessedAt?time(data.collection.lastProcessedAt):'—'}</div>}
    <Tabs activeKey={tab} onChange={setTab} items={[
      {key:'overview',label:t('usage.overview'),children:!stats?<Spin />:<>
        <div className="usage-metrics">{[[t('usage.calls'),format(stats.calls)],[t('usage.successRate'),format(stats.success_rate,'%')],[t('usage.p95'),format(stats.p95_ms,' ms')],[t('usage.users'),format(stats.active_users)]].map(([label,value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
        <div className="usage-collection">{t('usage.requests')}: {format(stats.requests)} · {t('usage.peak')}: {format(stats.peak_per_minute)} · {t('usage.unknown')}: {format(stats.unknown)} · {t('usage.average')}: {format(stats.avg_ms,' ms')}</div>
        <h4>{t('usage.trend')}</h4><Trend data={data!.trend} bucket={data!.bucket_ms} />
        <div className="usage-rank-heading"><h4>{t('usage.ranking')}</h4><Select aria-label={t('usage.dimension')} value={dimension} onChange={setDimension} options={['server','tool','user','client'].map(value => ({value,label:t(value==='server'?'usage.server':value==='tool'?'usage.tool':value==='user'?'usage.user':'usage.client')}))} /></div>
        <Table size="small" rowKey="name" pagination={false} dataSource={data!.ranking} scroll={{x:550}} columns={[
          {title:t('usage.name'),dataIndex:'name'},{title:t('usage.calls'),dataIndex:'calls',align:'right'},{title:t('usage.failed'),dataIndex:'failed',align:'right'},
          {title:t('usage.unknown'),dataIndex:'unknown',align:'right'},{title:t('usage.p95'),dataIndex:'p95_ms',align:'right',render:value => format(value,' ms')},
        ]} /><p className="usage-note">{t('usage.semantics')}</p>
      </>},
      {key:'logs',label:t('usage.logs'),children:<>
        <Select className="usage-log-toolbar" aria-label={t('usage.result')} value={filters.outcome??''} onChange={outcome => setFilters({...filters,outcome})} options={[{value:'',label:t('usage.allResults')},...Object.entries(outcomes).map(([value,label]) => ({value,label}))]} />
        <Table size="small" rowKey="id" pagination={false} dataSource={events} scroll={{x:850}} columns={[
          {title:t('monitoring.time'),dataIndex:'started_at',render:time},{title:t('usage.user'),dataIndex:'username',render:(value,row) => value||String(row.user_id||'—')},
          {title:t('usage.server'),dataIndex:'server'},{title:t('usage.tool'),render:(_,row) => row.tool||row.method},
          {title:t('usage.result'),dataIndex:'outcome',render:value => <Tag color={value==='success'?'success':value==='failed'?'error':'warning'}>{outcomes[value]??value}</Tag>},
          {title:t('usage.duration'),dataIndex:'duration_ms',render:value => format(value,' ms')},
          {title:t('monitoring.requestId'),dataIndex:'request_id',render:(value,row) => <Button type="link" onClick={() => setDetail(row)}>{value.slice(0,8)}</Button>},
        ]} />
        {cursor&&<Button loading={loading} onClick={async () => {const snapshot=current.current;paged.current=true;setLoading(true);try {const page=await api.usageCalls(filters,cursor);if(current.current===snapshot){setEvents(rows => [...rows,...page.events.filter(event => !rows.some(row => row.id===event.id))]);setCursor(page.next_cursor);}}catch(error){if(current.current===snapshot)setError(error instanceof Error?error.message:String(error));}finally{setLoading(false);}}}>{t('monitoring.loadOlderEvents')}</Button>}
        {paged.current&&<p className="usage-note">{t('usage.historyPaused')}</p>}
        <p className="usage-note">{t('usage.privacy')}</p>
      </>},
      {key:'alerts',label:t('usage.alerts'),children:<>
        <p className="usage-note">{t('usage.alertRules')}</p>
        {!data?<Spin />:data.alerts.length?data.alerts.map(alert => <Alert key={alert.server+alert.type} type="warning" showIcon message={`${alert.server} · ${t(alert.type==='error_rate'?'usage.errorRateAlert':'usage.slowAlert')} · ${format(alert.value,alert.type==='error_rate'?'%':' ms')} > ${alert.threshold}${alert.type==='error_rate'?'%':' ms'}`} />):<Alert type="success" message={t('usage.noAlerts')} />}
      </>},
    ]} />
    <Drawer open={detail!==null} onClose={() => setDetail(null)} title={t('usage.detail')} width={500}>
      {detail&&<Descriptions bordered column={1} size="small" items={[
        {key:'id',label:t('monitoring.requestId'),children:detail.request_id},{key:'user',label:t('usage.user'),children:detail.username+' (#'+detail.user_id+')'},
        {key:'client',label:t('usage.client'),children:detail.client_id||'—'},{key:'method',label:t('usage.method'),children:detail.method},
        {key:'tool',label:t('usage.tool'),children:detail.tool||'—'},{key:'http',label:'HTTP',children:detail.http_status||'—'},
        {key:'error',label:t('usage.error'),children:detail.error||'—'},{key:'instance',label:t('usage.instance'),children:detail.instance||'—'},
        {key:'attempts',label:t('usage.attempts'),children:detail.attempts},
      ]} />}
    </Drawer>
  </section>;
}
