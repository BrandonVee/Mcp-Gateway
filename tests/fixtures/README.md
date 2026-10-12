# Smoke-test fixtures

This private workspace supplies MCP upstreams and registration data for disposable smoke-test databases. It is excluded from default Compose, local development startup, and the production runtime image. Its dependencies are development-only.

CI explicitly selects the `test-upstream` Docker target through `.github/compose.ci.yml`. The fixture tools cover legacy replica-pool session stickiness, load balancing, API Key injection, and upstream OAuth. The seeder explicitly retains `routing_mode=pool`; independent grouped upstreams and their credentials are exercised by `scripts/smoke-upstream-groups.ts`.

To import fixture records, set `DATABASE_URL` to a disposable database and run:

```bash
CONFIG_FILE="$PWD/config/docker.json" pnpm --filter @mcp/test-upstream seed --docker
```

The seeder requires an explicit database URL and refuses production mode. It never reads `.env.local`. Upstream addresses come from `servers.json`; fixture processes require `MCP_SERVER_NAME`, `MCP_INSTANCE_ID`, and `MCP_PORT`.
