#!/usr/bin/env bash
set -euo pipefail

# Shared across Compose projects and retained when an individual stack is removed.
if ! docker network inspect mcp-gateway >/dev/null 2>&1; then
  docker network create --driver bridge mcp-gateway >/dev/null
fi
