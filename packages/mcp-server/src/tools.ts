import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface KnowledgeDocument {
  id: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
}

const KNOWLEDGE_DOCUMENTS: KnowledgeDocument[] = [
  {
    id: 'platform-overview',
    title: 'MCP 统一认证平台概览',
    summary: '平台由 Auth Server、Gateway、PostgreSQL、Redis 和 MCP Server 实例组成。',
    content:
      'Auth Server 负责 OAuth 2.1、用户登录和 JWT 签发；Gateway 校验 JWT 中的 mcp_servers 权限并转发请求；PostgreSQL 保存用户、权限和 Server 注册表；Redis 保存 MCP Session 与实例的粘性绑定。',
    tags: ['mcp', 'architecture', 'oauth', 'gateway'],
  },
  {
    id: 'client-config',
    title: 'MCP 客户端连接配置',
    summary: '客户端连接 Gateway 的逻辑入口，而不是直接连接后端实例。',
    content:
      'Knowledge MCP 的客户端地址是 http://localhost:8000/mcp/knowledge。支持 OAuth 的客户端会通过 protected resource metadata 自动发现 http://localhost:9001，并使用 Authorization Code + PKCE 完成登录。',
    tags: ['client', 'config', 'streamable-http'],
  },
  {
    id: 'troubleshooting',
    title: '常见连接问题',
    summary: 'server_not_found、Unknown OAuth state 和上游路径错误的排查方法。',
    content:
      'server_not_found 表示逻辑 Server 尚未注册；Unknown OAuth state 通常表示旧回调对应的认证流程已经被新流程覆盖；Cannot POST /path 表示注册的上游 MCP Endpoint 路径错误，内置服务使用 /mcp。',
    tags: ['troubleshooting', 'oauth', 'routing'],
  },
];

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

  if (opts.serverName === 'knowledge') {
    registerKnowledgeTools(server);
    return;
  }

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

function registerKnowledgeTools(server: McpServer): void {
  const documentSummarySchema = z.object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    tags: z.array(z.string()),
  });

  server.registerTool(
    'knowledge_list',
    {
      title: '列出知识文档',
      description: '列出当前简单知识库中的全部文档及其摘要。',
      inputSchema: {},
      outputSchema: { documents: z.array(documentSummarySchema) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const documents = KNOWLEDGE_DOCUMENTS.map(({ content: _content, ...document }) => document);
      return {
        structuredContent: { documents },
        content: [{ type: 'text', text: JSON.stringify(documents, null, 2) }],
      };
    },
  );

  server.registerTool(
    'knowledge_search',
    {
      title: '搜索知识库',
      description: '按关键词搜索文档标题、摘要、正文和标签，并返回匹配度最高的结果。',
      inputSchema: {
        query: z.string().min(1).describe('搜索关键词，例如 OAuth、客户端配置或连接失败'),
        limit: z.number().int().min(1).max(10).optional().describe('最多返回多少条，默认 5 条'),
      },
      outputSchema: {
        query: z.string(),
        matches: z.array(documentSummarySchema.extend({ score: z.number() })),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const matches = KNOWLEDGE_DOCUMENTS.map((document) => {
        const title = document.title.toLocaleLowerCase();
        const tags = document.tags.join(' ').toLocaleLowerCase();
        const body = `${document.summary} ${document.content}`.toLocaleLowerCase();
        const score = terms.reduce(
          (total, term) => total + (title.includes(term) ? 5 : 0) + (tags.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0),
          0,
        );
        const { content: _content, ...summary } = document;
        return { ...summary, score };
      })
        .filter((document) => document.score > 0)
        .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
        .slice(0, limit ?? 5);
      const result = { query, matches };
      return {
        structuredContent: result,
        content: [{ type: 'text', text: matches.length ? JSON.stringify(result, null, 2) : `未找到与“${query}”相关的文档。` }],
      };
    },
  );

  server.registerTool(
    'knowledge_get',
    {
      title: '读取知识文档',
      description: '通过文档 ID 读取一篇知识文档的完整内容。',
      inputSchema: { id: z.string().min(1).describe('文档 ID，可先通过 knowledge_list 或 knowledge_search 获取') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const document = KNOWLEDGE_DOCUMENTS.find((item) => item.id === id);
      if (!document) {
        return {
          isError: true,
          content: [{ type: 'text', text: `文档不存在：${id}。请先调用 knowledge_list 获取有效 ID。` }],
        };
      }
      return {
        structuredContent: { document },
        content: [{ type: 'text', text: `# ${document.title}\n\n${document.content}\n\n标签：${document.tags.join('、')}` }],
      };
    },
  );
}
