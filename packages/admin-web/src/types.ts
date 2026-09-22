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
  user_count: number;
  created_at: number;
  instances: McpInstance[];
}

export interface GatewayHealth {
  ok: boolean;
  redis: boolean;
  registry?: { lastSuccessAt?: number; lastError?: string };
}

export type View = "overview" | "users" | "servers";

export type DialogState =
  | { type: null }
  | { type: "create-user" }
  | { type: "assign-user"; user: AdminUser }
  | { type: "reset-password"; user: AdminUser }
  | { type: "create-server" }
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
}

export interface AddInstanceInput {
  id?: string;
  url: string;
}
