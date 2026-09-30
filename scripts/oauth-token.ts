import { createHash, randomBytes } from 'node:crypto';

/** Obtain a token using a dynamically registered public client and an existing user. */
export async function getAccessToken(): Promise<{ access_token: string; expires_in: number }> {
  const username = process.env.MCP_USER;
  const password = process.env.MCP_PASSWORD;
  if (!username || !password) throw new Error('Set MCP_USER and MCP_PASSWORD to an existing user account');
  const auth = process.env.AUTH_URL ?? 'http://localhost:9001';
  const redirectUri = 'http://localhost:8080/callback';
  const registered = await fetch(`${auth}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'MCP Gateway CLI', redirect_uris: [redirectUri] }),
  });
  if (!registered.ok) throw new Error(`Client registration failed (${registered.status})`);
  const { client_id: clientId } = await registered.json() as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorizeUrl = new URL(`${auth}/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    scope: 'mcp', state: randomBytes(16).toString('hex'),
    code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  const pageResponse = await fetch(authorizeUrl);
  if (!pageResponse.ok) throw new Error(`Authorization page failed (${pageResponse.status})`);
  const page = await pageResponse.text();
  const hidden = [...page.matchAll(/name="([^"]+)" value="([^"]*)"/g)]
    .map((match) => [match[1], match[2]] as [string, string]);
  const submitted = await fetch(`${auth}/authorize/submit`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([...hidden, ['username', username], ['password', password]]),
    redirect: 'manual',
  });
  const location = submitted.headers.get('location');
  if (submitted.status !== 302 || !location) throw new Error(`Authorization failed (${submitted.status})`);
  const callback = new URL(location);
  if (callback.searchParams.get('state') !== authorizeUrl.searchParams.get('state')) throw new Error('OAuth state mismatch');
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('Authorization did not return a code');
  const tokenResponse = await fetch(`${auth}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      client_id: clientId, redirect_uri: redirectUri,
    }),
  });
  if (!tokenResponse.ok) throw new Error(`Token exchange failed (${tokenResponse.status})`);
  return await tokenResponse.json() as { access_token: string; expires_in: number };
}
