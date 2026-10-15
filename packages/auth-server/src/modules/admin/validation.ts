import { normalizeEmail } from '@mcp/shared';
import { z } from 'zod';

export const SERVER_NAME_RE = /^(?!\.{1,2}$)[a-zA-Z0-9._-]{1,64}$/;

// Request bodies are parsed once per route instead of field by field. The auth_*
// fields are validated later by authSettings(), so they stay on the parsed body.
const NAME_MESSAGE = 'name must be 1-64 chars [a-zA-Z0-9._-]';

export const DESCRIPTION_MESSAGE = 'description must be a string of at most 2000 characters';

export const serverName = z
  .string({ required_error: NAME_MESSAGE, invalid_type_error: NAME_MESSAGE })
  .trim()
  .regex(SERVER_NAME_RE, NAME_MESSAGE);

export const serverDescription = z.string({ invalid_type_error: DESCRIPTION_MESSAGE }).max(2000, DESCRIPTION_MESSAGE);

export const signupAccess = z.boolean({ invalid_type_error: 'signup_access must be a boolean' });
const serverPolicyFields = {
  monitoring_logs_enabled: z.boolean().optional(),
  user_rate_limit_per_minute: z.number().int().min(0).max(100000).optional(),
  user_daily_quota: z.number().int().min(0).max(100000000).optional(),
  user_max_concurrent: z.number().int().min(0).max(1000).optional(),
};

export const userCreateSchema = z.object({
  username: z
    .string()
    .trim()
    .max(254)
    .refine((value) => Boolean(normalizeEmail(value)), 'invalid_email'),
  password: z.string().min(12, 'invalid_password').max(256, 'invalid_password'),
  role: z.enum(['admin', 'user']).default('user'),
  email: z.string().trim().max(254, 'invalid_email').optional(),
  servers: z.array(z.string()).optional(),
});

export const instanceId = z
  .string({ invalid_type_error: 'invalid_instance_payload' })
  .trim()
  .max(256, 'invalid_instance_payload');

export const instanceCreateSchema = z
  .object({
    display_name: z.string().trim().max(256).optional(),
    id: instanceId.optional(),
    url: z.string({ required_error: 'invalid_upstream_endpoint', invalid_type_error: 'invalid_upstream_endpoint' }),
  })
  .passthrough();

export const instancePatchSchema = z
  .object({
    display_name: z.string().trim().max(256).optional(),
    url: z.string({ invalid_type_error: 'invalid_upstream_endpoint' }).optional(),
    enabled: z.boolean({ invalid_type_error: 'invalid_instance_payload' }).optional(),
  })
  .passthrough();

export const serverCreateSchema = z
  .object({
    ...serverPolicyFields,
    name: serverName,
    routing_mode: z.enum(['pool', 'aggregate']).optional(),
    display_name: z.string({ invalid_type_error: 'display_name must be a string' }).optional(),
    description: serverDescription.optional(),
    signup_access: signupAccess.optional(),
    instances: z.array(instanceCreateSchema).optional(),
  })
  .passthrough();

export const serverPatchSchema = z
  .object({
    ...serverPolicyFields,
    name: serverName.optional(),
    routing_mode: z.enum(['pool', 'aggregate']).optional(),
    display_name: z
      .string({ invalid_type_error: 'display_name must be a non-empty string' })
      .trim()
      .min(1, 'display_name must be a non-empty string')
      .optional(),
    description: serverDescription.optional(),
    enabled: z.boolean({ invalid_type_error: 'enabled must be a boolean' }).optional(),
    signup_access: signupAccess.optional(),
  })
  .passthrough();
