# MCP Gateway

集中管理 MCP 服务、访问权限和上游凭据，为客户端提供统一入口。

[![CI](https://github.com/BrandonVee/Mcp-Gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/BrandonVee/Mcp-Gateway/actions/workflows/ci.yml)

[快速部署](#快速部署) · [认证与访问控制](#认证与访问控制) · [日常使用](#日常使用) · [开发与测试](#开发与测试) · [详细文档](#详细文档)

一个应用镜像包含管理网页、认证服务、MCP 网关和内部 Nginx，PostgreSQL 与 Redis 独立运行。支持 `linux/amd64` 和 `linux/arm64`，生产环境只需对外提供一个 HTTPS 地址。

```mermaid
flowchart LR
    Client["MCP 客户端"] --> Access["本系统入口认证<br/>OAuth / 用户 API Key / 免认证"]
    Access --> Gateway["逻辑服务<br/>/mcp/{service}"]
    Gateway --> A["MCP Server A<br/>独立上游认证"]
    Gateway --> B["MCP Server B<br/>独立上游认证"]
```

## 能做什么

| 能力       | 说明                                                                        |
| ---------- | --------------------------------------------------------------------------- |
| 服务接入   | 多上游工具聚合、实例池、粘性会话与健康探测。                                |
| 入口认证   | 每个 MCP 服务独立选择 OAuth、用户 API Key 或免认证，默认 OAuth。            |
| 上游凭据   | 分别配置个人或管理员统一使用的 API Key / OAuth 凭据，加密保存并按请求注入。 |
| 用户与权限 | 用户和服务的多对多授权、通配符、账号禁用与权限即时回收。                    |
| 调用与运维 | 调用日志、用量统计、限流与配额、告警通知、管理操作审计。                    |
| 管理界面   | 管理后台与个人连接中心，中英文切换，亮色、深色及跟随系统。                  |

## 快速部署

### 方式一：一键部署应用与数据库

服务器准备 **Docker Engine、Docker Compose 插件和 Git**，以及域名、HTTPS 证书与反向代理。宿主机不需要安装 Node.js 或 pnpm。

```bash
git clone https://github.com/BrandonVee/Mcp-Gateway.git
cd Mcp-Gateway
./scripts/deploy.sh
```

按提示确认 HTTP 端口、镜像来源和初始管理员密码：

- 默认拉取 `brandonvee/mcp-gateway:latest`，同时启动 PostgreSQL 和 Redis。
- HTTP 默认监听 `127.0.0.1:8080`。远程访问使用 HTTPS 反向代理。
- 管理员用户名为 `admin`，密码至少 16 个字符，留空则自动生成。
- 配置保存在 `deploy/single-host/`，其中 `runtime.env` 权限为 `0600`。自定义目录可设置 `MCP_DEPLOY_DIR`。

启动后检查健康状态：

```bash
curl --fail http://127.0.0.1:8080/healthz
```

脚本也支持非交互执行和本机构建：

```bash
./scripts/deploy.sh --yes                    # 使用最新发布镜像
MCP_VERSION=vX.Y.Z ./scripts/deploy.sh --yes  # 将 vX.Y.Z 替换为已发布版本
MCP_IMAGE_PREFIX= ./scripts/deploy.sh --yes   # 从当前代码构建
```

### 方式二：仅启动应用，连接已有数据库

无需克隆仓库，准备好容器可访问的 PostgreSQL 和 Redis 后执行：

```bash
docker volume create mcp-gateway-data
docker run -d --name mcp-gateway-server \
  --restart unless-stopped --stop-timeout 15 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  -p 127.0.0.1:8080:8080 -v mcp-gateway-data:/app/data \
  brandonvee/mcp-gateway:latest

docker logs mcp-gateway-server
```

在日志中找到 `[setup] initialization key:`，打开初始化页面，依次验证 PostgreSQL、Redis，设置管理员账号并保存。远程初始化可通过 SSH 隧道访问：

```bash
ssh -L 18080:127.0.0.1:8080 用户@服务器
# 然后在自己的电脑打开 http://127.0.0.1:18080
```

连接地址必须从容器内可访问：容器中的 `localhost` 指应用自身。初始化配置和凭据加密密钥保存在 `mcp-gateway-data` 卷，升级时保留并备份该卷。

需要不克隆仓库、同时启动应用和数据库的完整 Compose 示例，见 [Docker Hub 使用说明](docs/dockerhub.md)。

### 配置 HTTPS 与首次登录

两种部署方式都需要配置 HTTPS。将以下内容加入宿主机已有的 HTTPS `server`，按实际 HTTP 端口调整 `proxy_pass`：

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
sudo systemctl reload nginx                   # Linux / systemd 示例
curl --fail https://mcp.example.com/healthz    # 替换为实际域名
```

通过 HTTPS 登录后台，在**系统设置**中完成以下配置：

1. **对外访问地址**：填写公开的 HTTPS 根地址，例如 `https://mcp.example.com`。
2. **可信上游主机**：白名单默认开启，每行填写一个上游主机名或 IP；开启但名单为空时拒绝所有上游。
3. 按需调整用户注册、调用采集与保留、告警和通知选项，保存设置。

未保存对外访问地址时，管理后台可用，OAuth 与 MCP 接入返回 `503 system_not_configured`。更换地址后，已有 MCP 客户端需要重新授权。

宿主机反向代理部署应配置 `AUTH_TRUSTED_PROXY_IPS`，以正确识别客户端 IP，详见 [Docker 部署说明](docs/dockerhub.md)。

## 认证与访问控制

**客户端访问本系统**与**本系统访问上游**是两层独立认证。入口选择 OAuth，不要求上游也使用 OAuth；用户访问密钥也不等于上游 API Key。

### 客户端 → 本系统

在服务注册或编辑中的**本系统访问认证**选择：

| 方式              | 客户端如何连接                                                                 | 访问范围                     |
| ----------------- | ------------------------------------------------------------------------------ | ---------------------------- |
| **OAuth（默认）** | 按客户端提示登录，使用 Authorization Code + PKCE。                             | 当前账号获准访问的服务。     |
| **用户 API Key**  | 在「个人连接中心 → 访问密钥」创建，以 `Authorization: Bearer <API Key>` 访问。 | 沿用密钥所属账号的服务权限。 |
| **免认证**        | 直接连接 MCP 地址。                                                            | 该服务允许匿名访问。         |

访问密钥的完整内容仅在创建时显示，数据库只保存哈希。撤销密钥、禁用账号或重置密码后，后续请求失效。免认证服务的上游只能使用无需认证或管理员统一配置的凭据，不会读取个人上游凭据。

### 本系统 → 上游 MCP Server

每个上游分别配置认证，可选择无需认证、管理员统一 API Key / OAuth，或用户个人 API Key / OAuth。需要个人凭据时，用户先在连接中心完成连接；未连接会返回 `409 connection_required` 和连接地址。

### 限流与配额

新服务的**每分钟请求数、每日工具调用配额、最大并发数默认均为 `0`，表示不限制**。填写正整数后生效，已有服务的限制不会被升级覆盖。

认证访问按用户和服务单独计数，免认证访问按来源 IP 计数。每日配额按已受理的工具调用计数，包含失败调用，在 UTC 零点重置。

## 日常使用

### 接入第一个 MCP 服务

新数据库的服务列表为空，需要接入已有的 MCP Server；应用镜像不内置业务 MCP 服务。

1. 在**服务注册**创建逻辑端点，设置名称、描述、本系统访问认证和限流策略。
2. 为端点添加 MCP Server，填写 Gateway 可访问的 HTTP/HTTPS Streamable MCP 地址，分别配置上游认证。
3. 为使用 OAuth 或用户 API Key 的账号分配服务权限。通配符 `*` 表示全部服务。
4. 需要个人上游凭据时，在**个人连接中心**配置 API Key 或完成 OAuth 授权。
5. 从连接中心复制 MCP 配置，粘贴到客户端的 `mcpServers` 字段。

客户端统一连接 Gateway 地址，例如：

```json
{
  "mcpServers": {
    "external-search": {
      "type": "streamableHttp",
      "url": "https://mcp.example.com/mcp/external-search"
    }
  }
}
```

OAuth 服务首次连接会提示登录；API Key 服务复制的配置含 `YOUR_API_KEY` 占位符，替换为本系统访问密钥后使用；免认证服务无需登录。

### 用户、日志与告警

- **用户与授权**：创建账号、分配服务、重置密码、禁用或删除用户。最后一名启用管理员受到保护。
- **自行注册**：系统设置中的注册开关默认开启。服务可设置“新注册用户默认可访问”，已有用户权限保持不变。
- **调用日志**：按时间、服务、工具和结果筛选，支持工具名称模糊搜索；下拉筛选与完整时间范围选择后自动查询。
- **用量统计**：工具调用量只统计 `tools/call`，初始化与工具发现不计入；输入输出记录受系统和服务的采集开关控制。
- **告警与审计**：配置调用错误率、延迟阈值和通知，查看管理员操作记录。

## 升级与备份

一键部署默认开启网页更新，可在「系统设置 → 系统更新」选择镜像版本。使用部署脚本时，也可在项目根目录执行：

```bash
./scripts/backup.sh
./scripts/deploy.sh --yes
```

默认镜像部署会拉取 `latest`；固定版本使用 `MCP_VERSION=vX.Y.Z`。从源码构建时，先更新本地代码，再运行部署脚本。已有账号的密码不会因修改 `ADMIN_PASSWORD` 被重置。

一键部署的备份默认写入 `backups/`，包含数据库、配置和凭据加密密钥，保留 14 天，不包含 Redis 会话。使用网页初始化的部署还应备份 `/app/data` 数据卷。停止生产服务时不要使用 `down -v`，它会删除数据卷。

完整步骤见 [网页端更新](docs/production.md#网页端一键更新默认开启)、[备份与恢复](docs/production.md#备份与恢复)。

## 开发与测试

需要 **Node.js 20.19+（20.x）或 ≥ 22.12、pnpm 10.33.0**。以下示例用 Docker 运行 PostgreSQL 和 Redis，在宿主机运行应用：

```bash
pnpm install --frozen-lockfile
docker compose up -d --wait postgres redis
```

在 `.env.local` 中配置连接地址，保留该文件中已有的应用密钥：

```dotenv
DATABASE_URL=postgres://mcp:mcp-dev-password@127.0.0.1:5433/mcp
REDIS_URL=redis://127.0.0.1:6380
```

```bash
pnpm dev:local            # http://localhost:5173
```

首次空库的开发账号为 `admin` / `admin123`，已有数据库使用原账号密码。应用启动时自动执行数据库迁移；`dev:local` 会补充缺失的本地应用密钥。

代码检查与构建：

```bash
pnpm format:check
pnpm typecheck
pnpm test:unit
pnpm build:admin
pnpm build:runtime
```

全部使用本机服务、完整容器开发和端到端测试，见 [开发文档](docs/development.md)。

## 常见问题

| 现象                                 | 处理                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| 无法通过服务器 IP 访问 `8080`        | 默认只监听回环地址，使用 HTTPS 域名；首次初始化可通过 SSH 隧道访问。         |
| 管理员提示凭据无效                   | 核对部署时的密码；修改启动变量不会重置已有账号。                             |
| MCP 返回 `503 system_not_configured` | 在系统设置保存真实的 HTTPS 对外访问地址。                                    |
| 上游无法注册或连接                   | 检查可信上游白名单，以及从 Gateway 容器到上游的连通性。                      |
| MCP 返回 `409 connection_required`   | 在个人连接中心为该上游补充个人凭据。                                         |
| 容器 unhealthy、调用异常或告警未送达 | 查看 Compose 服务状态与日志，再按 [故障排查](docs/troubleshooting.md) 检查。 |

## 详细文档

| 文档                                                   | 内容                                          |
| ------------------------------------------------------ | --------------------------------------------- |
| [Docker Hub 使用说明](docs/dockerhub.md)               | 镜像启动、完整 Compose 示例、已有数据库接入。 |
| [生产部署与上线检查](docs/production.md)               | 部署配置、网页更新、备份恢复、CI 与自动发布。 |
| [故障排查](docs/troubleshooting.md)                    | 注册表、Redis、上游、监控与告警问题。         |
| [架构与运行机制](docs/architecture.md)                 | 路由、权限、状态存储与运行机制。              |
| [上游服务接入与用户凭据](docs/upstream-connections.md) | 聚合与实例池、独立上游认证和凭据管理。        |
| [管理 API 与管理端](docs/admin-api.md)                 | 管理接口、账号生命周期与前端能力。            |
| [本地开发与测试](docs/development.md)                  | 开发环境、验证脚本与端到端测试。              |
