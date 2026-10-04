import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { GraphChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import type { TopologySnapshot, TopologyHealthState } from '../../types';
import { useColorMode } from '../../color-mode';
import { useI18n, type MessageKey } from '../../i18n';

echarts.use([GraphChart, TooltipComponent, CanvasRenderer]);

export type TopologyDimension = 'user' | 'client';

export interface TopologySelection {
  kind: 'participant' | 'server' | 'instance';
  /** participant: display name; server: server name; instance: instance hash. */
  id: string;
  /** Instance selections carry the owning server name. */
  server?: string;
}

const HEALTH_COLORS: Record<TopologyHealthState, string> = {
  up: '#3fb27f',
  degraded: '#f0a020',
  down: '#e5484d',
  unknown: '#8a94a6',
};
const STATE_LABELS: Record<TopologyHealthState, MessageKey> = {
  up: 'topology.stateUp',
  degraded: 'topology.stateDegraded',
  down: 'topology.stateDown',
  unknown: 'topology.stateUnknown',
};
const PARTICIPANT_COLOR = '#5b8ff9';
const SERVER_COLOR = '#9254de';
const DISABLED_COLOR = '#8a94a6';
const SESSION_COLOR = '#3fb27f';
const MAX_PARTICIPANT_NODES = 60;
const TOP_PARTICIPANTS = 20;

const truncate = (name: string, length = 14) => (name.length > length ? `${name.slice(0, length - 1)}…` : name);

interface EdgeBucket {
  calls: number;
  failed: number;
  sessions: number;
}

interface GraphMeta {
  selection: TopologySelection;
  hint: string;
}

interface GraphNode {
  id: string;
  name: string;
  x: number;
  y: number;
  symbolSize: number;
  itemStyle: { color: string; borderColor?: string; borderWidth?: number; borderType?: string };
  label: { position: 'left' | 'right' | 'top' };
  meta: GraphMeta;
}

interface GraphLink {
  source: string;
  target: string;
  lineStyle: { width: number; color: string; type?: string; curveness: number; opacity: number };
  meta: { hint: string };
}

/**
 * Fixed three-column layout (participant -> server -> instance). Deterministic
 * placement beats force-directed layout for an operations view: nodes stay put
 * between polls, so the eye can track change instead of re-learning the map.
 */
function buildGraph(
  snapshot: TopologySnapshot,
  dimension: TopologyDimension,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): { nodes: GraphNode[]; links: GraphLink[] } {
  const participantVolume = new Map<string, number>();
  const leftEdges = new Map<string, EdgeBucket & { left: string; server: string }>();
  const rightEdges = new Map<string, EdgeBucket & { server: string; instance: string }>();

  const bump = (map: Map<string, number>, key: string, by: number) => map.set(key, (map.get(key) ?? 0) + by);

  for (const flow of snapshot.flows) {
    const left = dimension === 'user' ? flow.username : flow.client_id;
    if (left) {
      bump(participantVolume, left, flow.calls);
      const key = `${left}\x1f${flow.server}`;
      const edge = leftEdges.get(key) ?? { left, server: flow.server, calls: 0, failed: 0, sessions: 0 };
      edge.calls += flow.calls;
      edge.failed += flow.failed;
      leftEdges.set(key, edge);
    }
    const key = `${flow.server}\x1f${flow.instance}`;
    const edge = rightEdges.get(key) ?? { server: flow.server, instance: flow.instance, calls: 0, failed: 0, sessions: 0 };
    edge.calls += flow.calls;
    edge.failed += flow.failed;
    rightEdges.set(key, edge);
  }
  // Session owners are users; the client dimension cannot attribute them.
  if (dimension === 'user') {
    for (const session of snapshot.sessions) {
      bump(participantVolume, session.owner, session.count);
      const lkey = `${session.owner}\x1f${session.server}`;
      const left = leftEdges.get(lkey) ?? { left: session.owner, server: session.server, calls: 0, failed: 0, sessions: 0 };
      left.sessions += session.count;
      leftEdges.set(lkey, left);
      const rkey = `${session.server}\x1f${session.instance}`;
      const right = rightEdges.get(rkey) ?? {
        server: session.server,
        instance: session.instance,
        calls: 0,
        failed: 0,
        sessions: 0,
      };
      right.sessions += session.count;
      rightEdges.set(rkey, right);
    }
  }

  // Crowd control: fold the long tail of participants into one aggregate node.
  const ranked = [...participantVolume.entries()].sort((a, b) => b[1] - a[1]);
  const overflow = ranked.length > MAX_PARTICIPANT_NODES ? ranked.slice(TOP_PARTICIPANTS) : [];
  const kept = new Set((overflow.length ? ranked.slice(0, TOP_PARTICIPANTS) : ranked).map(([name]) => name));
  const otherLabel = t('topology.other', { count: overflow.length });
  if (overflow.length) {
    participantVolume.set(otherLabel, overflow.reduce((sum, [, volume]) => sum + volume, 0));
    for (const edge of leftEdges.values()) {
      if (kept.has(edge.left) || edge.left === otherLabel) continue;
      const key = `${otherLabel}\x1f${edge.server}`;
      const folded = leftEdges.get(key) ?? { left: otherLabel, server: edge.server, calls: 0, failed: 0, sessions: 0 };
      folded.calls += edge.calls;
      folded.failed += edge.failed;
      folded.sessions += edge.sessions;
      leftEdges.set(key, folded);
      edge.calls = 0;
      edge.failed = 0;
      edge.sessions = 0;
    }
  }

  const serverVolume = new Map<string, number>();
  const instanceVolume = new Map<string, number>();
  for (const edge of rightEdges.values()) {
    bump(serverVolume, edge.server, edge.calls + edge.sessions);
    bump(instanceVolume, `${edge.server}\x1f${edge.instance}`, edge.calls + edge.sessions);
  }

  const maxEdgeCalls = Math.max(1, ...[...leftEdges.values(), ...rightEdges.values()].map((edge) => edge.calls));
  const maxVolume = Math.max(
    1,
    ...participantVolume.values(),
    ...serverVolume.values(),
    ...instanceVolume.values(),
  );
  const scale = (volume: number) => Math.sqrt(volume / maxVolume);

  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const HEIGHT = 600;
  const COLUMN_X = { participant: 0, server: 420, instance: 840 };
  const placeColumn = (count: number, index: number) => (index + 0.5) * (HEIGHT / Math.max(1, count));

  const flowColor = (edge: EdgeBucket) => {
    if (!edge.calls) return PARTICIPANT_COLOR;
    const rate = edge.failed / edge.calls;
    return rate > 0.2 ? '#e5484d' : edge.failed > 0 ? '#f0a020' : '#4d7fd6';
  };
  const appendEdgePair = (
    source: string,
    target: string,
    edge: EdgeBucket,
    sourceName: string,
    targetName: string,
  ) => {
    if (edge.calls > 0)
      links.push({
        source,
        target,
        lineStyle: {
          width: 1 + 4 * Math.sqrt(edge.calls / maxEdgeCalls),
          color: flowColor(edge),
          type: 'dashed',
          curveness: 0.18,
          opacity: 0.75,
        },
        meta: {
          hint: `${sourceName} → ${targetName}<br/>${t('topology.detail.calls')}: ${edge.calls} · ${t('topology.detail.failed')}: ${edge.failed}`,
        },
      });
    if (edge.sessions > 0)
      links.push({
        source,
        target,
        lineStyle: {
          width: 1 + Math.min(3, edge.sessions),
          color: SESSION_COLOR,
          curveness: -0.18,
          opacity: 0.85,
        },
        meta: {
          hint: `${sourceName} → ${targetName}<br/>${t('topology.detail.sessions')}: ${edge.sessions}`,
        },
      });
  };

  const participants = [...participantVolume.entries()]
    .filter(([name]) => kept.size === 0 || kept.has(name) || name === otherLabel)
    .sort((a, b) => b[1] - a[1]);
  participants.forEach(([name, volume], index) => {
    nodes.push({
      id: `p:${name}`,
      name: truncate(name, 18),
      x: COLUMN_X.participant,
      y: placeColumn(participants.length, index),
      symbolSize: 12 + 16 * scale(volume),
      itemStyle: { color: PARTICIPANT_COLOR },
      label: { position: 'left' },
      meta: {
        selection: { kind: 'participant', id: name },
        hint: `${name}<br/>${t('topology.detail.calls')}: ${volume}`,
      },
    });
  });

  const servers = [...snapshot.servers].sort(
    (a, b) => (serverVolume.get(b.name) ?? 0) - (serverVolume.get(a.name) ?? 0),
  );
  servers.forEach((server, index) => {
    const volume = serverVolume.get(server.name) ?? 0;
    nodes.push({
      id: `s:${server.name}`,
      name: truncate(server.display_name || server.name),
      x: COLUMN_X.server,
      y: placeColumn(servers.length, index),
      symbolSize: 22 + 14 * scale(volume),
      itemStyle: { color: server.enabled ? SERVER_COLOR : DISABLED_COLOR },
      label: { position: 'top' },
      meta: {
        selection: { kind: 'server', id: server.name },
        hint: `${server.display_name || server.name}<br/>${t('topology.detail.calls')}: ${volume}`,
      },
    });
  });

  interface InstanceEntry {
    server: string;
    id: string;
    label: string;
    state: TopologyHealthState;
    enabled: boolean;
  }
  const instances: InstanceEntry[] = [];
  const registered = new Set<string>();
  for (const server of snapshot.servers)
    for (const instance of server.instances) {
      registered.add(`${server.name}\x1f${instance.id}`);
      instances.push({
        server: server.name,
        id: instance.id,
        label: instance.url.replace(/^https?:\/\//, ''),
        state: instance.health.state,
        enabled: instance.enabled,
      });
    }
  // Traffic to an instance that left the registry still gets a ghost node.
  for (const edge of rightEdges.values())
    if (!registered.has(`${edge.server}\x1f${edge.instance}`))
      instances.push({ server: edge.server, id: edge.instance, label: edge.instance, state: 'unknown', enabled: true });

  instances.sort(
    (a, b) => (instanceVolume.get(`${b.server}\x1f${b.id}`) ?? 0) - (instanceVolume.get(`${a.server}\x1f${a.id}`) ?? 0),
  );
  instances.forEach((instance, index) => {
    nodes.push({
      id: `i:${instance.server}:${instance.id}`,
      name: truncate(instance.label, 22),
      x: COLUMN_X.instance,
      y: placeColumn(instances.length, index),
      symbolSize: 14 + 10 * scale(instanceVolume.get(`${instance.server}\x1f${instance.id}`) ?? 0),
      itemStyle: instance.enabled
        ? { color: HEALTH_COLORS[instance.state] }
        : { color: DISABLED_COLOR, borderColor: '#5a6678', borderWidth: 1, borderType: 'dashed' },
      label: { position: 'right' },
      meta: {
        selection: { kind: 'instance', id: instance.id, server: instance.server },
        hint: `${instance.label}<br/>${t(STATE_LABELS[instance.state])}`,
      },
    });
  });

  for (const edge of leftEdges.values()) {
    if (!edge.calls && !edge.sessions) continue;
    const left = kept.has(edge.left) || edge.left === otherLabel ? edge.left : otherLabel;
    appendEdgePair(`p:${left}`, `s:${edge.server}`, edge, truncate(left, 18), edge.server);
  }
  for (const edge of rightEdges.values())
    appendEdgePair(
      `s:${edge.server}`,
      `i:${edge.server}:${edge.instance}`,
      edge,
      edge.server,
      truncate(edge.instance, 22),
    );

  return { nodes, links };
}

export function TopologyGraph({
  snapshot,
  dimension,
  onSelect,
}: {
  snapshot: TopologySnapshot;
  dimension: TopologyDimension;
  onSelect: (selection: TopologySelection) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const { mode } = useColorMode();
  const { t } = useI18n();

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const instance = echarts.init(element);
    chart.current = instance;
    instance.on('click', (params) => {
      const data = (params as { dataType?: string; data?: { meta?: GraphMeta } }).data;
      if ((params as { dataType?: string }).dataType === 'node' && data?.meta)
        selectRef.current(data.meta.selection);
    });
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(element);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const { nodes, links } = buildGraph(snapshot, dimension, t);
    const dark = mode === 'dark';
    const option: EChartsCoreOption = {
      tooltip: {
        trigger: 'item',
        backgroundColor: dark ? '#14202f' : '#ffffff',
        borderColor: dark ? '#2c3e57' : '#d9e2ec',
        textStyle: { color: dark ? '#dbe4f0' : '#33415c', fontSize: 12 },
        formatter: (params: unknown) => {
          const data = (params as { data?: { meta?: GraphMeta; name?: string } }).data;
          return data?.meta?.hint ?? data?.name ?? '';
        },
      },
      series: [
        {
          type: 'graph',
          layout: 'none',
          roam: true,
          data: nodes,
          links,
          left: 110,
          right: 130,
          top: 40,
          bottom: 30,
          label: { show: true, fontSize: 11, color: dark ? '#b8c7dd' : '#4a5a70' },
          emphasis: { focus: 'adjacency', lineStyle: { opacity: 1 } },
          select: { disabled: true },
        },
      ],
    };
    chart.current?.setOption(option, { notMerge: true });
  }, [snapshot, dimension, mode, t]);

  return <div ref={ref} className="topology-canvas" />;
}
