import {
  API_KEY_HEADER,
  API_KEY_MAX_LENGTH,
  API_KEY_PREFIX_MAX_LENGTH,
  apiKeyPrefixSchema,
  credentialHeaderSchema,
} from '@/shared/security/credentials.js';
import { z } from 'zod';

const discoveryEntrySchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
});

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
      'resources_failed',
      'prompts_failed',
      'response_too_large',
      'gateway_unavailable',
      'busy',
    ]),
    stage: z.enum(['initialize', 'tools', 'resources', 'resource_templates', 'prompts', 'gateway']),
    duration_ms: z.number().int().min(0).max(120_000),
    http_status: z.number().int().min(100).max(599).nullable(),
    server: z.object({ name: z.string().max(128), version: z.string().max(128) }).nullable(),
    protocol_version: z.string().max(64).nullable(),
    tools_count: z.number().int().min(0).nullable(),
    tools: z.array(discoveryEntrySchema).nullable().default(null),
    resources: z
      .array(discoveryEntrySchema.extend({ uri: z.string(), mimeType: z.string().optional() }))
      .nullable()
      .default(null),
    resource_templates: z
      .array(discoveryEntrySchema.extend({ uriTemplate: z.string(), mimeType: z.string().optional() }))
      .nullable()
      .default(null),
    prompts: z
      .array(
        discoveryEntrySchema.extend({
          arguments: z
            .array(z.object({ name: z.string(), description: z.string().optional(), required: z.boolean().optional() }))
            .optional(),
        }),
      )
      .nullable()
      .default(null),
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
    tools: null,
    resources: null,
    resource_templates: null,
    prompts: null,
  };
}

/** Only the credential header is sent to the gateway; it never appears in probe results. */
export const upstreamTestCredentialSchema = credentialHeaderSchema.extend({
  value: credentialHeaderSchema.shape.value.refine(
    (value) => value.length <= API_KEY_MAX_LENGTH + API_KEY_PREFIX_MAX_LENGTH,
  ),
});
export type UpstreamTestCredential = z.infer<typeof upstreamTestCredentialSchema>;

/** Optional draft configuration; existing OAuth/user credentials are resolved server-side. */
export const upstreamTestAuthInputSchema = z.object({
  instance_id: z.string().min(1).max(256).optional(),
  auth_mode: z.enum(['none', 'api_key', 'system_api_key', 'oauth', 'system_oauth']).optional(),
  system_api_key: z.string().max(API_KEY_MAX_LENGTH).optional(),
  api_key_header: z.string().regex(API_KEY_HEADER).optional(),
  api_key_prefix: apiKeyPrefixSchema.optional(),
});
export type UpstreamTestAuthInput = z.infer<typeof upstreamTestAuthInputSchema>;
