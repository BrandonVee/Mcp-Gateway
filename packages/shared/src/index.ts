import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
export * from '@/shared/alerts.js';
export {
  upstreamTestResultSchema,
  unavailableUpstreamTest,
  type UpstreamTestResult,
  upstreamTestCredentialSchema,
  upstreamTestAuthInputSchema,
  type UpstreamTestCredential,
  type UpstreamTestAuthInput,
} from '@/shared/upstream-test.js';

/** A backend MCP server: one logical name mapped to N instance URLs. */
export interface McpServerConfig {
  name: string;
  instances: string[];
  authMode: 'none' | 'api_key' | 'system_api_key' | 'oauth' | 'system_oauth';
  upstreams?: Array<{
    id: string;
    displayName?: string;
    url: string;
    authMode: 'none' | 'api_key' | 'system_api_key' | 'oauth' | 'system_oauth';
  }>;
}

/** Explicit host allowlist shared by the control plane and every Gateway replica. */
export function allowedUpstreamHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.MCP_UPSTREAM_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function upstreamAllowlistEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MCP_UPSTREAM_ALLOWLIST_ENABLED !== undefined) return env.MCP_UPSTREAM_ALLOWLIST_ENABLED !== 'false';
  return env.NODE_ENV === 'production' || allowedUpstreamHosts(env).size > 0;
}

export type UpstreamEndpointValidation =
  | { url: string; error?: never }
  | { url?: never; error: 'invalid_upstream_endpoint' | 'upstream_host_not_allowed'; host?: string };

export function validateUpstreamEndpoint(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): UpstreamEndpointValidation {
  try {
    if (typeof value !== 'string') return { error: 'invalid_upstream_endpoint' };
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash)
      return { error: 'invalid_upstream_endpoint' };
    const host = url.hostname.toLowerCase();
    if (upstreamAllowlistEnabled(env) && !allowedUpstreamHosts(env).has(host))
      return { error: 'upstream_host_not_allowed', host };
    if (url.pathname === '/' || !url.pathname) url.pathname = '/mcp';
    return { url: url.toString().replace(/\/$/, '') };
  } catch {
    return { error: 'invalid_upstream_endpoint' };
  }
}

export function normalizeUpstreamEndpoint(value: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return validateUpstreamEndpoint(value, env).url ?? null;
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
  if (!config.auth.postgres?.url || !Number.isInteger(config.auth.postgres.poolMax) || config.auth.postgres.poolMax < 1)
    fail('auth.postgres is required');
  if (!config.auth.internalApiToken) fail('auth.internalApiToken is required');
  if (!config.gateway || !validPort(config.gateway.port) || !config.gateway.redisUrl)
    fail('gateway settings are required');
  if (
    !config.gateway.registryUrl ||
    !Number.isInteger(config.gateway.registryRefreshSeconds) ||
    config.gateway.registryRefreshSeconds < 1
  )
    fail('gateway registry settings are required');
}

/**
 * Fail closed before opening a listener when production still carries
 * local-development defaults. Settings stored in the database replace the file
 * configuration after setup, so those file-based checks are skipped once
 * databaseSettingsEnabled() is true.
 */
export function validateProductionRuntime(
  config: PlatformConfig,
  service: 'auth' | 'gateway',
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV !== 'production') return;
  const developmentBrokerToken = 'ef23e6d931a69ad96a57d9ba38a39c810d6adb8a61f4e38990a9b14e0bc6a36d';
  const developmentEncryptionKey = '9f52ebfcbdfb3f52cfcf214b6196952c486efe7ec2c1d7f7a2144d72428c01fc';
  const fail = (message: string): never => {
    throw new Error(`Production configuration: ${message}`);
  };
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
    } catch {
      /* Invalid URL is reported below. */
    }
    fail(`${name} must be a public HTTPS URL without embedded credentials`);
  };

  if (!env.CONFIG_FILE) fail('CONFIG_FILE must select a deployment-specific configuration file');
  if (
    env.MCP_UPSTREAM_ALLOWLIST_ENABLED !== undefined &&
    !['true', 'false'].includes(env.MCP_UPSTREAM_ALLOWLIST_ENABLED)
  ) {
    fail('MCP_UPSTREAM_ALLOWLIST_ENABLED must be true or false');
  }
  const upstreamHosts = allowedUpstreamHosts(env);
  if (
    (!databaseSettingsEnabled(env) && upstreamAllowlistEnabled(env) && upstreamHosts.size === 0) ||
    [...upstreamHosts].some((host) => !/^[a-z0-9][a-z0-9.-]*$/.test(host) || host.includes('..'))
  ) {
    fail('MCP_UPSTREAM_ALLOWED_HOSTS must list trusted upstream hostnames');
  }
  if (!databaseSettingsEnabled(env)) {
    requireHttps('auth.issuer', config.auth.issuer);
    requireHttps('gateway.resourceBaseUrl', config.gateway.resourceBaseUrl);
    if (new URL(config.auth.issuer).origin !== config.auth.issuer.replace(/\/$/, ''))
      fail('auth.issuer must be an HTTPS origin without a path');
    if (new URL(config.gateway.resourceBaseUrl).origin !== config.gateway.resourceBaseUrl.replace(/\/$/, ''))
      fail('gateway.resourceBaseUrl must be an HTTPS origin without a path');
  }
  const internalToken = requireSecret('INTERNAL_API_TOKEN');
  const brokerToken = requireSecret('CREDENTIAL_BROKER_TOKEN');
  if (internalToken === brokerToken) fail('INTERNAL_API_TOKEN and CREDENTIAL_BROKER_TOKEN must differ');
  if (service === 'auth') {
    if (!env.DATABASE_URL) fail('DATABASE_URL must be supplied via the environment');
    if (!env.REDIS_URL) fail('REDIS_URL must be supplied via the environment');
    let databaseUrl: URL;
    try {
      databaseUrl = new URL(env.DATABASE_URL ?? '');
    } catch {
      return fail('DATABASE_URL must be a PostgreSQL URL');
    }
    if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !databaseUrl.hostname)
      fail('DATABASE_URL must be a PostgreSQL URL');
    if (decodeURIComponent(databaseUrl.password) === 'mcp-dev-password')
      fail('DATABASE_URL still contains the development password');
    if (!/^[0-9a-fA-F]{64}$/.test(env.CREDENTIAL_ENCRYPT_KEY ?? ''))
      fail('CREDENTIAL_ENCRYPT_KEY must be a 32-byte hex key');
    if (env.CREDENTIAL_ENCRYPT_KEY === developmentEncryptionKey)
      fail('CREDENTIAL_ENCRYPT_KEY must not use the development default');
    if (!databaseSettingsEnabled(env)) requireHttps('ADMIN_WEB_URL', env.ADMIN_WEB_URL);
  } else {
    if (!env.REDIS_URL) fail('REDIS_URL must be supplied via the environment');
    if (!databaseSettingsEnabled(env)) requireHttps('CONNECTIONS_WEB_URL', env.CONNECTIONS_WEB_URL);
  }
  let redisUrl: URL;
  try {
    redisUrl = new URL(env.REDIS_URL ?? '');
  } catch {
    return fail('REDIS_URL must be a Redis URL');
  }
  if (!['redis:', 'rediss:'].includes(redisUrl.protocol) || !redisUrl.hostname) fail('REDIS_URL must be a Redis URL');
}

export * from '@/shared/monitoring.js';

export interface SystemSettings {
  public_url: string | null;
  upstream_allowlist_enabled: boolean;
  upstream_hosts: string[];
  registration_enabled?: boolean;
  registration_email_verification?: boolean;
  monitoring_enabled?: boolean;
  monitoring_logs_enabled?: boolean;
  monitoring_retention_days?: number;
  monitoring_summary_days?: number;
  monitoring_error_rate?: number;
  monitoring_slow_ms?: number;
  alert_email_recipients?: string[];
  alert_webhook_url?: string;
  /** Outbound mail for verification codes. Empty host disables sending. */
  smtp_host?: string;
  smtp_port?: number;
  smtp_secure?: boolean;
  smtp_username?: string;
  /** Encrypted at rest (credential envelope); never sent back to browsers. */
  smtp_password?: string;
  smtp_from?: string;
}
export const systemOptionDefaults = {
  registration_enabled: true,
  registration_email_verification: false,
  monitoring_enabled: true,
  monitoring_logs_enabled: true,
  monitoring_retention_days: 14,
  monitoring_summary_days: 365,
  monitoring_error_rate: 5,
  monitoring_slow_ms: 2000,
  alert_email_recipients: [],
  alert_webhook_url: '',
  smtp_host: '',
  smtp_port: 465,
  smtp_secure: true,
  smtp_username: '',
  smtp_password: '',
  smtp_from: '',
};
export function runtimeSettings() {
  return { ...systemOptionDefaults, ...currentSystemSettings() };
}
export function registrationEnabled(): boolean {
  return process.env.SYSTEM_CONFIG_MODE === 'file'
    ? process.env.MCP_REGISTRATION_ENABLED !== 'false'
    : runtimeSettings().registration_enabled;
}
let storedSettingsActive = false;
let systemSettings: SystemSettings = { public_url: null, upstream_allowlist_enabled: true, upstream_hosts: [] };
export function databaseSettingsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.SYSTEM_CONFIG_MODE === 'database' ||
    (env === process.env && env.SYSTEM_CONFIG_MODE !== 'file' && storedSettingsActive)
  );
}
export function currentSystemSettings(): SystemSettings {
  return systemSettings;
}
export function applySystemSettings(value: SystemSettings): void {
  // Settings only take effect once a public URL exists: an empty URL means setup
  // has not finished and the file configuration must keep answering.
  storedSettingsActive = Boolean(value.public_url);
  systemSettings = value;
  if (databaseSettingsEnabled()) {
    process.env.MCP_UPSTREAM_ALLOWED_HOSTS = value.upstream_hosts.join(',');
    process.env.MCP_UPSTREAM_ALLOWLIST_ENABLED = String(value.upstream_allowlist_enabled);
  }
}
export function systemConfigured(): boolean {
  return !databaseSettingsEnabled() || Boolean(systemSettings.public_url);
}
export function authIssuer(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NODE_ENV !== 'production') return loadPlatformConfig().auth.issuer;
  return databaseSettingsEnabled(env) ? (systemSettings.public_url ?? '') : loadPlatformConfig().auth.issuer;
}
export function gatewayPublicUrl(env: NodeJS.ProcessEnv = process.env): string {
  // Local development has separate Auth and Gateway listeners, not one ingress.
  if (env.NODE_ENV !== 'production') return loadPlatformConfig().gateway.resourceBaseUrl;
  return databaseSettingsEnabled(env)
    ? (systemSettings.public_url ?? '')
    : loadPlatformConfig().gateway.resourceBaseUrl;
}
export function adminWebUrl(env: NodeJS.ProcessEnv = process.env): string {
  // Vite remains a separate browser origin when development uses stored settings.
  if (env.NODE_ENV !== 'production') return env.ADMIN_WEB_URL ?? 'http://localhost:5173';
  return databaseSettingsEnabled(env)
    ? (systemSettings.public_url ?? '/')
    : (env.ADMIN_WEB_URL ?? 'http://localhost:5173');
}
// Stored settings arrive from the admin API, so every field is parsed instead of
// trusted: one schema keeps the accepted shape and the bounds in one place.
const boundedInt = (max: number) => z.number().int().min(1).max(max);
const upstreamHost = z
  .string()
  .max(253)
  .regex(/^[a-z0-9][a-z0-9.-]*$/i)
  .refine((host) => !host.includes('..'));

export function normalizeUpstreamHost(value: unknown): string | null {
  const parsed = upstreamHost.safeParse(typeof value === 'string' ? value.trim().toLowerCase() : value);
  return parsed.success ? parsed.data : null;
}
const publicOrigin = (production: boolean) =>
  z.string().refine((value) => {
    try {
      const url = new URL(value.trim());
      const protocols = production ? ['https:'] : ['http:', 'https:'];
      return (
        protocols.includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/'
      );
    } catch {
      return false;
    }
  });
const webhookUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  });
const systemSettingsSchema = (production: boolean) =>
  z.object({
    public_url: publicOrigin(production),
    upstream_allowlist_enabled: z.boolean().optional(),
    upstream_hosts: z.array(upstreamHost).max(200),
    registration_enabled: z.boolean().optional(),
    registration_email_verification: z.boolean().optional(),
    monitoring_enabled: z.boolean().optional(),
    monitoring_logs_enabled: z.boolean().optional(),
    monitoring_retention_days: boundedInt(90).optional(),
    monitoring_summary_days: boundedInt(730).optional(),
    monitoring_error_rate: boundedInt(100).optional(),
    monitoring_slow_ms: boundedInt(3_600_000).optional(),
    alert_email_recipients: z.array(z.string().max(254)).max(20).optional(),
    alert_webhook_url: webhookUrl.optional(),
    smtp_host: z
      .string()
      .max(253)
      .regex(/^$|^[a-z0-9][a-z0-9.-]*(\.[a-z0-9][a-z0-9.-]*)+$|^\d{1,3}(\.\d{1,3}){3}$/i)
      .optional(),
    smtp_port: boundedInt(65535).optional(),
    smtp_secure: z.boolean().optional(),
    smtp_username: z.string().max(254).optional(),
    // Accepts plaintext (encrypted before persistence) or the stored envelope.
    smtp_password: z.string().max(4096).optional(),
    smtp_from: z.string().max(254).optional(),
  });

export function normalizeSystemSettings(
  value: unknown,
  production = process.env.NODE_ENV === 'production',
): SystemSettings | null {
  const parsed = systemSettingsSchema(production).safeParse(value);
  if (!parsed.success) return null;
  const input = parsed.data;
  const options: Partial<SystemSettings> = {};
  for (const key of Object.keys(systemOptionDefaults) as Array<keyof typeof systemOptionDefaults>) {
    if (input[key] !== undefined) Object.assign(options, { [key]: input[key] });
  }
  return {
    public_url: new URL(input.public_url.trim()).origin,
    upstream_allowlist_enabled: input.upstream_allowlist_enabled ?? true,
    upstream_hosts: [...new Set(input.upstream_hosts.map((host) => host.toLowerCase()))].sort(),
    ...options,
  };
}

/** Before initial setup, accept only the browser origin of the requested host. */
export function bootstrapOriginAllowed(
  origin: string,
  host: string | undefined,
  production = process.env.NODE_ENV === 'production',
): boolean {
  try {
    const url = new URL(origin);
    return Boolean(
      host &&
      url.host.toLowerCase() === host.toLowerCase() &&
      url.origin === origin &&
      (production ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol)),
    );
  } catch {
    return false;
  }
}

// Pragmatic address check: one @, non-empty labels, a dot in the domain.
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]{1,253}(\.[^\s@.]{1,253})+$/;
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

/** Sending requires at least a relay host and a From address. */
export function smtpConfigured(settings: SystemSettings): boolean {
  return Boolean(settings.smtp_host && settings.smtp_from);
}

export function alertNotificationsConfigured(settings: SystemSettings): boolean {
  return Boolean(settings.alert_webhook_url || (settings.alert_email_recipients?.length && smtpConfigured(settings)));
}

export function registrationEmailVerificationEnabled(): boolean {
  return runtimeSettings().registration_email_verification;
}
