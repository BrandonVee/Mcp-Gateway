import { adminWebUrl, authIssuer } from '@mcp/shared';

/** Callback paths are public OAuth contracts; existing provider registrations depend on them. */
export function poolCallbackUrl(serverName: string): string {
  return `${authIssuer()}/oauth/callback/${encodeURIComponent(serverName)}`;
}

export function upstreamCallbackUrl(instanceId: string): string {
  return `${authIssuer()}/oauth/upstream-callback/${encodeURIComponent(instanceId)}`;
}

/** Both connection modes return to the same portal with a status and target identifier only. */
export function connectionPortalUrl(result: string, target: string): string {
  const url = new URL('/connections', adminWebUrl());
  url.searchParams.set('result', result);
  url.searchParams.set('server', target);
  return url.toString();
}
