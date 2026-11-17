#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/compose-lib.sh"
umask 077
command_name="${1:-help}"
if [[ "$command_name" == help || "$command_name" == --help ]]; then
  printf '%s\n' '用法：bash scripts/ops.sh status|logs|backup [备份根目录]|restore <备份目录>|admin' \
    'backup 短暂停止应用以同时快照数据库和安装包，完成或失败后恢复服务。' \
    'restore 只恢复到空数据卷，已有数据绝不覆盖。用新 COMPOSE_PROJECT_NAME 进行恢复演练。' \
    'admin 隐藏输入密码，可创建管理员或重置同邮箱管理员密码。'
  exit 0
fi
require_docker
select_compose
case "$command_name" in
  status) "${COMPOSE[@]}" ps ;;
  logs) "${COMPOSE[@]}" logs --tail=100 ;;
  admin)
    read -r -p '管理员邮箱：' admin_email </dev/tty
    read -r -s -p '管理员密码（14–128 位）：' admin_password </dev/tty
    printf '\n'
    read -r -s -p '再次输入密码：' admin_repeat </dev/tty
    printf '\n'
    [[ "$admin_password" == "$admin_repeat" ]] || die '两次密码不一致。'
    printf '%s\n%s\n%s\n' "$admin_email" "$admin_password" '平台管理员' |
      "${COMPOSE[@]}" run --rm --no-deps -T softcove node scripts/create-admin.mjs --stdin
    unset admin_password admin_repeat ;;
  backup)
    backup_root="${2:-$SOFTCOVE_ROOT/backups}"
    mkdir -p -- "$backup_root"
    backup_root=$(cd -- "$backup_root" && pwd)
    [[ "$backup_root" != *:* ]] || die '备份路径不能包含冒号。'
    snapshot="softcove-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
    running=$("${COMPOSE[@]}" ps --status running -q softcove)
    resume_app() { if [[ -n "$running" ]]; then "${COMPOSE[@]}" start softcove; fi; }
    trap resume_app EXIT
    "${COMPOSE[@]}" stop softcove
    "${COMPOSE[@]}" run --rm --no-deps -T --user 0:0 --cap-add DAC_OVERRIDE --cap-add FOWNER -v "$backup_root:/backups" softcove \
      node scripts/backup.mjs create "/backups/$snapshot"
    printf '备份完成：%s/%s\n请复制到另一台设备妥善保存。\n' "$backup_root" "$snapshot" ;;
  restore)
    [[ -n "${2:-}" && -d "$2" ]] || die '请指定现有备份目录。'
    backup_source=$(cd -- "$2" && pwd)
    [[ "$backup_source" != *:* ]] || die '备份路径不能包含冒号。'
    [[ -z "$("${COMPOSE[@]}" ps --status running -q softcove)" ]] || die '请先停止恢复目标的应用，建议使用一个全新项目名。'
    "${COMPOSE[@]}" run --rm --no-deps -T --user 0:0 --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER -v "$backup_source:/backup:ro" softcove \
      sh -c 'node scripts/backup.mjs restore /backup && chown -R node:node /app/data'
    printf '%s\n' '恢复完成；请验证数据后启动应用。' ;;
  *) die "未知命令：$command_name" ;;
esac
