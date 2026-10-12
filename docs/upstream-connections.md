# 上游服务接入与用户凭据

注册外部 MCP Server、上游白名单，以及用户连接上游所需的 API Key / OAuth 凭据。

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
注册服务、添加实例或修改实例地址时，可点击 **测试 MCP 连接**。测试由实际 Gateway 发起 MCP 初始化；上游声明支持工具时，还会读取一页工具列表。支持 JSON 和 SSE 响应，测试使用匿名连接，不执行业务工具。需要上游认证时会明确提示，后续须配置系统密钥或在个人连接中心配置用户凭据，并通过客户端验证。
测试结果区分 DNS 解析失败、连接拒绝、超时、TLS、HTTP 状态、错误路径与 MCP 协议异常；地址改变后会清除旧结果。测试沿用上游白名单，需先加入可信主机；成功测试会清除该地址的临时不可用状态。MCP 测试最长 8 秒，单个响应限制为 1 MiB，网关最多同时执行 4 个测试；会话在测试完成后关闭。
Docker 部署中的 `127.0.0.1` / `localhost` 指网关容器自身。容器名称需要可解析的 Docker 网络；跨网络接入可使用网关能访问的宿主机地址与映射端口，宿主机只绑定回环地址的端口不能这样访问。
统一应用镜像和本地开发自动通过回环地址连接 Gateway。Auth / Gateway 分离部署时，在 Auth 配置 `GATEWAY_INTERNAL_URL=http://gateway:8000`（按实际内部地址调整）；仓库的分离部署 Compose 已配置该值。浏览器只访问管理员接口，内部测试入口仍由内部 Token 保护，不经公网 Nginx 暴露。
上游白名单可在后台“系统设置”中启用或关闭，默认开启；旧配置也按开启处理。开启时 Auth Server 注册与 Gateway 同步路由均会校验可信上游主机，名单为空时拒绝所有上游；关闭时仍校验 URL 的合法性，注册时仍拒绝网关自引用。保存后 Auth Server 立即生效，Gateway 在下一次路由同步时生效（默认 15 秒）。配置文件模式通过 `MCP_UPSTREAM_ALLOWLIST_ENABLED`（默认 `true`）控制开关，通过 `MCP_UPSTREAM_ALLOWED_HOSTS` 指定主机名单（逗号分隔）。Gateway 还会拒绝不在 `MCP_ALLOWED_ORIGINS` 中的浏览器 MCP Origin，并用 `UPSTREAM_MAX_ACTIVE_REQUESTS`（默认 100，每进程）限制同时上游请求数；部署配置和网络隔离要求见 [生产部署与上线检查](production.md)。

## 外部服务的认证

平台登录与外部服务凭据是两层独立认证：用户先取得某个逻辑 Server 的访问授权，再登录 **http://localhost:5173/** 为该 Server 连接自己的 API Key 或 OAuth 账号。管理员从侧边栏进入个人连接中心，在 Server 卡片的“设置认证”中选择 `无额外认证`、`用户 API Key`、`系统 API 密钥` 或 `用户 OAuth`，并在“分配权限”中选择可访问该 Server 的普通用户。切换认证方式会删除该 Server 已保存的用户连接，以避免旧凭据被误用。

管理后台侧边栏的**二次认证**页面会列出用户与需要认证的 Server 的授权关系、连接状态、认证方式和更新时间；管理员可撤销单个用户的连接，用户随后需在**个人连接中心**重新配置。管理页面只返回连接元数据，不显示 API Key、Access Token 或 Refresh Token。管理员与普通用户共用 `/` 登录页，登录后按角色进入对应工作台；管理后台侧边栏提供个人连接中心入口，旧 `/connections` 链接仍可使用。管理接口为 `GET /admin/connections` 和 `DELETE /admin/connections/:userId/:serverName`，仅管理员可调用。

### API Key

管理员配置上游请求头（`authorization` 或 `x-*`）及值前缀。例如 `authorization` + `Bearer `，或 `x-api-key` + 空前缀。用户在连接中心输入 Key 后，Auth Server 使用 AES-256-GCM 加密并保存，Gateway 仅在该用户的请求中向上游注入；管理 API 和用户状态接口均不返回密钥明文。更新和断开连接也由用户在连接中心完成。

### 系统 API Key

在服务的认证配置中选择“系统 API 密钥”，由管理员填写 Key、上游请求头及值前缀，再通过用户管理分配服务权限。用户以自己的平台身份访问，Gateway 检查权限后携带统一 Key 调用上游；用户无需在连接中心填写或领取上游密钥。

管理 API 使用 `auth_mode: "system_api_key"` 和 `system_api_key` 字段创建或修改服务。首次配置必须提供非空密钥；编辑时省略 `system_api_key` 保留当前密钥，提供新值则更新。密钥使用 AES-256-GCM 加密保存，服务列表只返回 `system_api_key_configured` 状态。切换到其他认证模式会清除系统密钥。撤销用户的服务权限即可阻止其继续使用；所有获得权限的用户共用上游账号及其配额。系统密钥缺失或被上游拒绝时，Gateway 返回 `503 system_credential_unavailable` 或 `503 system_credential_rejected`，由管理员修复配置。

### OAuth

管理员配置外部提供方的授权地址、Token 地址、Client ID、可选 Client Secret、Token 端点客户端认证方式（无、`client_secret_basic`、`client_secret_post`）、Scopes、Resource URL 和响应 Issuer。需在提供方注册回调地址：

```text
{AUTH_ISSUER}/oauth/callback/{SERVER_NAME}
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

用户连接相关接口：`POST/GET/DELETE /me/session`、`GET/POST /me/signup`、`POST /me/email/send-code`、`POST /me/email/verify`、`GET /me/servers`、`PUT/DELETE /me/servers/:name/credential`、`POST /me/servers/:name/oauth`。这些接口使用浏览器的 HttpOnly 会话 Cookie；服务器会对带 `Origin` 的写请求检查来源。`GET /me/signup` 供登录页匿名读取注册开关，`POST /me/signup` 为自助注册（需用户名、邮箱、密码）并在成功后直接下发会话；管理员在系统设置中配置 SMTP 发件邮箱后，注册会自动发送 6 位邮箱验证码，`/me/email/send-code` 与 `/me/email/verify` 用于补发与校验。
