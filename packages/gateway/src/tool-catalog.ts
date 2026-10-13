import type { McpServerConfig } from '@mcp/shared';

type Upstream = NonNullable<McpServerConfig['upstreams']>[number];
export type ToolRoute = { upstreamId: string; name: string };
export type ToolCatalogState = {
  toolRoutes?: Record<string, ToolRoute>;
  members: Record<string, { toolNames?: string[] }>;
};

/** A readable prefix for collisions only. Never expose internal IDs in tool names. */
function serverLabel(upstream: Upstream): string {
  const slug = (value: string) =>
    value
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9_.-]+/g, '_')
      .replace(/^_+|_+$/g, '');
  const configured = slug(upstream.displayName ?? '');
  if (configured) return configured.slice(0, 48);
  const url = new URL(upstream.url);
  const path = url.pathname
    .split('/')
    .filter((part) => part && part !== 'mcp')
    .at(-1);
  return (slug(path ?? url.hostname) || 'server').slice(0, 48);
}

/** Reserve names for this user's session: an unavailable upstream must never redirect old calls. */
export function mergeToolCatalog(
  upstreams: Upstream[],
  state: ToolCatalogState,
  catalogs: Array<{ upstream: Upstream; tools: Array<Record<string, any>> }>,
): Array<Record<string, any>> {
  const routes: Record<string, ToolRoute> = Object.assign(Object.create(null), state.toolRoutes);
  state.toolRoutes = routes;
  const previousNames = new Map<string, string[]>();
  for (const [exposed, route] of Object.entries(routes)) {
    const identity = JSON.stringify([route.upstreamId, route.name]);
    const names = previousNames.get(identity) ?? [];
    names.push(exposed);
    previousNames.set(identity, names);
  }
  const counts = new Map<string, number>();
  for (const upstream of upstreams) {
    for (const name of new Set(state.members[upstream.id]?.toolNames ?? [])) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  // Prefixes are independent of credential availability and registry ordering.
  const labels = new Map<string, string>();
  const usedLabels = new Set<string>();
  for (const upstream of [...upstreams].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const base = serverLabel(upstream);
    let label = base,
      suffix = 2;
    while (usedLabels.has(label)) label = `${base}_${suffix++}`;
    usedLabels.add(label);
    labels.set(upstream.id, label);
  }
  return catalogs.flatMap(({ upstream, tools }) =>
    tools.map((tool) => {
      const name = tool.name as string;
      const duplicate = (counts.get(name) ?? 0) > 1;
      const matches = (route: ToolRoute | undefined) => route?.upstreamId === upstream.id && route.name === name;
      const previous = previousNames
        .get(JSON.stringify([upstream.id, name]))
        ?.find((key) => !duplicate || key !== name);
      let exposed = previous;
      if (!exposed) {
        const base =
          !duplicate && (!routes[name] || matches(routes[name]))
            ? name
            : `${labels.get(upstream.id)}__${name}`.slice(0, 128);
        exposed = base;
        let suffix = 2;
        // Also reserve upstream originals so a generated alias cannot hide a real tool.
        while ((routes[exposed] && !matches(routes[exposed])) || (exposed !== name && counts.has(exposed))) {
          const ending = `_${suffix++}`;
          exposed = base.slice(0, 128 - ending.length) + ending;
        }
        routes[exposed] = { upstreamId: upstream.id, name };
      }
      return { ...tool, name: exposed };
    }),
  );
}
