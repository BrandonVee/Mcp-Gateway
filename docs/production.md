# 生产部署与上线检查

当前 `docker-compose.yml` 使用源码挂载和开发进程，只用于本地验证；生产环境应构建固定版本镜像，并由负载均衡器或编排平台提供 TLS、滚动更新和网络隔离。

## 启动前配置

1. 从 `config/default.json` 复制独立配置文件，设置公网 HTTPS `auth.issuer`、`gateway.resourceBaseUrl`，以及内网的注册表和 JWKS 地址。不要把真实密钥写入此文件。
2. 注入以下环境变量。Auth 和 Gateway 的 `INTERNAL_API_TOKEN`、`CREDENTIAL_BROKER_TOKEN` 必须一致，两个令牌彼此不同；加密密钥只授予 Auth。

   ```text
   NODE_ENV=production
   CONFIG_FILE=/etc/mcp/production.json
   DATABASE_URL=postgres://USER:PASSWORD@POSTGRES_HOST:5432/DB
   REDIS_URL=rediss://REDIS_HOST:6379
   INTERNAL_API_TOKEN=<独立随机值，至少 32 字符>
   CREDENTIAL_BROKER_TOKEN=<另一独立随机值，至少 32 字符>
   CREDENTIAL_ENCRYPT_KEY=<32 字节随机值的 64 位十六进制编码>
   ADMIN_WEB_URL=https://ADMIN_HOST
   CONNECTIONS_WEB_URL=https://ADMIN_HOST/connections
   MCP_UPSTREAM_ALLOWED_HOSTS=mcp-a.internal.example,mcp-b.internal.example
   MCP_ALLOWED_ORIGINS=https://ADMIN_HOST
   UPSTREAM_MAX_ACTIVE_REQUESTS=100
   ADMIN_PASSWORD=<首次初始化时至少 16 字符>
   ```

3. Secret 应由部署平台的 Secret 管理器注入。不要复用 Compose 内的本地默认值，也不要将 `.env.local` 放进镜像；`.dockerignore` 已排除它。
4. 在外部负载均衡器终止 TLS，并只把公开入口暴露给客户端。Auth 的 `/internal/*` 与 PostgreSQL、Redis 应留在受限网络。根据业务需要限制管理员入口 IP 与上游 MCP Endpoint 范围。
   `MCP_UPSTREAM_ALLOWED_HOSTS` 在 Auth 和 Gateway 中必须配置为相同的、逗号分隔的上游主机名（不含协议、端口或路径）；注册和 Gateway 刷新路由时都会拒绝列表外的地址。此名单只限制主机名，仍须用防火墙或容器网络策略限制 Gateway 的实际出站目的地，防止 DNS 变化导致越界访问。
   浏览器 MCP 客户端如从其他源发起请求，将其完整 Origin 加到 `MCP_ALLOWED_ORIGINS`；不带 Origin 的非浏览器客户端不受此项影响。`UPSTREAM_MAX_ACTIVE_REQUESTS` 是**每个 Gateway 进程**允许的同时上游请求数，默认 100；长时间 SSE 连接也占用一个名额，超出时返回 503 和 `Retry-After: 1`。应按实例内存与实际连接数压测后调整。
5. 先备份 PostgreSQL 和 `CREDENTIAL_ENCRYPT_KEY`，再部署迁移。演练恢复：数据库、签名密钥记录和加密密钥必须一起恢复；丢失加密密钥将使已保存的用户连接凭据失效。

生产模式在启动时执行配置校验；缺少独立配置文件、HTTPS 公网地址、数据库/Redis 地址、安全密钥或上游主机名单时会拒绝启动。首次空数据库还要求显式提供管理员密码。存活探针使用 `/live`，就绪探针使用 `/health`（依赖故障返回 503）。

## 持续集成

`.github/workflows/ci.yml` 在每次推送和拉取请求中先运行类型检查、单元测试和前端构建；通过后构建 Docker 镜像，检查镜像内的前端产物，并使用 `.github/compose.ci.yml` 从镜像文件启动服务（不挂载源码、不使用 watch 进程）运行端到端 smoke 测试。Docker 镜像使用锁文件和 `pnpm install --frozen-lockfile`，避免构建时依赖漂移。此流程验证容器构建和运行，不包含生产发布或部署审批。

## 尚需在生产环境验收的事项

- **备份与恢复**：自动化 PostgreSQL 备份、Secret 托管、定期恢复演练，并定义 RPO/RTO。
- **认证防护**：为登录、令牌和 OAuth 端点增加跨副本的速率限制、异常登录告警和密码策略；评估企业 SSO/MFA。
- **权限治理**：目前只有管理员与普通用户两种角色，若存在多团队、多租户需求，需要细粒度 RBAC 与租户隔离。
- **可观测性**：将 JSON 日志接入集中采集，并增加指标、链路追踪、告警阈值和 SLO；当前页面提供健康状态与管理审计，不是完整 APM。
- **高可用**：演练多副本、数据库迁移协调、Redis 故障恢复和上游 MCP 超时/熔断策略；确认负载均衡器的就绪探针行为。
- **供应链**：增加依赖与镜像漏洞扫描、SBOM、镜像签名和发布审批。当前 CI 只验证功能与构建。

以上验收项需要结合实际部署拓扑、合规要求和流量规模确定阈值，不能仅凭本地 smoke 测试视为完成。
