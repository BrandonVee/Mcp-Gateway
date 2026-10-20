# Mcp-Gateway

MCP 统一认证与多入口网关，集中管理服务接入、访问权限和用户连接。

一条部署命令即可在服务器上跑起来：统一应用镜像包含管理网页、Nginx、Auth Server 和 Gateway，只提供一个 HTTP 入口（默认 `127.0.0.1:8080`），由你自己的 Nginx 提供 HTTPS。

```text
                       ┌─ /mcp/search    ──> 外部搜索服务实例池
MCP Client ── OAuth ──>│  Gateway
                       └─ /mcp/knowledge ──> 外部知识库服务
                              │
                              └─ 校验统一 Auth Server 签发的 JWT
```

## 核心特性

- **统一身份**：OAuth 2.1 Authorization Code + PKCE，一份登录同时用于管理后台与 MCP 客户端。
- **多入口路由**：按逻辑 Server 注册外部 MCP Endpoint，支持多实例、粘性会话与健康探测。
- **细粒度授权**：用户与 Server 多对多授权，支持通配符与即时撤销。
- **上游凭据**：按用户加密保存 API Key 或 OAuth 令牌，请求时注入，平台令牌不外泄。
- **管理后台**：用户、服务、授权、连接、调用监控与管理操作审计。支持亮色、深色和跟随系统；登录页、管理端及个人连接中心的外观按钮会记住当前浏览器的选择。
- **中英文界面**：登录页、管理台与连接中心共用语言切换。

## 服务器部署（推荐）

除下载项目外，以下命令均在项目根目录执行。服务器需要 **Docker Engine、Docker Compose 插件和 Git**，无需在宿主机安装 Node.js 或 pnpm；另外准备域名、HTTPS 证书和反向代理。

### 1. 下载项目并启动

```bash
git clone https://github.com/BrandonVee/Mcp-Gateway.git
cd Mcp-Gateway
./scripts/deploy.sh
```

脚本默认拉取已发布镜像 `brandonvee/mcp-gateway:latest`（支持 `linux/amd64` 与 `linux/arm64`）。需要固定版本或改用源码构建时：

```bash
MCP_VERSION=v0.1.2 ./scripts/deploy.sh --yes   # 固定到已发布版本
MCP_IMAGE_PREFIX= ./scripts/deploy.sh --yes    # 用当前代码本机构建
```

交互模式下只需填写 **HTTP 端口**（默认 `8080`，仅监听回环地址）和 **首次管理员密码**（用户名固定 `admin`，至少 16 个字符，留空自动生成）；仓库、镜像名和版本都已内置 —— 拉取已发布镜像时**默认就是最新版本**，回车即可，需要固定版本时再输入 `vX.Y.Z` 或提交号。自动化部署用 `--yes` 跳过提示，同样使用最新版本。配置保存在 `deploy/single-host/`：`runtime.env`（权限 `0600`）与 `config.json`，自定义目录用 `MCP_DEPLOY_DIR`。

部署完成后确认状态：

```bash
docker compose --env-file deploy/single-host/runtime.env -f deploy/compose.single-host.yml ps
curl --fail http://127.0.0.1:8080/healthz
```

### 2. 配置 HTTPS 反向代理

在宿主机已有的 HTTPS `server` 中加入以下内容（修改过 HTTP 端口时同步调整 `proxy_pass`）：

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
sudo systemctl reload nginx                    # Linux / systemd 示例
curl --fail https://mcp.example.com/healthz    # 替换为实际域名
```

### 3. 登录并完成系统设置

通过 HTTPS 地址打开后台，使用初始管理员登录（初始密码也保存在 `runtime.env` 的 `ADMIN_PASSWORD`），系统会引导进入**系统设置**：

1. **对外访问地址**：填写 Nginx 对外的 HTTPS 根地址，例如 `https://mcp.example.com`；OAuth、MCP 入口与连接中心统一使用此地址。
2. **启用上游白名单**：默认开启。开启时在**可信上游主机**填写计划接入的 MCP 服务主机名或 IP，每行一个；名单为空时拒绝所有上游。
3. 按需调整**用户注册**、**调用采集与保留**、**告警阈值**，保存设置。

未保存访问地址时，管理后台可用，OAuth 与 MCP 接入返回 `503 system_not_configured`。设置持久化在 PostgreSQL 中，重启后继续生效；更换地址后已有 MCP 客户端需重新授权。

想接入已有 PostgreSQL / Redis 而不是让脚本创建，改用网页初始化：`docker compose -f deploy/compose.setup.yml up -d`，用日志中的初始化密钥在网页完成连接与管理员设置，详见 [Docker Hub 使用说明](docs/dockerhub.md)。

### 升级与备份

```bash
./scripts/backup.sh                            # 升级前备份数据库、配置和密钥
./scripts/deploy.sh                            # 源码构建部署前先 git pull --ff-only
./scripts/deploy.sh --yes                      # 镜像部署：重跑即升级到最新版本
```

镜像部署默认跟随 `latest`，每次重跑都会拉最新已发布版本；需要固定版本时用 `MCP_VERSION=v0.3.2 ./scripts/deploy.sh --yes`（也可在交互提示里输入版本）。本机构建仍按当前代码的提交号打标签。

部署脚本默认开启网页更新，登录后在「系统设置 → 系统更新」可直接更新到最新镜像，无需额外设置环境变量。需要关闭时使用 `MCP_UPDATE_ENABLED=false ./scripts/deploy.sh --yes`，该选择会保存并在后续部署中沿用。详见 [网页端一键更新](docs/production.md#网页端一键更新默认开启)。

备份默认写入 `backups/`，包含 PostgreSQL、配置和凭据加密密钥（权限 `0600`，保留 14 天，**不含 Redis 会话**）。定时备份与恢复步骤见 [备份与恢复](docs/production.md#备份与恢复)。不要用 `down -v` 停止生产部署，它会删除数据库卷。

健康检查失败、注册表不可用、Redis 异常、上游连接失败、监控积压或告警未通知时，按 [故障排查](docs/troubleshooting.md) 处理。

### 常见部署问题

| 现象                                 | 排查与处理                                                           |
| ------------------------------------ | -------------------------------------------------------------------- |
| 无法通过服务器 IP 访问 `8080`        | 默认只监听回环地址，使用已配置的 HTTPS 域名；初始化可使用 SSH 隧道。 |
| 管理员提示凭据无效                   | 核对该部署的密码；已有数据库账号不会因修改 `ADMIN_PASSWORD` 被重置。 |
| MCP 返回 `503 system_not_configured` | 在“系统设置”保存真实 HTTPS 对外访问地址。                            |
| 无法注册上游服务                     | 检查白名单开关、可信上游主机和容器到上游的连通性。                   |
| 应用未就绪或容器 unhealthy           | 用对应 Compose 文件查看 `ps` 与应用日志，再检查 PostgreSQL / Redis。 |

## Docker 部署（不用克隆源码）

只需要 Docker 和 Compose 时，直接用已发布镜像 `brandonvee/mcp-gateway` 启动三个容器：应用、PostgreSQL、Redis。

新建目录并生成密钥（只执行一次，不要覆盖已有 `.env`）：

```bash
mkdir mcp-gateway && cd mcp-gateway
umask 077
{
  echo MCP_VERSION=latest
  echo POSTGRES_PASSWORD=$(openssl rand -hex 32)
  echo REDIS_PASSWORD=$(openssl rand -hex 32)
  echo INTERNAL_API_TOKEN=$(openssl rand -hex 32)
  echo CREDENTIAL_BROKER_TOKEN=$(openssl rand -hex 32)
  echo CREDENTIAL_ENCRYPT_KEY=$(openssl rand -hex 32)
  echo ADMIN_PASSWORD=$(openssl rand -hex 32)
} > .env
```

保存为 `compose.yml`：

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: mcp
      POSTGRES_USER: mcp
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?}
    volumes: ['postgres_data:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U mcp -d mcp']
      interval: 3s
      timeout: 3s
      retries: 30
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ['sh', '-c', 'exec redis-server --appendonly yes --requirepass "$$REDIS_PASSWORD"']
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD:?}
    volumes: ['redis_data:/data']
    healthcheck:
      test: ['CMD-SHELL', 'REDISCLI_AUTH=$$REDIS_PASSWORD redis-cli ping | grep -q PONG']
      interval: 3s
      timeout: 3s
      retries: 30
  mcp-server:
    container_name: ${COMPOSE_PROJECT_NAME:-mcp-gateway}-server
    image: brandonvee/mcp-gateway:${MCP_VERSION:-latest}
    restart: unless-stopped
    stop_grace_period: 15s
    read_only: true
    tmpfs: ['/tmp']
    cap_drop: ['ALL']
    security_opt: ['no-new-privileges:true']
    environment:
      DATABASE_URL: postgres://mcp:${POSTGRES_PASSWORD:?}@postgres:5432/mcp
      REDIS_URL: redis://:${REDIS_PASSWORD:?}@redis:6379/0
      INTERNAL_API_TOKEN: ${INTERNAL_API_TOKEN:?}
      CREDENTIAL_BROKER_TOKEN: ${CREDENTIAL_BROKER_TOKEN:?}
      CREDENTIAL_ENCRYPT_KEY: ${CREDENTIAL_ENCRYPT_KEY:?}
      ADMIN_USERNAME: admin
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:?}
      AUTH_TRUSTED_PROXY_IPS: ${AUTH_TRUSTED_PROXY_IPS:-}
    ports: ['127.0.0.1:8080:8080']
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
volumes:
  postgres_data:
  redis_data:
```

```bash
docker compose up -d --wait
curl --fail http://127.0.0.1:8080/healthz
```

管理员为 `admin`，初始密码在 `.env` 的 `ADMIN_PASSWORD`。之后与一键部署相同：配置 HTTPS 反向代理并登录，在“系统设置”填写对外访问地址。升级：

```bash
docker compose pull mcp-server
docker compose up -d --wait mcp-server
```

调用限流与统计依赖真实客户端 IP；由宿主机 Nginx 代理时，把 `AUTH_TRUSTED_PROXY_IPS` 填为 Nginx 所在网络的网关地址后重建应用（见 [Docker Hub 使用说明](docs/dockerhub.md)）。该文档还包含备份与固定版本说明。

### 只跑应用镜像，在网页里连接已有数据库

已有 PostgreSQL / Redis，或想先起容器再填连接信息时，只启动一个应用容器即可，不需要写任何环境变量：

```bash
docker volume create mcp-gateway-data
docker run -d --name mcp-gateway-server --restart unless-stopped --stop-timeout 15 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  -p 127.0.0.1:8080:8080 -v mcp-gateway-data:/app/data \
  brandonvee/mcp-gateway:latest
docker logs mcp-gateway-server
```

也可以用仓库里的 `deploy/compose.setup.yml`（`docker compose -f deploy/compose.setup.yml up -d`），内容同上。

1. 在日志中找到 `[setup] initialization key:` 后面的初始化密钥。
2. 打开 `http://127.0.0.1:8080`；远程部署可在自己电脑上执行 `ssh -L 18080:127.0.0.1:8080 用户@服务器`，再访问 `http://127.0.0.1:18080`。
3. 输入初始化密钥，点击“验证并继续”。
4. 依次填写 PostgreSQL、Redis 参数，**每一步独立测试通过后才进入下一步**；可返回修改，已填内容保留。
5. 设置管理员账号与至少 16 个字符的密码，点击“保存并启动”：程序会重测两项连接、生成应用密钥、保存配置并自动进入管理页面。
6. 之后与上面相同：配置 HTTPS 反向代理并登录，在“系统设置”填写对外访问地址。

注意事项：

- **地址要从容器内访问。** `127.0.0.1` / `localhost` 指应用容器自身；另一容器用同一 Docker 网络的服务名，宿主机上的数据库可用 `host.docker.internal`（Linux 需在 `docker run` 加 `--add-host host.docker.internal:host-gateway`，并确认数据库监听地址与防火墙）。
- 配置与凭据加密密钥保存在 `mcp-gateway-data` 卷的 `/app/data/bootstrap.json`，**必须与该卷一起备份**；初始化后网页配置接口关闭，重启或重建容器会读取同一个卷。不要用空卷连接已有业务库，否则之前保存的上游凭据无法解密。
- 升级时保留该卷：拉取新镜像后停止并删除旧容器，再用相同参数重建，不需要重新初始化。
- 等待初始化时 `/healthz` 返回 `mode: setup, ready: false`；初始化后才提供完整健康状态。管理员登录使用安全 Cookie，需要 HTTPS 域名（或上面的 SSH 隧道完成初始化）。

## 日常使用

### 注册 MCP 服务

在管理后台**服务**页注册实际 MCP Endpoint（外部 Streamable HTTP 地址，支持多实例）。项目不内置 MCP Server，新数据库的服务列表为空。客户端入口为：

```text
https://mcp.example.com/mcp/{SERVER_NAME}
```

### 创建用户与分配权限

管理员可创建用户、重置密码、禁用账号，并从用户或服务两个视角分配可访问的 Server；通配符 `*` 表示全部 Server。最后一名启用管理员不可禁用或删除。

没有账号的用户可以自行注册：**登录页**的“还没有账号？立即注册”，或 MCP 客户端 OAuth 登录页的“创建账号”。两者规则一致，注册成功即登录，账号为普通用户。系统设置的**允许自行注册**默认开启，关闭后两个入口都会隐藏。管理员可在服务上开启**新注册用户默认可访问**，让新用户自动获得该服务权限。

### 客户端接入

服务的**本系统访问认证**独立于上游认证，默认 **OAuth**。在客户端的 `mcpServers` 中粘贴连接中心复制的配置，首次连接会跳转 OAuth 登录：

```json
{
  "mcpServers": {
    "external-search": { "url": "https://mcp.example.com/mcp/external-search" }
  }
}
```

也可在服务注册或编辑时选择 **用户 API Key** 或 **免认证**：

- **用户 API Key**：在个人连接中心的**访问密钥**中创建密钥，以 `Authorization: Bearer <API Key>` 访问。复制的客户端配置含 `YOUR_API_KEY` 占位符，需要替换。密钥沿用所属账号的服务权限，撤销、账号禁用或密码重置后失效；完整密钥仅在创建时返回，数据库只保存哈希。
- **免认证**：客户端可直接访问 MCP 地址。上游只能使用无需认证或管理员统一配置的凭据，不会读取个人上游凭据。

新服务的每分钟请求数、每日工具调用配额、最大并发数均默认 **0**，表示不限制。已有服务的显式限制保持原值。填写正整数后按用户和服务单独计数；免认证访问按来源 IP 计数。

### 上游需要凭据时

服务配置了 API Key 或 OAuth 时，用户在**个人连接中心**（管理员从侧边栏进入）为该服务连接自己的凭据；凭据加密保存，只在该用户的请求中注入上游。用户未连接时 Gateway 返回 `409 connection_required` 并给出连接地址。

## 本地开发

需要 **Node.js 20.19+ 或 ≥ 22.12、pnpm 10.33.0**，以及可用的 PostgreSQL 和 Redis：

```bash
pnpm install --frozen-lockfile
docker compose up -d --wait postgres redis
pnpm dev:local            # 打开 http://localhost:5173，默认管理员 admin / admin123
pnpm typecheck && pnpm test:unit
```

其他开发方式（全部本机服务、整套容器开发）、客户端验证脚本与冒烟测试见 [开发文档](docs/development.md)。

## 文档

| 文档                                                   | 内容                                                 |
| ------------------------------------------------------ | ---------------------------------------------------- |
| [生产部署与上线检查](docs/production.md)               | 分离部署、外部数据库、网络与密钥、备份恢复、自动发布 |
| [故障排查](docs/troubleshooting.md)                    | Registry、Redis、上游、监控与告警通知问题            |
| [架构与运行机制](docs/architecture.md)                 | 权限模型、状态存储、实例池、配置文件、日志与监控     |
| [上游服务接入与用户凭据](docs/upstream-connections.md) | 注册外部 MCP Server、API Key / OAuth 连接、凭据加密  |
| [管理 API 与管理端](docs/admin-api.md)                 | 管理接口清单、授权与账号生命周期、前端能力           |
| [本地开发与测试](docs/development.md)                  | 三种开发方式、客户端验证、冒烟测试                   |
| [Docker Hub 使用说明](docs/dockerhub.md)               | 直接用镜像启动、连接已有数据库                       |
