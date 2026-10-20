import { z } from 'zod';

export const gatewayApiKeyPattern = /^mcp_key_[A-Za-z0-9_-]{43}$/;
export const gatewayIdentitySchema = z.object({
  uid: z.number().int().positive().safe(),
  sub: z.string().min(1),
  role: z.enum(['admin', 'user']),
  auth_version: z.number().int().nonnegative().safe(),
  mcp_servers: z.array(z.string()),
  client_id: z.string(),
  scope: z.string(),
});
