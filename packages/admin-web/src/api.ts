import type { AdminUser, GatewayHealth, McpServer } from "./types";

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
    throw new Error(message);
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
  servers: () => request<{ servers: McpServer[] }>("/api/admin/servers"),
  createServer: (body: {
    name: string;
    display_name: string;
    instances: Array<{ id?: string; url: string }>;
  }) =>
    request<McpServer>("/api/admin/servers", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateServer: (
    name: string,
    body: { display_name?: string; enabled?: boolean },
  ) =>
    request(`/api/admin/servers/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteServer: (name: string) =>
    request(`/api/admin/servers/${encodeURIComponent(name)}`, {
      method: "DELETE",
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
};
