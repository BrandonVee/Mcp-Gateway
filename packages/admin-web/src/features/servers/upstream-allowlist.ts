import type { McpServer, SystemSettings } from '../../types';
import { isEndpointUrl } from '../../utils/validation';

export function routableInstances(server: McpServer, settings: SystemSettings | null) {
  return server.enabled
    ? server.instances.filter(
        (instance) => instance.enabled && isEndpointUrl(instance.url) && !untrustedUpstreamHost(instance.url, settings),
      )
    : [];
}

export function untrustedUpstreamHost(value: unknown, settings: SystemSettings | null): string | null {
  if (!settings?.upstream_allowlist_enabled || typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash)
      return null;
    if (
      settings.public_url &&
      url.origin === new URL(settings.public_url).origin &&
      /^\/mcp(?:\/|$)/.test(url.pathname === '/' ? '/mcp' : url.pathname)
    )
      return null;
    const host = url.hostname.toLowerCase();
    return settings.upstream_hosts.some((trusted) => trusted.toLowerCase() === host) ? null : host;
  } catch {
    return null;
  }
}
