import { adminWebUrl, authIssuer } from '@mcp/shared';

export const callback = (id: string) => `${authIssuer()}/oauth/upstream-callback/${encodeURIComponent(id)}`;

export const portal = (result: string, id: string) => {
  const url = new URL('/connections', adminWebUrl());
  url.searchParams.set('result', result);
  url.searchParams.set('server', id);
  return url.toString();
};
