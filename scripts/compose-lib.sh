#!/usr/bin/env bash
# Shared by deployment and maintenance. Never source .env as shell code.
set -euo pipefail
SOFTCOVE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$SOFTCOVE_ROOT"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-softcove}"
export SOFTCOVE_ENV_FILE="${SOFTCOVE_ENV_FILE:-$SOFTCOVE_ROOT/.env}"

die() { printf '错误：%s\n' "$*" >&2; exit 1; }
config_value() {
  # Only simple, unquoted deployment values are read here; secrets are never read.
  sed -n "s/^${1}=//p" "$SOFTCOVE_ENV_FILE" | tail -n 1 | tr -d '\r'
}
require_docker() {
  command -v docker >/dev/null || die '请先安装并启动 Docker Engine 和 Compose v2。'
  docker compose version >/dev/null || die '需要 Docker Compose v2。'
  docker info >/dev/null 2>&1 || die 'Docker 未运行或当前用户没有访问权限。'
}
select_compose() {
  local mode="${1:-}"
  [[ -f "$SOFTCOVE_ENV_FILE" ]] || die '尚无 .env，请先运行 bash deploy.sh。'
  COMPOSE=(docker compose --env-file "$SOFTCOVE_ENV_FILE" -f "$SOFTCOVE_ROOT/compose.yaml")
  if [[ "$mode" != local ]] && [[ -n "$(config_value SOFTCOVE_DOMAIN)" ]]; then
    COMPOSE+=(-f "$SOFTCOVE_ROOT/compose.production.yaml")
  fi
}
