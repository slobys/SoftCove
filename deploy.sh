#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/scripts/compose-lib.sh"
umask 077
mode=production
skip_admin=0
check_only=0
for arg in "$@"; do
  case "$arg" in
    --local) mode=local ;;
    --skip-admin) skip_admin=1 ;;
    --check) check_only=1 ;;
    --help|-h)
      printf '%s\n' '用法：bash deploy.sh [--local] [--skip-admin] [--check]' \
        '默认引导域名部署并启用 Caddy HTTPS；--local 仅绑定 127.0.0.1。' \
        '--check 只验证已有 Compose 配置；--skip-admin 跳过管理员初始化。'
      exit 0 ;;
    *) die "未知参数：$arg" ;;
  esac
done
require_docker
command -v curl >/dev/null || die '需要 curl 来验证部署结果。'

if [[ "$check_only" == 1 ]]; then
  select_compose "$mode"
  "${COMPOSE[@]}" config --quiet
  printf '%s\n' 'Compose 配置通过；未构建、启动或修改服务。'
  exit 0
fi

if [[ ! -f "$SOFTCOVE_ENV_FILE" ]]; then
  domain=''
  if [[ "$mode" == production ]]; then
    [[ -r /dev/tty ]] || die '首次部署需交互式终端输入域名，或预先创建 .env。'
    read -r -p '平台域名（例如 shop.example.com，DNS 需已指向本机）：' domain </dev/tty
    [[ "$domain" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]] || die '请输入纯域名，不含 https://、端口或路径。'
  fi
  # Create atomically without overwriting existing configuration.
  config_tmp=$(mktemp "${SOFTCOVE_ENV_FILE}.XXXXXX")
  sed '/^PUBLIC_BASE_URL=/d; /^ENABLE_DEMO_CATALOG=/d; /^SOFTCOVE_DOMAIN=/d; /^DEMO_CHECKOUT_ENABLED=/d' config.example > "$config_tmp"
  printf '\nDEMO_CHECKOUT_ENABLED=1\n' >> "$config_tmp"
  if [[ "$mode" == production ]]; then
    printf '\nPUBLIC_BASE_URL=https://%s\nSOFTCOVE_DOMAIN=%s\nENABLE_DEMO_CATALOG=0\n' "$domain" "$domain" >> "$config_tmp"
  else
    printf '\nPUBLIC_BASE_URL=http://localhost:%s\nENABLE_DEMO_CATALOG=0\n' "${SOFTCOVE_HTTP_PORT:-3100}" >> "$config_tmp"
  fi
  mv -- "$config_tmp" "$SOFTCOVE_ENV_FILE"
  printf '%s\n' '已创建私有 .env：演示交易已启用，不会收取真实款项。'
fi

base_url=$(config_value PUBLIC_BASE_URL)
if [[ "$mode" == production ]]; then
  domain=$(config_value SOFTCOVE_DOMAIN)
  [[ "$domain" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]] || die '请在 .env 设置 SOFTCOVE_DOMAIN=你的域名；已有反向代理请用 --local。'
  [[ "$base_url" == "https://$domain" ]] || die 'PUBLIC_BASE_URL 必须等于 https://SOFTCOVE_DOMAIN。'
else
  [[ "$base_url" =~ ^https?://[a-zA-Z0-9.:-]+$ ]] || die '请检查 .env 中未加引号的 PUBLIC_BASE_URL。'
fi
if [[ -n "$(config_value ADMIN_PASSWORD)" ]]; then
  die '请先从 .env 移除 ADMIN_PASSWORD；新部署通过隐藏输入初始化管理员。'
fi
select_compose "$mode"
"${COMPOSE[@]}" config --quiet
printf '%s\n' '正在构建并启动；现有数据卷会保留。'
"${COMPOSE[@]}" build softcove
# Validate configuration before replacing a running application.
"${COMPOSE[@]}" run --rm --no-deps -T softcove node --input-type=module -e \
  'import {loadConfig} from "./src/config.mjs"; loadConfig(); console.log("应用配置通过");'
"${COMPOSE[@]}" up -d --wait --wait-timeout 120

if [[ "$skip_admin" == 0 ]]; then
  if "${COMPOSE[@]}" exec -T softcove node scripts/create-admin.mjs --check; then
    printf '%s\n' '管理员已存在，保留原有账户和密码。'
  else
    [[ -r /dev/tty ]] || die '尚无管理员。请在交互终端重跑，或使用 --skip-admin 后单独初始化。'
    read -r -p '管理员邮箱：' admin_email </dev/tty
    read -r -s -p '管理员密码（14–128 位，不回显）：' admin_password </dev/tty
    printf '\n'
    read -r -s -p '再次输入密码：' admin_repeat </dev/tty
    printf '\n'
    [[ "$admin_password" == "$admin_repeat" ]] || die '两次密码不一致；服务保留，可重跑初始化。'
    printf '%s\n%s\n%s\n' "$admin_email" "$admin_password" '平台管理员' |
      "${COMPOSE[@]}" exec -T softcove node scripts/create-admin.mjs --stdin --if-missing
    unset admin_password admin_repeat
  fi
fi

if curl --fail --silent --show-error --retry 8 --retry-delay 3 --retry-all-errors \
  --connect-timeout 5 --max-time 10 "$base_url/api/health" >/dev/null; then
  printf '\n部署与访问检查通过：%s\n管理员登录：%s/#/auth\n' "$base_url" "$base_url"
  printf '%s\n' '请进入管理后台查看“开店准备”，再使用独立卖家账号上架软件。'
else
  die '应用已启动，但站点访问/证书检查未通过。请检查 DNS、80/443 端口和 Caddy 日志；修复后重跑。'
fi
