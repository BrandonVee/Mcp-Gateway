# 生产部署与上线检查

推荐使用 [README 的一键部署](../README.md#服务器部署推荐)：无需部署域名参数，使用自己的 Nginx 转发一个 HTTP 端口，再在管理后台保存系统访问地址与可信上游。`deploy/compose.single-host.yml` 同时启动数据库和应用；配置保存在 PostgreSQL 的 `meta.system_settings` 中。默认应用由单个 `mcp-gateway` 镜像运行，加 PostgreSQL、Redis 共三个容器。下面提供外部数据库部署，并保留分离域名的高级模式。

根目录 `docker-compose.yml` 使用源码挂载和开发进程，只用于本地验证。分离服务生产示例在 `deploy/compose.production.yml`：它构建 Node 运行镜像和 Nginx 静态前端镜像，不包含开发账号、演示数据、PostgreSQL 或 Redis。三个 HTTP 端口只绑定宿主机回环地址，须由同机负载均衡器提供 TLS、公网路由、访问控制和滚动更新。生产镜像的基础镜像按 digest 固定；升级时要同时更新 digest 并重新扫描。

## 统一应用镜像

`Dockerfile.production` 的默认最终目标为 `app`，部署脚本使用的镜像名称为 `mcp-gateway`（本机构建时为 `mcp-gateway:<提交号>`，可用 `MCP_IMAGE_NAME` 覆盖）。镜像内依次启动 Auth、Gateway、Nginx；进程管理器由 tini 托管，任何子进程异常退出都会关闭其他进程并退出容器，由 Docker 重启策略重新启动。SIGTERM 会传给子进程，超过 8 秒仍未退出的进程会被终止，Compose 停止宽限为 15 秒。健康检查通过 `/healthz` 同时检查 Auth、Gateway（包括数据库/Redis依赖）；Docker 的 unhealthy 状态本身不会触发重启，依赖恢复后探针可恢复健康。

镜像以非 root 用户运行，应用端口为 8080；9001、8000、9002 仅在容器回环地址监听，外部入口拒绝 `/internal/*` 和 `/api/internal/*`。单机 Compose 采用只读文件系统、临时 `/tmp`、移除 capabilities 和禁止提权。应用进程共享容器隔离边界，网页、认证和网关会一起升级、重启。

内置 Nginx 对管理页面入口使用 `no-cache`，每次访问校验最新版本；Vite 生成的带内容哈希的 `/assets/` 文件缓存一年，缺失资源返回 404。仅静态页面及资源启用 gzip，API、OAuth 和 MCP 响应保留原有代理行为。各生产入口的访问日志只记录路径，不包含 OAuth 查询参数。可在装有 Docker、Node 和项目依赖的开发或 CI 环境运行 `pnpm exec tsx scripts/smoke-nginx.ts`，通过独立容器验证路由、缓存、压缩、安全响应头及日志，无需连接业务数据库。

```bash
docker build -f Dockerfile.production --target app -t mcp-gateway:local .
docker save -o mcp-gateway-local.tar mcp-gateway:local
# 在服务器上导入，然后使用本地已导入的版本启动：
docker load -i mcp-gateway-local.tar
MCP_VERSION=local ./scripts/deploy.sh --yes --use-local-image
```

离线示例还需要服务器已有 PostgreSQL、Redis 镜像。`--use-local-image` 会使用已导入的本地版本，并执行相同的配置、代理信任和旧容器迁移步骤。

### 首次打开网页配置数据库

只启动应用、接入已有 PostgreSQL / Redis 时，可使用浏览器引导：

```bash
docker compose -f deploy/compose.setup.yml up -d
docker compose -f deploy/compose.setup.yml logs mcp-server
```

首次打开 8080 入口，按四步完成配置：输入日志中的初始化密钥、填写并测试 PostgreSQL、填写并测试 Redis、设置管理员并保存。前一步通过后才能继续，可返回修改；最后保存时再次校验两项连接。中间步骤不写入配置，刷新页面需重新填写。系统会生成密钥并自动启动；重建容器沿用 `app_data` 卷，初始化接口关闭。详细的 HTTPS / SSH 隧道访问、数据库权限、配置备份及纯镜像部署步骤见 [Docker Hub 使用说明](dockerhub.md)。该方式不创建外部数据库，连接前需准备好数据库和账号。

`/healthz` 在等待初始化时返回 `mode: setup, ready: false`；已完成初始化后恢复聚合探针。初始化状态健康表示配置页面可用，不代表 MCP 服务已就绪。`/app/data/bootstrap.json` 保存连接密码和凭据加密密钥，文件权限 `0600`，需要和数据库一起备份；显式环境变量优先。不要用空配置卷连接已有业务库。

### 使用外部数据库

复制 `deploy/app.env.example` 为权限 `0600` 的 `deploy/app.env`，填写外部 PostgreSQL/Redis 地址、三组独立随机密钥、初始管理员密码、镜像版本和可信代理。宿主机 Nginx 将统一 HTTPS 域名转发到 8080，系统访问地址和可信上游在后台设置。该方式只启动一个应用容器：

```bash
docker compose --env-file deploy/app.env -f deploy/compose.app.yml config --quiet
docker compose --env-file deploy/app.env -f deploy/compose.app.yml build
docker compose --env-file deploy/app.env -f deploy/compose.app.yml up -d --wait
curl --fail http://127.0.0.1:8080/healthz
```

外部数据库的备份与密钥托管由部署方负责，一键部署的备份脚本仅适用于内置 PostgreSQL 服务。

### 从旧版应用容器升级

```bash
git pull --ff-only
./scripts/backup.sh
./scripts/deploy.sh   # 选择 1，本机构建
```

脚本沿用原项目名、端口、密码和密钥，先准备新应用镜像，再停止并移除该 Compose 项目中原 `auth`、`gateway`、`admin-web` 或旧版统一应用 `app` 容器，启动新的 `mcp-server` 服务。PostgreSQL/Redis 容器及数据卷保持原样。镜像构建或拉取失败时不会停止原应用。手动 Compose 部署的旧 `app` 迁移步骤见 [Docker Hub 使用说明](dockerhub.md#更新日志和备份)。恢复旧备份时，启动器会把原 `http://auth:9001` 内部链接转换为回环链接，只生成容器内临时配置，不改写归档。

回退至旧五容器代码时，先用当前 Compose 停止并移除 `mcp-server` 容器，然后切换到原提交执行原 `deploy.sh`，让旧脚本重建内网链接；保留数据库卷和密钥。数据库迁移的回退须结合版本兼容性评估，需要恢复时先保存当前备份。

### 升级影响与管理员恢复

Auth Server 启动时自动迁移数据库。身份迁移 `0013_identity_lifecycle` 会使旧浏览器登录会话、授权码和 refresh token 失效；升级后需重新登录，让 MCP 客户端重新完成平台授权。用户、服务、权限和已保存的上游连接保留，正常升级不会重置管理员密码。

若旧部署已没有启用管理员，且配置指定的账号已被禁用或降级，启动会明确报错。恢复需同时显式设置 `ADMIN_BOOTSTRAP_RECOVERY=true` 和 `ADMIN_PASSWORD`，只恢复 `ADMIN_USERNAME` 指定的账号；生产密码至少 16 字符。单机部署可临时传入环境变量并重建应用容器：

```bash
ADMIN_BOOTSTRAP_RECOVERY=true ADMIN_PASSWORD='替换为新的强密码，至少16字符' \
  docker compose --env-file deploy/single-host/runtime.env -f deploy/compose.single-host.yml up -d --force-recreate mcp-server
```

自定义管理员还需传入 `ADMIN_USERNAME`。恢复成功后移除临时开关，再重建应用容器，使用新密码登录；维护 `runtime.env` 中的密码时也应同步更新。自定义 `MCP_DEPLOY_DIR` 时替换上面的环境文件路径。已有启用管理员时，恢复开关不会覆盖任何账号。

## 分离服务部署（高级）

首次服务器部署见 [README：服务器部署](../README.md#服务器部署推荐)。以下高级示例使用 `SYSTEM_CONFIG_MODE=file`，将独立的 Auth、Gateway 和管理端地址保留在配置文件中，后台系统设置只读。`deploy/production.env.example` 提供环境变量模板，`deploy/nginx-ingress.conf.example` 提供宿主机 Nginx 示例；`MCP_IMAGE_PREFIX` 可为空或指定带末尾 `/` 的镜像仓库命名空间。

1. 准备独立的 PostgreSQL 与 Redis，确认备份、恢复和容量告警可用。复制 `deploy/production.json.example` 为 `deploy/production.json`，填写真实的 HTTPS 域名和 Auth 内网地址。该文件不放密钥，已加入 Git 忽略。
2. 提供下列环境变量，可使用权限为 `0600` 的 `deploy/production.env` 并通过 `--env-file` 加载，也可由 Secret 管理器提供；不要写入 Git 或 Compose 文件。`MCP_VERSION` 使用已审核的提交或发布号。首次空库须设置 `ADMIN_PASSWORD`；管理员已创建后可移除它。

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
   docker compose --env-file deploy/production.env -f deploy/compose.production.yml config --quiet
   docker compose --env-file deploy/production.env -f deploy/compose.production.yml build
   docker compose --env-file deploy/production.env -f deploy/compose.production.yml up -d --wait
   curl --fail http://127.0.0.1:9001/health
   curl --fail http://127.0.0.1:8000/health
   curl --fail http://127.0.0.1:8080/healthz
   ```

4. 负载均衡器只应公开 Auth 的 OAuth、会话、管理 API 路由，Gateway 的 MCP 路由，以及管理前端。**禁止从公网转发 Auth 的 `/internal/*`**。前端 Nginx 已拒绝 `/api/internal/*`，但 Auth 自身的公网入口仍须独立配置。对 Admin 入口设访问策略，限制 Gateway 到上游的网络出口。为 Auth、Gateway 和前端分别配置 `/health`、`/health`、`/healthz` 就绪探针。
5. 用真实域名完成 OAuth 登录、MCP 初始化、工具调用、用户凭据连接与撤销，再演练单副本故障、Redis 故障、上游故障和数据库恢复。发布后观察 5xx、429、网关容量拒绝、认证失败与审计日志。

当代理会在 `X-Forwarded-For` 追加客户端地址时，`AUTH_TRUSTED_PROXY_IPS` 必须包含 Auth 看到的直接代理以及转发链中的其他可信代理 IP 或 CIDR；未列入的来源所提交的 XFF 被忽略。只配置实际代理网段，代理须清除客户端传入的伪造转发头，再生成可信链。上线前用两个不同客户端验证限流身份归属，避免把所有用户错误地归到一个代理 IP。Auth 的登录、Token、动态客户端注册采用 Redis 共享限流；Redis 不可用时 Auth 的就绪探针失败，相关写入口返回 503。

## 网络、密钥与容量

Auth 和 Gateway 的 `INTERNAL_API_TOKEN`、`CREDENTIAL_BROKER_TOKEN` 必须一致，两个令牌彼此不同。统一镜像的启动器只向 Auth 子进程传递加密密钥和数据库凭据；分离模式下加密密钥仅配置给 Auth。不要复用开发 Compose 内的默认值，也不要将 `.env.local` 放进镜像；`.dockerignore` 已排除它。PostgreSQL、Redis 和 Auth 的 `/internal/*` 应留在受限网络。

`MCP_UPSTREAM_ALLOWLIST_ENABLED` 控制上游白名单，默认 `true`；设为 `false` 时允许任意合法的上游 URL。开启时必须提供非空的 `MCP_UPSTREAM_ALLOWED_HOSTS`，填写逗号分隔的主机名或 IP。Auth 和 Gateway 中的开关及名单必须相同。数据库配置模式通过后台“系统设置”保存开关和名单；已有配置缺少开关时按开启处理。该名单只校验主机名；还须用防火墙或容器网络策略限制 Gateway 的实际出口，防止 DNS 变化导致越界访问。浏览器 MCP 客户端如从其他源发起请求，将完整 Origin 加到 `MCP_ALLOWED_ORIGINS`。`UPSTREAM_MAX_ACTIVE_REQUESTS` 是每个 Gateway 进程允许的同时上游请求数，默认 100；长时间 SSE 连接也占用名额，超出时返回 503。按实际连接数压测后调整。

部署迁移前备份 PostgreSQL 和 `CREDENTIAL_ENCRYPT_KEY`。恢复时数据库、签名密钥记录和加密密钥必须一起恢复；丢失加密密钥将使已保存的用户连接凭据失效。

生产模式在启动时执行配置校验；本节文件配置模式缺少独立配置文件、HTTPS 公网地址、数据库/Redis 地址、安全密钥或上游主机名单时会拒绝启动。数据库中若存在 `demo-user` 或 `demo-client` 也会拒绝启动；不要在生产库导入 `tests/fixtures/` 的测试数据。首次空数据库还要求显式提供管理员密码。普通用户创建和密码重置至少需要 12 字符。存活探针使用 `/live`，就绪探针使用 `/health`（PostgreSQL 或 Redis 不可用时返回 503）。数据库迁移和初始管理员创建已通过 PostgreSQL advisory lock 序列化；签名密钥首次生成时采用先写入者为准的策略，可支持 Auth 多副本同时启动。

生产管理 API 默认只接受管理员浏览器会话。若确实需要自动化 Bearer 调用，显式设置 `ADMIN_BEARER_CLIENT_IDS` 为受信 OAuth Client ID 列表，并在授权请求中使用 `resource=https://auth.example.com/admin`（与实际 Issuer 对应）。动态注册的新客户端不会自动获得管理 API Bearer 权限。管理员仍应避免授权不认识的 OAuth 客户端。

## 持续集成

`.github/workflows/ci.yml` 在每次推送和拉取请求中运行类型检查、单元测试、前端及 Node 运行包构建和生产依赖审计；通过后以独立的 `mcp-ci` Compose 项目构建统一应用镜像，检查 Nginx 内的前端产物，并使用 `.github/compose.app-ci.yml` 从镜像文件启动服务（不挂载源码、不使用 watch 进程）运行端到端 smoke 测试；测试上游使用独立的 `test-upstream` 镜像目标，不包含在生产 runtime 镜像中。Docker 镜像使用锁文件和 `pnpm install --frozen-lockfile`。另有 `single-host` 任务实际执行一键部署，验证首次后台设置、注册总开关、OAuth 地址变更、旧令牌失效、重启持久化、数据库和加密密钥的备份恢复、内部端口隔离、整体健康检查、故障重启、正常停止和五容器迁移。调用监控测试覆盖 JSON/SSE、HTTP 200 工具错误、未知结果、去重、元数据隐私、排行和采集开关；注册及监控测试先于会故意耗尽动态客户端注册额度的完整 smoke 测试。此流程验证构建与功能，不代替真实域名、真实上游和生产流量验收。在本机复现 CI 时也应设置独立的 `COMPOSE_PROJECT_NAME`；`docker compose down -v` 会删除该项目的 PostgreSQL 卷。

## 备份与恢复

以下脚本适用于 `deploy/compose.single-host.yml` 的一键部署；独立数据库的高级部署应由数据库备份系统完成同等操作。数据库备份包含用户、服务、授权、调用数据和 OAuth 签名密钥，归档同时保存 `runtime.env` 中的凭据加密密钥和 `config.json`。Redis 的会话和未落库调用队列不在备份中，恢复后客户端应重新授权或初始化。

```bash
./scripts/backup.sh
# 可调整路径和保留天数；MCP_DEPLOY_DIR 默认 deploy/single-host。
MCP_BACKUP_DIR=/srv/mcp-backups MCP_BACKUP_KEEP_DAYS=30 ./scripts/backup.sh
```

默认备份含明文密钥，文件权限为 `0600`，目录及临时文件以 `umask 077` 创建；备份目录已排除 Git 和镜像构建上下文。生产建议安装 `age`，使用公钥加密，再同步至独立存储。私钥应离线保管；脚本不会生成或托管它。

```bash
MCP_BACKUP_RECIPIENT=age1YOUR_PUBLIC_KEY ./scripts/backup.sh
```

Linux 定时备份示例默认仓库位于 `/root/mcp`。路径不同先修改 service 的 `WorkingDirectory` 和 `ExecStart`。可在权限 `0600` 的 `/etc/mcp-backup.env` 填写 `MCP_DEPLOY_DIR`、`MCP_BACKUP_DIR`、`MCP_BACKUP_KEEP_DAYS`、`MCP_BACKUP_RECIPIENT`；不要填 age 私钥。timer 每天 03:00 后随机延迟最多 10 分钟执行，停机期间错过的任务会补跑。

```bash
sudo install -m 644 deploy/mcp-backup.service deploy/mcp-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mcp-backup.timer
sudo systemctl start mcp-backup.service       # 首次手动验证
sudo journalctl -u mcp-backup.service -n 50
sudo systemctl list-timers mcp-backup.timer
```

恢复会替换当前数据库及密钥，先备份当前状态，并安排停机窗口。脚本在停止应用前检查归档路径、普通文件、SHA-256、数据库/Redis 密码和 dump 格式；数据库恢复使用单个事务，失败会回滚并让应用保持停止。成功后恢复配置、密钥并启动应用，保留当前 Compose 项目、镜像版本、端口和可信代理设置；不自动回退镜像。

```bash
./scripts/backup.sh
./scripts/restore.sh --confirm /srv/mcp-backups/mcp-backup-TIMESTAMP.tar.gz
# 加密归档：
MCP_BACKUP_IDENTITY=/secure/age-key.txt ./scripts/restore.sh --confirm /srv/mcp-backups/mcp-backup-TIMESTAMP.tar.gz.age
```

跨主机恢复须先从备份安全取出部署配置，以原数据库/Redis 密码初始化依赖，准备兼容的应用镜像后再恢复。不要用新的加密密钥搭配旧数据库。保留期限仅清理本脚本生成的已完成归档，只有新备份成功后才执行；定期在隔离环境恢复并验证用户连接凭据，按可接受的数据损失和停机时间确定备份频率、异地副本与 RPO/RTO。

## 自行部署后的验收

```bash
git pull --ff-only
./scripts/backup.sh
./scripts/deploy.sh   # 镜像来源选择 1，本机构建
docker compose --env-file deploy/single-host/runtime.env -f deploy/compose.single-host.yml ps
docker compose --env-file deploy/single-host/runtime.env -f deploy/compose.single-host.yml logs --tail=100 mcp-server
curl --fail https://YOUR_DOMAIN/healthz
curl --fail https://YOUR_DOMAIN/api/health
curl --fail https://YOUR_DOMAIN/gateway/health
```

1. 管理员打开系统设置，确认访问地址和可信上游正确，注册和采集开关保存后刷新仍保持。
2. 从真实 MCP 客户端登录，调用实际服务的一项工具；10 秒内在日志监控按该服务筛选，确认次数、用户、客户端、结果及耗时。长连接或异步响应若不能关联最终结果，应显示未知。
3. 在可控的测试服务触发工具错误，确认 HTTP 200 的工具失败仍显示失败；核对记录未包含工具参数、返回正文或凭据。
4. 关闭“记录调用明细”，再次调用，确认汇总增加而新明细不增加；关闭“启用调用统计”后确认新统计停止。Gateway 配置刷新最长约 15 秒，测试前等待同步，再按需要恢复开关。
5. 关闭自行注册，以退出登录的浏览器打开后台登录页和授权地址，确认两处注册入口都消失、直接注册被拒绝（`POST /api/me/signup` 返回 403）、已有用户仍可登录；重新开启后注册测试用户，确认仅获得勾选“新注册用户默认可访问”的服务。
6. 手动执行备份并查看定时任务结果，在隔离部署恢复，核对账号、服务权限、用户连接凭据可用。生产环境不要运行 `smoke-*`：这些脚本会创建测试数据、修改系统设置，部分会耗尽限流额度或替换数据库。

## 尚需在生产环境验收的事项

- **备份与恢复**：启用已提供的定时备份，将加密归档保存至独立存储，定期恢复演练，并定义 RPO/RTO。
- **认证运营**：将 429 和管理员登录失败日志接入异常登录告警；按组织要求评估密码轮换、企业 SSO/MFA 与自动化账户治理。现有账号的旧密码不会因新密码最小长度规则自动重置。
- **权限治理**：目前只有管理员与普通用户两种角色，若存在多团队、多租户需求，需要细粒度 RBAC 与租户隔离。
- **可观测性**：在现有调用统计、明细和当前阈值告警之上，将 JSON 日志接入集中采集，逐步增加跨连接关联、链路追踪、外部告警通知与 SLO。
- **高可用**：演练多副本、数据库迁移协调、Redis 故障恢复和上游 MCP 超时/熔断策略；确认负载均衡器的就绪探针行为。
- **上游故障演练**：Gateway 当前按进程执行 TCP/TLS 探测与短暂避让，只有无 session 的 `initialize` 可换实例；需测试实际外部 MCP 的协议健康、长连接中断、会话重建及跨 Gateway 副本的故障行为。
- **客户端兼容**：用目标版本的 WorkBuddy 实际导入配置并完成 OAuth、工具调用和刷新令牌流程；仓库测试覆盖协议与回调注册，不能代替真实客户端验收。
- **供应链**：当前 CI 检查生产 npm 依赖的高危漏洞；仍需增加容器镜像扫描、SBOM、镜像签名和发布审批。

以上验收项需要结合实际部署拓扑、合规要求和流量规模确定阈值，不能仅凭本地 smoke 测试视为完成。

## 自动发布到 Docker Hub

`.github/workflows/ci.yml` 的 `publish` 任务等待类型检查、单元测试、完整 MCP/OAuth/监控测试和单机升级/备份演练全部通过，再构建 `Dockerfile.production` 的 `app` 目标并推送到 `brandonvee/mcp-gateway`。构建使用 Docker 官方 Actions、Buildx 与 QEMU，同时发布 `linux/amd64`、`linux/arm64`，生成 SBOM 和最小构建来源证明，复用 GitHub Actions 缓存。发布任务串行执行，避免同时覆盖标签。

首次配置：

1. 在 Docker 账号设置的 Personal access tokens 中创建发布专用令牌，授予 Read & Write 权限。不要使用账号密码。见 [Docker 令牌说明](https://docs.docker.com/security/access-tokens/personal-access-tokens/)。
2. 在 [GitHub Actions secrets](https://github.com/BrandonVee/Mcp-Gateway/settings/secrets/actions) 添加 Repository secret：名称 `DOCKERHUB_TOKEN`，值为上述令牌。用户名固定为 `brandonvee`。
3. 推送到 `main`，或在 Actions → CI → Run workflow 选择 `main`。密钥缺失时发布任务会明确报错，测试任务仍可执行。

标签规则：

| 触发方式 | 发布标签 |
| --- | --- |
| 推送 `main` 或手动运行 `main` | `latest`、12 位提交 SHA、自动版本 `vX.Y.Z` / `X.Y.Z` |
| 推送 `v1.2.3` | `v1.2.3`、`1.2.3`、12 位提交 SHA |
| PR、其他分支 | 仅测试 |

通过全部测试并成功发布镜像后，`github-actions[bot]` 自动创建版本标签和 [GitHub Release](https://github.com/BrandonVee/Mcp-Gateway/releases)，记录同一提交的双架构镜像 digest 和部署命令。首版为 `v0.1.0`；之后普通提交递增补丁版本，`feat:` 递增次版本，`!` 或 `BREAKING CHANGE:` 递增主版本。重复运行同一已发布提交会复用版本，不移动已有标签。工作流声明 `contents: write`，使用内置 `GITHUB_TOKEN`，无需额外的 GitHub PAT。

机器人创建标签不会再次触发 CI，因此版本镜像和 Release 都在当前已通过测试的流水线中完成。手动推送版本标签仍可发布固定版本镜像。

版本标签不会覆盖 `latest`；`latest` 跟随通过所有测试的 `main`。在发布任务的摘要中查看镜像 digest，Docker Hub 的 Tags 页面查看两个架构。

```bash
# 可选：手动指定版本（main 已支持自动发版）：
git tag v1.2.3
git push origin v1.2.3

# 服务器从 Docker Hub 拉取（已有部署建议先备份）：
./scripts/backup.sh
./scripts/deploy.sh --yes
```

已发布镜像 `brandonvee/mcp-gateway` 是脚本默认值，`MCP_VERSION` 默认 `latest`，需要固定版本时显式设置。`MCP_IMAGE_PREFIX=`（空值）改用本机构建，镜像名默认 `mcp-gateway`。

外部数据库模式在 `deploy/app.env` 中设置 `MCP_IMAGE_PREFIX=brandonvee/`、`MCP_IMAGE_NAME=mcp-gateway`、`MCP_VERSION=latest`，然后执行 `docker compose --env-file deploy/app.env -f deploy/compose.app.yml pull mcp-server` 和 `up -d --no-build --wait`。

## 手动发布生产镜像

也可在构建机器上，从要发布的代码提交构建统一 `app` 目标，手动发布到同一 Docker Hub 仓库：

```bash
export IMAGE_NAMESPACE=brandonvee
export MCP_VERSION=$(git rev-parse --short=12 HEAD)

# 登录提示中输入允许写入的 Docker Hub 访问令牌。
docker login -u brandonvee

# 首次创建；已有此 builder 时用 docker buildx use mcp-release。
docker buildx create --name mcp-release --driver docker-container --use

docker buildx build --platform linux/amd64,linux/arm64 \
  -f Dockerfile.production --target app \
  -t "$IMAGE_NAMESPACE/mcp-gateway:$MCP_VERSION" --push .
```

这会发布适用于 x86_64 和 ARM64 服务器的单个应用镜像；**不要发布 `builder` 或 `test-upstream` 目标**。详见 [Docker 多架构构建](https://docs.docker.com/build/building/multi-platform/)。


发布完成后，`./scripts/deploy.sh --yes` 即默认拉取该镜像；需要固定版本时使用 README 的 `MCP_VERSION` 一键拉取部署命令。分离服务高级模式仍可单独构建 `runtime` 和 `admin-web` 目标，使用原 `mcp-runtime` / `mcp-admin-web` 名称；它们不用于默认单机部署。

Docker Hub Overview 自动维护：main 镜像发布成功后自动同步 `docs/dockerhub.md` 中的启动说明，复用 `DOCKERHUB_TOKEN`，也可手动运行 `.github/workflows/dockerhub-description.yml` 单独同步说明。镜像推送本身不会更新 Overview。
