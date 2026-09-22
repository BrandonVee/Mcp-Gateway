import { parseServersConfig, type McpServerConfig } from '@mcp/shared';

export const env = {
  port: Number(process.env.PORT ?? 8000),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  authIssuer: process.env.AUTH_ISSUER ?? 'http://localhost:9001',
  authJwksUrl: process.env.AUTH_JWKS_URL ?? 'http://localhost:9001/jwks.json',
  jwtAudience: process.env.JWT_AUDIENCE ?? 'mcp-gateway',
  // External base URL of this gateway (used in RFC 9728 metadata).
  resourceBaseUrl: process.env.RESOURCE_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8000}`,
  serversRaw: process.env.GATEWAY_SERVERS ?? 'demo|http://localhost:3001,http://localhost:3002',
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS ?? 3600),
};

export const serverConfigs: Map<string, McpServerConfig> = parseServersConfig(env.serversRaw);

export function getServerConfig(name: string): McpServerConfig | undefined {
  return serverConfigs.get(name);
}

