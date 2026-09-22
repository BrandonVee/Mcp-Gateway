/**
 * Mint an access token for the pre-registered "demo-client" and print it.
 * Use it to configure clients that support a static Authorization header:
 *
 *   pnpm token
 */
import { createHash, randomBytes } from 'node:crypto';

const AUTH = process.env.AUTH_URL ?? 'http://localhost:9001';
const CLIENT_ID = 'demo-client';
const REDIRECT_URI = 'http://localhost:8080/callback';

async function main(): Promise<void> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const authorizeUrl = new URL(`${AUTH}/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('scope', 'mcp');
  authorizeUrl.searchParams.set('state', 'token-mint');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  // Simulate the login form submission (any username works in the skeleton).
  const page = await (await fetch(authorizeUrl)).text();
  const hidden = [...page.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]] as [string, string]);
  const form = new URLSearchParams([...hidden, ['username', process.env.MCP_USER ?? 'demo-user'], ['password', process.env.DEMO_PASSWORD ?? 'demo123']]);
  const redirect = await fetch(`${AUTH}/authorize/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });
  const code = new URL(redirect.headers.get('location') ?? '').searchParams.get('code') ?? '';
  if (!code) throw new Error('authorization failed');

  const tokens = (await (
    await fetch(`${AUTH}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: CLIENT_ID, redirect_uri: REDIRECT_URI }),
    })
  ).json()) as { access_token: string; expires_in: number };

  const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
  console.log(`sub:     ${payload.sub}`);
  console.log(`expires: ${new Date(payload.exp * 1000).toISOString()} (${tokens.expires_in}s)`);
  console.log('\nBearer token for client config:');
  console.log(tokens.access_token);
}

main().catch((err) => {
  console.error('mint token failed:', err.message);
  process.exit(1);
});
