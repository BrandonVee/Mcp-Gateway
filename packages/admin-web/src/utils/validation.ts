import { isEndpointUrl } from '@/shared/security/urls.js';
export function validationRule(check: (value: string) => boolean, message: string, optional = false) {
  return {
    validator: (_rule: unknown, value: unknown) => {
      if (optional && (value === undefined || value === null || value === '')) return Promise.resolve();
      return typeof value === 'string' && check(value) ? Promise.resolve() : Promise.reject(new Error(message));
    },
  };
}

export function isPublicOrigin(value: string, requireHttps = true): boolean {
  if (!isEndpointUrl(value)) return false;
  const url = new URL(value.trim());
  return (!requireHttps || url.protocol === 'https:') && url.pathname === '/' && !url.search;
}

export function upstreamHosts(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((host) => host.toLowerCase()),
    ),
  ].sort();
}

export function validUpstreamHosts(value: string): boolean {
  const hosts = upstreamHosts(value);
  return (
    hosts.length <= 200 &&
    hosts.every((host) => host.length <= 253 && /^[a-z0-9][a-z0-9.-]*$/.test(host) && !host.includes('..'))
  );
}
