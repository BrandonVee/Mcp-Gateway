/** Browser-safe URL policy shared by forms and upstream configuration validation. */
export function isEndpointUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return (
      ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
}

/** OAuth requires HTTPS, except for local development loopback endpoints. */
export function isOAuthUrl(value: unknown): value is string {
  if (!isEndpointUrl(value)) return false;
  const url = new URL(value.trim());
  return url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname);
}
