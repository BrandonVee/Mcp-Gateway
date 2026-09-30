export interface AdminUser {
  id: number;
  username: string;
  role: "admin" | "user";
  disabled: boolean;
  servers: string[];
  created_at: number;
}

export interface McpInstance {
  id: string;
  url: string;
  enabled: boolean;
}

export interface McpServer {
  name: string;
  display_name: string;
  enabled: boolean;
  auth_mode: "none" | "api_key" | "oauth";
  api_key_header: string;
  api_key_prefix: string;
  oauth_authorize_url: string | null;
  oauth_token_url: string | null;
  oauth_client_id: string | null;
  oauth_scopes: string | null;
  oauth_resource: string | null;
  oauth_issuer: string | null;
  oauth_client_auth_method: "none" | "client_secret_basic" | "client_secret_post";
  user_count: number;
  created_at: number;
  instances: McpInstance[];
}

export interface GatewayHealth {
  ok: boolean;
  redis: boolean;
  registry?: { lastSuccessAt?: number; lastError?: string };
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
  mode: "api_key" | "oauth";
  expires_at: number | null;
  has_refresh_token: boolean;
  updated_at: number;
}

export type View = "overview" | "users" | "servers" | "credentials" | "monitoring" | "settings";

export type DialogState =
  | { type: null }
  | { type: "create-user" }
  | { type: "assign-user"; user: AdminUser }
  | { type: "reset-password"; user: AdminUser }
  | { type: "create-server" }
  | { type: "configure-server-auth"; server: McpServer }
  | { type: "configure-server-users"; server: McpServer }
  | { type: "add-instance"; server: McpServer };

export interface CreateUserInput {
  username: string;
  password: string;
  role: string;
  servers: string[];
}

export interface CreateServerInput {
  name: string;
  display_name: string;
  instances: Array<{ id?: string; url: string }>;
  auth_mode: "none" | "api_key" | "oauth";
  api_key_header?: string;
  api_key_prefix?: string;
  oauth_authorize_url?: string;
  oauth_token_url?: string;
  oauth_client_id?: string;
  oauth_client_secret?: string;
  oauth_scopes?: string;
  oauth_resource?: string;
  oauth_issuer?: string;
  oauth_client_auth_method?: "none" | "client_secret_basic" | "client_secret_post";
}

export type ServerAuthInput = Omit<CreateServerInput, "name" | "display_name" | "instances">;

export interface ConnectionServer {
  name: string;
  display_name: string;
  auth_mode: "none" | "api_key" | "oauth";
  connection_status: "not_required" | "not_connected" | "connected" | "expired";
}

export interface AddInstanceInput {
  id?: string;
  url: string;
}

export interface SystemSettings {
  managed: boolean;
  configured: boolean;
  public_url: string | null;
  upstream_allowlist_enabled: boolean;
  upstream_hosts: string[];
}
