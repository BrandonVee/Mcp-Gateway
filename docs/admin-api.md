# 管理 API 与管理端

## 管理 API

开发环境中的管理接口可用 `role=admin` 的 Bearer token；生产环境默认使用管理员浏览器会话，自动化 Bearer 调用还需显式配置受信 Client ID 和管理 API Audience（见 [生产部署文档](production.md)）：

```http
GET    /admin/servers
POST   /admin/servers
PATCH  /admin/servers/:name
DELETE /admin/servers/:name
GET    /admin/servers/:name/users
PUT    /admin/servers/:name/users

POST   /admin/servers/:name/instances
PATCH  /admin/servers/:name/instances/:id
DELETE /admin/servers/:name/instances/:id

GET /admin/users/:id/servers
PUT /admin/users/:id/servers
PATCH /admin/users/:id
GET   /admin/audit-events
GET   /admin/system-settings
PUT   /admin/system-settings
```

`GET /admin/audit-events` 仅管理员可读，支持 `limit`（1–100，默认 50）、`before`（上一页最后一条事件 ID）、`actor` 和 `method`（POST/PUT/PATCH/DELETE）查询参数。响应为 `{ "events": [...], "next_before": ID | null }`；参数错误返回 400，未授权返回 403。事件仅包含时间、操作人、HTTP 方法、路径、状态码和请求 ID，不保存请求正文、Cookie、Token 或密钥。

替换某个用户的全部 server 授权：

```bash
curl -X PUT http://localhost:9001/admin/users/USER_ID/servers \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"servers":["search","knowledge"]}'
```

也可以通过 `PUT /admin/servers/:name/users` 提交 `{"user_ids":[USER_ID]}`，从 Server 视角替换普通用户的指定授权。通配符用户不在单个 Server 的授权列表中编辑；管理员账号默认具有全部 Server 的访问权限。

给普通用户设置通配符：`PUT /admin/users/:id/servers` 提交 `{"servers":["*"]}`。`*` 必须单独使用，不能与具体 Server 名称混用；撤销通配符后可再分配具体 Server。

管理员通过 `PATCH /admin/users/:id` 设置 `{"disabled":true}` 可关闭用户认证。关闭认证、重置密码或变更角色会递增认证版本，撤销浏览器会话、授权码、刷新令牌和待完成的上游 OAuth 授权，并立即拒绝旧管理与 MCP Access Token。认证记录绑定不可复用用户 ID，删除后重建同名账号不会继承旧身份。最后一名启用管理员不可禁用、降级或删除，界面和服务端均拦截，包括并发操作。移除 Server 授权会立即阻止旧 Access Token 访问；新增授权仍需获取新 Token，因为 JWT 中的授权列表是签发时的快照。

创建和编辑逻辑端点还支持以下字段：

| 字段                         | 默认值 | 含义                                                 |
| ---------------------------- | ------ | ---------------------------------------------------- |
| `user_rate_limit_per_minute` | 120    | 每用户每分钟请求上限，0 为不限                       |
| `user_max_concurrent`        | 5      | 每用户同时请求上限，0 为不限                         |
| `user_daily_quota`           | 0      | 每用户每日受理的工具调用次数，UTC 零点重置，0 为不限 |
| `monitoring_logs_enabled`    | false  | 是否记录端点的输入输出，同时受系统调用明细开关控制   |

`GET /admin/connections` 新增 `validation_status`（`saved`、`verified`、`rejected`）及 `validated_at` 元数据。个人连接状态区分凭据已保存、已验证、被拒绝和过期；连接中心的验证接口及并发策略见 [上游服务接入](upstream-connections.md)。

## 前端管理系统

`packages/admin-web` 是 React + TypeScript + Vite + Ant Design 管理端，覆盖：

- 管理员与普通用户统一从 `/` 登录、退出，按角色进入对应工作台；跨标签页切换账号会重新核验身份，旧页面不能将凭据保存给新账号；
- 用户创建、认证开关、删除和密码重置；
- 从用户或 Server 两个视角管理 MCP Server 访问授权；
- 内部/外部 MCP Server 注册、启停和删除；
- 上游实例添加、启停、删除；
- Gateway、Redis、动态注册表运行状态总览；
- 系统设置：维护对外访问地址、可信上游、注册开关、调用采集开关、保留期限和告警阈值；
- 日志监控：服务健康、调用趋势、服务/工具/用户/客户端排行、调用明细、当前阈值告警，以及可筛选的管理操作审计；
- 个人连接中心可复制单个或全部已授权 Server 的 MCP 配置；复制结果是 `mcpServers` 字段的内容，不包含外层 `mcpServers` 包装。配置只包含 Gateway URL（本地开发默认 `http://localhost:8000/mcp/{SERVER_NAME}`），登录和二次认证仍由各自的 OAuth/连接流程完成。平台动态注册支持 [WorkBuddy 文档](https://open.workbuddy.cn/docs/connector)所述的私有协议 OAuth 回调及本机回环回调；
- 中文/英文界面切换：登录页、管理台、连接中心共用语言下拉菜单；页面标题、状态、表单、提示和请求错误均来自语义键的 `zh-CN` / `en-US` 资源文件。语言选择保存在浏览器本地存储，变量通过 `t("key", { name })` 传递。OAuth 登录/授权页按 `Accept-Language`（含权重）或 `?lang=zh-CN|en-US` 选择语言，并在表单提交时保持选择。协议名称、产品名称、HTTP 方法和实际标识符保持原文；
- 界面字体：英文使用 Nunito，简体中文使用随前端打包的 [Resource Han Rounded CN](https://github.com/CyanoHao/Resource-Han-Rounded) 字形子集；字体许可及更新说明见 `packages/admin-web/src/assets/fonts/`。

本地单独启动：

```bash
pnpm dev:admin
```

Vite 开发服务器会把 `/api/*` 转发至 Auth Server，把 `/gateway/*` 转发至 Gateway；目标可分别通过 `ADMIN_API_TARGET` 与 `GATEWAY_TARGET` 覆盖。
