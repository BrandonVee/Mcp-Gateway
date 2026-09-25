import { loadPlatformConfig, type McpServerConfig } from '@mcp/shared';

const config = loadPlatformConfig();

export const env = {
  port: config.gateway.port,
  redisUrl: process.env.REDIS_URL ?? config.gateway.redisUrl,
  authIssuer: config.auth.issuer,
  authJwksUrl: config.gateway.authJwksUrl,
  jwtAudience: config.gateway.jwtAudience,
  // External base URL of this gateway (used in RFC 9728 metadata).
  resourceBaseUrl: config.gateway.resourceBaseUrl,
  sessionTtlSeconds: config.gateway.sessionTtlSeconds,
  registryUrl: config.gateway.registryUrl,
  credentialUrl: new URL('/internal/connector-credential', config.gateway.registryUrl).toString(),
  accessCheckUrl: new URL('/internal/mcp-access', config.gateway.registryUrl).toString(),
  credentialBrokerToken: process.env.CREDENTIAL_BROKER_TOKEN,
  connectionsWebUrl: process.env.CONNECTIONS_WEB_URL ?? 'http://localhost:5173/connections',
  registryRefreshSeconds: config.gateway.registryRefreshSeconds,
  internalApiToken: process.env.INTERNAL_API_TOKEN ?? config.auth.internalApiToken,
};

// The database-backed registry is the only source of routing data.
export const serverConfigs: Map<string, McpServerConfig> = new Map();

export function getServerConfig(name: string): McpServerConfig | undefined {
  return serverConfigs.get(name);
}

export interface RegistryStatus {
  lastSuccessAt?: number;
  lastError?: string;
}

export const registryStatus: RegistryStatus = {};

/** Refresh the logical-server routing table from the auth control plane. */
export async function refreshServerConfigs(): Promise<void> {
  try {
    const response = await fetch(env.registryUrl, {
      headers: { authorization: `Bearer ${env.internalApiToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`);
    const body = (await response.json()) as {
      servers?: Array<{ name: string; authMode?: 'none' | 'api_key' | 'oauth'; instances: Array<{ id: string; url: string }> }>;
    };
    if (!Array.isArray(body.servers)) throw new Error('registry response has no servers array');
    const next = new Map<string, McpServerConfig>();
    for (const server of body.servers) {
      if (!server.name || !Array.isArray(server.instances) || !server.instances.length) continue;
      const instances = server.instances.map((instance) => {
        const url = new URL(instance.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`unsupported URL for ${server.name}`);
        return url.toString().replace(/\/$/, '');
      });
      if (server.authMode && !['none', 'api_key', 'oauth'].includes(server.authMode)) throw new Error(`invalid auth mode for ${server.name}`);
      next.set(server.name, { name: server.name, authMode: server.authMode ?? 'none', instances });
    }
    serverConfigs.clear();
    for (const [name, server] of next) serverConfigs.set(name, server);
    registryStatus.lastSuccessAt = Date.now();
    registryStatus.lastError = undefined;
  } catch (error) {
    registryStatus.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export function startRegistryRefresh(logError: (error: unknown) => void): void {
  setInterval(
    () => void refreshServerConfigs().catch(logError),
    Math.max(1, env.registryRefreshSeconds) * 1000,
  ).unref();
}
