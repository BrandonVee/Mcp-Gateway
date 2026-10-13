import { gatewayPublicUrl, validateUpstreamEndpoint } from '@mcp/shared';

export function validateMcpEndpoint(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
  publicUrl = gatewayPublicUrl(env),
) {
  // Check URL shape and proxy loops before the allowlist so an invalid address
  // never invites the administrator to trust its host.
  const endpoint = validateUpstreamEndpoint(value, { ...env, MCP_UPSTREAM_ALLOWLIST_ENABLED: 'false' });
  if (endpoint.error) return endpoint;
  const url = new URL(endpoint.url);
  if (publicUrl && url.origin === new URL(publicUrl).origin && /^\/mcp(?:\/|$)/.test(url.pathname))
    return { error: 'gateway_self_referential_endpoint' as const };
  return validateUpstreamEndpoint(endpoint.url, env);
}
