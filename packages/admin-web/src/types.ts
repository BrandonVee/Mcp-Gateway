export type { UpstreamTestResult, UpstreamTestAuthInput } from '../../shared/src/upstream-test';

export interface AdminUser {
  id: number;
  username: string;
  role: 'admin' | 'user';
  email: string | null;
  email_verified: boolean;
  disabled: boolean;
  can_disable: boolean;
  can_delete: boolean;
  servers: string[];
  created_at: number;
}

export interface PlatformSession {
  user_id: number;
  auth_version: number;
  authenticated: true;
  username: string;
  role: 'admin' | 'user';
  email?: string | null;
  email_verified?: boolean;
}

export interface McpInstance extends Partial<ServerAuthInput> {
  display_name?: string;
  system_api_key_configured?: boolean;
  oauth_client_secret_configured?: boolean;
  system_oauth_connected?: boolean;
  id: string;
  url: string;
  enabled: boolean;
}

export interface McpServer {
  upstream_id?: string;
  routing_mode?: 'pool' | 'aggregate';
  name: string;
  display_name: string;
  description?: string;
  enabled: boolean;
  signup_access: boolean;
  auth_mode: 'none' | 'api_key' | 'system_api_key' | 'oauth' | 'system_oauth';
  api_key_header: string;
  api_key_prefix: string;
  system_api_key_configured?: boolean;
  oauth_authorize_url: string | null;
  oauth_token_url: string | null;
  oauth_client_id: string | null;
  oauth_scopes: string | null;
  oauth_resource: string | null;
  oauth_issuer: string | null;
  oauth_client_auth_method: 'none' | 'client_secret_basic' | 'client_secret_post';
  oauth_client_secret_configured?: boolean;
  user_count: number;
  created_at: number;
  instances: McpInstance[];
}

export interface SystemUpdateStatus {
  container_ready?: boolean;
  latest_version: string;
  update_available: boolean | null;
  releases: Array<{ tag: string; version: string; digest: string }>;
  release_check_error: boolean;
  release_check_failures?: Array<{
    source: 'github' | 'dockerhub';
    reason:
      'timeout' | 'dns' | 'tls' | 'network' | 'rate_limited' | 'http' | 'invalid_response' | 'proxy_configuration';
    http_status?: number;
  }>;
  releases_supported: boolean;
  checked_at: number | null;
  target_image: string;
  enabled: boolean;
  socket_available: boolean;
  version: string;
  image: string;
  image_id: string;
  container_id: string;
  container_name: string;
}

export interface GatewayHealth {
  ok: boolean;
  redis: boolean;
  registry?: { lastSuccessAt?: number; lastError?: string };
  monitoring?: { dropped: number; lastQueuedAt: number; lastError: string };
  upstreams?: { total: number; unavailable: number };
}

export interface AuthHealth {
  ok: boolean;
  postgres: boolean;
}

export interface AuditEvent {
  id: number;
  actor: string;
  method: string;
  path: string;
  status_code: number;
  request_id: string;
  created_at: number;
}

export interface AuditEventPage {
  events: AuditEvent[];
  next_before: number | null;
}

export interface AdminConnection {
  user_id: number;
  server_name: string;
  upstream_id?: string;
  mode: 'api_key' | 'oauth';
  expires_at: number | null;
  has_refresh_token: boolean;
  updated_at: number;
}

export type View = 'overview' | 'users' | 'servers' | 'credentials' | 'topology' | 'monitoring' | 'audit' | 'settings';

export type DialogState =
  | { type: null }
  | { type: 'create-user' }
  | { type: 'edit-user'; user: AdminUser }
  | { type: 'assign-user'; user: AdminUser }
  | { type: 'reset-password'; user: AdminUser }
  | { type: 'create-server' }
  | { type: 'edit-server'; server: McpServer }
  | { type: 'edit-instance'; server: McpServer; instance: McpInstance }
  | { type: 'configure-server-auth'; server: McpServer }
  | { type: 'configure-server-users'; server: McpServer }
  | { type: 'add-instance'; server: McpServer };

export interface CreateUserInput {
  username: string;
  password: string;
  role: string;
  email?: string;
  servers: string[];
}

export interface UpdateUserInput {
  username?: string;
  password?: string;
  role?: string;
  disabled?: boolean;
  /** null clears the stored address. */
  email?: string | null;
  email_verified?: boolean;
}

export interface CreateServerInput {
  routing_mode?: 'pool' | 'aggregate';
  name: string;
  display_name: string;
  description?: string;
  signup_access?: boolean;
  instances: Array<{ id?: string; url: string }>;
  auth_mode: 'none' | 'api_key' | 'system_api_key' | 'oauth' | 'system_oauth';
  api_key_header?: string;
  api_key_prefix?: string;
  system_api_key?: string;
  oauth_authorize_url?: string;
  oauth_token_url?: string;
  oauth_client_id?: string;
  oauth_client_secret?: string;
  oauth_scopes?: string;
  oauth_resource?: string;
  oauth_issuer?: string;
  oauth_client_auth_method?: 'none' | 'client_secret_basic' | 'client_secret_post';
}

export type ServerAuthInput = Omit<CreateServerInput, 'name' | 'display_name' | 'description' | 'instances'>;

export interface ConnectionServer {
  endpoint_name?: string;
  endpoint_display_name?: string;
  name: string;
  display_name: string;
  description?: string;
  auth_mode: 'none' | 'api_key' | 'system_api_key' | 'oauth' | 'system_oauth';
  connection_status: 'not_required' | 'not_connected' | 'connected' | 'expired';
}

export interface AddInstanceInput extends Partial<ServerAuthInput> {
  display_name?: string;
  id?: string;
  url: string;
}

export interface SystemSettings {
  managed: boolean;
  configured: boolean;
  public_url: string | null;
  upstream_allowlist_enabled: boolean;
  upstream_hosts: string[];
  public_url_requires_https?: boolean;
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
  smtp_host?: string;
  smtp_port?: number;
  smtp_secure?: boolean;
  smtp_username?: string;
  smtp_password?: string;
  smtp_password_configured?: boolean;
  smtp_from?: string;
}
export type SystemSettingsInput = Omit<
  SystemSettings,
  'managed' | 'configured' | 'public_url' | 'public_url_requires_https' | 'smtp_password_configured'
> & {
  public_url: string;
};

export interface UsageFilters {
  hours: number;
  server?: string;
  tool?: string;
  user_id?: string;
  client_id?: string;
  outcome?: string;
  method?: string;
  request_id?: string;
  q?: string;
}
export interface UsageStat {
  name?: string;
  calls: number;
  success: number;
  failed: number;
  unknown: number;
  success_rate: number | null;
  avg_ms: number | null;
  p95_ms: number | null;
}
export interface UsageSummary {
  enabled: boolean;
  summary: UsageStat & { requests: number; active_users: number; peak_per_minute: number };
  ranking: UsageStat[];
  trend: { time: number; calls: number; failed: number }[];
  bucket_ms: number;
  alerts: { server: string; type: string; value: number; threshold: number }[];
  alert_events: AlertEvent[];
  collection: { lastProcessedAt: number; lastError: string; queued: number | null; dropped: number | null };
}

export interface AlertEvent {
  id: number;
  server: string;
  type: 'error_rate' | 'slow_calls';
  value: number;
  threshold: number;
  first_seen_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
  notified_at: number | null;
  notification_error: string | null;
}

export interface AlertEvent {
  id: number;
  server: string;
  type: 'error_rate' | 'slow_calls';
  value: number;
  threshold: number;
  first_seen_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
  notified_at: number | null;
  notification_error: string | null;
}
export interface UsageCall {
  input: string | null;
  output: string | null;
  id: string;
  request_id: string;
  started_at: number;
  finished_at: number;
  user_id: number;
  username: string;
  client_id: string;
  server: string;
  method: string;
  tool: string;
  outcome: string;
  http_status: number;
  duration_ms: number | null;
  error: string;
  instance: string;
  attempts: number;
}

export type TopologyHealthState = 'up' | 'degraded' | 'down' | 'unknown';

export interface TopologyInstance {
  id: string;
  url: string;
  enabled: boolean;
  health: {
    state: TopologyHealthState;
    replicas_total: number;
    replicas_down: number;
    last_probe_age_ms: number | null;
  };
}

export interface TopologyServer {
  name: string;
  display_name: string;
  enabled: boolean;
  instances: TopologyInstance[];
}

export interface TopologySessionEdge {
  server: string;
  instance: string;
  owner: string;
  count: number;
}

export interface TopologyFlowEdge {
  server: string;
  instance: string;
  username: string;
  client_id: string;
  calls: number;
  failed: number;
}

export interface TopologySnapshot {
  generated_at: number;
  window_seconds: number;
  monitoring_enabled: boolean;
  servers: TopologyServer[];
  sessions: TopologySessionEdge[];
  flows: TopologyFlowEdge[];
  degraded: { health: boolean; sessions: boolean; flows: boolean };
}

export type SmtpSettingsInput = Pick<
  SystemSettingsInput,
  'smtp_host' | 'smtp_port' | 'smtp_secure' | 'smtp_username' | 'smtp_password' | 'smtp_from'
>;
