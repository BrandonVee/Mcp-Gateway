/**
 * Demo MCP client: full OAuth flow -> connect through the gateway -> list tools -> call tools.
 *
 *   pnpm client
 *
 * This mimics what real MCP clients (Claude, Cursor, ...) do:
 *   1. POST /mcp/demo without a token -> 401 + WWW-Authenticate resource_metadata
 *   2. discover auth server metadata, do authorization-code + PKCE
 *      (here we simulate the browser login POST; a real client opens a browser)
 *   3. connect StreamableHTTPClientTransport with the bearer token
 */
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const GW = process.env.GATEWAY_URL ?? 'http://localhost:8000';
const AUTH = process.env.AUTH_URL ?? 'http://localhost:9001';
const CLIENT_ID = 'demo-client';
const REDIRECT_URI = 'http://localhost:8080/callback';

async function getAccessToken(): Promise<string> {
  // 1. discover the auth server via protected-resource metadata (RFC 9728)
  const prMeta = (await fetch(`${GW}/.well-known/oauth-protected-resource`).then((r) => r.json())) as {
    authorization_servers: string[];
  };
  const issuer = prMeta.authorization_servers[0];
  console.log(`[auth] discovered issuer: ${issuer}`);

  // 2. authorization code + PKCE (S256)
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorizeUrl = new URL(`${issuer}/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('scope', 'mcp');
  authorizeUrl.searchParams.set('state', randomBytes(8).toString('hex'));
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  // A real client opens this URL in a browser and waits on the redirect.
  // Here we simulate the user submitting the login form.
  const page = await (await fetch(authorizeUrl)).text();
  const hidden = [...page.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]] as [string, string]);
  const form = new URLSearchParams([...hidden, ['username', 'demo-user'], ['password', 'demo123']]);
  const redirect = await fetch(`${issuer}/authorize/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });
  const code = new URL(redirect.headers.get('location') ?? '').searchParams.get('code') ?? '';
  if (!code) throw new Error('authorization failed');

  // 3. exchange the code for tokens
  const tokens = (await (
    await fetch(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI }),
    })
  ).json()) as { access_token: string };
  return tokens.access_token;
}

async function main(): Promise<void> {
  const token = await getAccessToken();
  console.log('[auth] access token obtained');

  const transport = new StreamableHTTPClientTransport(new URL(`${GW}/mcp/demo`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'demo-client', version: '1.0.0' });
  await client.connect(transport);
  console.log('[mcp] connected, session id:', transport.sessionId);

  const tools = await client.listTools();
  console.log('[mcp] tools:', tools.tools.map((t) => t.name).join(', '));

  const sum = await client.callTool({ name: 'add', arguments: { a: 1, b: 2 } });
  console.log('[mcp] add(1,2) =', sum.content[0].text);

  for (let i = 0; i < 3; i++) {
    const info = await client.callTool({ name: 'server_info', arguments: {} });
    console.log('[mcp] server_info ->', info.content[0].text.replace(/\n\s*/g, ' '));
  }

  await client.close();
  console.log('done');
}

main().catch((err) => {
  console.error('client demo failed:', err);
  process.exit(1);
});
