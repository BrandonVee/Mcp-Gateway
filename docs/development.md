# 本地开发与测试

宿主机运行源码需 **Node.js 20.19+（20.x）或 ≥ 22.12、pnpm 10.33.0**（与 Vite 要求一致），以及可用的 PostgreSQL 和 Redis。以下开发方式任选一种，不要同时启动两组 Auth、Gateway 和管理前端。

## 路径别名与工具边界

路径映射统一定义在根目录 `tsconfig.base.json`，所有工作区继承；Vite 从同一份配置读取映射，esbuild 显式使用它，根目录 `tsconfig.json` 供 tsx 脚本解析。根配置不重复执行各包的类型检查，统一使用 `pnpm typecheck`。

| 别名           | 源码目录                     |
| -------------- | ---------------------------- |
| `@/auth/*`     | `packages/auth-server/src/*` |
| `@/gateway/*`  | `packages/gateway/src/*`     |
| `@/web/*`      | `packages/admin-web/src/*`   |
| `@/shared/*`   | `packages/shared/src/*`      |
| `@/fixtures/*` | `tests/fixtures/src/*`       |
| `@/scripts/*`  | `scripts/*`                  |

例如：`import { db } from '@/auth/infrastructure/database/client.js'`。同一个测试进程会加载多个包，因此别名显式标识包，不按当前工作目录改变 `@/` 的含义。现有 `@mcp/shared` 公共入口继续使用；浏览器只导入 shared 中不依赖 Node 的具体模块，不能导入包含配置文件读取的服务端入口。

- TypeScript 模块引用统一使用上述别名；NodeNext 服务端保留 `.js` 扩展名。
- CSS 内部引用、字体和图片 URL、`new URL(..., import.meta.url)`、数据库迁移路径是资源定位，不改写为模块别名。
- 直接由 Node 运行的 `.mjs` 运维脚本使用原生模块路径，不为它们新增自定义加载器。
- 优先使用已有库和标准库：Zod 负责凭据契约校验，Node `crypto` 负责 PKCE 和安全比较，`URL` 负责地址解析，`node:util.parseEnv` 负责本地环境文件解析。不要手写替代实现。
- 跨前后端的纯校验放 `packages/shared/src/security`；仅服务端可用的安全工具独立存放。凭据归属、权限检查、事务锁和 OAuth 刷新仍属于业务服务，不能塞进通用 utils。
- 只有明确复用的逻辑才提取小函数；不创建万能请求客户端、通用仓储或只转发导出的兼容入口。

`modules/connections/pool/` 维护仍在使用的实例池认证与旧地址回调，`modules/upstreams/` 维护每个 MCP Server 独立认证。前者不是未使用文件：移除它需要先迁移现有池、凭据和 OAuth 提供方登记的回调地址。

新增的 `scripts/module-aliases.test.ts` 从根目录及所有工作区验证跨包导入；`pnpm build:admin`、`pnpm build:runtime` 和 `pnpm --filter @mcp/auth-server db:generate` 分别检查前端、服务端及 Drizzle 的解析。

## 方式一：容器运行数据库，宿主机运行应用

在项目根目录安装依赖并启动数据库：

```bash
pnpm install --frozen-lockfile
bash scripts/ensure-mcp-network.sh
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
pnpm dev:detached  # 先确保共享网络存在，再执行 docker compose up -d --build
pnpm dev:logs
# 停止开发容器：pnpm dev:down
```

此方式使用根目录 `docker-compose.yml`、源码挂载和 Vite 开发服务器。打开 <http://localhost:5173>；默认管理员见 `config/docker.json`。宿主机不安装 pnpm 时也可直接执行对应的 Docker Compose 命令。

Auth 和 Gateway 容器会加入共享的 `mcp-gateway` bridge 网络；`pnpm dev` 和 `pnpm dev:detached` 自动创建它。直接运行 Compose 前先执行 `bash scripts/ensure-mcp-network.sh`。其他 MCP 容器加入同一网络后，可通过 `http://容器名:容器内部端口/mcp` 接入，并在系统设置中允许对应的上游主机。`pnpm dev:local` 的应用仍运行在宿主机，访问容器时使用发布到宿主机的端口。

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

测试上游、测试用户与注册数据位于 `tests/fixtures/`，仅用于独立测试数据库，不参与 `pnpm dev:local`、默认 Docker Compose 或生产 runtime 镜像。CI 通过 `.github/compose.app-ci.yml` 显式启动测试上游并导入测试数据。

PR 和非 main 分支推送运行 `pnpm smoke --core`，验证服务就绪、OAuth 登录、MCP 工具发现与调用，以及无效令牌、未授权服务和管理员接口的访问限制。推送到 main 或手动运行 CI 时执行完整回归：`pnpm smoke`、其余专项集成测试，以及 `single-host` 的部署、升级和备份恢复演练。自动发布必须等待完整验证通过。

隔离数据库回归测试覆盖旧库升级、同名账号重建、认证版本撤销、最后管理员并发保护、跨标签页身份切换，以及上游 OAuth 短寿命令牌、暂时错误恢复和回调/刷新/撤销并发；结束后删除测试库或 schema。单元测试还覆盖 MCP 会话不重复返回 session header 及长 SSE 请求时的续期。

端到端测试覆盖统一登录、server 列表过滤、未授权入口返回 403、用户授权后进入指定入口，以及同一逻辑 server 的会话粘性与负载分配。

## 邮箱注册与验证

新用户注册和管理员新建账号均使用规范化的小写邮箱作为用户名。已有账号保留原用户名，同时可用已绑定邮箱登录；初始管理员仍可用原账号登录。

管理员在「系统设置 → 邮箱配置」保存并测试 SMTP 后，可在「用户注册」开启「注册时验证邮箱」。关闭时直接注册；开启后网页和 OAuth 授权页均要求六位验证码，验证码 10 分钟有效、60 秒内只能发送一次、每邮箱每小时最多发送 5 次。验证与创建账号在同一事务中完成，成功后验证码只能消费一次，失败或过期不能创建账号。

新增数据库迁移随 Auth 启动执行。隔离数据库回归脚本 `scripts/signup-regression.mts` 只接受名为 `mcp_signup_test_*` 的测试库，通过 `DATABASE_URL` 指定，覆盖邮箱身份、旧账号登录、验证开关、错误/过期/跨邮箱验证码与并发注册。
