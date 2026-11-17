#!/usr/bin/env bash
# Real deployment wrapper acceptance on Linux, without a public domain/payment.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
test_dir=$(mktemp -d)
export COMPOSE_PROJECT_NAME="softcove-deploy-test-$RANDOM"
recovery_project="$COMPOSE_PROJECT_NAME-recovery"
export SOFTCOVE_ENV_FILE="$test_dir/.env"
export SOFTCOVE_HTTP_PORT="$((39000 + RANDOM % 1000))"
cleanup() {
  docker compose --env-file "$SOFTCOVE_ENV_FILE" down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
  COMPOSE_PROJECT_NAME="$recovery_project" docker compose --env-file "$SOFTCOVE_ENV_FILE" down -v --remove-orphans --rmi local >/dev/null 2>&1 || true
  if [[ -d "$test_dir/backups" ]]; then
    docker run --rm -v "$test_dir/backups:/backups" node:24-bookworm-slim node -e \
      'for (const name of require("fs").readdirSync("/backups")) require("fs").rmSync("/backups/"+name,{recursive:true,force:true})' >/dev/null
  fi
  rm -rf -- "$test_dir"
}
trap cleanup EXIT
bash deploy.sh --local --skip-admin
bash deploy.sh --local --check
docker compose --env-file "$SOFTCOVE_ENV_FILE" exec -T softcove node scripts/create-admin.mjs --stdin --if-missing <<'ADMIN'
ci-admin@test.example
OnlyForDisposableCiTests123!
CI 管理员
ADMIN
before=$(sha256sum "$SOFTCOVE_ENV_FILE")
bash deploy.sh --local
[[ "$(sha256sum "$SOFTCOVE_ENV_FILE")" == "$before" ]]
bash scripts/ops.sh backup "$test_dir/backups"
snapshot=$(find "$test_dir/backups" -mindepth 1 -maxdepth 1 -type d -name 'softcove-*')
COMPOSE_PROJECT_NAME="$recovery_project" docker compose --env-file "$SOFTCOVE_ENV_FILE" build softcove
COMPOSE_PROJECT_NAME="$recovery_project" bash scripts/ops.sh restore "$snapshot"
COMPOSE_PROJECT_NAME="$recovery_project" docker compose --env-file "$SOFTCOVE_ENV_FILE" run --rm --no-deps -T softcove node scripts/create-admin.mjs --check
printf '%s\n' '部署脚本验收通过：首次生成配置、重复运行、保留管理员、停机备份和空卷恢复。'
