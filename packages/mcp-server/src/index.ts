import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';

const PORT = Number(process.env.PORT ?? 3001);
const SERVER_NAME = process.env.SERVER_NAME ?? 'demo';
const INSTANCE_ID = process.env.INSTANCE_ID ?? 'instance-1';

/**
 * Sessions are kept in-memory per instance (the transport owns its state).
 * The gateway guarantees stickiness: it stores `session id -> instance` in
 * Redis, so every request of one MCP session reaches this same process.
 */
interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}
const sessions = new Map<string, Session>();

async function createSession(): Promise<Session> {
  const server = new McpServer({ name: SERVER_NAME, version: '1.0.0' });
  registerTools(server, { serverName: SERVER_NAME, instanceId: INSTANCE_ID });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, session);
      console.log(`[${INSTANCE_ID}] session initialized: ${sessionId} (total: ${sessions.size})`);
    },
  });

  const session: Session = { server, transport };
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) sessions.delete(sid);
    console.log(`[${INSTANCE_ID}] session closed: ${sid ?? '?'}`);
  };
  await server.connect(transport);
  return session;
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS so web-based MCP clients can connect directly.
app.use('/mcp', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, server: SERVER_NAME, instance: INSTANCE_ID, sessions: sessions.size });
});

app.post('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      if (sessionId) {
        // Unknown session: ask the client to re-initialize.
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
        return;
      }
      session = await createSession();
    }

    await session.transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(`[${INSTANCE_ID}] error handling request:`, err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

const requireSession = async (req: express.Request, res: express.Response): Promise<Session | undefined> => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32001, message: 'No valid session provided' }, id: null });
  }
  return session;
};

app.get('/mcp', async (req, res) => {
  // Standalone SSE stream for server->client messages of an existing session.
  const session = await requireSession(req, res);
  if (session) await session.transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const session = await requireSession(req, res);
  if (session) await session.transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  console.log(`[${INSTANCE_ID}] MCP server "${SERVER_NAME}" listening on :${PORT} at /mcp`);
});
