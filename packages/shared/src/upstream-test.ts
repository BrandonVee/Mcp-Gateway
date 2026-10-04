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
