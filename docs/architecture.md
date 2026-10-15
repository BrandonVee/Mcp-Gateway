# 架构与运行机制

面向需要改动代码或排查内部行为的读者。日常部署与使用见 [README](../README.md)，生产部署与上线检查见 [生产部署文档](production.md)。

## 权限模型

- 一个 Auth Server 负责所有用户的登录和 OAuth 2.1 Authorization Code + PKCE。
- `users` 与 `mcp_servers` 通过 `user_server_access` 形成多对多关系。
- 普通用户可由管理员授予指定 Server，或授予通配符 `*` 以访问当前和未来新增的全部 Server；管理员默认拥有通配符权限。
- Access Token 的 `mcp_servers` claim 是签发时的授权快照，例如：

  ```json
  { "sub": "alice", "mcp_servers": ["search", "knowledge"] }
  ```

- Gateway 先验证 JWT 和令牌内的 Server 范围，再向 Auth Server 复核用户是否启用、当前 Server 授权是否仍有效，最后按逻辑端点的路由模式聚合独立上游，或进入旧版副本池。
- `admin` token 使用 `mcp_servers: ["*"]`，可进入全部入口。
- `/servers` 只返回当前用户有权访问的 server。

## 状态存储

- PostgreSQL 持久化用户、OAuth 客户端、授权码、Refresh Token、登录会话、签名密钥、MCP Server 和用户授权关系。
- Redis 保存 MCP Session 到后端实例的粘性路由，数据只需要保留到 Session TTL 结束。
- 数据访问统一使用 Drizzle ORM，领域表定义在 `packages/auth-server/src/infrastructure/database/schema/`，由同级 `schema.ts` 汇总。
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

## 逻辑端点与实际上游

逻辑 Server 与实例池保存在 PostgreSQL 的 `mcp_servers`、`mcp_server_instances` 表中。管理 API/界面修改数据库后，Gateway 从 Auth Server 的注册表刷新路由；并发同步共用一个请求，缓存有效时业务请求直接使用快照，未变化的配置以 ETag / 304 同步。注册表通过批量查询读取端点和上游。普通服务启动不会再从配置文件重建或覆盖这些记录。

项目不内置 MCP Server，也不会在启动时导入演示服务。新数据库的服务列表为空；管理员通过管理界面或管理 API 注册实际 MCP Endpoint，并为用户分配访问权限。

注册后，客户端使用 `http://localhost:8000/mcp/{SERVER_NAME}` 访问对应服务。上游 MCP Server 由其提供方独立部署和运行。

新逻辑端点是一个分组。`mcp_server_instances` 中的每个记录代表一个实际 MCP Server，分别保存上游地址、认证方式和认证修订号。用户凭据保存到 `upstream_credentials`，以 `(instance_id, owner)` 隔离；系统 OAuth 的 owner 为 `system`，用户连接的 owner 为 `user:<id>`。`upstream_oauth_states` 保存一次性的授权状态。

聚合模式用 Redis 保存每个用户逻辑会话对应的上游 session IDs，工具名保留原名，仅重名工具加可读 Server 前缀，展示名与实际上游的映射按用户会话保存；资源 URI 带上游命名空间；每次调用只携带该上游自己的凭据。同一逻辑会话支持并行工具调用；成员初始化按上游同步，工具映射用 Redis 比较并交换更新，业务调用不持有会话锁。执行期间只延长现存会话，断开后迟到结果不会重建会话。旧版副本池在迁移后保留，并可在管理界面显式切换到聚合模式。

以下副本池行为仅适用于 `routing_mode=pool`。Gateway 通过 Redis 保存 MCP session 与实例的粘性绑定。
Gateway 每 15 秒对已注册实例做一次 TCP/TLS 连通性探测，并在连接失败或上游返回 502/503/504 时暂时避开该实例；`/health` 会报告不可用实例数量。尚未建立 session 的 `initialize` 请求可在实例失败时尝试同一逻辑 Server 的其他实例。已有 session 始终发送到原实例，不会错误地切换到不认识该 session 的实例；原实例故障时客户端需重新初始化。探测只验证传输层连通性，不等同于 MCP 工具可用性检查。

Gateway 只读取数据库注册表；注册表在启动时不可用会导致 Gateway 启动失败，不会回退到旧的静态路由。

## 配置文件

- `config/default.json`：直接在宿主机启动服务时使用。
- `config/docker.json`：Docker Compose 使用，包含容器网络地址。
- `CONFIG_FILE`：选择基础配置文件；根目录开发 Compose 使用 `/app/config/docker.json`，生产一键部署使用生成的 `/app/config/production.json`。

配置文件只管理 Auth Server、PostgreSQL、Gateway、Redis 等服务参数；逻辑 Server、实例地址和用户授权以 PostgreSQL 为准。密钥、数据库密码等生产机密仍可通过环境变量或 Secret 注入覆盖。

推荐的一键部署和统一应用镜像使用 `SYSTEM_CONFIG_MODE=database`，基础运行配置由部署脚本或网页初始化准备，对外访问地址、可信上游、注册及监控选项在后台保存到 PostgreSQL。Auth 的系统设置读取使用 1 秒缓存和请求合并，本进程保存后立即更新且不会被迟到读取覆盖。高级分离部署使用 `SYSTEM_CONFIG_MODE=file`，需要独立的生产配置文件及 HTTPS 地址，后台系统设置只读。

生产模式会校验独立的内部令牌、凭据加密密钥及数据库/Redis 环境变量，并拒绝仓库内的开发默认凭据与演示用户/客户端。首次创建管理员需提供至少 16 个字符的密码；已有管理员不会在重新部署时被覆盖。生产镜像和部署示例位于 `Dockerfile.production`、`deploy/`，详见 [生产部署与上线检查](production.md)。

## 日志与监控

- Auth Server 以 JSON 行输出请求日志，包含请求 ID、方法、路径、状态码和耗时；Gateway 使用 Fastify 结构化日志。两者都不记录 URL 查询字符串，避免 OAuth 回调码进入日志。上游 MCP Server 的运行日志由服务提供方采集。命令行开发时在 `pnpm dev:local` 的终端查看；推荐部署使用 `docker compose --env-file deploy/single-host/runtime.env -f deploy/compose.single-host.yml logs -f mcp-server`；源码开发使用 `docker compose logs -f auth gateway`。
- 管理 API 和个人连接中心对带 `Origin` 的浏览器写请求进行来源校验；显式提供无效 Bearer Token 时不会回退到 Cookie 会话。Gateway 转发上游时移除客户端 Cookie、平台授权头和可伪造的身份头，也不把上游 `Set-Cookie` 写回平台域名。
- 管理操作和管理员登录会写入 PostgreSQL 的 `audit_events` 表。默认保留 90 天，由 Auth Server 定期清理；可用 `AUDIT_RETENTION_DAYS` 调整。审计写入失败会在服务日志中报错，不会把已完成的管理操作伪装成失败。
- 管理后台的“日志监控”页每 10 秒刷新服务健康和调用统计，支持时间、服务、工具、用户 ID、客户端筛选，以及成功/失败/未知结果的明细分页。加载较早明细后暂停明细自动刷新，手动刷新或更换筛选可回到最新记录。管理员可查看调用次数、成功率、平均耗时、P95 耗时分桶上界、活跃用户、每分钟峰值及四类排行；调用总览仅统计 `tools/call`，协议请求数包括其他 MCP 消息，批量消息逐条计数。
- 调用记录保存时间、请求 ID、用户/客户端、服务/工具、状态、耗时、错误分类及实例摘要，并在系统明细和端点内容采集均开启时保存 MCP params 与 result/error 内容；端点内容采集默认关闭，明细默认仅记录元数据。输入输出各限制为 64 KiB，超出部分标记截断；密码、Token、Cookie、API key 等字段按键名递归脱敏，不采集传输层请求头。管理员可查询全部记录，普通用户通过 /api/me/monitoring/calls 查询时，后端强制追加当前用户 ID 条件；支持时间窗口、服务、工具、方法、客户端、结果、请求 ID 和内容关键词筛选及游标分页。历史记录的输入输出为空，保留期限沿用明细设置。HTTP 200 内的 JSON-RPC 错误和 `isError` 工具结果均记为失败；无法观察最终结果的异步调用、超过解析上限的响应记为未知，不计入成功率或工具耗时。当前版本不跨 HTTP 连接关联异步结果。
- Gateway 将调用元数据异步写入有界 Redis Stream，Auth Server 持久化并按事件 ID 去重；队列不可用或积压达到上限时不阻塞 MCP 响应，页面展示队列积压、采集错误和丢弃计数。重启、队列故障或大流量时统计可能缺失，不作为计费凭据。
- 系统设置可单独关闭调用明细而继续汇总统计，或关闭全部新调用采集。默认明细保留 14 天、分钟汇总保留 365 天，每 10 分钟清理过期数据；去重记录保留 7 天。当前告警在最近 5 分钟至少 20 次已知结果时检查错误率（默认超过 5%），至少 20 次有耗时时检查 P95 分桶上界（默认超过 2000ms），同时显示采集故障及不可用上游。告警支持历史记录、管理员确认及邮件 / Webhook 通知。同一故障持续期间不重复通知，恢复后再次触发会创建新记录；通知失败按 1、2、5、15 分钟退避，最多尝试 5 次。通知在数据库事务外发送，多个 Auth 副本通过行锁领取任务。
- 管理操作审计支持独立筛选和翻页。运行日志仍需从标准输出或容器日志采集。
- Auth Server 与 Gateway 的 `/live` 用于进程存活探测；`/health` 用于就绪探测，依赖不可用时返回 HTTP 503。Gateway 会同时检查 Redis 与动态注册表是否及时同步。

## Auth Server 模块组织

Auth Server 的职责分为 `application`（启动与 HTTP 装配）、`modules`（业务领域）、`infrastructure`（数据库、Docker、缓存、邮件和加密）与 `shared`（公共 HTTP 和校验工具）。根目录只保留 `index.ts` 执行入口；脚本与配置直接引用对应模块，不保留旧路径转发文件。具体职责、依赖规则和安全约束见 [源代码目录规范](../packages/auth-server/src/README.md)。
