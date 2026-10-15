# 上游服务接入与用户凭据

逻辑端点负责分组和用户授权；分组内的每个实际 MCP Server 单独配置地址、API Key 或 OAuth。

## 注册外部 MCP Server

在后台先点击“创建逻辑端点”，只填写分组标识、显示名称、描述与默认访问权限。创建完成后，在端点卡片内点击“添加 MCP Server”，分别填写每个上游的名称、URL 和认证方式。服务权限分配在逻辑端点上，不需要把上游密钥交给用户。

管理 API 示例（使用已登录的管理员会话）：

```json
POST /admin/servers
{"name":"research","display_name":"研究工具组","instances":[],"auth_mode":"none","routing_mode":"aggregate"}

POST /admin/servers/research/instances
{"id":"papers","display_name":"论文搜索","url":"https://papers.example/mcp","auth_mode":"system_api_key","system_api_key":"管理员的上游密钥","api_key_header":"authorization","api_key_prefix":"Bearer "}

POST /admin/servers/research/instances
{"id":"notes","display_name":"个人笔记","url":"https://notes.example/mcp","auth_mode":"oauth","oauth_authorize_url":"https://notes.example/authorize","oauth_token_url":"https://notes.example/token","oauth_client_id":"client","oauth_client_auth_method":"none"}
```

配置修改使用 `PATCH /admin/servers/:endpoint/instances/:id`，密钥省略时保留原值。修改地址或认证配置仅清除此上游的已保存连接与待完成 OAuth 流程，不影响同组其他上游。

Gateway 通过受内部 Token 保护的 `/internal/mcp-servers` 控制面同步路由，并定时刷新。首次访问尚未缓存的新入口时也会立即刷新：

```text
http://localhost:8000/mcp/external-search
```

已缓存的入口共用路由快照，默认每 15 秒同步一次；并发同步会合并，配置未变化时使用 ETag 返回 304。用户禁用、凭据撤销和权限移除仍在请求中实时复核。

外部地址支持 HTTP/HTTPS 和自定义路径；如果只填写主机根地址，系统会自动补全 `/mcp`。
注册服务、添加实例或修改实例地址时，可点击 **测试 MCP 连接**。测试由实际 Gateway 发起 MCP 初始化；上游声明支持工具时，还会读取一页工具列表。支持 JSON 和 SSE 响应，测试使用当前上游的认证配置，不执行业务工具。系统 API Key 可使用表单中的密钥，留空时由后端读取已保存密钥；地址、请求头和值前缀均使用当前表单内容，测试不要求先保存。OAuth 和用户 API Key 使用当前管理员已有且未过期的连接；探测不会刷新或覆盖正式令牌。尚无授权时需完成账号授权。密钥不会出现在测试结果中。
测试结果区分 DNS 解析失败、连接拒绝、超时、TLS、HTTP 状态、错误路径与 MCP 协议异常；地址改变后会清除旧结果。测试沿用上游白名单，需先加入可信主机；成功测试会清除该地址的临时不可用状态。MCP 测试最长 8 秒，单个响应限制为 1 MiB，网关最多同时执行 4 个测试；会话在测试完成后关闭。
Docker 部署中的 `127.0.0.1` / `localhost` 指网关容器自身。容器名称需要可解析的 Docker 网络；跨网络接入可使用网关能访问的宿主机地址与映射端口，宿主机只绑定回环地址的端口不能这样访问。
统一应用镜像和本地开发自动通过回环地址连接 Gateway。Auth / Gateway 分离部署时，在 Auth 配置 `GATEWAY_INTERNAL_URL=http://gateway:8000`（按实际内部地址调整）；仓库的分离部署 Compose 已配置该值。浏览器只访问管理员接口，内部测试入口仍由内部 Token 保护，不经公网 Nginx 暴露。
上游白名单可在后台“系统设置”中启用或关闭，默认开启；旧配置也按开启处理。开启时 Auth Server 注册与 Gateway 同步路由均会校验可信上游主机，名单为空时拒绝所有上游；关闭时仍校验 URL 的合法性，注册时仍拒绝网关自引用。保存后 Auth Server 立即生效，Gateway 在下一次路由同步时生效（默认 15 秒）。配置文件模式通过 `MCP_UPSTREAM_ALLOWLIST_ENABLED`（默认 `true`）控制开关，通过 `MCP_UPSTREAM_ALLOWED_HOSTS` 指定主机名单（逗号分隔）。Gateway 还会拒绝不在 `MCP_ALLOWED_ORIGINS` 中的浏览器 MCP Origin，并用 `UPSTREAM_MAX_ACTIVE_REQUESTS`（默认 100，每进程）限制同时上游请求数；部署配置和网络隔离要求见 [生产部署与上线检查](production.md)。

### 服务配额与调用内容

在逻辑端点的“创建”或“编辑信息”中，可以设置每用户每分钟请求数（默认 120）、同时请求数（默认 5）和每日工具调用配额（默认 0，表示不限）。三项均可设为 0 关闭对应限制。计数按“用户 + 逻辑端点”隔离，并由 Redis 在所有网关副本间共享；每日配额只统计已受理的 `tools/call`，失败调用也计入，按 UTC 零点重置。超过限制返回 HTTP 429、具体错误码和 `Retry-After`。进程退出后，未释放的并发名额会在租约到期后回收。

管理 API 的字段为 `user_rate_limit_per_minute`、`user_max_concurrent`、`user_daily_quota`。全局 `UPSTREAM_MAX_ACTIVE_REQUESTS` 仍限制每个网关进程的总请求数。

端点的“记录调用输入输出”默认关闭，包括升级后的已有端点。调用明细开启时默认只记录元数据；管理员显式打开端点的 `monitoring_logs_enabled` 后，才采集该端点的输入输出。系统设置中的“调用明细”是总开关，关闭后所有端点均停止记录明细。输入输出仍有大小上限和凭据字段脱敏；正文中的私人内容可能被记录，开启前应确认该端点的数据用途。

## 分组内每个 MCP Server 的认证

| 方式         | 谁配置凭据     | 用户行为                             |
| ------------ | -------------- | ------------------------------------ |
| 无额外认证   | 无             | 有端点权限即可使用                   |
| 用户 API Key | 每位用户       | 在个人连接中心为此上游填写自己的 Key |
| 用户 OAuth   | 每位用户       | 为此上游授权自己的账号               |
| 系统 API Key | 管理员         | 用户无需配置 Key                     |
| 系统 OAuth   | 管理员统一授权 | 用户无需个人授权                     |

用户连接按“用户 + 上游 ID”保存；系统 OAuth 使用独立的系统凭据，与管理员个人 OAuth 连接分开。用户页面按上游显示认证状态，复制的客户端地址仍然是所属逻辑端点。同组多个上游只需配置一个客户端入口。

例如同一逻辑端点内有用户 API Key 的文献服务、用户 OAuth 的 GitHub 和系统 API Key 的搜索服务：用户登录个人连接中心，在文献服务卡片填写自己的 Key，在 GitHub 卡片点击“连接账号”完成授权；搜索服务直接使用管理员配置。另一个用户在相同卡片填写自己的凭据，两人的连接相互独立。客户端只对网关完成平台身份认证，网关调用上游时按当前用户及具体 Server 选择凭据。

### 聚合行为

`/mcp/research` 初始化并聚合可用上游的工具、资源与提示词。工具名称默认保留上游原名；只有重名工具才增加可读的 Server 名前缀，例如 `paper_radar__search` 与 `github__search`，不再自动拼接 MCP ID。前缀来自管理员设置的 Server 显示名；显示名无法生成有效工具前缀时使用上游地址中的路径或主机名。同名 Server 或前缀与现有工具名冲突时加数字后缀，确保名称唯一。提示词和资源 URI 继续保持独立的上游命名空间。

工具展示名到上游原名的映射按用户会话保存在 Redis。调用先查映射，再只向对应 MCP Server 注入其凭据；上游不可用、用户断开授权或进程切换不会让旧名称转向另一个 Server。已经展示过的名称在该会话中保留归属，工具目录变化后如需重新生成最简名称，可重新连接逻辑端点并刷新工具列表。每个上游保留自己的 MCP session。

未配置用户凭据或暂不可用的上游会从列表中省略，其原因通过响应 `_meta.unavailable_upstreams` 返回；其他上游继续可用。全部上游不可用则返回错误。每次请求复核端点授权，每次上游调用再复核对应凭据。聚合入口当前支持工具、资源、资源模板和提示词，以及 ping、初始化与断开；不提供独立 GET/SSE 推送流、订阅或 completion 接口。上游 POST 响应可以是 JSON 或 SSE。

已有端点升级后保留原来的副本池行为，避免破坏存量会话和客户端工具名。迁移会把端点认证及用户凭据复制到每个上游，已有权限不变。通过端点的“编辑信息 → 端点连接方式”切换到聚合模式，随后分别编辑每个 MCP Server 的配置；切换模式后客户端需要重新连接。新创建的逻辑端点默认使用聚合模式。

### 平台与上游认证

平台登录与外部服务凭据是两层独立认证：用户先取得某个逻辑 Server 的访问授权，再登录 **http://localhost:5173/** 为该 Server 连接自己的 API Key 或 OAuth 账号。管理员在每个上游的“配置地址与认证”中选择 `无额外认证`、`用户 API Key`、`系统 API 密钥` 或 `用户 OAuth`，并在“分配权限”中选择可访问该 Server 的普通用户。切换认证方式会删除该上游已保存的连接，以避免旧凭据被误用。

管理后台侧边栏的**二次认证**页面会列出用户与需要认证的 Server 的授权关系、连接状态、认证方式和更新时间；管理员可撤销单个用户的连接，用户随后需在**个人连接中心**重新配置。管理页面只返回连接元数据，不显示 API Key、Access Token 或 Refresh Token。管理员与普通用户共用 `/` 登录页，登录后按角色进入对应工作台；管理后台侧边栏提供个人连接中心入口，旧 `/connections` 链接仍可使用。管理接口为 `GET /admin/connections` 和 `DELETE /admin/connections/:userId/:serverName`，仅管理员可调用。

### API Key

管理员配置上游请求头（`authorization` 或 `x-*`）及值前缀。例如 `authorization` + `Bearer `，或 `x-api-key` + 空前缀。用户在连接中心输入 Key 后，Auth Server 使用 AES-256-GCM 加密并保存，Gateway 仅在该用户的请求中向上游注入；管理 API 和用户状态接口均不返回密钥明文。更新和断开连接也由用户在连接中心完成。

保存 Key 后先显示“已保存，待验证”，网页会自动发起 MCP 连接验证，也可点击“验证连接”重试。验证或实际调用被上游接受后显示“已连接”；上游返回 401/403 时记录“凭据被拒绝”，客户端收到 HTTP 409 和连接中心地址。网络故障不会把已保存凭据标记为错误。验证只执行初始化与工具发现，不执行业务工具，不刷新 OAuth Token。迟到的验证结果按凭据版本复核，不会改变已更换或已断开的连接；更换凭据后会重新建立该上游的 MCP 会话，保留工具路由的归属。

个人验证接口为 `POST /me/upstreams/:id/test-connection`，旧副本池为 `POST /me/servers/:name/test-connection`。仅允许验证当前用户有权访问且已保存凭据的地址，每用户每分钟最多 10 次；系统 OAuth 仅允许管理员发起验证。

### 系统 API Key

在服务的认证配置中选择“系统 API 密钥”，由管理员填写 Key、上游请求头及值前缀，再通过用户管理分配服务权限。用户以自己的平台身份访问，Gateway 检查权限后携带统一 Key 调用上游；用户无需在连接中心填写或领取上游密钥。

在每个上游的管理 API 中使用 `auth_mode: "system_api_key"` 和 `system_api_key` 字段。首次配置必须提供非空密钥；编辑时省略 `system_api_key` 保留当前密钥，提供新值则更新。密钥使用 AES-256-GCM 加密保存，服务列表只返回 `system_api_key_configured` 状态。切换到其他认证模式会清除系统密钥。撤销用户的服务权限即可阻止其继续使用；所有获得权限的用户共用上游账号及其配额。系统密钥缺失或被上游拒绝时，Gateway 返回 `503 system_credential_unavailable` 或 `503 system_credential_rejected`，由管理员修复配置。

### OAuth

管理员配置外部提供方的授权地址、Token 地址、Client ID、可选 Client Secret、Token 端点客户端认证方式（无、`client_secret_basic`、`client_secret_post`）、Scopes、Resource URL 和响应 Issuer。需在提供方注册回调地址：

```text
{AUTH_ISSUER}/oauth/upstream-callback/{UPSTREAM_ID}
```

用户在连接中心点击“连接账号”；平台使用 Authorization Code + PKCE、一次性 `state` 和浏览器回调取得**外部服务的** Access/Refresh Token。Gateway 按用户注入外部 Bearer Token；即将过期时平台在数据库锁内刷新，避免并发重复兑换轮换型 Refresh Token。平台自己的 JWT 不会转发给外部服务。若提供方在授权响应中返回 `iss`，建议配置预期 Issuer；若提供方要求 RFC 8707 的 `resource` 参数，请配置其受保护资源 URL。

用户未连接时 Gateway 返回 `409 {"error":"connection_required", "connect_url":"..."}`；上游拒绝已保存凭据时返回 `409 {"error":"upstream_credential_rejected", "connect_url":"..."}`，不会将上游 OAuth Challenge 当成平台登录 Challenge 透传。当前客户端应引导用户打开连接中心完成连接，再重试 MCP 请求。Gateway 的连接中心地址可用 `CONNECTIONS_WEB_URL` 覆盖。

没有 refresh token 的 access token 可使用到实际过期时间。刷新遇到网络错误、429、408 或 5xx 会保留 refresh token 供恢复，仅明确 `invalid_grant` 撤销刷新凭据。修改 OAuth 配置、断开连接或重新授权会取消旧 state；进行中的回调或刷新不能重新保存已撤销凭据。

### 凭据加密配置

Auth Server 使用 `CREDENTIAL_ENCRYPT_KEY`，值必须为 32 字节的十六进制字符串。Gateway 与 Auth Server 还必须共享独立的 `CREDENTIAL_BROKER_TOKEN`，用于保护仅面向 Gateway 的凭据读取接口；它与路由注册表的 `INTERNAL_API_TOKEN` 不同。Docker Compose 自带的默认值**仅用于本地开发**；其他环境须使用独立 Secret，例如：

```bash
export CREDENTIAL_ENCRYPT_KEY="$(openssl rand -hex 32)"
export CREDENTIAL_BROKER_TOKEN="$(openssl rand -hex 32)"
```

备份此密钥并与数据库备份一同管理；丢失或更换密钥会使已保存的 API Key、OAuth Token 和 Client Secret 不可解密。生产环境还应使用 HTTPS、限制内部凭据接口只能由 Gateway 访问，并为每个外部 OAuth 提供方核对回调、Scopes 和 Token 请求约定。

用户连接相关接口：`POST/GET/DELETE /me/session`、`GET/POST /me/signup`、`POST /me/email/send-code`、`POST /me/email/verify`、`GET /me/upstreams`、`PUT/DELETE /me/upstreams/:id/credential`、`POST /me/upstreams/:id/oauth`。这些接口使用浏览器的 HttpOnly 会话 Cookie；服务器会对带 `Origin` 的写请求检查来源。`GET /me/signup` 供登录页匿名读取注册开关，`POST /me/signup` 为自助注册（需用户名、邮箱、密码）并在成功后直接下发会话；管理员在系统设置中配置 SMTP 发件邮箱后，注册会自动发送 6 位邮箱验证码，`/me/email/send-code` 与 `/me/email/verify` 用于补发与校验。

### 系统 OAuth

在对应 MCP Server 配置中选择“系统 OAuth（管理员统一授权）”，填写提供方的 OAuth 参数。保存后点击该上游的“连接账号”，或在管理员个人连接中心对该上游发起授权。Auth Server 使用 Authorization Code + PKCE，回调地址为 `{AUTH_ISSUER}/oauth/upstream-callback/{UPSTREAM_ID}`。用户 OAuth 也使用这个回调地址，每个上游需在提供方注册自己的完整回调。

系统授权完成后 Access/Refresh Token 加密保存在系统凭据记录中。Gateway 检查调用用户对逻辑端点的权限后使用该系统 Token，普通用户不能发起、覆盖或撤销系统 OAuth。刷新在数据库锁中串行执行，保留轮换的 Refresh Token。系统连接解除、账号禁用、权限撤销、认证变更或重复回调均经过复核，未完成回调不能复活已撤销连接。

上游用户连接接口为 `GET /me/upstreams`、`PUT/DELETE /me/upstreams/:id/credential` 和 `POST /me/upstreams/:id/oauth`；后两个 OAuth 操作遇到系统模式时仅允许管理员。旧 `/me/servers` 接口仅用于兼容旧副本池。

业务工具调用采用独立的等待时间，默认最多 10 分钟，可通过 Gateway 环境变量 `UPSTREAM_TOOL_TIMEOUT_MS` 配置（1000–3600000 毫秒）。初始化和工具发现仍使用短超时。长时间论文检索建议使用上游的 `submit_search`、`get_search_status` 和 `get_search_result`。

连接测试与确认保存是两个独立动作：测试只使用点击时的草稿，不修改注册表或正式凭据；新填 API Key 立即用于该次测试，留空则沿用已保存 Key。即使草稿测试成功，未点击保存时正式流量仍使用之前的地址和认证配置。
