#!/usr/bin/env bash
set -euo pipefail
umask 077
project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
deployment_dir=${MCP_DEPLOY_DIR:-"$project_dir/deploy/single-host"}
backup_dir=${MCP_BACKUP_DIR:-"$project_dir/backups"}
keep_days=${MCP_BACKUP_KEEP_DAYS:-14}
if [[ ${1:-} == --help ]]; then
  echo '用法：scripts/backup.sh；可设置 MCP_DEPLOY_DIR、MCP_BACKUP_DIR、MCP_BACKUP_KEEP_DAYS、MCP_BACKUP_RECIPIENT（age 公钥）。'
  exit 0
fi
[[ $# == 0 ]] || { echo '未知参数' >&2; exit 1; }
[[ "$keep_days" =~ ^[0-9]{1,4}$ ]] && ((10#$keep_days >= 1 && 10#$keep_days <= 3650)) || { echo '保留天数须为 1–3650' >&2; exit 1; }
[[ -f "$deployment_dir/runtime.env" && -f "$deployment_dir/config.json" ]] || { echo '请先完成部署配置' >&2; exit 1; }
if [[ -n ${MCP_BACKUP_RECIPIENT:-} ]]; then command -v age >/dev/null || { echo '加密备份需要安装 age' >&2; exit 1; }; fi
mkdir -p "$backup_dir"
stage=$(mktemp -d "$backup_dir/.backup-stage.XXXXXX")
archive="$backup_dir/mcp-backup-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz"
partial="$archive.part"
cleanup() { rm -rf -- "$stage"; rm -f -- "$partial" "$partial.age"; }
trap cleanup EXIT
compose=(docker compose --env-file "$deployment_dir/runtime.env" -f "$project_dir/deploy/compose.single-host.yml")
"${compose[@]}" exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$stage/database.dump"
cp "$deployment_dir/runtime.env" "$stage/runtime.env"
cp "$deployment_dir/config.json" "$stage/config.json"
if command -v sha256sum >/dev/null; then checksum=(sha256sum); else checksum=(shasum -a 256); fi
(cd "$stage" && "${checksum[@]}" database.dump runtime.env config.json > sha256.txt)
tar -C "$stage" -czf "$partial" database.dump runtime.env config.json sha256.txt
if [[ -n ${MCP_BACKUP_RECIPIENT:-} ]]; then
  age -r "$MCP_BACKUP_RECIPIENT" -o "$partial.age" "$partial"
  archive="$archive.age"; mv "$partial.age" "$archive"
else
  mv "$partial" "$archive"
fi
chmod 600 "$archive"
# Only remove completed archives from this tool, after a successful new backup.
find "$backup_dir" -maxdepth 1 -type f \( -name 'mcp-backup-*.tar.gz' -o -name 'mcp-backup-*.tar.gz.age' \) -mtime +"$keep_days" -delete
printf '备份完成：%s\n' "$archive"
