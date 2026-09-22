import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Demo tools. `server_info` shows which instance answered — handy to watch load balancing. */
export function registerTools(server: McpServer, opts: { serverName: string; instanceId: string }): void {
  server.registerTool(
    'server_info',
    {
      description: 'Returns the name/id of the MCP server instance handling this call',
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { server: opts.serverName, instance: opts.instanceId, pid: process.pid, time: new Date().toISOString() },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerTool(
    'echo',
    {
      description: 'Echoes the given message back',
      inputSchema: { message: z.string().describe('The message to echo') },
    },
    async ({ message }) => ({
      content: [{ type: 'text', text: message }],
    }),
  );

  server.registerTool(
    'add',
    {
      description: 'Adds two numbers',
      inputSchema: {
        a: z.number().describe('First number'),
        b: z.number().describe('Second number'),
      },
    },
    async ({ a, b }) => ({
      content: [{ type: 'text', text: String(a + b) }],
    }),
  );
}
