# Mcp-Gateway

MCP 统一认证与多入口网关，集中管理服务接入、访问权限和用户连接。

本地开发管理前端：**http://localhost:5173**（默认管理员账号见 `config/default.json` / `config/docker.json`）。

访问 Auth Server 的 `/admin` 也会跳转到管理端；推荐部署的公开地址在后台“系统设置”中维护。

这个项目把认证、授权和 MCP 实例路由拆成三层：

```text
                       ┌─ /mcp/search    ──> 外部搜索服务实例池
MCP Client ── OAuth ──>│  Gateway
                       └─ /mcp/knowledge ──> 外部知识库服务
                              │
                              └─ 校验统一 Auth Server 签发的 JWT
```

## 服务器部署（推荐）

服务器只需要 **Docker（含 Compose）和 Git**。应用对外提供一个 HTTP 端口，域名、证书和 HTTPS 由你自己的 Nginx 处理。

```bash
git clone https://github.com/BrandonVee/Mcp-Gateway.git
cd Mcp-Gateway
./scripts/deploy.sh
```

在终端运行时，脚本会引导填写以下参数，回车保留默认值：

- **HTTP 端口**：默认 `8080`，仅监听 `127.0.0.1`，供你自己的 Nginx 转发。
- **镜像来源**：默认本机构建；选择拉取已发布镜像时，再输入镜像仓库前缀和版本。
- **首次管理员密码**：用户名固定为 `admin`；密码至少 16 个字符，隐藏输入并再次确认，留空则自动生成。已有部署会保留密码，不重复询问。

脚本会显示配置摘要，确认后保存并启动 **app、PostgreSQL、Redis 三个容器**。应用镜像 `mcp-app` 包含管理网页、Nginx、Auth Server 和 Gateway，仅提供一个 HTTP 入口。数据库密码、内部令牌和凭据加密密钥自动生成，不需要手写环境文件；取消或输入中断不会保存本次配置。自动生成的管理员密码会在本次执行结束时显示，手动输入的密码不会输出。

需要显式进入交互、先准备配置，或用于自动化部署时：

```bash
./scripts/deploy.sh --interactive                 # 交互安装
./scripts/deploy.sh --interactive --prepare-only  # 只保存配置，不启动服务
./scripts/deploy.sh --yes                         # 使用环境变量、已有配置或默认值，跳过提示
MCP_VERSION=local ./scripts/deploy.sh --yes --use-local-image # 使用已导入的本地镜像
```

非终端环境默认跳过提示，CI 使用 `--yes`。配置保存在 `deploy/single-host/`；升级时以已有参数作为交互默认值。对外访问地址与可信上游统一在管理后台设置。

### Nginx 转发与首次设置

在你已有的 HTTPS `server` 中加入：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
}
```

通过你的 HTTPS 地址打开后台，使用初始管理员登录。系统会引导进入**系统设置**：

1. **对外访问地址**：填写 Nginx 对外的 HTTPS 根地址，例如 `https://mcp.example.com`。OAuth 登录、MCP 入口与个人连接中心统一使用此地址，部署时无需配置 `PUBLIC_URL`。
2. **启用上游白名单**：默认开启。开启时在**可信上游主机**填写计划接入的 MCP 服务主机名或 IP，每行一个，不带协议、端口或路径；名单为空时拒绝所有上游。关闭后允许管理员接入任意合法的上游地址，已填写的名单仍会保留。
3. 保存后注册实际 MCP 服务、创建用户并分配访问权限。客户端入口为 `https://mcp.example.com/mcp/{SERVER_NAME}`。

系统设置持久化在 PostgreSQL 中，重启后继续生效。未设置访问地址时，管理后台可用，OAuth 与 MCP 接入返回 `503 system_not_configured`；生产环境的访问地址需使用 HTTPS。更换地址后，已有 MCP 客户端需重新授权。

MCP 客户端打开 OAuth 登录页后，没有账号的用户可以选择“创建账号”。注册成功后会自动登录并继续原来的授权，保留客户端、回调地址、PKCE 和 state 参数。注册账号均为普通用户。

系统设置中的**允许自行注册**默认开启；关闭后隐藏注册入口，并拒绝直接访问或提交注册页面，已有账号仍可登录、授权，管理员仍可创建用户。文件配置模式可用 `MCP_REGISTRATION_ENABLED=false` 关闭注册。

管理员可在“注册服务”弹窗或服务的“分配权限”弹窗中开启**新注册用户默认可访问**。自行注册的新用户会自动获得已启用且勾选此项的服务权限；其他服务仍由管理员手动分配。该选项默认关闭，调整后只影响之后的注册，已有用户的权限不变。服务本身需要 API 密钥或 OAuth 连接时，用户仍需在个人连接中心完成对应连接。

这里的 Nginx 运行在同一台宿主机。若你自己的 Nginx 在容器中，需让它能访问应用入口，再调整 `proxy_pass`；`127.0.0.1` 在容器中指的是该 Nginx 容器自身。

### 升级、查看日志与备份

```bash
# 更新到要部署的代码版本，再执行同一条命令。
git pull --ff-only
./scripts/backup.sh                    # 升级前备份数据库、配置和密钥
./scripts/deploy.sh

# 查看容器和日志。
docker compose --env-file deploy/single-host/runtime.env -f deploy/compose.single-host.yml ps
docker compose --env-file deploy/single-host/runtime.env -f deploy/compose.single-host.yml logs --tail=100 app
```

部署时选择 **1) 本机构建** 即可，无需镜像仓库。脚本会保留已生成的密钥和密码；数据库与 Redis 使用命名卷持久化。备份默认写入 `backups/`，包含 PostgreSQL、配置和凭据加密密钥，权限为 `0600`，默认保留 14 天。定时备份、加密与恢复步骤见 [备份与恢复](docs/production.md#备份与恢复)。不要用 `down -v` 停止生产部署，它会删除数据库卷。单机升级可能短暂中断，已有 MCP 会话中断后客户端需重新初始化。

需要改 HTTP 端口时，在交互提示中输入新端口，或运行 `MCP_HTTP_PORT=18080 ./scripts/deploy.sh --yes`，随后调整你自己的 Nginx 上游端口。

### 已发布镜像的部署

当前 CI 会构建和测试统一应用镜像，尚未自动发布到镜像仓库。发布 `app` 目标为 `mcp-app` 后，服务器可直接拉取：

```bash
# 私有镜像仓库先使用 docker login 登录。
MCP_IMAGE_PREFIX=ghcr.io/your-lowercase-account/ MCP_VERSION=YOUR_RELEASE_TAG ./scripts/deploy.sh --yes
```

也可直接运行 `./scripts/deploy.sh`，在交互提示中选择“拉取已发布镜像”。此方式使用相同的后台设置流程，跳过服务器源码构建。环境变量方式的镜像前缀保留末尾 `/`，版本须与已发布 tag 一致；交互输入会自动补上末尾 `/`。

也可在构建机上生成一个应用镜像：

```bash
docker build -f Dockerfile.production --target app -t mcp-app:local .
# 离线传到服务器时可导出，服务器用 docker load 导入。
docker save -o mcp-app-local.tar mcp-app:local
```

数据库与 Redis 仍独立运行。已有五容器部署直接执行同一部署脚本：镜像准备成功后，脚本会移除原 `auth`、`gateway`、`admin-web` 容器并启动 `app`，保留 PostgreSQL/Redis 容器、数据卷和密钥。升级会短暂中断 MCP 会话，客户端需重新初始化。

镜像发布、离线部署、外部数据库和回退步骤见 [生产部署文档](docs/production.md)。

## 权限模型

- 一个 Auth Server 负责所有用户的登录和 OAuth 2.1 Authorization Code + PKCE。
- `users` 与 `mcp_servers` 通过 `user_server_access` 形成多对多关系。
- 普通用户可由管理员授予指定 Server，或授予通配符 `*` 以访问当前和未来新增的全部 Server；管理员默认拥有通配符权限。
- Access Token 的 `mcp_servers` claim 是签发时的授权快照，例如：

  ```json
  { "sub": "alice", "mcp_servers": ["search", "knowledge"] }
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

项目不内置 MCP Server，也不会在启动时导入演示服务。新数据库的服务列表为空；管理员通过管理界面或管理 API 注册实际 MCP Endpoint，并为用户分配访问权限。

注册后，客户端使用 `http://localhost:8000/mcp/{SERVER_NAME}` 访问对应服务。上游 MCP Server 由其提供方独立部署和运行。

同一个逻辑 server 可以有多个实例。Gateway 通过 Redis 保存 MCP session 与实例的粘性绑定。
Gateway 每 15 秒对已注册实例做一次 TCP/TLS 连通性探测，并在连接失败或上游返回 502/503/504 时暂时避开该实例；`/health` 会报告不可用实例数量。尚未建立 session 的 `initialize` 请求可在实例失败时尝试同一逻辑 Server 的其他实例。已有 session 始终发送到原实例，不会错误地切换到不认识该 session 的实例；原实例故障时客户端需重新初始化。探测只验证传输层连通性，不等同于 MCP 工具可用性检查。

Gateway 只读取数据库注册表；注册表在启动时不可用会导致 Gateway 启动失败，不会回退到旧的静态路由。

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
上游白名单可在后台“系统设置”中启用或关闭，默认开启；旧配置也按开启处理。开启时 Auth Server 注册与 Gateway 同步路由均会校验可信上游主机，名单为空时拒绝所有上游；关闭时仍校验 URL 的合法性，注册时仍拒绝网关自引用。保存后 Auth Server 立即生效，Gateway 在下一次路由同步时生效（默认 15 秒）。配置文件模式通过 `MCP_UPSTREAM_ALLOWLIST_ENABLED`（默认 `true`）控制开关，通过 `MCP_UPSTREAM_ALLOWED_HOSTS` 指定主机名单（逗号分隔）。Gateway 还会拒绝不在 `MCP_ALLOWED_ORIGINS` 中的浏览器 MCP Origin，并用 `UPSTREAM_MAX_ACTIVE_REQUESTS`（默认 100，每进程）限制同时上游请求数；部署配置和网络隔离要求见 [生产部署与上线检查](docs/production.md)。

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

生产部署需设置 `NODE_ENV=production` 和独立的 `CONFIG_FILE`。服务会在监听端口前校验公网 HTTPS 地址、独立的内部令牌、凭据加密密钥及数据库/Redis 环境变量，并拒绝仓库内的开发默认凭据与演示用户/客户端。首次创建管理员还需通过 `ADMIN_PASSWORD` 提供至少 16 位密码；已有用户的数据库启动时不依赖此变量。根目录 Compose 文件与 Vite 开发服务仅用于本地开发；生产镜像和部署示例位于 `Dockerfile.production`、`deploy/`。详见 [生产部署与上线检查](docs/production.md)。

## 管理 API

开发环境中的管理接口可用 `role=admin` 的 Bearer token；生产环境默认使用管理员浏览器会话，自动化 Bearer 调用还需显式配置受信 Client ID 和管理 API Audience（见生产部署文档）：

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
GET   /admin/system-settings
PUT   /admin/system-settings
```

`GET /admin/audit-events` 仅管理员可读，支持 `limit`（1–100，默认 50）、`before`（上一页最后一条事件 ID）、`actor` 和 `method`（POST/PUT/PATCH/DELETE）查询参数。响应为 `{ "events": [...], "next_before": ID | null }`；参数错误返回 400，未授权返回 403。事件仅包含时间、操作人、HTTP 方法、路径、状态码和请求 ID，不保存请求正文、Cookie、Token 或密钥。

替换某个用户的全部 server 授权：

```bash
curl -X PUT http://localhost:9001/admin/users/USER_ID/servers \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"servers":["search","knowledge"]}'
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
- 系统设置：维护对外访问地址、可信上游、注册开关、调用采集开关、保留期限和告警阈值。
- 日志监控：服务健康、调用趋势、服务/工具/用户/客户端排行、调用明细、当前阈值告警，以及可筛选的管理操作审计。
- 个人连接中心可复制单个或全部已授权 Server 的 WorkBuddy MCP 导入配置；配置只包含 Gateway URL，登录和二次认证仍由各自的 OAuth/连接流程完成。平台动态注册支持 [WorkBuddy 文档](https://open.workbuddy.cn/docs/connector)所述的私有协议 OAuth 回调及本机回环回调。
- 中文/英文界面切换：登录页、管理台、连接中心共用语言下拉菜单；页面标题、状态、表单、提示和请求错误均来自语义键的 `zh-CN` / `en-US` 资源文件。语言选择保存在浏览器本地存储，变量通过 `t("key", { name })` 传递。OAuth 登录/授权页按 `Accept-Language`（含权重）或 `?lang=zh-CN|en-US` 选择语言，并在表单提交时保持选择。协议名称、产品名称、HTTP 方法和实际标识符保持原文。
- 界面字体：英文使用 Nunito，简体中文使用随前端打包的 [Resource Han Rounded CN](https://github.com/CyanoHao/Resource-Han-Rounded) 字形子集；字体许可及更新说明见 `packages/admin-web/src/assets/fonts/`。

本地单独启动：

```bash
pnpm dev:admin
```

Vite 开发服务器会把 `/api/*` 转发至 Auth Server，把 `/gateway/*` 转发至 Gateway；目标可分别通过 `ADMIN_API_TARGET` 与 `GATEWAY_TARGET` 覆盖。

## 日志与监控

- Auth Server 以 JSON 行输出请求日志，包含请求 ID、方法、路径、状态码和耗时；Gateway 使用 Fastify 结构化日志。两者都不记录 URL 查询字符串，避免 OAuth 回调码进入日志。上游 MCP Server 的运行日志由服务提供方采集。命令行开发时在 `pnpm dev:local` 的终端查看；推荐部署使用 `docker compose --env-file deploy/single-host/runtime.env -f deploy/compose.single-host.yml logs -f app`；源码开发使用 `docker compose logs -f auth gateway`。
- 管理 API 和个人连接中心对带 `Origin` 的浏览器写请求进行来源校验；显式提供无效 Bearer Token 时不会回退到 Cookie 会话。Gateway 转发上游时移除客户端 Cookie、平台授权头和可伪造的身份头，也不把上游 `Set-Cookie` 写回平台域名。
- 管理操作和管理员登录会写入 PostgreSQL 的 `audit_events` 表。默认保留 90 天，由 Auth Server 定期清理；可用 `AUDIT_RETENTION_DAYS` 调整。审计写入失败会在服务日志中报错，不会把已完成的管理操作伪装成失败。
- 管理后台的“日志监控”页每 10 秒刷新服务健康和调用统计，支持时间、服务、工具、用户 ID、客户端筛选，以及成功/失败/未知结果的明细分页。加载较早明细后暂停明细自动刷新，手动刷新或更换筛选可回到最新记录。管理员可查看调用次数、成功率、平均耗时、P95 耗时分桶上界、活跃用户、每分钟峰值及四类排行；调用总览仅统计 `tools/call`，协议请求数包括其他 MCP 消息，批量消息逐条计数。
- 调用记录只保存时间、请求 ID、用户/客户端、服务/工具、状态、耗时、错误分类及实例摘要，不保存参数、结果正文、Token、Cookie 或上游完整地址。HTTP 200 内的 JSON-RPC 错误和 `isError` 工具结果均记为失败；无法观察最终结果的异步调用、超过解析上限的响应记为未知，不计入成功率或工具耗时。当前版本不跨 HTTP 连接关联异步结果。
- Gateway 将调用元数据异步写入有界 Redis Stream，Auth Server 持久化并按事件 ID 去重；队列不可用或积压达到上限时不阻塞 MCP 响应，页面展示队列积压、采集错误和丢弃计数。重启、队列故障或大流量时统计可能缺失，不作为计费凭据。
- 系统设置可单独关闭调用明细而继续汇总统计，或关闭全部新调用采集。默认明细保留 14 天、分钟汇总保留 365 天，每 10 分钟清理过期数据；去重记录保留 7 天。当前告警在最近 5 分钟至少 20 次已知结果时检查错误率（默认超过 5%），至少 20 次有耗时时检查 P95 分桶上界（默认超过 2000ms），同时显示采集故障及不可用上游。这些是页面当前告警，尚无历史告警、确认流程或外部通知。
- 管理操作审计支持独立筛选和翻页。运行日志仍需从标准输出或容器日志采集。
- Auth Server 与 Gateway 的 `/live` 用于进程存活探测；`/health` 用于就绪探测，依赖不可用时返回 HTTP 503。Gateway 会同时检查 Redis 与动态注册表是否及时同步。

## 本地运行与验证

不使用 Docker 时，先在本机安装并启动 PostgreSQL 和 Redis，并按 `config/default.json` 创建 PostgreSQL 用户 `mcp`、数据库 `mcp`。这是首次运行的依赖准备；Auth Server 启动时会自动执行表结构迁移。随后在项目根目录执行：

```bash
pnpm install
pnpm dev:local
```

`pnpm dev:local` 会一次启动 Auth Server、Gateway、管理前端；Server 路由只来自数据库注册的实际服务。需要自定义本地配置时，可先执行 `cp .env.local.example .env.local`（已有 `.env.local` 时不要覆盖）；首次启动会向 `.env.local` 写入生成的凭据加密密钥与内部 Broker Token，并将文件权限设为 `0600`。该文件被 Git 忽略。打开 <http://localhost:5173>，按 `Ctrl+C` 停止这组 Node 进程。PostgreSQL 和 Redis 是独立服务，不随脚本退出。

默认数据库连接是 `postgres://mcp:mcp-dev-password@localhost:5432/mcp`，Redis 是 `redis://localhost:6379`。可在 `.env.local` 中设置 `DATABASE_URL`、`REDIS_URL`、`CONFIG_FILE` 等覆盖本地配置；重新启动前请保持原有 `CREDENTIAL_ENCRYPT_KEY`，否则已保存的用户连接凭据不能解密。若 5173、8000 或 9001 端口被其他进程占用，脚本会明确报错。

若只想把 PostgreSQL 和 Redis 放在容器里，其余服务在宿主机命令行运行：

```bash
docker compose up -d postgres redis
# 在 .env.local 中保留已有密钥，并设置以下数据库与 Redis 地址：
# DATABASE_URL=postgres://mcp:mcp-dev-password@127.0.0.1:5433/mcp
# REDIS_URL=redis://127.0.0.1:6380
pnpm dev:local
```

Compose 仅向宿主机回环地址发布 PostgreSQL `5433` 和 Redis `6380`，不会启动 Auth、Gateway 或前端容器。

Docker 启动与验证仍可使用：

```bash
docker compose up -d --build
pnpm typecheck
pnpm test:unit
```

启动后打开管理前端注册实际服务。宿主机运行和容器运行时，请分别填写对应网络中 Gateway 能够访问的上游地址。

## 客户端验证

客户端脚本通过动态注册创建 OAuth 客户端，使用已有用户完成登录，再连接已注册的实际服务：

```bash
MCP_SERVER_NAME=external-search MCP_USER=alice MCP_PASSWORD='<用户密码>' pnpm client
MCP_USER=alice MCP_PASSWORD='<用户密码>' pnpm token
```

`pnpm client` 会列出实际服务提供的工具；`pnpm token` 输出该用户的 Access Token。用户需已被授予对应服务的权限，必要时先在个人连接中心完成上游认证。

## 冒烟测试

测试上游、测试用户与注册数据位于 `tests/fixtures/`，仅用于独立测试数据库，不参与 `pnpm dev:local`、默认 Docker Compose 或生产 runtime 镜像。CI 通过 `.github/compose.app-ci.yml` 显式启动测试上游并导入测试数据，再运行 `pnpm smoke`。

端到端测试覆盖统一登录、server 列表过滤、未授权入口返回 403、用户授权后进入指定入口，以及同一逻辑 server 的会话粘性与负载分配。
