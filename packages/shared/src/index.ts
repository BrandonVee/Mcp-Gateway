import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A backend MCP server: one logical name mapped to N instance URLs. */
export interface McpServerConfig {
  name: string;
  instances: string[];
  authMode: 'none' | 'api_key' | 'oauth';
}

export interface PlatformConfig {
  auth: {
    port: number;
    issuer: string;
    accessTokenTtlSeconds: number;
    defaultAudience: string;
    postgres: { url: string; poolMax: number };
    internalApiToken: string;
    bootstrap: {
      adminUsername: string;
      adminPassword?: string;
    };
  };
  gateway: {
    port: number;
    resourceBaseUrl: string;
    redisUrl: string;
    authJwksUrl: string;
    jwtAudience: string;
    sessionTtlSeconds: number;
    registryUrl: string;
    registryRefreshSeconds: number;
  };
}

const DEFAULT_CONFIG_FILE = fileURLToPath(new URL('../../../config/default.json', import.meta.url));
let cached: { path: string; value: PlatformConfig } | undefined;

/** Load the platform JSON configuration. CONFIG_FILE selects another environment file. */
export function loadPlatformConfig(): PlatformConfig {
  const path = process.env.CONFIG_FILE ?? DEFAULT_CONFIG_FILE;
  if (cached?.path === path) return cached.value;
  const value = JSON.parse(readFileSync(path, 'utf8')) as PlatformConfig;
  validatePlatformConfig(value, path);
  cached = { path, value };
  return value;
}

function validatePlatformConfig(config: PlatformConfig, path: string): void {
  const fail = (message: string): never => {
    throw new Error(`Invalid platform config ${path}: ${message}`);
  };
  if (!config.auth || !Number.isInteger(config.auth.port)) fail('auth.port must be an integer');
  if (!config.auth.postgres?.url || !Number.isInteger(config.auth.postgres.poolMax)) fail('auth.postgres is required');
  if (!config.auth.internalApiToken) fail('auth.internalApiToken is required');
  if (!config.gateway || !Number.isInteger(config.gateway.port) || !config.gateway.redisUrl) fail('gateway settings are required');
  if (!config.gateway.registryUrl || !Number.isInteger(config.gateway.registryRefreshSeconds)) fail('gateway registry settings are required');
}
