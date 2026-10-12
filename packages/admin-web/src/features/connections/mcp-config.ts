import type { ConnectionServer } from '../../types';

/** Server entries to paste into mcpServers; OAuth is completed by the client. */
export function mcpServerUrl(name: string, resource: string): string {
  if (!name || name === '.' || name === '..') throw new Error('Invalid MCP server name');
  const base = new URL(resource);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('Invalid Gateway resource URL');
  }
  return new URL(`/mcp/${encodeURIComponent(name)}`, base).toString();
}

export function mcpConfig(servers: ConnectionServer[], resource: string): string {
  const mcpServers = Object.fromEntries(
    servers.map((server) => [
      server.endpoint_name ?? server.name,
      {
        type: 'streamableHttp',
        url: mcpServerUrl(server.endpoint_name ?? server.name, resource),
      },
    ]),
  );
  return JSON.stringify(mcpServers, null, 2);
}
