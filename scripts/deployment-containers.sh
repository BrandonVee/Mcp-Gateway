#!/usr/bin/env bash
# Shared by upgrade and restore. Data services and volumes remain in place.
remove_legacy_apps() {
  local project=$1 service id
  local ids=()
  for service in auth gateway admin-web; do
    while IFS= read -r id; do
      [[ -z "$id" ]] || ids+=("$id")
    done < <(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")
  done
  if (( ${#ids[@]} )); then
    docker stop --time 15 "${ids[@]}" >/dev/null
    docker rm "${ids[@]}" >/dev/null
  fi
}
