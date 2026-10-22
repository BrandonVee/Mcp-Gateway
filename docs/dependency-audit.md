# 依赖检查（2026-10-22）

版本以 npm 官方 registry 和上游发布记录为准；下表的旧版本取自更新前的锁文件。

| 依赖                        | 旧版本  | 更新版本           |
| --------------------------- | ------- | ------------------ |
| MCP SDK（客户端、测试上游） | 1.30.0  | 1.32.1，与网关统一 |
| Hono                        | 4.13.8  | 4.13.13            |
| Hono Node 适配器            | 1.19.17 | 2.1.5              |
| Fastify                     | 5.12.5  | 5.12.7             |
| JOSE                        | 5.10.0  | 6.2.13             |
| Nodemailer                  | 10.0.14 | 10.2.0             |
| PostgreSQL 驱动 pg          | 8.23.0  | 8.23.1             |
| Drizzle ORM                 | 0.45.3  | 0.45.4             |
| React / React DOM           | 19.3.0  | 19.3.1             |
| Ant Design                  | 6.6.5   | 6.6.7              |
| Vite                        | 7.3.6   | 7.3.7              |
| Prettier                    | 3.9.9   | 3.9.10             |
| source-map-js（间接依赖）   | 1.2.1   | 1.2.2              |
| esbuild（迁移工具间接依赖） | 0.18.20 | 0.28.2             |

主要修复依据：[MCP SDK 安全公告](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories)、[Fastify 5.12.6 安全发布](https://github.com/fastify/fastify/releases/tag/v5.12.6)、[Hono Node 静态路径解码公告](https://github.com/honojs/node-server/security/advisories/GHSA-rmxm-3fg6-px4f)、[Vite 7.3.7](https://github.com/vitejs/vite/releases/tag/v7.3.7)、[source-map-js 1.2.2](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2)、[esbuild 开发服务器公告](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99)。JOSE 按[官方维护政策](https://github.com/panva/jose/security/policy)迁移到仍接收安全更新的 6.x，并适配签名密钥类型；原有 PEM 存储格式保持兼容。

`drizzle-kit` 当前仍通过旧的 `@esbuild-kit/core-utils` 引入 esbuild 0.18。`pnpm-workspace.yaml` 对这一依赖边指定 0.28.2，并实际执行临时目录中的数据库迁移生成，验证覆盖后的工具可用。上游移除旧依赖后可删除此覆盖。

本次保留 TypeScript 5、Zod 3、Vite 7 / React 插件 5、Express 4、ioredis 5、Undici 7；这些大版本迁移需要分别验证 API、构建或运行时兼容性。`@types/node` 继续对齐生产使用的 Node 22。

本机 npm 镜像不提供审计接口，npm 官方审计接口也持续超时。因此使用 [OSV 查询接口](https://google.github.io/osv.dev/api/)扫描完整锁文件中的包名和版本，最终 430 个包未命中已知漏洞；这不代表不存在尚未收录的漏洞。CI 原有 `pnpm audit --prod --audit-level high` 门禁继续保留。

验证包含冻结锁文件安装、格式和类型检查、216 个单元测试、前后端构建、迁移生成，以及隔离 PostgreSQL / Redis 环境中的账号生命周期、OAuth 生命周期、网关权限、上游分组、核心与完整冒烟测试。

Docker 重新构建在 Corepack 获取 pnpm 10.33.0 时遇到 npm 官方 registry 返回 HTTP 503，未完成镜像构建和本次镜像验证。
