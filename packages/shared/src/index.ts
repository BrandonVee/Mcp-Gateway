/** A backend MCP server: one logical name mapped to N instance URLs. */
export interface McpServerConfig {
  name: string;
  instances: string[];
}

/**
 * Parse GATEWAY_SERVERS env:
 *   "demo|http://mcp-a:3001,http://mcp-b:3002;other|http://other:3003"
 * -> entries separated by ';', each entry is "name|url1,url2,..."
 */
export function parseServersConfig(raw: string): Map<string, McpServerConfig> {
  const map = new Map<string, McpServerConfig>();
  for (const entry of raw.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf('|');
    if (sep <= 0) {
      throw new Error(`GATEWAY_SERVERS: invalid entry "${trimmed}" (expected "name|url1,url2")`);
    }
    const name = trimmed.slice(0, sep).trim();
    const instances = trimmed
      .slice(sep + 1)
      .split(',')
      .map((u) => u.trim().replace(/\/+$/, ''))
      .filter(Boolean);
    if (!name || instances.length === 0) {
      throw new Error(`GATEWAY_SERVERS: invalid entry "${trimmed}"`);
    }
    for (const url of instances) new URL(url); // throws on invalid
    map.set(name, { name, instances });
  }
  return map;
}
