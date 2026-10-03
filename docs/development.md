# 本地开发与测试

宿主机运行源码需 **Node.js 20.19+（20.x）或 ≥ 22.12、pnpm 10.33.0**（与 Vite 要求一致），以及可用的 PostgreSQL 和 Redis。以下开发方式任选一种，不要同时启动两组 Auth、Gateway 和管理前端。

## 方式一：容器运行数据库，宿主机运行应用

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

## 方式二：全部使用本机服务

先安装并启动 PostgreSQL 和 Redis，按 `config/default.json` 创建 PostgreSQL 用户 `mcp`、数据库 `mcp`；默认连接为 `postgres://mcp:mcp-dev-password@localhost:5432/mcp` 和 `redis://localhost:6379`。若已有 `.env.local`，确认其中地址与本机服务一致，再执行：

```bash
pnpm install --frozen-lockfile
pnpm dev:local
```

两种方式都由 `pnpm dev:local` 启动 Auth Server、Gateway 和管理前端；Auth 启动时自动执行数据库迁移。打开 <http://localhost:5173>，首次空库默认管理员为 `admin` / `admin123`（仅开发环境，见 `config/default.json`）。已有账号继续使用数据库中的密码。

开发模式保留独立入口：管理网页默认 `5173`、OAuth 认证默认 `9001`、MCP 网关默认 `8000`。即使数据库保存了生产访问地址，本地认证与 MCP 发现仍使用当前配置文件中的对应地址；生产统一应用镜像则使用后台保存的公开访问地址。直接连接本地网关的客户端也可在 `8000` 上发现认证元数据、注册客户端和交换令牌，浏览器授权会跳转到认证服务。

首次运行会在 `.env.local` 中补充凭据加密密钥和内部 Broker Token，权限设为 `0600`，该文件被 Git 忽略。保留原有 `CREDENTIAL_ENCRYPT_KEY`，否则已保存的用户连接凭据不能解密。按 `Ctrl+C` 停止 Node 进程，PostgreSQL 和 Redis 不随脚本退出。

## 方式三：整套开发环境运行在 Docker

```bash
pnpm dev:detached  # 等价于 docker compose up -d --build
pnpm dev:logs
# 停止开发容器：pnpm dev:down
```

此方式使用根目录 `docker-compose.yml`、源码挂载和 Vite 开发服务器。打开 <http://localhost:5173>；默认管理员见 `config/docker.json`。宿主机不安装 pnpm 时也可直接执行对应的 Docker Compose 命令。

## 常见启动问题与检查

| 现象                                            | 处理                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `PostgreSQL is not reachable at 127.0.0.1:5433` | 执行 `docker compose up -d --wait postgres redis`，再核对 `.env.local`；`dev:local` 不会自动启动数据库。 |
| PostgreSQL 拒绝账号或数据库不存在               | 核对 `DATABASE_URL` 的账号、密码和库名；使用本机数据库时须先创建账号与数据库。                           |
| `5173`、`8000` 或 `9001` 已被占用               | 停止原有开发进程或整套开发容器，再启动选定的开发方式。                                                   |

在已安装依赖的宿主机执行代码检查：

```bash
pnpm typecheck
pnpm test:unit
pnpm format:check
```

代码风格由 Prettier 统一（配置见 `.prettierrc.json`）：`pnpm format` 写入格式，`pnpm format:check` 只检查，CI 的 `verify` 任务会执行后者。

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

隔离数据库回归测试覆盖旧库升级、同名账号重建、认证版本撤销、最后管理员并发保护、跨标签页身份切换，以及上游 OAuth 短寿命令牌、暂时错误恢复和回调/刷新/撤销并发；结束后删除测试库或 schema。单元测试还覆盖 MCP 会话不重复返回 session header 及长 SSE 请求时的续期。

端到端测试覆盖统一登录、server 列表过滤、未授权入口返回 403、用户授权后进入指定入口，以及同一逻辑 server 的会话粘性与负载分配。
