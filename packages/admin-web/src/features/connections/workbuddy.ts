import type { ConnectionServer } from "../../types";

/** WorkBuddy's direct MCP import format; authentication is completed by its OAuth client. */
export function workBuddyConfig(servers: ConnectionServer[], resource: string): string {
  const base = new URL(resource);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
    throw new Error("Invalid Gateway resource URL");
  }
  const mcpServers = Object.fromEntries(servers.map((server) => [server.name, {
    type: "http",
    url: new URL(`/mcp/${encodeURIComponent(server.name)}`, base).toString(),
  }]));
  return JSON.stringify({ mcpServers }, null, 2);
}
