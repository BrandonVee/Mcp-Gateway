# 生产部署与上线检查

根目录 `docker-compose.yml` 使用源码挂载和开发进程，只用于本地验证。生产示例在 `deploy/compose.production.yml`：它构建 Node 运行镜像和 Nginx 静态前端镜像，不包含开发账号、演示数据、PostgreSQL 或 Redis。三个 HTTP 端口只绑定宿主机回环地址，须由同机负载均衡器提供 TLS、公网路由、访问控制和滚动更新。生产镜像的基础镜像按 digest 固定；升级时要同时更新 digest 并重新扫描。

## 部署流程

1. 准备独立的 PostgreSQL 与 Redis，确认备份、恢复和容量告警可用。复制 `deploy/production.json.example` 为 `deploy/production.json`，填写真实的 HTTPS 域名和 Auth 内网地址。该文件不放密钥，已加入 Git 忽略。
2. 从 Secret 管理器注入下列环境变量，不要写入 Git 或 Compose 文件。`MCP_VERSION` 使用已审核的提交或发布号。首次空库须设置 `ADMIN_PASSWORD`；管理员已创建后可移除它。

   ```text
   MCP_VERSION=<已审核的发布号>
   DATABASE_URL=<PostgreSQL 连接串>
   REDIS_URL=<Redis 连接串>
   INTERNAL_API_TOKEN=<独立随机值，至少 32 字符>
   CREDENTIAL_BROKER_TOKEN=<另一独立随机值，至少 32 字符>
   CREDENTIAL_ENCRYPT_KEY=<32 字节随机值的 64 位十六进制编码>
   ADMIN_WEB_URL=https://admin.example.com
   CONNECTIONS_WEB_URL=https://admin.example.com/connections
   MCP_UPSTREAM_ALLOWED_HOSTS=mcp-a.internal.example,mcp-b.internal.example
   MCP_ALLOWED_ORIGINS=https://admin.example.com
   AUTH_TRUSTED_PROXY_IPS=<可信代理 IP 或 CIDR，逗号分隔>
   ADMIN_PASSWORD=<仅首次启动使用，至少 16 字符>
   ```

3. 校验配置后构建、启动并查看健康状态：

   ```bash
   docker compose -f deploy/compose.production.yml config --quiet
   docker compose -f deploy/compose.production.yml build
   docker compose -f deploy/compose.production.yml up -d --wait
   curl --fail http://127.0.0.1:9001/health
   curl --fail http://127.0.0.1:8000/health
   curl --fail http://127.0.0.1:8080/healthz
   ```

4. 负载均衡器只应公开 Auth 的 OAuth、会话、管理 API 路由，Gateway 的 MCP 路由，以及管理前端。**禁止从公网转发 Auth 的 `/internal/*`**。前端 Nginx 已拒绝 `/api/internal/*`，但 Auth 自身的公网入口仍须独立配置。对 Admin 入口设访问策略，限制 Gateway 到上游的网络出口。为 Auth、Gateway 和前端分别配置 `/health`、`/health`、`/healthz` 就绪探针。
5. 用真实域名完成 OAuth 登录、MCP 初始化、工具调用、用户凭据连接与撤销，再演练单副本故障、Redis 故障、上游故障和数据库恢复。发布后观察 5xx、429、网关容量拒绝、认证失败与审计日志。

当代理会在 `X-Forwarded-For` 追加客户端地址时，`AUTH_TRUSTED_PROXY_IPS` 必须包含 Auth 看到的直接代理以及转发链中的其他可信代理 IP 或 CIDR；未列入的来源所提交的 XFF 被忽略。只配置实际代理网段，代理须清除客户端传入的伪造转发头，再生成可信链。上线前用两个不同客户端验证限流身份归属，避免把所有用户错误地归到一个代理 IP。Auth 的登录、Token、动态客户端注册采用 Redis 共享限流；Redis 不可用时 Auth 的就绪探针失败，相关写入口返回 503。

## 网络、密钥与容量

Auth 和 Gateway 的 `INTERNAL_API_TOKEN`、`CREDENTIAL_BROKER_TOKEN` 必须一致，两个令牌彼此不同；加密密钥只授予 Auth。不要复用开发 Compose 内的默认值，也不要将 `.env.local` 放进镜像；`.dockerignore` 已排除它。PostgreSQL、Redis 和 Auth 的 `/internal/*` 应留在受限网络。

`MCP_UPSTREAM_ALLOWED_HOSTS` 在 Auth 和 Gateway 中必须配置为相同的、逗号分隔的上游主机名。该名单只校验主机名；还须用防火墙或容器网络策略限制 Gateway 的实际出口，防止 DNS 变化导致越界访问。浏览器 MCP 客户端如从其他源发起请求，将完整 Origin 加到 `MCP_ALLOWED_ORIGINS`。`UPSTREAM_MAX_ACTIVE_REQUESTS` 是每个 Gateway 进程允许的同时上游请求数，默认 100；长时间 SSE 连接也占用名额，超出时返回 503。按实际连接数压测后调整。

部署迁移前备份 PostgreSQL 和 `CREDENTIAL_ENCRYPT_KEY`。恢复时数据库、签名密钥记录和加密密钥必须一起恢复；丢失加密密钥将使已保存的用户连接凭据失效。

生产模式在启动时执行配置校验；缺少独立配置文件、HTTPS 公网地址、数据库/Redis 地址、安全密钥或上游主机名单时会拒绝启动。数据库中若存在 `demo-user` 或 `demo-client` 也会拒绝启动；不要在生产库执行 `db:seed:dev`。首次空数据库还要求显式提供管理员密码。普通用户创建和密码重置至少需要 12 字符。存活探针使用 `/live`，就绪探针使用 `/health`（PostgreSQL 或 Redis 不可用时返回 503）。数据库迁移和初始管理员创建已通过 PostgreSQL advisory lock 序列化；签名密钥首次生成时采用先写入者为准的策略，可支持 Auth 多副本同时启动。

生产管理 API 默认只接受管理员浏览器会话。若确实需要自动化 Bearer 调用，显式设置 `ADMIN_BEARER_CLIENT_IDS` 为受信 OAuth Client ID 列表，并在授权请求中使用 `resource=https://auth.example.com/admin`（与实际 Issuer 对应）。动态注册的新客户端不会自动获得管理 API Bearer 权限。管理员仍应避免授权不认识的 OAuth 客户端。

## 持续集成

`.github/workflows/ci.yml` 在每次推送和拉取请求中运行类型检查、单元测试、前端及 Node 运行包构建和生产依赖审计；通过后以独立的 `mcp-ci` Compose 项目构建生产镜像，检查 Nginx 内的前端产物，并使用 `.github/compose.ci.yml` 从镜像文件启动服务（不挂载源码、不使用 watch 进程）运行端到端 smoke 测试。Docker 镜像使用锁文件和 `pnpm install --frozen-lockfile`。此流程验证构建与功能，不代替真实域名、真实上游和生产流量验收。在本机复现 CI 时也应设置独立的 `COMPOSE_PROJECT_NAME`；`docker compose down -v` 会删除该项目的 PostgreSQL 卷。

## 尚需在生产环境验收的事项

- **备份与恢复**：自动化 PostgreSQL 备份、Secret 托管、定期恢复演练，并定义 RPO/RTO。
- **认证运营**：将 429 和管理员登录失败日志接入异常登录告警；按组织要求评估密码轮换、企业 SSO/MFA 与自动化账户治理。现有账号的旧密码不会因新密码最小长度规则自动重置。
- **权限治理**：目前只有管理员与普通用户两种角色，若存在多团队、多租户需求，需要细粒度 RBAC 与租户隔离。
- **可观测性**：将 JSON 日志接入集中采集，并增加指标、链路追踪、告警阈值和 SLO；当前页面提供健康状态与管理审计，不是完整 APM。
- **高可用**：演练多副本、数据库迁移协调、Redis 故障恢复和上游 MCP 超时/熔断策略；确认负载均衡器的就绪探针行为。
- **上游故障演练**：Gateway 当前按进程执行 TCP/TLS 探测与短暂避让，只有无 session 的 `initialize` 可换实例；需测试实际外部 MCP 的协议健康、长连接中断、会话重建及跨 Gateway 副本的故障行为。
- **客户端兼容**：用目标版本的 WorkBuddy 实际导入配置并完成 OAuth、工具调用和刷新令牌流程；仓库测试覆盖协议与回调注册，不能代替真实客户端验收。
- **供应链**：当前 CI 检查生产 npm 依赖的高危漏洞；仍需增加容器镜像扫描、SBOM、镜像签名和发布审批。

以上验收项需要结合实际部署拓扑、合规要求和流量规模确定阈值，不能仅凭本地 smoke 测试视为完成。
