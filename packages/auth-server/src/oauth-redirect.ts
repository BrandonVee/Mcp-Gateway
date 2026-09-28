/** Public OAuth clients may use HTTPS, loopback, or WorkBuddy's PKCE callback. */
export function isValidRedirectUri(uri: string): boolean {
  if (uri.length > 2048) return false;
  try {
    const url = new URL(uri);
    if (url.username || url.password || url.hash || url.searchParams.has('code')) return false;
    if (url.protocol === 'workbuddy:') {
      return url.hostname === 'workbuddy' && !url.search
        && /^\/mcp\/connector%3a[a-z0-9._-]+\/oauth\/callback$/i.test(url.pathname);
    }
    return url.protocol === 'https:'
      || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}
