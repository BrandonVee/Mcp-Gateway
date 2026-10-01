#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
prepare_only=false
use_local_image=false
interaction=auto
usage() {
  cat <<EOF
用法：$0 [--interactive | --yes] [--prepare-only] [--use-local-image]
  默认：终端中交互配置；非终端环境沿用环境变量和已有配置。
  --interactive   显式启用交互配置
  --yes           跳过提示，适用于 CI 和自动部署
  --prepare-only  只保存配置，不启动服务
  --use-local-image 使用已构建/导入的本地镜像，跳过构建和拉取
  --help          显示帮助
EOF
}
fail() { echo "$*" >&2; exit 1; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prepare-only) prepare_only=true ;;
    --use-local-image) use_local_image=true ;;
    --interactive|--yes|--non-interactive)
      selected=interactive
      if [[ "$1" != '--interactive' ]]; then selected=yes; fi
      if [[ "$interaction" != auto && "$interaction" != "$selected" ]]; then fail '--interactive 与 --yes 不能同时使用'; fi
      interaction=$selected ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "未知参数：$1" ;;
  esac
  shift
done
interactive=false
if [[ "$interaction" == interactive ]] || { [[ "$interaction" == auto ]] && [[ -t 0 && -t 1 ]]; }; then interactive=true; fi
command -v docker >/dev/null || fail '请先安装 Docker Engine 和 Compose 插件'
docker compose version >/dev/null || fail 'Docker Compose 插件不可用'
requested_version=${MCP_VERSION:-}
export MCP_DEPLOY_DIR=${MCP_DEPLOY_DIR:-"$root/deploy/single-host"}
env_path="$MCP_DEPLOY_DIR/runtime.env"
if [[ -f "$env_path" ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      MCP_VERSION|MCP_IMAGE_PREFIX|COMPOSE_PROJECT_NAME|POSTGRES_PASSWORD|REDIS_PASSWORD|INTERNAL_API_TOKEN|CREDENTIAL_BROKER_TOKEN|CREDENTIAL_ENCRYPT_KEY|ADMIN_PASSWORD|AUTH_TRUSTED_PROXY_IPS|MCP_HTTP_PORT)
        # Passwords are double-quoted for Compose; decode without evaluating input.
        if [[ "$value" == \"*\" ]]; then
          value=${value:1:${#value}-2}
          value=${value//\$\$/\$}
          value=${value//\\\"/\"}
          value=${value//\\\\/\\}
        fi
        if [[ -z "${!key:-}" ]]; then export "$key=$value"; fi ;;
    esac
  done < "$env_path"
fi
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-mcp-gateway}
export MCP_IMAGE_PREFIX=${MCP_IMAGE_PREFIX:-}
if $use_local_image; then export MCP_IMAGE_PREFIX=''; fi
export MCP_HTTP_PORT=${MCP_HTTP_PORT:-8080}
export AUTH_TRUSTED_PROXY_IPS=${AUTH_TRUSTED_PROXY_IPS:-}

read_answer() {
  printf '%s' "$1" >&2
  IFS= read -r answer || fail '输入已结束，未保存本次配置'
}
valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 )); }
valid_password() { [[ ${#1} -ge 16 && ! "$1" =~ [[:cntrl:]] ]]; }
valid_prefix() { [[ "$1" =~ ^[a-z0-9][a-z0-9._:/-]*/$ ]]; }
valid_version() { [[ "$1" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]]; }
generated_admin=false
if $interactive; then
  echo 'MCP Gateway 安装配置（回车保留默认值）' >&2
  echo '对外访问地址和可信上游将在管理后台的“系统设置”中填写。' >&2
  while true; do
    read_answer "HTTP 端口 [$MCP_HTTP_PORT]："
    candidate=${answer:-$MCP_HTTP_PORT}
    if valid_port "$candidate"; then export MCP_HTTP_PORT=$((10#$candidate)); break; fi
    echo '端口须为 1–65535 的整数。' >&2
  done
  if ! $use_local_image; then
    mode=1
    if [[ -n "$MCP_IMAGE_PREFIX" ]]; then mode=2; fi
    while true; do
      read_answer "镜像来源：1) 本机构建  2) 拉取已发布镜像 [$mode]："
      candidate=${answer:-$mode}
      if [[ "$candidate" == 1 || "$candidate" == 2 ]]; then mode=$candidate; break; fi
      echo '请输入 1 或 2。' >&2
    done
    if [[ "$mode" == 1 ]]; then
      export MCP_IMAGE_PREFIX=''
    else
      while true; do
        read_answer "镜像仓库前缀${MCP_IMAGE_PREFIX:+ [$MCP_IMAGE_PREFIX]}（如 ghcr.io/your-account/）："
        candidate=${answer:-$MCP_IMAGE_PREFIX}
        if [[ -n "$candidate" && "$candidate" != */ ]]; then candidate="$candidate/"; fi
        if valid_prefix "$candidate"; then export MCP_IMAGE_PREFIX=$candidate; break; fi
        echo '请输入小写的镜像仓库前缀。' >&2
      done
    fi
  fi
fi
if [[ -n "$requested_version" ]]; then
  export MCP_VERSION=$requested_version
elif [[ -z "$MCP_IMAGE_PREFIX" ]] && ! $use_local_image; then
  export MCP_VERSION=$(git rev-parse --short=12 HEAD)
fi
export MCP_VERSION=${MCP_VERSION:-$(git rev-parse --short=12 HEAD)}
if $interactive && [[ -n "$MCP_IMAGE_PREFIX" ]]; then
  while true; do
    read_answer "已发布的镜像版本 [$MCP_VERSION]："
    candidate=${answer:-$MCP_VERSION}
    if valid_version "$candidate"; then export MCP_VERSION=$candidate; break; fi
    echo '请输入有效的镜像 tag（最多 128 个字母、数字、下划线、点或连字符）。' >&2
  done
fi
if $interactive && [[ -z "${ADMIN_PASSWORD:-}" ]]; then
  while true; do
    printf '首次管理员密码（至少 16 个字符，留空自动生成，输入隐藏）：' >&2
    IFS= read -r -s password || fail '输入已结束，未保存本次配置'
    printf '\n' >&2
    if [[ -z "$password" ]]; then break; fi
    if ! valid_password "$password"; then echo '密码至少 16 个字符，不能包含控制字符。' >&2; continue; fi
    printf '再次输入管理员密码：' >&2
    IFS= read -r -s confirmation || fail '输入已结束，未保存本次配置'
    printf '\n' >&2
    if [[ "$password" != "$confirmation" ]]; then echo '两次密码不一致，请重新输入。' >&2; continue; fi
    export ADMIN_PASSWORD=$password
    break
  done
fi
valid_port "$MCP_HTTP_PORT" || fail 'MCP_HTTP_PORT 须为 1–65535 的整数'
export MCP_HTTP_PORT=$((10#$MCP_HTTP_PORT))
[[ "$COMPOSE_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'COMPOSE_PROJECT_NAME 须为小写字母、数字、下划线或连字符'
if [[ -n "$MCP_IMAGE_PREFIX" ]]; then valid_prefix "$MCP_IMAGE_PREFIX" || fail 'MCP_IMAGE_PREFIX 须为小写镜像仓库前缀，以 / 结尾'; fi
valid_version "$MCP_VERSION" || fail 'MCP_VERSION 不是有效的镜像 tag'
if [[ -z "${ADMIN_PASSWORD:-}" ]]; then generated_admin=true; fi
for key in POSTGRES_PASSWORD REDIS_PASSWORD INTERNAL_API_TOKEN CREDENTIAL_BROKER_TOKEN CREDENTIAL_ENCRYPT_KEY ADMIN_PASSWORD; do
  if [[ -z "${!key:-}" ]]; then
    value=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
    export "$key=$value"
  fi
done
valid_password "$ADMIN_PASSWORD" || fail 'ADMIN_PASSWORD 至少 16 个字符，不能包含控制字符'
for key in POSTGRES_PASSWORD REDIS_PASSWORD INTERNAL_API_TOKEN CREDENTIAL_BROKER_TOKEN CREDENTIAL_ENCRYPT_KEY; do
  if [[ ! "${!key}" =~ ^[0-9a-fA-F]{64}$ ]]; then echo "$key must contain 64 hex characters" >&2; exit 1; fi
done
if $interactive; then
  printf '\n配置目录：%s\nHTTP 入口：http://127.0.0.1:%s\n' "$MCP_DEPLOY_DIR" "$MCP_HTTP_PORT" >&2
  if $use_local_image; then
    echo "镜像：本地现有 mcp-app:$MCP_VERSION" >&2
  elif [[ -z "$MCP_IMAGE_PREFIX" ]]; then
    echo "镜像：本机构建，版本 $MCP_VERSION" >&2
  else
    echo "镜像：${MCP_IMAGE_PREFIX}mcp-app:$MCP_VERSION" >&2
  fi
  echo '管理员：admin；已有账号的密码不会因重新部署而修改。' >&2
  action='开始部署'
  if $prepare_only; then action='保存配置（不启动服务）'; fi
  read_answer "${action}？[Y/n]："
  case "$answer" in
    ''|y|Y|yes|YES) ;;
    *) echo '已取消，未保存本次配置。' >&2; exit 0 ;;
  esac
fi
umask 077
mkdir -p "$MCP_DEPLOY_DIR"
save_config() {
  cat > "$env_path" <<EOF
COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME
MCP_VERSION=$MCP_VERSION
MCP_IMAGE_PREFIX=$MCP_IMAGE_PREFIX
MCP_HTTP_PORT=$MCP_HTTP_PORT
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
REDIS_PASSWORD=$REDIS_PASSWORD
INTERNAL_API_TOKEN=$INTERNAL_API_TOKEN
CREDENTIAL_BROKER_TOKEN=$CREDENTIAL_BROKER_TOKEN
CREDENTIAL_ENCRYPT_KEY=$CREDENTIAL_ENCRYPT_KEY
AUTH_TRUSTED_PROXY_IPS=$AUTH_TRUSTED_PROXY_IPS
EOF
  # Compose expands $ in unquoted values. Preserve literal passwords, including
  # quotes, backslashes and dollar signs, for both manual Compose and this script.
  encoded_password=${ADMIN_PASSWORD//\\/\\\\}
  encoded_password=${encoded_password//\"/\\\"}
  encoded_password=${encoded_password//\$/\$\$}
  printf 'ADMIN_PASSWORD="%s"\n' "$encoded_password" >> "$env_path"
  chmod 600 "$env_path"
  cat > "$MCP_DEPLOY_DIR/config.json" <<EOF
{
  "auth": {
    "port": 9001, "issuer": "http://localhost:8080", "accessTokenTtlSeconds": 3600,
    "defaultAudience": "mcp-gateway", "internalApiToken": "provided-via-environment",
    "postgres": { "url": "postgres://unused:unused@postgres:5432/mcp", "poolMax": 10 },
    "bootstrap": { "adminUsername": "admin" }
  },
  "gateway": {
    "port": 8000, "resourceBaseUrl": "http://localhost:8080", "redisUrl": "redis://redis:6379",
    "authJwksUrl": "http://127.0.0.1:9001/jwks.json", "jwtAudience": "mcp-gateway",
    "sessionTtlSeconds": 3600, "registryUrl": "http://127.0.0.1:9001/internal/mcp-servers",
    "registryRefreshSeconds": 15
  }
}
EOF
  chmod 644 "$MCP_DEPLOY_DIR/config.json"
}
save_config
compose() { docker compose --env-file "$env_path" -f "$root/deploy/compose.single-host.yml" "$@"; }
compose config --quiet
if $prepare_only; then
  echo "配置已保存：$MCP_DEPLOY_DIR"
  if $generated_admin; then echo "首次管理员密码：$ADMIN_PASSWORD"; fi
  exit 0
fi

compose up -d --wait postgres redis
subnets=$(docker network inspect "${COMPOSE_PROJECT_NAME}_control" --format '{{range .IPAM.Config}}{{.Subnet}},{{end}}')
export AUTH_TRUSTED_PROXY_IPS=${subnets%,}
save_config
if $use_local_image; then
  docker image inspect "mcp-app:$MCP_VERSION" >/dev/null || fail "未找到本地镜像 mcp-app:$MCP_VERSION，请先构建或 docker load 导入。"
elif [[ -z "$MCP_IMAGE_PREFIX" ]]; then
  compose build app
else
  compose pull app
fi
# Build/pull succeeded; stop only the former application services in this project.
source "$root/scripts/deployment-containers.sh"
remove_legacy_apps "$COMPOSE_PROJECT_NAME"
compose up -d --no-build --pull never --wait
echo "Ready: proxy your Nginx to http://127.0.0.1:$MCP_HTTP_PORT"
echo "Log in through your Nginx and set the public URL in System settings."
echo "Administrator: admin. Initial password is stored as ADMIN_PASSWORD in $env_path"
if $generated_admin; then echo "Initial administrator password: $ADMIN_PASSWORD"; fi
