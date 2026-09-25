import { Alert, Badge, Button, Empty, Input, Select, Spin, Tag } from "antd";
import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import { api } from "../../api";
import type { AuditEvent, AuthHealth, GatewayHealth } from "../../types";

const PAGE_SIZE = 50;
const timestamp = (value: number) => new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
}).format(new Date(value));

function StatusCell({ label, good, detail }: { label: string; good: boolean; detail: string }) {
  return (
    <div className={`monitor-status-cell ${good ? "is-good" : "is-bad"}`}>
      <div className="monitor-status-top"><span>{label}</span><Badge status={good ? "success" : "error"} /></div>
      <strong>{good ? "运行正常" : "需要检查"}</strong>
      <small>{detail}</small>
    </div>
  );
}

export function MonitoringPage() {
  const [auth, setAuth] = useState<AuthHealth | null>(null);
  const [gateway, setGateway] = useState<GatewayHealth | null>(null);
  const [draftActor, setDraftActor] = useState("");
  const [actor, setActor] = useState("");
  const [method, setMethod] = useState("");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [healthCheckedAt, setHealthCheckedAt] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      const [authResult, gatewayResult] = await Promise.allSettled([api.authHealth(), api.gatewayHealth()]);
      if (!active) return;
      setAuth(authResult.status === "fulfilled" ? authResult.value : null);
      setGateway(gatewayResult.status === "fulfilled" ? gatewayResult.value : null);
      setHealthCheckedAt(Date.now());
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api.auditEvents({ limit: PAGE_SIZE, actor: actor || undefined, method: method || undefined })
      .then((page) => {
        if (!active) return;
        setEvents(page.events);
        setNextBefore(page.next_before);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "审计日志读取失败");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actor, method, revision]);

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.auditEvents({ limit: PAGE_SIZE, before: nextBefore, actor: actor || undefined, method: method || undefined });
      setEvents((current) => [...current, ...page.events]);
      setNextBefore(page.next_before);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载更多日志失败");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="page-stack page-enter monitor-page">
      <section className="monitor-overview">
        <div className="monitor-section-heading">
          <div><span className="section-eyebrow">LIVE SERVICE PULSE</span><h3>服务脉搏</h3></div>
          <span className="monitor-checked">每 10 秒检测 · {healthCheckedAt ? timestamp(healthCheckedAt) : "检测中"}</span>
        </div>
        <div className="monitor-status-grid">
          <StatusCell label="AUTH API" good={Boolean(auth?.ok)} detail="认证服务" />
          <StatusCell label="POSTGRES" good={Boolean(auth?.postgres)} detail="主数据存储" />
          <StatusCell label="GATEWAY" good={Boolean(gateway?.ok)} detail="MCP 统一入口" />
          <StatusCell label="REDIS" good={Boolean(gateway?.redis)} detail="会话粘性路由" />
          <StatusCell label="REGISTRY" good={Boolean(gateway?.registry?.lastSuccessAt && !gateway?.registry?.lastError)} detail={gateway?.registry?.lastError ?? "数据库路由同步"} />
        </div>
      </section>

      <section className="monitor-audit-panel">
        <div className="monitor-section-heading">
          <div><span className="section-eyebrow">ADMINISTRATIVE AUDIT TRAIL</span><h3>操作审计</h3></div>
          <Tag color="cyan" bordered={false}>仅记录元数据 · 默认保留 90 天</Tag>
        </div>
        <div className="monitor-toolbar">
          <Input
            className="monitor-actor-input"
            prefix={<SearchOutlined />}
            value={draftActor}
            maxLength={64}
            placeholder="筛选操作人"
            onChange={(event) => setDraftActor(event.target.value)}
            onPressEnter={() => setActor(draftActor.trim())}
            allowClear
          />
          <Button onClick={() => setActor(draftActor.trim())}>查询</Button>
          <Select
            value={method}
            onChange={setMethod}
            options={[
              { value: "", label: "全部操作" },
              { value: "POST", label: "新增 / 登录" },
              { value: "PUT", label: "替换" },
              { value: "PATCH", label: "修改" },
              { value: "DELETE", label: "删除 / 退出" },
            ]}
            className="monitor-method-select"
          />
          <Button icon={<ReloadOutlined />} onClick={() => setRevision((value) => value + 1)} loading={loading}>刷新日志</Button>
        </div>

        {error && <Alert type="error" showIcon message={error} className="monitor-error" />}
        <div className="monitor-log-head"><span>时间</span><span>操作人</span><span>请求</span><span>结果</span><span>请求 ID</span></div>
        <div className="monitor-log-body">
          {loading ? <div className="monitor-empty"><Spin /></div> : events.length ? events.map((event) => (
            <div className="monitor-log-row" key={event.id}>
              <time>{timestamp(event.created_at)}</time>
              <strong>{event.actor}</strong>
              <div className="monitor-operation"><Tag color={event.method === "DELETE" ? "red" : event.method === "POST" ? "blue" : "gold"} bordered={false}>{event.method}</Tag><code title={event.path}>{event.path}</code></div>
              <Tag color={event.status_code < 400 ? "success" : "error"} bordered={false}>{event.status_code}</Tag>
              <code className="monitor-request-id" title={event.request_id}>{event.request_id.slice(0, 8)}</code>
            </div>
          )) : <div className="monitor-empty"><Empty description="暂无符合条件的审计事件" /></div>}
        </div>
        {nextBefore !== null && <div className="monitor-footer"><Button onClick={() => void loadMore()} loading={loadingMore}>加载更早记录</Button></div>}
      </section>
    </div>
  );
}
