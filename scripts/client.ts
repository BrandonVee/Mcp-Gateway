/** Connect to a registered MCP Server and list its actual tools. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getAccessToken } from './oauth-token.js';

async function main(): Promise<void> {
  const serverName = process.env.MCP_SERVER_NAME;
  if (!serverName) throw new Error('Set MCP_SERVER_NAME to a registered Server name');
  const { access_token: token } = await getAccessToken();
  const gateway = process.env.GATEWAY_URL ?? 'http://localhost:8000';
  const transport = new StreamableHTTPClientTransport(new URL(`/mcp/${encodeURIComponent(serverName)}`, gateway), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'mcp-gateway-cli', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    console.log(JSON.stringify(tools.tools, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error('MCP client failed:', error.message);
  process.exitCode = 1;
});
