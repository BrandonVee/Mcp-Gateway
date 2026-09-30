#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
prepare_only=false
if [[ "${1:-}" == '--prepare-only' ]]; then prepare_only=true; shift; fi
if [[ $# -ne 0 ]]; then echo "Usage: $0 [--prepare-only]" >&2; exit 1; fi
requested_version=${MCP_VERSION:-}
export MCP_DEPLOY_DIR=${MCP_DEPLOY_DIR:-"$root/deploy/single-host"}
env_path="$MCP_DEPLOY_DIR/runtime.env"
umask 077
mkdir -p "$MCP_DEPLOY_DIR"
if [[ -f "$env_path" ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      MCP_VERSION|MCP_IMAGE_PREFIX|COMPOSE_PROJECT_NAME|POSTGRES_PASSWORD|REDIS_PASSWORD|INTERNAL_API_TOKEN|CREDENTIAL_BROKER_TOKEN|CREDENTIAL_ENCRYPT_KEY|ADMIN_PASSWORD|AUTH_TRUSTED_PROXY_IPS|MCP_HTTP_PORT)
        if [[ -z "${!key:-}" ]]; then export "$key=$value"; fi ;;
    esac
  done < "$env_path"
fi
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-mcp-gateway}
export MCP_IMAGE_PREFIX=${MCP_IMAGE_PREFIX:-}
if [[ -n "$requested_version" ]]; then
  export MCP_VERSION=$requested_version
elif [[ -z "$MCP_IMAGE_PREFIX" ]]; then
  export MCP_VERSION=$(git rev-parse --short=12 HEAD)
fi
export MCP_VERSION=${MCP_VERSION:-$(git rev-parse --short=12 HEAD)}
export MCP_HTTP_PORT=${MCP_HTTP_PORT:-8080}
export AUTH_TRUSTED_PROXY_IPS=${AUTH_TRUSTED_PROXY_IPS:-}

new_admin=false
if [[ -z "${ADMIN_PASSWORD:-}" ]]; then new_admin=true; fi
for key in POSTGRES_PASSWORD REDIS_PASSWORD INTERNAL_API_TOKEN CREDENTIAL_BROKER_TOKEN CREDENTIAL_ENCRYPT_KEY ADMIN_PASSWORD; do
  if [[ -z "${!key:-}" ]]; then
    value=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
    export "$key=$value"
  fi
done
for key in POSTGRES_PASSWORD REDIS_PASSWORD INTERNAL_API_TOKEN CREDENTIAL_BROKER_TOKEN CREDENTIAL_ENCRYPT_KEY; do
  if [[ ! "${!key}" =~ ^[0-9a-fA-F]{64}$ ]]; then echo "$key must contain 64 hex characters" >&2; exit 1; fi
done
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
ADMIN_PASSWORD=$ADMIN_PASSWORD
AUTH_TRUSTED_PROXY_IPS=$AUTH_TRUSTED_PROXY_IPS
EOF
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
    "authJwksUrl": "http://auth:9001/jwks.json", "jwtAudience": "mcp-gateway",
    "sessionTtlSeconds": 3600, "registryUrl": "http://auth:9001/internal/mcp-servers",
    "registryRefreshSeconds": 15
  }
}
EOF
  chmod 644 "$MCP_DEPLOY_DIR/config.json"
}
save_config
command -v docker >/dev/null || { echo 'Install Docker Engine and its Compose plugin first' >&2; exit 1; }
compose() { docker compose --env-file "$env_path" -f "$root/deploy/compose.single-host.yml" "$@"; }
compose config --quiet
if $prepare_only; then echo "Deployment configuration prepared in $MCP_DEPLOY_DIR"; exit 0; fi

compose up -d --wait postgres redis
subnets=$(docker network inspect "${COMPOSE_PROJECT_NAME}_control" --format '{{range .IPAM.Config}}{{.Subnet}},{{end}}')
export AUTH_TRUSTED_PROXY_IPS=${subnets%,}
save_config
if [[ -z "$MCP_IMAGE_PREFIX" ]]; then
  compose build auth admin-web
else
  compose pull auth gateway admin-web
fi
compose up -d --no-build --pull never --wait
echo "Ready: proxy your Nginx to http://127.0.0.1:$MCP_HTTP_PORT"
echo "Log in through your Nginx and set the public URL in System settings."
echo "Administrator: admin. Initial password is stored as ADMIN_PASSWORD in $env_path"
if $new_admin; then echo "Initial administrator password: $ADMIN_PASSWORD"; fi
