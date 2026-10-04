import {
  loadPlatformConfig,
  upstreamTestResultSchema,
  unavailableUpstreamTest,
  type UpstreamTestResult,
  type UpstreamEndpointValidation,
} from '@mcp/shared';

type PolicyError =
  Extract<UpstreamEndpointValidation, { error: string }> | { error: 'gateway_self_referential_endpoint' };

/** Forward to the actual gateway, including split-container deployments. */
export async function requestUpstreamTest(
  endpoint: string,
  options?: { gatewayUrl: string; token: string },
): Promise<UpstreamTestResult | PolicyError> {
  const config = options ? undefined : loadPlatformConfig();
  const gatewayUrl =
    options?.gatewayUrl ?? process.env.GATEWAY_INTERNAL_URL ?? `http://127.0.0.1:${config!.gateway.port}`;
  const token = options?.token ?? process.env.INTERNAL_API_TOKEN ?? config!.auth.internalApiToken;
  try {
    const response = await fetch(new URL('/internal/upstream-test', gatewayUrl), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: endpoint }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json();
    if (response.status === 400) {
      // A refreshed gateway policy can be newer than the control plane's cached policy.
      if (body?.error === 'upstream_host_not_allowed') return { error: body.error, host: new URL(endpoint).hostname };
      if (body?.error === 'invalid_upstream_endpoint' || body?.error === 'gateway_self_referential_endpoint')
        return { error: body.error };
    }
    if (!response.ok) return unavailableUpstreamTest('gateway_unavailable');
    const parsed = upstreamTestResultSchema.safeParse(body);
    return parsed.success ? parsed.data : unavailableUpstreamTest('gateway_unavailable');
  } catch {
    return unavailableUpstreamTest('gateway_unavailable');
  }
}
