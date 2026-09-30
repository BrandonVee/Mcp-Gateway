import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A backend MCP server: one logical name mapped to N instance URLs. */
export interface McpServerConfig {
  name: string;
  instances: string[];
  authMode: 'none' | 'api_key' | 'oauth';
}

/** Explicit host allowlist shared by the control plane and every Gateway replica. */
export function allowedUpstreamHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.MCP_UPSTREAM_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean));
}

export function normalizeUpstreamEndpoint(value: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) return null;
    const allowed = allowedUpstreamHosts(env);
    if (allowed.size > 0 && !allowed.has(url.hostname.toLowerCase())) return null;
    if (env.NODE_ENV === 'production' && allowed.size === 0) return null;
    if (url.pathname === '/' || !url.pathname) url.pathname = '/mcp';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
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
  const validPort = (value: number) => Number.isInteger(value) && value >= 1 && value <= 65535;
  if (!config.auth || !validPort(config.auth.port)) fail('auth.port must be a valid TCP port');
  if (!config.auth.postgres?.url || !Number.isInteger(config.auth.postgres.poolMax) || config.auth.postgres.poolMax < 1) fail('auth.postgres is required');
  if (!config.auth.internalApiToken) fail('auth.internalApiToken is required');
  if (!config.gateway || !validPort(config.gateway.port) || !config.gateway.redisUrl) fail('gateway settings are required');
  if (!config.gateway.registryUrl || !Number.isInteger(config.gateway.registryRefreshSeconds) || config.gateway.registryRefreshSeconds < 1) fail('gateway registry settings are required');
}

/** Fail closed before opening a listener when production still carries local-development defaults. */
export function validateProductionRuntime(
  config: PlatformConfig,
  service: 'auth' | 'gateway',
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== 'production') return;
  const developmentBrokerToken = 'ef23e6d931a69ad96a57d9ba38a39c810d6adb8a61f4e38990a9b14e0bc6a36d';
  const developmentEncryptionKey = '9f52ebfcbdfb3f52cfcf214b6196952c486efe7ec2c1d7f7a2144d72428c01fc';
  const fail = (message: string): never => { throw new Error(`Production configuration: ${message}`); };
  const requireSecret = (name: string): string => {
    const value = env[name];
    if (!value || value.length < 32 || value === 'local-registry-token' || value === developmentBrokerToken) {
      fail(`${name} must be an independent secret of at least 32 characters, not a development default`);
    }
    return value as string;
  };
  const requireHttps = (name: string, value: string | undefined): void => {
    try {
      const url = new URL(value ?? '');
      if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) return;
    } catch { /* Invalid URL is reported below. */ }
    fail(`${name} must be a public HTTPS URL without embedded credentials`);
  };

  if (!env.CONFIG_FILE) fail('CONFIG_FILE must select a deployment-specific configuration file');
  const upstreamHosts = allowedUpstreamHosts(env);
  if ((!databaseSettingsEnabled(env) && upstreamHosts.size === 0) || [...upstreamHosts].some((host) => !/^[a-z0-9][a-z0-9.-]*$/.test(host) || host.includes('..'))) {
    fail('MCP_UPSTREAM_ALLOWED_HOSTS must list trusted upstream hostnames');
  }
  if (!databaseSettingsEnabled(env)) {
    requireHttps('auth.issuer', config.auth.issuer);
    requireHttps('gateway.resourceBaseUrl', config.gateway.resourceBaseUrl);
    if (new URL(config.auth.issuer).origin !== config.auth.issuer.replace(/\/$/, '')) fail('auth.issuer must be an HTTPS origin without a path');
    if (new URL(config.gateway.resourceBaseUrl).origin !== config.gateway.resourceBaseUrl.replace(/\/$/, '')) fail('gateway.resourceBaseUrl must be an HTTPS origin without a path');
  }
  const internalToken = requireSecret('INTERNAL_API_TOKEN');
  const brokerToken = requireSecret('CREDENTIAL_BROKER_TOKEN');
  if (internalToken === brokerToken) fail('INTERNAL_API_TOKEN and CREDENTIAL_BROKER_TOKEN must differ');
  if (service === 'auth') {
    if (!env.DATABASE_URL) fail('DATABASE_URL must be supplied via the environment');
    if (!env.REDIS_URL) fail('REDIS_URL must be supplied via the environment');
    let databaseUrl: URL;
    try { databaseUrl = new URL(env.DATABASE_URL ?? ''); } catch { return fail('DATABASE_URL must be a PostgreSQL URL'); }
    if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !databaseUrl.hostname) fail('DATABASE_URL must be a PostgreSQL URL');
    if (decodeURIComponent(databaseUrl.password) === 'mcp-dev-password') fail('DATABASE_URL still contains the development password');
    if (!/^[0-9a-fA-F]{64}$/.test(env.CREDENTIAL_ENCRYPT_KEY ?? '')) fail('CREDENTIAL_ENCRYPT_KEY must be a 32-byte hex key');
    if (env.CREDENTIAL_ENCRYPT_KEY === developmentEncryptionKey) fail('CREDENTIAL_ENCRYPT_KEY must not use the development default');
    if (!databaseSettingsEnabled(env)) requireHttps('ADMIN_WEB_URL', env.ADMIN_WEB_URL);
  } else {
    if (!env.REDIS_URL) fail('REDIS_URL must be supplied via the environment');
    if (!databaseSettingsEnabled(env)) requireHttps('CONNECTIONS_WEB_URL', env.CONNECTIONS_WEB_URL);
  }
  let redisUrl: URL;
  try { redisUrl = new URL(env.REDIS_URL ?? ''); } catch { return fail('REDIS_URL must be a Redis URL'); }
  if (!['redis:', 'rediss:'].includes(redisUrl.protocol) || !redisUrl.hostname) fail('REDIS_URL must be a Redis URL');
}

export interface SystemSettings {
  public_url: string | null;
  upstream_hosts: string[];
}
let storedSettingsActive = false;
let systemSettings: SystemSettings = { public_url: null, upstream_hosts: [] };
export function databaseSettingsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SYSTEM_CONFIG_MODE === 'database' || (env === process.env && env.SYSTEM_CONFIG_MODE !== 'file' && storedSettingsActive);
}
export function currentSystemSettings(): SystemSettings { return systemSettings; }
export function applySystemSettings(value: SystemSettings): void {
  storedSettingsActive = Boolean(value.public_url);
  systemSettings = value;
  if (databaseSettingsEnabled()) process.env.MCP_UPSTREAM_ALLOWED_HOSTS = value.upstream_hosts.join(',');
}
export function systemConfigured(): boolean { return !databaseSettingsEnabled() || Boolean(systemSettings.public_url); }
export function authIssuer(): string {
  return databaseSettingsEnabled() ? systemSettings.public_url ?? '' : loadPlatformConfig().auth.issuer;
}
export function gatewayPublicUrl(): string {
  return databaseSettingsEnabled() ? systemSettings.public_url ?? '' : loadPlatformConfig().gateway.resourceBaseUrl;
}
export function adminWebUrl(): string {
  return databaseSettingsEnabled() ? systemSettings.public_url ?? '/' : process.env.ADMIN_WEB_URL ?? 'http://localhost:5173';
}
export function normalizeSystemSettings(value: unknown, production = process.env.NODE_ENV === 'production'): SystemSettings | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.public_url !== 'string' || !Array.isArray(input.upstream_hosts)) return null;
  try {
    const url = new URL(input.public_url.trim());
    if ((production ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol))
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (input.upstream_hosts.length > 200 || !input.upstream_hosts.every((host) => typeof host === 'string'
      && host.length <= 253 && /^[a-z0-9][a-z0-9.-]*$/i.test(host) && !host.includes('..'))) return null;
    return { public_url: url.origin, upstream_hosts: [...new Set((input.upstream_hosts as string[]).map((host) => host.toLowerCase()))].sort() };
  } catch { return null; }
}

/** Before initial setup, accept only the browser origin of the requested host. */
export function bootstrapOriginAllowed(origin: string, host: string | undefined, production = process.env.NODE_ENV === 'production'): boolean {
  try {
    const url = new URL(origin);
    return Boolean(host && url.host.toLowerCase() === host.toLowerCase() && url.origin === origin
      && (production ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol)));
  } catch { return false; }
}
