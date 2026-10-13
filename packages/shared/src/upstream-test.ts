import { z } from 'zod';

export const upstreamTestResultSchema = z
  .object({
    ok: z.boolean(),
    reason: z.enum([
      'ok',
      'dns',
      'connection_refused',
      'timeout',
      'tls',
      'network',
      'http',
      'not_found',
      'method_not_allowed',
      'auth_required',
      'access_denied',
      'redirect',
      'invalid_mcp',
      'tools_failed',
      'response_too_large',
      'gateway_unavailable',
      'busy',
    ]),
    stage: z.enum(['initialize', 'tools', 'gateway']),
    duration_ms: z.number().int().min(0).max(120_000),
    http_status: z.number().int().min(100).max(599).nullable(),
    server: z.object({ name: z.string().max(128), version: z.string().max(128) }).nullable(),
    protocol_version: z.string().max(64).nullable(),
    tools_count: z.number().int().min(0).nullable(),
  })
  .refine((value) => value.ok === (value.reason === 'ok'));

export type UpstreamTestResult = z.infer<typeof upstreamTestResultSchema>;

export function unavailableUpstreamTest(reason: 'gateway_unavailable' | 'busy'): UpstreamTestResult {
  return {
    ok: false,
    reason,
    stage: 'gateway',
    duration_ms: 0,
    http_status: null,
    server: null,
    protocol_version: null,
    tools_count: null,
  };
}

/** Only the credential header is sent to the gateway; it never appears in probe results. */
export const upstreamTestCredentialSchema = z.object({
  header: z.string().regex(/^(authorization|x-[a-z0-9-]{1,60})$/i),
  value: z
    .string()
    .min(1)
    .max(4196)
    .refine((value) => !/[\x00-\x1f\x7f]/.test(value)),
});
export type UpstreamTestCredential = z.infer<typeof upstreamTestCredentialSchema>;

/** Optional draft configuration; existing OAuth/user credentials are resolved server-side. */
export const upstreamTestAuthInputSchema = z.object({
  instance_id: z.string().min(1).max(256).optional(),
  auth_mode: z.enum(['none', 'api_key', 'system_api_key', 'oauth', 'system_oauth']).optional(),
  system_api_key: z.string().max(4096).optional(),
  api_key_header: z
    .string()
    .regex(/^(authorization|x-[a-z0-9-]{1,60})$/i)
    .optional(),
  api_key_prefix: z
    .string()
    .max(100)
    .refine((value) => !/[\x00-\x1f\x7f]/.test(value))
    .optional(),
});
export type UpstreamTestAuthInput = z.infer<typeof upstreamTestAuthInputSchema>;
