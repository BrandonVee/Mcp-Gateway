# Mcp-Gateway

MCP 统一认证与多入口网关，集中管理服务接入、访问权限和用户连接。

生产部署使用统一应用入口（默认 `127.0.0.1:8080`），经 HTTPS 反向代理访问；本地开发管理前端为 **http://localhost:5173**。公开访问地址在后台“系统设置”中维护。

快速入口：[服务器部署](#服务器部署推荐) · [已有数据库部署](#接入已有-postgresql--redis) · [本地开发](#本地运行与验证) · [完整生产部署文档](docs/production.md)

这个项目把认证、授权和 MCP 实例路由拆成三层：

```text
                       ┌─ /mcp/search    ──> 外部搜索服务实例池
MCP Client ── OAuth ──>│  Gateway
                       └─ /mcp/knowledge ──> 外部知识库服务
                              │
                              └─ 校验统一 Auth Server 签发的 JWT
```

## 服务器部署（推荐）

除下载项目外，以下命令均在项目根目录执行。服务器需要 **Docker Engine、Docker Compose 插件和 Git**，无需在宿主机安装 Node.js 或 pnpm；另外准备域名、HTTPS 证书和反向代理。

| 使用场景 | 部署入口 | 数据库与 Redis |
| --- | --- | --- |
| 从源码构建，包含本地修改 | `./scripts/deploy.sh`，默认本机构建 | 自动启动独立容器 |
| 使用已发布版本，跳过源码构建 | 下方 Docker Hub 部署命令 | 自动启动独立容器 |
| 接入已有 PostgreSQL / Redis | [网页初始化部署](#接入已有-postgresql--redis) | 使用已有服务 |
| 开发与调试 | [本地运行与验证](#本地运行与验证) | 本机服务或开发容器 |

根目录的 `pnpm dev` / `docker compose up --build` 启动开发环境；生产部署使用 `deploy/` 下的 Compose 文件。

### 1. 下载项目并启动

```bash
git clone https://github.com/BrandonVee/Mcp-Gateway.git
cd Mcp-Gateway
./scripts/deploy.sh
```

使用已发布镜像时，将最后一条命令替换为：

```bash
MCP_IMAGE_PREFIX=brandonvee/ MCP_IMAGE_NAME=mcp-gateway MCP_VERSION=latest ./scripts/deploy.sh --yes
```

发布镜像为 `brandonvee/mcp-gateway`，支持 `linux/amd64` 和 `linux/arm64`。`main` 通过全部测试并发布镜像后，`github-actions[bot]` 会自动创建版本标签和 GitHub Release；`latest` 跟随该提交。需要固定版本时改为已发布的 12 位提交号或版本标签（如 `vX.Y.Z` / `X.Y.Z`）。无需克隆源码的镜像启动方式见 [Docker Hub 使用说明](docs/dockerhub.md)。

不带 `--yes` 在终端运行时，脚本会引导填写以下参数，回车保留默认值：

- **HTTP 端口**：默认 `8080`，仅监听 `127.0.0.1`，供你自己的 Nginx 转发。
- **镜像来源**：默认本机构建；拉取 Docker Hub 镜像时，仓库前缀填写 `brandonvee/`，镜像名称填写 `mcp-gateway`，版本填写 `latest` 或指定版本。
- **首次管理员密码**：用户名固定为 `admin`；密码至少 16 个字符，隐藏输入并再次确认，留空则自动生成。已有部署会保留密码，不重复询问。

交互模式会显示配置摘要，确认后保存并启动 **mcp-server、PostgreSQL、Redis 三个容器**。统一应用镜像包含管理网页、Nginx、Auth Server 和 Gateway，仅提供一个 HTTP 入口。数据库密码、内部令牌和凭据加密密钥自动生成，不需要手写环境文件；取消或输入中断不会保存本次配置。自动生成的管理员密码会在本次执行结束时显示，手动输入的密码不会输出。

需要显式进入交互、先准备配置，或用于自动化部署时：

```bash
./scripts/deploy.sh --interactive                 # 交互安装
./scripts/deploy.sh --interactive --prepare-only  # 只保存配置，不启动服务
./scripts/deploy.sh --yes                         # 使用环境变量、已有配置或默认值，跳过提示
MCP_IMAGE_NAME=mcp-app MCP_VERSION=local ./scripts/deploy.sh --yes --use-local-image
```

非终端环境默认跳过提示，CI 使用 `--yes`。默认配置保存在 `deploy/single-host/`：`runtime.env` 保存镜像版本、端口、密码和密钥，权限为 `0600`；`config.json` 保存基础配置。可用 `MCP_DEPLOY_DIR` 指定其他目录，后续部署和备份也须使用该目录。升级沿用已有参数，不会重置数据库中已存在的管理员密码。

部署完成后检查容器和应用健康状态（修改过端口时同步替换 `8080`）：

```bash
docker compose --env-file deploy/single-host/runtime.env -f deploy/compose.single-host.yml ps
curl --fail http://127.0.0.1:8080/healthz
```

应用入口仅绑定服务器回环地址，不能直接通过 `服务器IP:8080` 访问；继续配置 HTTPS 代理后登录。生产管理员为 `admin`，初始密码来自交互输入或脚本生成值，也保存在 `runtime.env` 的 `ADMIN_PASSWORD` 中；开发密码 `admin123` 不适用于生产部署。

### 2. 配置 HTTPS 反向代理

在宿主机已有的 HTTPS `server` 中加入以下内容。此片段需要已有域名与证书配置；若部署时修改过 HTTP 端口，请同步调整 `proxy_pass`：

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

```bash
sudo nginx -t
sudo systemctl reload nginx              # Linux / systemd 示例
curl --fail https://mcp.example.com/healthz  # 替换为实际域名
```

这里的 Nginx 运行在同一台宿主机。若 Nginx 在容器中，需让它能通过容器网络访问应用，并调整 `proxy_pass`；容器内的 `127.0.0.1` 指该容器自身。其他代理拓扑还需核对 `AUTH_TRUSTED_PROXY_IPS`，见 [生产网络配置](docs/production.md#网络密钥与容量)。

### 3. 登录并完成系统设置

通过你的 HTTPS 地址打开后台，使用初始管理员登录。系统会引导进入**系统设置**：

1. **对外访问地址**：填写 Nginx 对外的 HTTPS 根地址，例如 `https://mcp.example.com`。OAuth 登录、MCP 入口与个人连接中心统一使用此地址，部署时无需配置 `PUBLIC_URL`。
2. **启用上游白名单**：默认开启。开启时在**可信上游主机**填写计划接入的 MCP 服务主机名或 IP，每行一个，不带协议、端口或路径；名单为空时拒绝所有上游。关闭后允许管理员接入任意合法的上游地址，已填写的名单仍会保留。
3. 按需调整**用户注册**、**调用采集与保留**、**告警阈值**，保存设置。
4. 注册实际 MCP 服务、创建用户并分配访问权限；新数据库不会导入演示服务。客户端入口为 `https://mcp.example.com/mcp/{SERVER_NAME}`，需要上游凭据时，用户到 `/connections` 完成连接。

系统设置持久化在 PostgreSQL 中，重启后继续生效。未设置访问地址时，管理后台可用，OAuth 与 MCP 接入返回 `503 system_not_configured`；生产环境的访问地址需使用 HTTPS。更换地址后，已有 MCP 客户端需重新授权。

MCP 客户端打开 OAuth 登录页后，没有账号的用户可以选择“创建账号”。注册成功后会自动登录并继续原来的授权，保留客户端、回调地址、PKCE 和 state 参数。注册账号均为普通用户。

系统设置中的**允许自行注册**默认开启；关闭后隐藏注册入口，并拒绝直接访问或提交注册页面，已有账号仍可登录、授权，管理员仍可创建用户。文件配置模式可用 `MCP_REGISTRATION_ENABLED=false` 关闭注册。

管理员可在“注册服务”弹窗或服务的“分配权限”弹窗中开启**新注册用户默认可访问**。自行注册的新用户会自动获得已启用且勾选此项的服务权限；其他服务仍由管理员手动分配。该选项默认关闭，调整后只影响之后的注册，已有用户的权限不变。服务本身需要 API 密钥或 OAuth 连接时，用户仍需在个人连接中心完成对应连接。

服务注册后，可通过“编辑信息”修改显示名称和服务描述，通过实例行的编辑按钮修改上游地址；“编辑信息”也可修改服务标识，实例、访问授权和已保存凭据会同步保留。修改后客户端需重新复制 MCP 配置并登录；OAuth 上游的回调地址也需同步更新。连接中心展示完整服务名称、网关 MCP 地址和描述，“复制 MCP 配置”仅复制 `mcpServers` 下的服务对象，可直接粘贴到客户端的该字段中。已有数据库会在 Auth 启动时自动迁移，补上描述字段。

### 升级、查看日志与备份

升级前先备份。源码构建会使用更新后的本地代码；镜像部署只使用指定镜像版本，本地代码修改不会进入已发布镜像。

```bash
# 源码构建部署：
git pull --ff-only
./scripts/backup.sh                    # 升级前备份数据库、配置和密钥
./scripts/deploy.sh

```

已发布镜像部署：

```bash
./scripts/backup.sh
MCP_IMAGE_PREFIX=brandonvee/ MCP_IMAGE_NAME=mcp-gateway MCP_VERSION=latest ./scripts/deploy.sh --yes
```

查看容器和日志：

```bash
# 查看容器和日志。
docker compose --env-file deploy/single-host/runtime.env -f deploy/compose.single-host.yml ps
docker compose --env-file deploy/single-host/runtime.env -f deploy/compose.single-host.yml logs --tail=100 mcp-server
```

镜像来源、名称和版本会保存，后续可执行 `./scripts/deploy.sh --yes` 沿用配置；若保存的是固定标签，须显式设置新的 `MCP_VERSION` 才会升级。需要切回源码构建时，交互选择 **1) 本机构建**。

脚本保留已生成的密钥和密码，数据库与 Redis 使用命名卷持久化。备份默认写入 `backups/`，包含 PostgreSQL、配置和凭据加密密钥，权限为 `0600`，默认保留 14 天；**不包含 Redis 会话及尚未落库的调用队列**。定时备份、加密与恢复步骤见 [备份与恢复](docs/production.md#备份与恢复)。保留部署配置及原有 `CREDENTIAL_ENCRYPT_KEY`，不要用 `down -v` 停止生产部署，它会删除数据库卷。单机升级可能短暂中断，已有 MCP 会话中断后客户端需重新初始化。

需要改 HTTP 端口时，在交互提示中输入新端口，或运行 `MCP_HTTP_PORT=18080 ./scripts/deploy.sh --yes`，随后调整你自己的 Nginx 上游端口。

### 接入已有 PostgreSQL / Redis

此方式只启动应用，不创建数据库或 Redis；先准备好可从应用容器访问的服务、专用数据库及账号。

```bash
docker compose -f deploy/compose.setup.yml up -d
docker compose -f deploy/compose.setup.yml logs mcp-server
```

打开应用入口，使用日志中 `[setup] initialization key:` 后的密钥，依次完成身份验证、PostgreSQL 测试、Redis 测试和管理员设置；保存后自动启动应用。远程初始化可用 `ssh -L 18080:127.0.0.1:8080 用户@服务器`，再访问本机 `http://127.0.0.1:18080`。管理员登录仍需上方的 HTTPS 入口。

容器中的 `localhost` 指应用容器自身，不能用来连接宿主机或其他容器的数据库。配置及加密密钥保存在 `app_data` 卷的 `/app/data/bootstrap.json`，须与外部数据库一起备份；重建容器时沿用原项目名和数据卷。一键部署的 `backup.sh` 不适用于此外部数据库模式。完整连接要求见 [Docker Hub 使用说明](docs/dockerhub.md#方式一首次打开网页连接已有-postgresql-和-redis)，环境变量部署见 [使用外部数据库](docs/production.md#使用外部数据库)。

### 离线镜像与旧版迁移

在联网构建机上生成镜像并导出，再传到相同 CPU 架构的服务器：

```bash
docker build -f Dockerfile.production --target app -t mcp-app:local .
# 离线传到服务器时可导出，服务器用 docker load 导入。
docker save -o mcp-app-local.tar mcp-app:local
# 在服务器项目根目录导入并部署：
docker load -i mcp-app-local.tar
MCP_IMAGE_NAME=mcp-app MCP_VERSION=local ./scripts/deploy.sh --yes --use-local-image
```

离线服务器还须预先导入 `postgres:16-alpine` 和 `redis:7-alpine` 镜像。本地镜像默认名为 `mcp-app`，与 Docker Hub 的 `brandonvee/mcp-gateway` 区分。

已有单机部署直接执行同一脚本：镜像准备成功后，脚本会移除当前项目的旧 `auth`、`gateway`、`admin-web` 或 `app` 容器并启动 `mcp-server`，保留数据库、Redis、数据卷和密钥。Compose 实际容器名包含项目名前缀，例如 `mcp-gateway-mcp-server-1`；日志命令使用服务名 `mcp-server`。

镜像发布和回退步骤见 [生产部署文档](docs/production.md)，自动发布配置见 [Docker Hub 发布](docs/production.md#自动发布到-docker-hub)。

### 常见部署问题

| 现象 | 排查与处理 |
| --- | --- |
| 无法通过服务器 IP 访问 `8080` | 默认只监听回环地址，使用已配置的 HTTPS 域名；初始化可使用 SSH 隧道。 |
| 管理员提示凭据无效或无管理员权限 | 核对该部署的管理员账号与密码；已有数据库账号不会因修改 `ADMIN_PASSWORD` 被重置。 |
| MCP 返回 `503 system_not_configured` | 在“系统设置”保存真实 HTTPS 对外访问地址。 |
| 无法注册上游服务 | 检查白名单开关、可信上游主机和容器到上游的连通性；默认开启白名单，空名单拒绝所有上游。 |
| 应用未就绪或容器 unhealthy | 用该部署对应的 Compose 文件查看 `ps` 和应用日志，再检查 PostgreSQL / Redis 连接；`unhealthy` 本身不会触发 Docker 自动重启。 |

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
- `CONFIG_FILE`：选择基础配置文件；根目录开发 Compose 使用 `/app/config/docker.json`，生产一键部署使用生成的 `/app/config/production.json`。

配置文件只管理 Auth Server、PostgreSQL、Gateway、Redis 等服务参数；逻辑 Server、实例地址和用户授权以 PostgreSQL 为准。密钥、数据库密码等生产机密仍可通过环境变量或 Secret 注入覆盖。

推荐的一键部署和统一应用镜像使用 `SYSTEM_CONFIG_MODE=database`，基础运行配置由部署脚本或网页初始化准备，对外访问地址、可信上游、注册及监控选项在后台保存到 PostgreSQL。高级分离部署使用 `SYSTEM_CONFIG_MODE=file`，需要独立的生产配置文件及 HTTPS 地址，后台系统设置只读。

生产模式会校验独立的内部令牌、凭据加密密钥及数据库/Redis 环境变量，并拒绝仓库内的开发默认凭据与演示用户/客户端。首次创建管理员需提供至少 16 个字符的密码；已有管理员不会在重新部署时被覆盖。生产镜像和部署示例位于 `Dockerfile.production`、`deploy/`，详见 [生产部署与上线检查](docs/production.md)。

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
- 个人连接中心可复制单个或全部已授权 Server 的 WorkBuddy MCP 配置；复制结果是 `mcpServers` 字段的内容，不包含外层 `mcpServers` 包装。配置只包含 Gateway URL（本地开发默认 `http://localhost:8000/mcp/{SERVER_NAME}`），登录和二次认证仍由各自的 OAuth/连接流程完成。平台动态注册支持 [WorkBuddy 文档](https://open.workbuddy.cn/docs/connector)所述的私有协议 OAuth 回调及本机回环回调。
- 中文/英文界面切换：登录页、管理台、连接中心共用语言下拉菜单；页面标题、状态、表单、提示和请求错误均来自语义键的 `zh-CN` / `en-US` 资源文件。语言选择保存在浏览器本地存储，变量通过 `t("key", { name })` 传递。OAuth 登录/授权页按 `Accept-Language`（含权重）或 `?lang=zh-CN|en-US` 选择语言，并在表单提交时保持选择。协议名称、产品名称、HTTP 方法和实际标识符保持原文。
- 界面字体：英文使用 Nunito，简体中文使用随前端打包的 [Resource Han Rounded CN](https://github.com/CyanoHao/Resource-Han-Rounded) 字形子集；字体许可及更新说明见 `packages/admin-web/src/assets/fonts/`。

本地单独启动：

```bash
pnpm dev:admin
```

Vite 开发服务器会把 `/api/*` 转发至 Auth Server，把 `/gateway/*` 转发至 Gateway；目标可分别通过 `ADMIN_API_TARGET` 与 `GATEWAY_TARGET` 覆盖。

## 日志与监控

- Auth Server 以 JSON 行输出请求日志，包含请求 ID、方法、路径、状态码和耗时；Gateway 使用 Fastify 结构化日志。两者都不记录 URL 查询字符串，避免 OAuth 回调码进入日志。上游 MCP Server 的运行日志由服务提供方采集。命令行开发时在 `pnpm dev:local` 的终端查看；推荐部署使用 `docker compose --env-file deploy/single-host/runtime.env -f deploy/compose.single-host.yml logs -f mcp-server`；源码开发使用 `docker compose logs -f auth gateway`。
- 管理 API 和个人连接中心对带 `Origin` 的浏览器写请求进行来源校验；显式提供无效 Bearer Token 时不会回退到 Cookie 会话。Gateway 转发上游时移除客户端 Cookie、平台授权头和可伪造的身份头，也不把上游 `Set-Cookie` 写回平台域名。
- 管理操作和管理员登录会写入 PostgreSQL 的 `audit_events` 表。默认保留 90 天，由 Auth Server 定期清理；可用 `AUDIT_RETENTION_DAYS` 调整。审计写入失败会在服务日志中报错，不会把已完成的管理操作伪装成失败。
- 管理后台的“日志监控”页每 10 秒刷新服务健康和调用统计，支持时间、服务、工具、用户 ID、客户端筛选，以及成功/失败/未知结果的明细分页。加载较早明细后暂停明细自动刷新，手动刷新或更换筛选可回到最新记录。管理员可查看调用次数、成功率、平均耗时、P95 耗时分桶上界、活跃用户、每分钟峰值及四类排行；调用总览仅统计 `tools/call`，协议请求数包括其他 MCP 消息，批量消息逐条计数。
- 调用记录只保存时间、请求 ID、用户/客户端、服务/工具、状态、耗时、错误分类及实例摘要，不保存参数、结果正文、Token、Cookie 或上游完整地址。HTTP 200 内的 JSON-RPC 错误和 `isError` 工具结果均记为失败；无法观察最终结果的异步调用、超过解析上限的响应记为未知，不计入成功率或工具耗时。当前版本不跨 HTTP 连接关联异步结果。
- Gateway 将调用元数据异步写入有界 Redis Stream，Auth Server 持久化并按事件 ID 去重；队列不可用或积压达到上限时不阻塞 MCP 响应，页面展示队列积压、采集错误和丢弃计数。重启、队列故障或大流量时统计可能缺失，不作为计费凭据。
- 系统设置可单独关闭调用明细而继续汇总统计，或关闭全部新调用采集。默认明细保留 14 天、分钟汇总保留 365 天，每 10 分钟清理过期数据；去重记录保留 7 天。当前告警在最近 5 分钟至少 20 次已知结果时检查错误率（默认超过 5%），至少 20 次有耗时时检查 P95 分桶上界（默认超过 2000ms），同时显示采集故障及不可用上游。这些是页面当前告警，尚无历史告警、确认流程或外部通知。
- 管理操作审计支持独立筛选和翻页。运行日志仍需从标准输出或容器日志采集。
- Auth Server 与 Gateway 的 `/live` 用于进程存活探测；`/health` 用于就绪探测，依赖不可用时返回 HTTP 503。Gateway 会同时检查 Redis 与动态注册表是否及时同步。

## 本地运行与验证

宿主机运行源码需 **Node.js 20.19+（20.x）或 ≥ 22.12、pnpm 10.33.0**（与 Vite 要求一致），以及可用的 PostgreSQL 和 Redis。以下开发方式任选一种，不要同时启动两组 Auth、Gateway 和管理前端。

### 方式一：容器运行数据库，宿主机运行应用

在项目根目录安装依赖并启动数据库：

```bash
pnpm install --frozen-lockfile
docker compose up -d --wait postgres redis
if [ ! -f .env.local ]; then cp .env.local.example .env.local; fi
```

编辑 `.env.local` 中的以下两项，保留其他已有配置和密钥：

```env
DATABASE_URL=postgres://mcp:mcp-dev-password@127.0.0.1:5433/mcp
REDIS_URL=redis://127.0.0.1:6380
```

再启动应用：

```bash
pnpm dev:local
```

开发 Compose 把 PostgreSQL 和 Redis 分别映射到宿主机的 `5433`、`6380`，与容器内部的 `5432`、`6379` 区分。上述命令仅启动两个依赖容器。

### 方式二：全部使用本机服务

先安装并启动 PostgreSQL 和 Redis，按 `config/default.json` 创建 PostgreSQL 用户 `mcp`、数据库 `mcp`；默认连接为 `postgres://mcp:mcp-dev-password@localhost:5432/mcp` 和 `redis://localhost:6379`。若已有 `.env.local`，确认其中地址与本机服务一致，再执行：

```bash
pnpm install --frozen-lockfile
pnpm dev:local
```

两种方式都由 `pnpm dev:local` 启动 Auth Server、Gateway 和管理前端；Auth 启动时自动执行数据库迁移。打开 <http://localhost:5173>，首次空库默认管理员为 `admin` / `admin123`（仅开发环境，见 `config/default.json`）。已有账号继续使用数据库中的密码。

开发模式保留独立入口：管理网页默认 `5173`、OAuth 认证默认 `9001`、MCP 网关默认 `8000`。即使数据库保存了生产访问地址，本地认证与 MCP 发现仍使用当前配置文件中的对应地址；生产统一应用镜像则使用后台保存的公开访问地址。直接连接本地网关的客户端也可在 `8000` 上发现认证元数据、注册客户端和交换令牌，浏览器授权会跳转到认证服务。

首次运行会在 `.env.local` 中补充凭据加密密钥和内部 Broker Token，权限设为 `0600`，该文件被 Git 忽略。保留原有 `CREDENTIAL_ENCRYPT_KEY`，否则已保存的用户连接凭据不能解密。按 `Ctrl+C` 停止 Node 进程，PostgreSQL 和 Redis 不随脚本退出。

### 方式三：整套开发环境运行在 Docker

```bash
pnpm dev:detached  # 等价于 docker compose up -d --build
pnpm dev:logs
# 停止开发容器：pnpm dev:down
```

此方式使用根目录 `docker-compose.yml`、源码挂载和 Vite 开发服务器。打开 <http://localhost:5173>；默认管理员见 `config/docker.json`。宿主机不安装 pnpm 时也可直接执行对应的 Docker Compose 命令。

### 常见启动问题与检查

| 现象 | 处理 |
| --- | --- |
| `PostgreSQL is not reachable at 127.0.0.1:5433` | 执行 `docker compose up -d --wait postgres redis`，再核对 `.env.local`；`dev:local` 不会自动启动数据库。 |
| PostgreSQL 拒绝账号或数据库不存在 | 核对 `DATABASE_URL` 的账号、密码和库名；使用本机数据库时须先创建账号与数据库。 |
| `5173`、`8000` 或 `9001` 已被占用 | 停止原有开发进程或整套开发容器，再启动选定的开发方式。 |

在已安装依赖的宿主机执行代码检查：

```bash
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
