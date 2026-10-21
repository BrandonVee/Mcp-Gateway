# MCP Gateway

统一的 MCP 服务入口，提供 OAuth 认证、用户与服务权限、用户自行注册、上游凭据管理、调用日志与频次统计。

- 一个应用镜像包含管理网页、认证服务、MCP 网关和内部 Nginx。
- PostgreSQL 与 Redis 独立运行，可连接已有服务，也可使用下方的 Compose 一起启动。
- 支持 `linux/amd64`、`linux/arm64`。应用入口为 `8080`。
- 标签：`latest` 跟随最新正式发布版本；12 位 Git 提交号用于固定版本；发布版本还提供 `vX.Y.Z` / `X.Y.Z` 标签。

## 方式一：首次打开网页，连接已有 PostgreSQL 和 Redis

准备好 PostgreSQL（建议 16）数据库、具备建表及创建 schema 权限的专用账号，以及可读写并执行 Lua 的 Redis（建议 7）账号。首次配置不需要事先填写环境变量。

```bash
docker network create mcp-gateway
docker volume create mcp-gateway-data
docker run -d \
  --name mcp-gateway-server \
  --network mcp-gateway \
  --restart unless-stopped \
  --stop-timeout 15 \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -p 127.0.0.1:8080:8080 \
  -v mcp-gateway-data:/app/data \
  brandonvee/mcp-gateway:latest

docker logs mcp-gateway-server
```

1. 在日志中找到 `[setup] initialization key:` 后面的初始化密钥。
2. 在部署机器打开 `http://127.0.0.1:8080`；远程部署可通过 HTTPS 反向代理访问，或在自己的电脑执行 `ssh -L 18080:127.0.0.1:8080 用户@服务器`，再打开 `http://127.0.0.1:18080`。
3. 第一步输入初始化密钥，点击“验证并继续”。
4. 第二步只填写 PostgreSQL 参数，点击“测试 PostgreSQL 并继续”；第三步只填写 Redis 参数，点击“测试 Redis 并继续”。每一步独立测试，通过后才能进入下一步；可返回上一步修改，已填内容会保留。高级选项可填写完整连接 URL，启用 TLS 时校验服务器证书。
5. 第四步设置管理员账号与至少 16 个字符的密码，点击“保存并启动”。程序会重新测试两项连接，生成独立的应用密钥，保存配置并自动进入管理页面。刷新页面需要重新填写；前三步不写入持久化配置。
6. 配置下面的 HTTPS 入口，再登录后台，在“系统设置”填写系统的 HTTPS 访问地址、可信上游、注册与监控选项。

**地址要从容器内可访问。** `127.0.0.1` / `localhost` 指应用容器自身；另一容器应使用同一 Docker 网络中的服务名，已有外部服务应使用其可访问的 IP / DNS。Docker Desktop 可使用 `host.docker.internal`；Linux 连接宿主机服务时，可在上述启动命令加 `--add-host host.docker.internal:host-gateway`，并确保数据库监听地址及防火墙允许 Docker 网络访问。

配置保存在 `/app/data/bootstrap.json`，初始化后网页配置接口关闭；重启或重建容器会读取同一个数据卷。请备份这个卷，尤其要保留凭据加密密钥。不要使用空卷连接已有业务库，否则之前保存的上游凭据无法解密。显式提供的环境变量优先于保存的配置。已有完整环境变量的部署直接启动应用。

等待初始化时 `/healthz` 返回 `mode: setup, ready: false`；初始化后才提供完整应用健康状态。管理员登录使用安全 Cookie，需要 HTTPS；本机 HTTP / SSH 隧道可完成连接参数初始化。

## 方式二：Compose 自动启动 PostgreSQL、Redis 和应用

以下方式自动配置数据连接与应用密钥，启动后直接进入管理网页。无需克隆源码仓库。

新建目录，在其中生成仅当前用户可读的 `.env`（仅首次执行，不要覆盖已有配置）：

```bash
mkdir mcp-gateway
cd mcp-gateway
umask 077
{
  echo MCP_VERSION=latest
  echo POSTGRES_PASSWORD=$(openssl rand -hex 32)
  echo REDIS_PASSWORD=$(openssl rand -hex 32)
  echo INTERNAL_API_TOKEN=$(openssl rand -hex 32)
  echo CREDENTIAL_BROKER_TOKEN=$(openssl rand -hex 32)
  echo CREDENTIAL_ENCRYPT_KEY=$(openssl rand -hex 32)
  echo ADMIN_PASSWORD=$(openssl rand -hex 32)
} > .env
```

保存以下内容为 `compose.yml`：

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: mcp
      POSTGRES_USER: mcp
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?}
    volumes: ['postgres_data:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U mcp -d mcp']
      interval: 3s
      timeout: 3s
      retries: 30
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ['sh', '-c', 'exec redis-server --appendonly yes --requirepass "$$REDIS_PASSWORD"']
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD:?}
    volumes: ['redis_data:/data']
    healthcheck:
      test: ['CMD-SHELL', 'REDISCLI_AUTH=$$REDIS_PASSWORD redis-cli ping | grep -q PONG']
      interval: 3s
      timeout: 3s
      retries: 30
  mcp-server:
    container_name: ${COMPOSE_PROJECT_NAME:-mcp-gateway}-server
    image: brandonvee/mcp-gateway:${MCP_VERSION:-latest}
    restart: unless-stopped
    stop_grace_period: 15s
    read_only: true
    tmpfs: ['/tmp']
    cap_drop: ['ALL']
    security_opt: ['no-new-privileges:true']
    environment:
      DATABASE_URL: postgres://mcp:${POSTGRES_PASSWORD:?}@postgres:5432/mcp
      REDIS_URL: redis://:${REDIS_PASSWORD:?}@redis:6379/0
      INTERNAL_API_TOKEN: ${INTERNAL_API_TOKEN:?}
      CREDENTIAL_BROKER_TOKEN: ${CREDENTIAL_BROKER_TOKEN:?}
      CREDENTIAL_ENCRYPT_KEY: ${CREDENTIAL_ENCRYPT_KEY:?}
      ADMIN_USERNAME: admin
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:?}
      AUTH_TRUSTED_PROXY_IPS: ${AUTH_TRUSTED_PROXY_IPS:-}
    ports: ['127.0.0.1:8080:8080']
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    networks: [default, mcp-gateway]
volumes:
  postgres_data:
  redis_data:

networks:
  default:
  mcp-gateway:
    name: mcp-gateway
    external: true
```

```bash
docker network create mcp-gateway
docker compose up -d --wait
curl --fail http://127.0.0.1:8080/healthz
```

管理员账号为 `admin`，初始密码在 `.env` 的 `ADMIN_PASSWORD` 中；配置 HTTPS 入口后登录，然后填写后台系统设置。数据库和 Redis 端口未发布到公网。已有源码的部署也可执行 `./scripts/deploy.sh`，选择拉取镜像：前缀 `brandonvee/`、名称 `mcp-gateway`、版本 `latest`。

共享网络 `mcp-gateway` 供其他 MCP 容器接入；如果网络已存在，可跳过创建命令。执行 `docker network connect mcp-gateway <容器名>` 后，上游地址使用 `http://<容器名>:<容器内部端口>/mcp`，并在系统设置中允许该上游主机。其他 Compose 项目应把服务加入 `name: mcp-gateway`、`external: true` 的网络，以便重建后仍可连接。

## HTTPS 入口

在宿主机 Nginx 已配置域名和 HTTPS 证书的 `server` 中加入：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

应用容器按 `<项目名>-server` 命名，一键部署和上述 `mcp-gateway` 目录部署的名称为 `mcp-gateway-server`；自定义项目名时使用对应前缀，避免多个部署重名。Compose 服务名保留 `mcp-server`，使用 `docker compose logs mcp-server` 查看日志；上述 `docker run` 命令的容器名为 `mcp-gateway-server`。

调用频次统计与登录限流依赖真实客户端 IP。设置 `AUTH_TRUSTED_PROXY_IPS` 为可信反向代理实际地址或其 Docker 网段，再重建应用；勿信任所有地址 `0.0.0.0/0`。外部代理需正确覆盖转发头。若由宿主机 Nginx 代理，可用 `docker inspect mcp-gateway-server` 查看容器所在网络，再用 `docker network inspect <网络名>` 确认宿主机网关地址。方式一在 `docker run` 加 `-e AUTH_TRUSTED_PROXY_IPS=<该网关IP>`，方式二在 `.env` 填写后执行 `docker compose up -d`。

## 更新、日志和备份

后台版本检测并行查询 GitHub Releases、Docker Hub API 和 Docker Registry，任一来源成功即可显示版本。源码仓库为私有仓库，匿名 GitHub 查询返回 404 不代表没有新版本；Registry 使用公开镜像的匿名拉取权限，无需配置 GitHub Token。Registry 备用来源按版本号排序并保留最近 20 个稳定版本，通过 manifest 的不可变 digest 固定更新目标。

如果版本检查失败，`release_check_failures` 会分别报告各来源的失败原因。`update_available: null` 表示暂时无法判断更新状态。请从应用容器内检查对 `hub.docker.com`、`auth.docker.io` 和 `registry-1.docker.io` 的 HTTPS 出站连接；宿主机能拉取镜像不代表容器内能访问这些接口。需要代理时，为应用容器配置 `HTTPS_PROXY` / `HTTP_PROXY`（支持 `http://` 或 `https://` 地址）及适当的 `NO_PROXY`，重建容器后重试。Docker daemon 拉取镜像的代理需在 daemon 中单独配置。

旧版统一应用容器可能名为 `mcp-gateway-mcp-server-1`。更新 Compose 配置后重新部署，Compose 会重建为 `mcp-gateway-server`；一键部署执行 `./scripts/deploy.sh --yes`，沿用现有配置。后台镜像更新会保留当前容器名称，不会仅因镜像升级而改名。希望立即改名且不中断服务时，可执行：

```bash
docker rename mcp-gateway-mcp-server-1 mcp-gateway-server
```

旧版 Compose 服务名为 `app`。源码的一键部署脚本会在新镜像准备成功后移除当前项目中的旧 `app`，保留数据库、Redis 和数据卷。手动 Compose 部署应先用原 Compose 文件停止并移除旧 `app` 容器，再用新文件启动 `mcp-server`；沿用原项目名和所有数据卷，不要删除 `/app/data` 配置。只改服务名不会改镜像仓库或数据卷名。

Compose 部署：

```bash
docker compose pull mcp-server
docker compose up -d --wait mcp-server
docker compose logs --tail 100 mcp-server
```

单应用容器：先保留启动参数与 `mcp-gateway-data` 卷，拉取镜像后停止并删除旧应用容器，再用相同参数重建。无需重新初始化。固定版本时将 `latest` 改为已发布的提交号 / 版本。

健康检查：`curl --fail http://127.0.0.1:8080/healthz`。应用端口无需额外暴露认证服务与网关内部端口。

备份需同时保存 PostgreSQL 数据、Redis 持久化数据、应用配置及加密密钥。方式一须备份 `mcp-gateway-data`；方式二须保存 `.env`，并使用 PostgreSQL / Redis 对应的备份工具。不要执行 `docker compose down -v` 或删除配置卷来升级。源码部署可使用 `./scripts/backup.sh` 与 `./scripts/restore.sh`。

源码与详细文档：[BrandonVee/Mcp-Gateway](https://github.com/BrandonVee/Mcp-Gateway)（访问源码仓库需相应 GitHub 权限；上方镜像部署无需源码权限）。
