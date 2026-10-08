import type { SmtpSettingsInput } from './types';
import type {
  PlatformSession,
  AlertEvent,
  SystemSettings,
  SystemSettingsInput,
  UsageFilters,
  UsageSummary,
  UsageCall,
  AdminConnection,
  AdminUser,
  AuditEventPage,
  AuthHealth,
  ConnectionServer,
  CreateServerInput,
  GatewayHealth,
  McpServer,
  ServerAuthInput,
  SystemUpdateStatus,
  TopologySnapshot,
  UpdateUserInput,
  UpstreamTestResult,
} from './types';
import { getCurrentLanguage, getTranslation, type Language, type MessageKey } from './i18n';

/** Present stable, localized UI errors instead of leaking English backend strings. */
export function apiErrorMessage(status: number, body: unknown, language: Language): string {
  const payload =
    body && typeof body === 'object' ? (body as { error?: unknown; host?: unknown; server?: unknown }) : {};
  const code = typeof payload.error === 'string' ? payload.error : undefined;
  if (code === 'upstream_host_not_allowed' && typeof payload.host === 'string')
    return getTranslation('serverDialog.upstreamHostBlocked', language, { host: payload.host });
  if (code === 'unknown_server' && typeof payload.server === 'string')
    return getTranslation('api.unknownServer', language, { server: payload.server });
  if (code?.startsWith('unknown server: ') || code?.startsWith('unknown or disabled server: '))
    return getTranslation('api.unknownServer', language, { server: code.slice(code.indexOf(': ') + 2) });
  const known: Record<string, MessageKey> = {
    invalid_user_payload: 'api.invalidUserPayload',
    invalid_instance_payload: 'api.invalidInstancePayload',
    instance_already_exists: 'api.instanceExists',
    'username must be 2-64 chars [a-zA-Z0-9._-]': 'auth.signup.usernameRule',
    'password must be at least 12 characters': 'auth.signup.passwordRule',
    'password must be 12-256 characters': 'auth.signup.passwordRule',
    'name must be 1-64 chars [a-zA-Z0-9._-]': 'serverDialog.serverIdFormat',
    'description must be a string of at most 2000 characters': 'serverDialog.descriptionMax',
    'display_name must be a non-empty string': 'serverDialog.enterDisplayName',
    'display_name must be a string': 'serverDialog.enterDisplayName',
    'auth_mode must be none, api_key or oauth': 'api.invalidAuthMode',
    'api_key_header must be authorization or an x-* header': 'api.invalidKeyHeader',
    'invalid api_key_prefix': 'api.invalidKeyPrefix',
    'valid OAuth authorize and token URLs are required': 'api.invalidOAuthUrl',
    'oauth_client_id is required': 'api.oauthClientIdRequired',
    'invalid oauth_client_secret': 'api.invalidOAuthSecret',
    'invalid oauth_client_auth_method': 'api.invalidOAuthMethod',
    'oauth_client_secret is required': 'api.oauthSecretRequired',
    'oauth_client_secret requires a client authentication method': 'api.oauthSecretMethod',
    'invalid oauth_scopes': 'api.invalidOAuthScopes',
    'invalid oauth_resource': 'api.invalidOAuthResource',
    'invalid oauth_issuer': 'api.invalidOAuthIssuer',
    invalid_api_key: 'api.invalidApiKey',
    server_does_not_use_api_key: 'api.serverAuthChanged',
    oauth_not_configured: 'api.oauthNotConfigured',
    server_changed_or_denied: 'api.serverChanged',
    server_not_found_or_denied: 'api.serverDenied',
    'user not found': 'api.userMissing',
    'server not found': 'api.serverMissing',
    'server instance not found': 'api.instanceMissing',
    'connection not found': 'api.connectionMissing',
    'admins already have access to every server': 'api.adminAccess',
    'wildcard must be the only server grant': 'api.invalidGrants',
    'servers must be an array of server names': 'api.invalidGrants',
    'user_ids must refer to ordinary users without wildcard access': 'api.grantsChanged',
    system_settings_unavailable: 'api.settingsUnavailable',
    upstream_host_not_allowed: 'serverDialog.upstreamBlocked',
    invalid_upstream_endpoint: 'serverDialog.enterValidHttpHttpsUrl',
    gateway_self_referential_endpoint: 'serverDialog.gatewayEndpointBlocked',
    invalid_upstream_host: 'serverDialog.invalidUpstreamHost',
    upstream_host_limit_reached: 'serverDialog.upstreamHostLimit',
    system_settings_managed_by_environment: 'settings.environmentManaged',
    system_settings_required: 'settings.setupRequired',
    invalid_admin_credentials: 'api.invalidCredentials',
    invalid_credentials: 'api.invalidCredentials',
    invalid_origin: 'api.invalidOrigin',
    invalid_system_settings: 'settings.invalid',
    'username already exists': 'api.usernameExists',
    'server already exists': 'servers.nameExists',
    last_active_admin_required: 'users.lastAdminProtected',
    session_changed: 'api.sessionChanged',
    username_taken: 'api.usernameExists',
    email_taken: 'api.emailExists',
    invalid_verification_code: 'auth.signup.invalidCode',
    verification_unavailable: 'auth.signup.verificationUnavailable',
    'email already exists': 'api.emailExists',
    invalid_email: 'api.invalidEmail',
    email_missing: 'api.emailMissing',
    smtp_not_configured: 'api.smtpNotConfigured',
    smtp_send_failed: 'api.smtpSendFailed',
    invalid_smtp_settings: 'api.invalidSmtpSettings',
    smtp_test_password_required: 'api.smtpTestPasswordRequired',
    invalid_code: 'api.invalidCode',
    registration_disabled: 'api.registrationDisabled',
    invalid_username: 'api.invalidUsername',
    invalid_password: 'api.invalidPassword',
    password_mismatch: 'api.passwordMismatch',
    already_authenticated: 'api.alreadyAuthenticated',
    system_update_disabled: 'api.updateDisabled',
    docker_unavailable: 'api.updateUnavailable',
    system_update_failed: 'api.updateFailed',
    system_update_in_progress: 'api.updateInProgress',
    invalid_update_version: 'api.invalidUpdateVersion',
    system_update_socket_not_mounted: 'api.updateSocketMount',
    invalid_update_task: 'api.updateFailed',
  };
  const statusKey: Record<number, MessageKey> = {
    400: 'api.invalidRequest',
    401: 'api.unauthorized',
    403: 'api.forbidden',
    404: 'api.notFound',
    409: 'api.conflict',
    429: 'api.rateLimited',
    500: 'api.serverError',
    502: 'api.serverError',
    503: 'api.serviceUnavailable',
    504: 'api.serviceUnavailable',
  };
  const key = code && Object.hasOwn(known, code) ? known[code] : statusKey[status];
  return key ? getTranslation(key, language) : getTranslation('common.requestFailed', language, { status });
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function sendRequest<T>(url: string, init?: RequestInit, identity?: string): Promise<T> {
  // Sign-in and self-registration write the identity they create, not an existing one.
  const anonymousWrite =
    init?.method === 'POST' &&
    (url.endsWith('/session') || url.endsWith('/signup') || url.endsWith('/signup/send-code'));
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'include',
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(identity && init?.method && !['GET', 'HEAD'].includes(init.method) && !anonymousWrite
          ? { 'x-session-identity': identity }
          : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(getTranslation('api.networkError', getCurrentLanguage()), 0);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      apiErrorMessage(response.status, body, getCurrentLanguage()),
      response.status,
      body && typeof body.error === 'string' ? body.error : undefined,
    );
  }
  return body as T;
}

/** Capture the page identity so callbacks cannot write using another tab's new Cookie. */
export function apiForSession(session?: PlatformSession) {
  const identity = session ? `${session.user_id}:${session.auth_version}` : undefined;
  const request = <T>(url: string, init?: RequestInit) => sendRequest<T>(url, init, identity);
  return {
    systemSettings: () => request<SystemSettings>('/api/admin/system-settings'),
    addUpstreamHost: (host: string) =>
      request<SystemSettings>('/api/admin/system-settings/upstream-hosts', {
        method: 'POST',
        body: JSON.stringify({ host }),
      }),
    saveSystemSettings: (body: SystemSettingsInput) =>
      request<SystemSettings>('/api/admin/system-settings', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    testEmail: (to: string, smtp?: SmtpSettingsInput) =>
      request<{ ok: boolean }>('/api/admin/system-settings/test-email', {
        method: 'POST',
        body: JSON.stringify({ to, smtp }),
      }),
    systemUpdate: (check = false, runtimeOnly = false) =>
      request<SystemUpdateStatus>(
        `/api/admin/system-update?${new URLSearchParams({ check: String(check), runtime: String(runtimeOnly) })}`,
      ),
    systemUpdateTask: (id: string) =>
      request<{ status: 'running' | 'succeeded' | 'failed' | 'missing' | 'unknown' }>(
        `/api/admin/system-update/tasks/${encodeURIComponent(id)}`,
      ),
    startSystemUpdate: (tag: string) =>
      request<{ status: string; container_id: string; updater_id: string }>('/api/admin/system-update', {
        method: 'POST',
        body: JSON.stringify({ tag }),
      }),
    usageSummary: (filters: UsageFilters, dimension: string) =>
      request<UsageSummary>(
        '/api/admin/monitoring/summary?' +
          new URLSearchParams(
            Object.entries({ ...filters, dimension })
              .filter(([, value]) => value !== undefined && value !== '')
              .map(([key, value]) => [key, String(value)]),
          ),
      ),
    usageCalls: (filters: UsageFilters, cursor?: string) =>
      request<{ events: UsageCall[]; next_cursor: string | null }>(
        '/api/admin/monitoring/calls?' +
          new URLSearchParams(
            Object.entries({ ...filters, cursor })
              .filter(([, value]) => value !== undefined && value !== '')
              .map(([key, value]) => [key, String(value)]),
          ),
      ),
    myUsageCalls: (filters: UsageFilters, cursor?: string) =>
      request<{ events: UsageCall[]; next_cursor: string | null }>(
        '/api/me/monitoring/calls?' +
          new URLSearchParams(
            Object.entries({ ...filters, cursor })
              .filter(([, value]) => value !== undefined && value !== '')
              .map(([key, value]) => [key, String(value)]),
          ),
      ),
    usageAlerts: () => request<{ events: AlertEvent[] }>('/api/admin/monitoring/alerts?status=open&limit=100'),
    acknowledgeAlert: (id: number) =>
      request<{ event: AlertEvent }>(`/api/admin/monitoring/alerts/${id}/ack`, { method: 'POST' }),
    topologySnapshot: (window = 5) => request<TopologySnapshot>(`/api/admin/topology/snapshot?window=${window}`),
    session: () => request<{ authenticated: boolean }>('/api/admin/session'),
    login: (username: string, password: string) =>
      request<{ authenticated: boolean; username: string }>('/api/admin/session', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    logout: () => request('/api/admin/session', { method: 'DELETE' }),
    users: () => request<{ users: AdminUser[] }>('/api/admin/users'),
    createUser: (body: { username: string; password: string; role: string; email?: string; servers: string[] }) =>
      request<AdminUser>('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    updateUser: (id: number, body: UpdateUserInput) =>
      request(`/api/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    deleteUser: (id: number) => request(`/api/admin/users/${id}`, { method: 'DELETE' }),
    setUserServers: (id: number, servers: string[]) =>
      request(`/api/admin/users/${id}/servers`, {
        method: 'PUT',
        body: JSON.stringify({ servers }),
      }),
    adminConnections: () => request<{ connections: AdminConnection[] }>('/api/admin/connections'),
    revokeConnection: (userId: number, serverName: string) =>
      request(`/api/admin/connections/${userId}/${encodeURIComponent(serverName)}`, { method: 'DELETE' }),
    servers: () => request<{ servers: McpServer[] }>('/api/admin/servers'),
    testUpstream: (url: string, signal?: AbortSignal) =>
      request<UpstreamTestResult>('/api/admin/servers/test-connection', {
        method: 'POST',
        body: JSON.stringify({ url }),
        signal,
      }),
    createServer: (body: CreateServerInput) =>
      request<McpServer>('/api/admin/servers', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    updateServer: (
      name: string,
      body:
        | { name?: string; display_name?: string; description?: string; enabled?: boolean; signup_access?: boolean }
        | ServerAuthInput,
    ) =>
      request(`/api/admin/servers/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    deleteServer: (name: string) =>
      request(`/api/admin/servers/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }),
    setServerUsers: (name: string, userIds: number[], signupAccess?: boolean) =>
      request(`/api/admin/servers/${encodeURIComponent(name)}/users`, {
        method: 'PUT',
        body: JSON.stringify({ user_ids: userIds, signup_access: signupAccess }),
      }),
    addInstance: (name: string, body: { id?: string; url: string }) =>
      request(`/api/admin/servers/${encodeURIComponent(name)}/instances`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    updateInstance: (name: string, id: string, body: { url?: string; enabled?: boolean }) =>
      request(`/api/admin/servers/${encodeURIComponent(name)}/instances/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    deleteInstance: (name: string, id: string) =>
      request(`/api/admin/servers/${encodeURIComponent(name)}/instances/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    gatewayHealth: () => request<GatewayHealth>('/gateway/health'),
    gatewayResource: () => request<{ resource: string }>('/gateway/.well-known/oauth-protected-resource'),
    authHealth: () => request<AuthHealth>('/api/health'),
    auditEvents: (options: { limit?: number; before?: number; actor?: string; method?: string } = {}) => {
      const params = new URLSearchParams();
      if (options.limit) params.set('limit', String(options.limit));
      if (options.before) params.set('before', String(options.before));
      if (options.actor) params.set('actor', options.actor);
      if (options.method) params.set('method', options.method);
      return request<AuditEventPage>(`/api/admin/audit-events?${params}`);
    },
    mySession: () => request<PlatformSession>('/api/me/session'),
    myLogin: (username: string, password: string) =>
      request<PlatformSession>('/api/me/session', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    myLogout: () => request('/api/me/session', { method: 'DELETE' }),
    signupStatus: () =>
      request<{ registration_enabled: boolean; registration_email_verification: boolean }>('/api/me/signup'),
    mySignup: (username: string, email: string, password: string, confirmation: string, verificationCode?: string) =>
      request<PlatformSession>('/api/me/signup', {
        method: 'POST',
        body: JSON.stringify({
          username: email,
          email,
          password,
          confirm_password: confirmation,
          verification_code: verificationCode,
        }),
      }),
    signupSendCode: (email: string) =>
      request<{ ok: boolean }>('/api/me/signup/send-code', { method: 'POST', body: JSON.stringify({ email }) }),
    myServers: () => request<{ servers: ConnectionServer[] }>('/api/me/servers'),
    saveApiKey: (name: string, apiKey: string) =>
      request(`/api/me/servers/${encodeURIComponent(name)}/credential`, {
        method: 'PUT',
        body: JSON.stringify({ api_key: apiKey }),
      }),
    removeCredential: (name: string) =>
      request(`/api/me/servers/${encodeURIComponent(name)}/credential`, { method: 'DELETE' }),
    startOAuth: (name: string) =>
      request<{ authorization_url: string }>(`/api/me/servers/${encodeURIComponent(name)}/oauth`, { method: 'POST' }),
  };
}

export const api = apiForSession();
