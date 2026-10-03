export function validationRule(check: (value: string) => boolean, message: string, optional = false) {
  return {
    validator: (_rule: unknown, value: unknown) => {
      if (optional && (value === undefined || value === null || value === '')) return Promise.resolve();
      return typeof value === 'string' && check(value) ? Promise.resolve() : Promise.reject(new Error(message));
    },
  };
}

export function isEndpointUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (
      ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
}

export function isOAuthUrl(value: string): boolean {
  if (!isEndpointUrl(value)) return false;
  const url = new URL(value.trim());
  return url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname);
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

export function validApiKey(value: string): boolean {
  return Boolean(value.trim()) && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
}
