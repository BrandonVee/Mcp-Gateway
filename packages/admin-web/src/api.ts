import type { AdminConnection, AdminUser, AuditEventPage, AuthHealth, ConnectionServer, CreateServerInput, GatewayHealth, McpServer, ServerAuthInput } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      body?.error?.message ??
      body?.error ??
      body?.error_description ??
      `请求失败（${response.status}）`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export const api = {
  session: () => request<{ authenticated: boolean }>("/api/admin/session"),
  login: (username: string, password: string) =>
    request<{ authenticated: boolean; username: string }>(
      "/api/admin/session",
      {
        method: "POST",
        body: JSON.stringify({ username, password }),
      },
    ),
  logout: () => request("/api/admin/session", { method: "DELETE" }),
  users: () => request<{ users: AdminUser[] }>("/api/admin/users"),
  createUser: (body: {
    username: string;
    password: string;
    role: string;
    servers: string[];
  }) =>
    request<AdminUser>("/api/admin/users", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateUser: (
    id: number,
    body: { password?: string; role?: string; disabled?: boolean },
  ) =>
    request(`/api/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteUser: (id: number) =>
    request(`/api/admin/users/${id}`, { method: "DELETE" }),
  setUserServers: (id: number, servers: string[]) =>
    request(`/api/admin/users/${id}/servers`, {
      method: "PUT",
      body: JSON.stringify({ servers }),
    }),
  adminConnections: () => request<{ connections: AdminConnection[] }>("/api/admin/connections"),
  revokeConnection: (userId: number, serverName: string) => request(
    `/api/admin/connections/${userId}/${encodeURIComponent(serverName)}`,
    { method: "DELETE" },
  ),
  servers: () => request<{ servers: McpServer[] }>("/api/admin/servers"),
  createServer: (body: CreateServerInput) =>
    request<McpServer>("/api/admin/servers", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateServer: (
    name: string,
    body: { display_name?: string; enabled?: boolean } | ServerAuthInput,
  ) =>
    request(`/api/admin/servers/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteServer: (name: string) =>
    request(`/api/admin/servers/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  setServerUsers: (name: string, userIds: number[]) =>
    request(`/api/admin/servers/${encodeURIComponent(name)}/users`, {
      method: "PUT",
      body: JSON.stringify({ user_ids: userIds }),
    }),
  addInstance: (name: string, body: { id?: string; url: string }) =>
    request(`/api/admin/servers/${encodeURIComponent(name)}/instances`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateInstance: (
    name: string,
    id: string,
    body: { url?: string; enabled?: boolean },
  ) =>
    request(
      `/api/admin/servers/${encodeURIComponent(name)}/instances/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    ),
  deleteInstance: (name: string, id: string) =>
    request(
      `/api/admin/servers/${encodeURIComponent(name)}/instances/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  gatewayHealth: () => request<GatewayHealth>("/gateway/health"),
  authHealth: () => request<AuthHealth>("/api/health"),
  auditEvents: (options: { limit?: number; before?: number; actor?: string; method?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.before) params.set("before", String(options.before));
    if (options.actor) params.set("actor", options.actor);
    if (options.method) params.set("method", options.method);
    return request<AuditEventPage>(`/api/admin/audit-events?${params}`);
  },
  mySession: () => request<{ authenticated: boolean; username: string }>("/api/me/session"),
  myLogin: (username: string, password: string) => request<{ authenticated: boolean; username: string }>("/api/me/session", {
    method: "POST", body: JSON.stringify({ username, password }),
  }),
  myLogout: () => request("/api/me/session", { method: "DELETE" }),
  myServers: () => request<{ servers: ConnectionServer[] }>("/api/me/servers"),
  saveApiKey: (name: string, apiKey: string) => request(`/api/me/servers/${encodeURIComponent(name)}/credential`, {
    method: "PUT", body: JSON.stringify({ api_key: apiKey }),
  }),
  removeCredential: (name: string) => request(`/api/me/servers/${encodeURIComponent(name)}/credential`, { method: "DELETE" }),
  startOAuth: (name: string) => request<{ authorization_url: string }>(`/api/me/servers/${encodeURIComponent(name)}/oauth`, { method: "POST" }),
};
