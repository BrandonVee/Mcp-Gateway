/** Mint a token for an existing user; requires MCP_USER and MCP_PASSWORD. */
import { getAccessToken } from '@/scripts/oauth-token.js';

async function main(): Promise<void> {
  const tokens = await getAccessToken();
  const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
  console.log(`sub:     ${payload.sub}`);
  console.log(`expires: ${new Date(payload.exp * 1000).toISOString()} (${tokens.expires_in}s)`);
  console.log('\nBearer token for client config:');
  console.log(tokens.access_token);
}

main().catch((error) => {
  console.error('Mint token failed:', error.message);
  process.exitCode = 1;
});
