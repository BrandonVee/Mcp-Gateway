# Python MCP 本地示例

这个目录提供三个独立的 Streamable HTTP MCP 服务，分别监听本机 `3101`、`3102`、`3103`，通过项目管理 API 注册为 `python-math`、`python-text`、`python-utility`。它们只用于本地测试。

需要 `uv`。在项目根目录先确保 PostgreSQL、Redis 以及宿主机上的 Auth Server 和 Gateway 正在运行。然后在两个终端中操作：

```bash
cd examples/python-mcp
uv sync
uv run python run_servers.py
```

第二个终端：

```bash
cd examples/python-mcp
uv run python register.py  # 输入管理员密码；重复运行会跳过已注册的相同服务
uv run python verify.py    # 通过 Gateway 列出工具并各调用一次
```

也可通过环境变量 `MCP_ADMIN_USERNAME`、`MCP_ADMIN_PASSWORD` 提供管理员凭据。`verify.py` 使用项目已有的 `demo-client` OAuth 客户端；首次准备演示数据时可运行根目录的 `pnpm db:seed:dev`。访问地址分别是 `http://localhost:8000/mcp/python-math`、`/mcp/python-text`、`/mcp/python-utility`。按 `Ctrl+C` 或运行 `uv run python stop_servers.py` 会一起停止三个 Python 服务；已注册的记录会留在 PostgreSQL，可在管理后台删除。
