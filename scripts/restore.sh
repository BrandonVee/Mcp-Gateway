#!/usr/bin/env bash
set -euo pipefail
umask 077
project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
deployment_dir=${MCP_DEPLOY_DIR:-"$project_dir/deploy/single-host"}
if [[ ${1:-} == --help || $# == 0 ]]; then
  echo '用法：scripts/restore.sh --confirm <备份文件>；会替换当前数据库与加密密钥，并重启应用。加密备份须设置 MCP_BACKUP_IDENTITY（age 私钥文件）。'
  exit 0
fi
[[ $# == 2 && $1 == --confirm ]] || { echo '恢复须显式提供 --confirm 和备份文件' >&2; exit 1; }
[[ -f "$2" && -f "$deployment_dir/runtime.env" ]] || { echo '缺少备份或部署配置' >&2; exit 1; }
stage=$(mktemp -d "${TMPDIR:-/tmp}/mcp-restore.XXXXXX")
trap 'rm -rf -- "$stage"; rm -f -- "$deployment_dir/runtime.env.restoring" "$deployment_dir/config.json.restoring"' EXIT
archive=$2
if [[ "$archive" == *.age ]]; then
  [[ -n ${MCP_BACKUP_IDENTITY:-} ]] || { echo '请设置 MCP_BACKUP_IDENTITY' >&2; exit 1; }
  age -d -i "$MCP_BACKUP_IDENTITY" -o "$stage/backup.tar.gz" "$archive"
  archive="$stage/backup.tar.gz"
fi
entries=$(tar -tzf "$archive")
[[ $(printf '%s\n' "$entries" | wc -l | tr -d ' ') == 4 ]] || { echo '备份文件结构无效' >&2; exit 1; }
while IFS= read -r entry; do
  case "$entry" in database.dump|runtime.env|config.json|sha256.txt) ;; *) echo '备份包含意外路径' >&2; exit 1 ;; esac
done <<< "$entries"
tar -tvzf "$archive" | awk 'substr($0,1,1)!="-" {exit 1}' || { echo '备份包含非普通文件' >&2; exit 1; }
tar -C "$stage" -xzf "$archive" database.dump runtime.env config.json sha256.txt
awk 'NF!=2 || length($1)!=64 || $1!~/^[a-f0-9]+$/ || $2!~/^(database\.dump|runtime\.env|config\.json)$/ || seen[$2]++ {exit 1} END {if(NR!=3) exit 1}' "$stage/sha256.txt" || { echo '备份校验清单无效，未修改数据库' >&2; exit 1; }
if command -v sha256sum >/dev/null; then checksum=(sha256sum); else checksum=(shasum -a 256); fi
(cd "$stage" && "${checksum[@]}" -c sha256.txt >/dev/null) || { echo '备份校验失败，未修改数据库' >&2; exit 1; }
for key in POSTGRES_PASSWORD REDIS_PASSWORD; do
  stored=$(sed -n "s/^${key}=//p" "$stage/runtime.env")
  current=$(sed -n "s/^${key}=//p" "$deployment_dir/runtime.env")
  [[ -n "$stored" && "$stored" == "$current" ]] || { echo '备份与当前数据库/Redis 密码不匹配。新主机须先使用备份中的部署配置初始化依赖。' >&2; exit 1; }
done
compose=(docker compose --env-file "$deployment_dir/runtime.env" -f "$project_dir/deploy/compose.single-host.yml")
"${compose[@]}" exec -T postgres pg_restore --list < "$stage/database.dump" >/dev/null
# Restore restarts without pulling/building; validate availability before replacing data.
while IFS= read -r image; do
  docker image inspect "$image" >/dev/null || { echo '缺少当前版本镜像，请先准备镜像；未修改数据库。' >&2; exit 1; }
done < <("${compose[@]}" config --images)
# Keep the current project, image version, HTTP port and proxy configuration.
awk -F= 'NR==FNR {if($1 ~ /^(COMPOSE_PROJECT_NAME|MCP_VERSION|MCP_IMAGE_PREFIX|MCP_HTTP_PORT|AUTH_TRUSTED_PROXY_IPS)$/) keep[$1]=$0; next} {if($1 in keep) print keep[$1]; else print}' "$deployment_dir/runtime.env" "$stage/runtime.env" > "$deployment_dir/runtime.env.restoring"
cp "$stage/config.json" "$deployment_dir/config.json.restoring"
chmod 600 "$deployment_dir/runtime.env.restoring"
chmod 644 "$deployment_dir/config.json.restoring"
project_name=${COMPOSE_PROJECT_NAME:-$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$deployment_dir/runtime.env")}
[[ "$project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo '部署项目名称无效' >&2; exit 1; }
source "$project_dir/scripts/deployment-containers.sh"
remove_legacy_apps "$project_name"
"${compose[@]}" stop app
if ! "${compose[@]}" exec -T postgres sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-acl --single-transaction --exit-on-error' < "$stage/database.dump"; then
  echo '恢复失败，数据库事务已回滚；应用保持停止，请检查日志后重新启动。' >&2
  exit 1
fi
mv "$deployment_dir/runtime.env.restoring" "$deployment_dir/runtime.env"
mv "$deployment_dir/config.json.restoring" "$deployment_dir/config.json"
"${compose[@]}" up -d --no-build --pull never --wait
echo '恢复完成：数据库和凭据加密密钥已一起恢复，当前镜像版本保持不变。'
