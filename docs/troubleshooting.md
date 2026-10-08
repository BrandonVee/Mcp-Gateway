# 故障排查

## 先确认整体状态

```bash
docker compose --env-file deploy/single-host/runtime.env -f deploy/compose.single-host.yml ps
curl --fail http://127.0.0.1:8080/healthz
```

`/healthz` 由统一应用转发到内部健康检查。若返回 503，继续查看 Auth Server 与 Gateway 的 `/health` 输出，以及容器日志：

```bash
docker compose --env-file deploy/single-host/runtime.env -f deploy/compose.single-host.yml logs --no-color mcp-server
```

## Registry / 动态路由不可用

- 表现：Gateway `/health` 中 `registry.ready=false` 或 `last_error` 非空；MCP 请求返回 `server_not_found`、`system_settings_unavailable`。
- 常见原因：PostgreSQL 不可用、Auth Server 刚重启、Auth Server 内部令牌不一致、`SYSTEM_CONFIG_MODE=database` 时系统设置读取失败。
- 处理：先确认 PostgreSQL 健康；再确认 Auth Server `/health`；检查 Auth 与 Gateway 是否使用同一个 `INTERNAL_API_TOKEN`；Gateway 启动最多等待 30 秒，注册表可用后会自动恢复，无需静态回退路由。

## Redis 不可用

- 表现：Auth `/health` 返回 503，或 Gateway `/health` 中 `redis=false`；登录、限流、MCP session 粘性与监控采集可能受影响。
- 常见原因：Redis 容器未就绪、`REDIS_URL` 不一致、内存或连接数上限。
- 处理：检查 Redis 日志与 `redis-cli ping`；确认容器网络地址；恢复后已有 MCP 客户端如丢失 session，需要重新 initialize。

## 上游连接失败

- 表现：Gateway `/health` 中 `upstreams.unavailable > 0`，管理台拓扑显示实例不可用；调用可能 502/503/504。
- 说明：探测只验证 TCP/TLS 连通性，不等同于 MCP 工具可用。
- 处理：确认实例 URL、端口、协议和路径；确认系统设置中的可信上游白名单包含主机；查看上游容器日志；启用实例或新增健康实例后，Gateway 会在下一次刷新中恢复路由。

## 监控采集异常或积压

- 表现：管理台显示“采集异常”“待入库事件”增长或“队列丢失事件”非零。
- 常见原因：Redis Stream 不可用、事件产生速度超过入库速度、PostgreSQL 写入慢。
- 处理：先恢复 Redis 和 PostgreSQL；查看 Auth Server 日志；监控数据为尽力采集，队列异常期间统计可能缺失，不应作为计费凭据。

## 告警没有通知

- 系统设置中的邮件通知需要同时配置 SMTP Host、From 和告警邮件接收人；Webhook 只需填写 HTTP/HTTPS 回调地址。
- 告警每分钟评估一次；错误率需要最近 5 分钟至少 20 个已知结果，P95 需要至少 20 个耗时样本。
- 管理台告警历史会显示 `notified_at` 与 `notification_error`。Webhook 非 2xx、超时或 SMTP 失败不会重试，下一次评估周期恢复后会继续更新当前告警。
- 确认收到通知后，在监控页对当前告警执行“确认”。

## 授权已撤销但客户端仍重试

- Gateway 会实时复核 `auth_version` 与当前授权；撤销授权后旧 Access Token 应立即得到 403。
- 如客户端反复触发 OAuth，先确认其仍持有旧 Token；管理员新增授权后，JWT 中的授权快照不会自动扩展，客户端需要重新授权获取新 Token。
- 若怀疑运行中的镜像较旧，重新执行部署或更新，并确认容器版本。

## 备份恢复后告警或监控数据不完整

- 备份包含 PostgreSQL 与配置，不包含 Redis 会话；恢复后调用统计、告警历史随数据库恢复，但 Redis 中的 pending 监控事件可能丢失。
- 恢复后运行迁移并等待 Auth Server 与 Gateway 健康检查恢复；不要使用 `down -v` 清理生产数据卷。
