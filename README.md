# MCP 统一认证与多入口网关

管理前端：**http://localhost:5173**（默认管理员账号见 `config/default.json` / `config/docker.json`）。

访问 Auth Server 的 `/admin` 也会跳转到该 Ant Design 管理端；部署到其他域名时可通过 `ADMIN_WEB_URL` 指定管理端公开地址。

这个项目把认证、授权和 MCP 实例路由拆成三层：

```text
                       ┌─ /mcp/demo    ──> demo-a / demo-b
MCP Client ── OAuth ──>│  Gateway
                       ├─ /mcp/reports ──> reports-a
                       └─ /mcp/knowledge ──> knowledge-a
                              │
                              └─ 校验统一 Auth Server 签发的 JWT
```

## 权限模型

- 一个 Auth Server 负责所有用户的登录和 OAuth 2.1 Authorization Code + PKCE。
- `users` 与 `mcp_servers` 通过 `user_server_access` 形成多对多关系。
- 普通用户可由管理员授予指定 Server，或授予通配符 `*` 以访问当前和未来新增的全部 Server；管理员默认拥有通配符权限。
- Access Token 的 `mcp_servers` claim 是签发时的授权快照，例如：

  ```json
  { "sub": "alice", "mcp_servers": ["demo", "reports"] }
  ```

- Gateway 先验证 JWT 和令牌内的 Server 范围，再向 Auth Server 复核用户是否启用、当前 Server 授权是否仍有效，最后转发到对应实例池。
- `admin` token 使用 `mcp_servers: ["*"]`，可进入全部入口。
- `/servers` 只返回当前用户有权访问的 server。

## 状态存储

- PostgreSQL 持久化用户、OAuth 客户端、授权码、Refresh Token、登录会话、签名密钥、MCP Server 和用户授权关系。
- Redis 保存 MCP Session 到后端实例的粘性路由，数据只需要保留到 Session TTL 结束。
- 数据访问统一使用 Drizzle ORM，表结构定义在 `packages/auth-server/src/schema.ts`。
- Auth Server 启动时自动执行 `packages/auth-server/drizzle/` 中的版本化迁移。
- PostgreSQL 使用连接池；`DATABASE_URL` 和 `PG_POOL_MAX` 可用于覆盖配置文件中的敏感部署参数。

```env
DATABASE_URL=postgres://mcp:mcp-dev-password@postgres:5432/mcp
PG_POOL_MAX=10
```

Docker Compose 使用 `postgres_data` volume 持久化 PostgreSQL 数据。

Drizzle 管理命令：

```bash
pnpm --filter @mcp/auth-server db:generate
pnpm --filter @mcp/auth-server db:migrate
pnpm --filter @mcp/auth-server db:studio
```

## 入口与实例池

逻辑 Server 与实例池保存在 PostgreSQL 的 `mcp_servers`、`mcp_server_instances` 表中。管理 API/界面修改数据库后，Gateway 从 Auth Server 的注册表刷新路由；普通服务启动不会再从配置文件重建或覆盖这些记录。

仅在**首次准备演示数据**时运行 `pnpm db:seed:dev`。它从 `scripts/dev-fixtures.json` 导入示例 Server、实例、演示用户和 OAuth 客户端；再次运行默认保留已有记录和实例 URL。该文件只用于演示数据导入和本地示例进程启动，不参与 Gateway 路由。删除过的示例数据只有再次显式运行导入命令才会重建。

对应入口：

- `http://localhost:8000/mcp/demo`
- `http://localhost:8000/mcp/reports`
- `http://localhost:8000/mcp/knowledge`

`knowledge` 是一个可直接测试的简单知识库 MCP，提供 `knowledge_list`、`knowledge_search`、`knowledge_get` 和 `server_info` 工具。

同一个逻辑 server 可以有多个实例。Gateway 通过 Redis 保存 MCP session 与实例的粘性绑定。

Gateway 只读取数据库注册表；注册表在启动时不可用会导致 Gateway 启动失败，不会回退到旧的静态路由。MCP 进程仅通过 `MCP_SERVER_NAME`、`MCP_INSTANCE_ID`、`MCP_PORT` 确定自己的名称和监听端口。

## 注册外部 MCP Server

管理员可以在运行时注册 Gateway 网络可访问的外部 Streamable HTTP MCP Endpoint，无需修改配置文件或重启 Gateway：

```bash
curl -X POST http://localhost:9001/admin/servers \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "external-search",
    "display_name": "External Search",
    "instances": [
      {"id":"external-search-a","url":"https://mcp.example.com/mcp"}
    ]
  }'
```

Gateway 通过受内部 Token 保护的 `/internal/mcp-servers` 控制面同步路由，并定时刷新。首次访问尚未缓存的新入口时也会立即刷新：

```text
http://localhost:8000/mcp/external-search
```

外部地址支持 HTTP/HTTPS 和自定义路径；如果只填写主机根地址，系统会自动补全 `/mcp`。

## 外部服务的用户级认证

平台登录与外部服务凭据是两层独立认证：用户先取得某个逻辑 Server 的访问授权，再到 **http://localhost:5173/connections** 为该 Server 连接自己的 API Key 或 OAuth 账号。管理员在 Server 卡片的“设置认证”中选择 `无额外认证`、`用户 API Key` 或 `用户 OAuth`，并在“分配权限”中选择可访问该 Server 的普通用户。切换认证方式会删除该 Server 已保存的用户连接，以避免旧凭据被误用。

管理后台侧边栏的**二次认证**页面会列出用户与需要认证的 Server 的授权关系、连接状态、认证方式和更新时间；管理员可撤销单个用户的连接，用户随后需在**个人连接中心**重新配置。管理页面只返回连接元数据，不显示 API Key、Access Token 或 Refresh Token。登录页与管理后台侧边栏均提供个人连接中心入口。管理接口为 `GET /admin/connections` 和 `DELETE /admin/connections/:userId/:serverName`，仅管理员可调用。

### API Key

管理员配置上游请求头（`authorization` 或 `x-*`）及值前缀。例如 `authorization` + `Bearer `，或 `x-api-key` + 空前缀。用户在连接中心输入 Key 后，Auth Server 使用 AES-256-GCM 加密并保存，Gateway 仅在该用户的请求中向上游注入；管理 API 和用户状态接口均不返回密钥明文。更新和断开连接也由用户在连接中心完成。

### OAuth

管理员配置外部提供方的授权地址、Token 地址、Client ID、可选 Client Secret、Token 端点客户端认证方式（无、`client_secret_basic`、`client_secret_post`）、Scopes、Resource URL 和响应 Issuer。需在提供方注册回调地址：

```text
{AUTH_ISSUER}/oauth/callback/{SERVER_NAME}
```

用户在连接中心点击“连接账号”；平台使用 Authorization Code + PKCE、一次性 `state` 和浏览器回调取得**外部服务的** Access/Refresh Token。Gateway 按用户注入外部 Bearer Token；即将过期时平台在数据库锁内刷新，避免并发重复兑换轮换型 Refresh Token。平台自己的 JWT 不会转发给外部服务。若提供方在授权响应中返回 `iss`，建议配置预期 Issuer；若提供方要求 RFC 8707 的 `resource` 参数，请配置其受保护资源 URL。

用户未连接时 Gateway 返回 `409 {"error":"connection_required", "connect_url":"..."}`；上游拒绝已保存凭据时返回 `409 {"error":"upstream_credential_rejected", "connect_url":"..."}`，不会将上游 OAuth Challenge 当成平台登录 Challenge 透传。当前客户端应引导用户打开连接中心完成连接，再重试 MCP 请求。Gateway 的连接中心地址可用 `CONNECTIONS_WEB_URL` 覆盖。

### 凭据加密配置

Auth Server 使用 `CREDENTIAL_ENCRYPT_KEY`，值必须为 32 字节的十六进制字符串。Gateway 与 Auth Server 还必须共享独立的 `CREDENTIAL_BROKER_TOKEN`，用于保护仅面向 Gateway 的凭据读取接口；它与路由注册表的 `INTERNAL_API_TOKEN` 不同。Docker Compose 自带的默认值**仅用于本地开发**；其他环境须使用独立 Secret，例如：

```bash
export CREDENTIAL_ENCRYPT_KEY="$(openssl rand -hex 32)"
export CREDENTIAL_BROKER_TOKEN="$(openssl rand -hex 32)"
```

备份此密钥并与数据库备份一同管理；丢失或更换密钥会使已保存的 API Key、OAuth Token 和 Client Secret 不可解密。生产环境还应使用 HTTPS、限制内部凭据接口只能由 Gateway 访问，并为每个外部 OAuth 提供方核对回调、Scopes 和 Token 请求约定。

用户连接相关接口：`POST/GET/DELETE /me/session`、`GET /me/servers`、`PUT/DELETE /me/servers/:name/credential`、`POST /me/servers/:name/oauth`。这些接口使用浏览器的 HttpOnly 会话 Cookie；服务器会对带 `Origin` 的写请求检查来源。

## 配置文件

- `config/default.json`：直接在宿主机启动服务时使用。
- `config/docker.json`：Docker Compose 使用，包含容器网络地址。
- `CONFIG_FILE`：选择配置文件；Compose 中统一设置为 `/app/config/docker.json`。

配置文件只管理 Auth Server、PostgreSQL、Gateway、Redis 等服务参数；逻辑 Server、实例地址和用户授权以 PostgreSQL 为准。密钥、数据库密码等生产机密仍可通过环境变量或 Secret 注入覆盖。

## 管理 API

管理接口需要 `role=admin` 的 Bearer token：

```http
GET    /admin/servers
POST   /admin/servers
PATCH  /admin/servers/:name
DELETE /admin/servers/:name
GET    /admin/servers/:name/users
PUT    /admin/servers/:name/users

POST   /admin/servers/:name/instances
PATCH  /admin/servers/:name/instances/:id
DELETE /admin/servers/:name/instances/:id

GET /admin/users/:id/servers
PUT /admin/users/:id/servers
PATCH /admin/users/:id
GET   /admin/audit-events
```

`GET /admin/audit-events` 仅管理员可读，支持 `limit`（1–100，默认 50）、`before`（上一页最后一条事件 ID）、`actor` 和 `method`（POST/PUT/PATCH/DELETE）查询参数。响应为 `{ "events": [...], "next_before": ID | null }`；参数错误返回 400，未授权返回 403。事件仅包含时间、操作人、HTTP 方法、路径、状态码和请求 ID，不保存请求正文、Cookie、Token 或密钥。

替换某个用户的全部 server 授权：

```bash
curl -X PUT http://localhost:9001/admin/users/USER_ID/servers \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"servers":["demo","reports"]}'
```

也可以通过 `PUT /admin/servers/:name/users` 提交 `{"user_ids":[USER_ID]}`，从 Server 视角替换普通用户的指定授权。通配符用户不在单个 Server 的授权列表中编辑；管理员账号默认具有全部 Server 的访问权限。

给普通用户设置通配符：`PUT /admin/users/:id/servers` 提交 `{"servers":["*"]}`。`*` 必须单独使用，不能与具体 Server 名称混用；撤销通配符后可再分配具体 Server。

管理员通过 `PATCH /admin/users/:id` 设置 `{"disabled":true}` 可关闭用户认证。关闭认证或重置密码会撤销该用户的浏览器会话、授权码和刷新令牌。移除 Server 授权或关闭用户认证会立即阻止旧 Access Token 继续访问；新增授权仍需用户获取新 Token，因为 JWT 中的授权列表是签发时的快照。

## 前端管理系统

`packages/admin-web` 是 React + TypeScript + Vite + Ant Design 管理端，覆盖：

- 统一管理员会话登录与退出；
- 用户创建、认证开关、删除和密码重置；
- 从用户或 Server 两个视角管理 MCP Server 访问授权；
- 内部/外部 MCP Server 注册、启停和删除；
- 上游实例添加、启停、删除；
- Gateway、Redis、动态注册表运行状态总览。
- 日志监控：Auth、PostgreSQL、Gateway、Redis、注册表状态，以及可筛选的管理操作审计。

本地单独启动：

```bash
pnpm dev:admin
```

Vite 开发服务器会把 `/api/*` 转发至 Auth Server，把 `/gateway/*` 转发至 Gateway；目标可分别通过 `ADMIN_API_TARGET` 与 `GATEWAY_TARGET` 覆盖。

## 日志与监控

- Auth Server 以 JSON 行输出请求日志，包含请求 ID、方法、路径、状态码和耗时；Gateway 使用 Fastify 结构化日志。两者都不记录 URL 查询字符串，避免 OAuth 回调码进入日志。MCP 实例继续向标准输出记录启动、会话和错误。命令行开发时在 `pnpm dev:local` 的终端查看；容器模式使用 `docker compose logs -f auth gateway mcp-a`。
- 管理操作和管理员登录会写入 PostgreSQL 的 `audit_events` 表。默认保留 90 天，由 Auth Server 定期清理；可用 `AUDIT_RETENTION_DAYS` 调整。审计写入失败会在服务日志中报错，不会把已完成的管理操作伪装成失败。
- 管理后台的“日志监控”页每 10 秒检查服务健康状态，并提供审计事件筛选、手动刷新和按 ID 翻页。审计页不是原始服务日志采集器；运行日志仍需从标准输出或容器日志采集。

## 本地运行与验证

不使用 Docker 时，先在本机安装并启动 PostgreSQL 和 Redis，并按 `config/default.json` 创建 PostgreSQL 用户 `mcp`、数据库 `mcp`。这是首次运行的依赖准备；Auth Server 启动时会自动执行表结构迁移。随后在项目根目录执行：

```bash
pnpm install
pnpm db:seed:dev  # 仅首次准备演示数据时执行
pnpm dev:local
```

`pnpm dev:local` 会一次启动 Auth Server、Gateway、管理前端，以及 `scripts/dev-fixtures.json` 中的本地示例 MCP 进程；Server 路由仍只来自数据库。首次启动自动生成被 Git 忽略的 `.env.local`，持久保存本地凭据加密密钥与内部 Broker Token。打开 <http://localhost:5173>，按 `Ctrl+C` 停止这组 Node 进程。PostgreSQL 和 Redis 是独立服务，不随脚本退出。

默认数据库连接是 `postgres://mcp:mcp-dev-password@localhost:5432/mcp`，Redis 是 `redis://localhost:6379`。可在 `.env.local` 中设置 `DATABASE_URL`、`REDIS_URL`、`CONFIG_FILE` 等覆盖本地配置；重新启动前请保持原有 `CREDENTIAL_ENCRYPT_KEY`，否则已保存的用户连接凭据不能解密。若 5173、8000、9001 或 MCP 实例端口被其他进程占用，脚本会明确报错。

若只想把 PostgreSQL 和 Redis 放在容器里，其余服务在宿主机命令行运行：

```bash
docker compose up -d postgres redis
# 在 .env.local 中保留已有密钥，并设置以下数据库与 Redis 地址：
# DATABASE_URL=postgres://mcp:mcp-dev-password@127.0.0.1:5433/mcp
# REDIS_URL=redis://127.0.0.1:6380
pnpm db:seed:dev  # 仅首次需要；已有数据库不必重复导入
pnpm dev:local
```

Compose 仅向宿主机回环地址发布 PostgreSQL `5433` 和 Redis `6380`，不会启动 Auth、Gateway、MCP 实例或前端容器。

若此前以 Docker 网络地址导入过示例实例，切回宿主机开发时可**显式**执行 `pnpm db:seed:dev --sync-urls`。此选项只更新示例实例的 URL，不改 Server 的启停和认证设置；未加该选项时不会覆盖管理界面修改的 URL。

Docker 启动与验证仍可使用：

```bash
docker compose up -d --build postgres redis auth
docker compose exec -T auth pnpm --filter @mcp/auth-server db:seed:dev --docker  # 仅首次需要
docker compose up -d --build
pnpm typecheck
pnpm smoke
```

同一数据库从宿主机开发切换到 Compose 全容器模式时，可显式加 `--sync-urls` 将示例实例地址改为 Docker 服务名；切回宿主机时运行不带 `--docker` 的同步命令。此操作不会在正常启动时自动执行。

端到端测试覆盖统一登录、server 列表过滤、未授权入口返回 403、用户授权后进入指定入口，以及同一逻辑 server 的会话粘性与负载分配。
