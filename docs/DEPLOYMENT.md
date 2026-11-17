# SoftCove 一键部署与运维

本版本提供 Linux VPS / NAS 的 Docker Compose 部署。服务器须已安装并启动 Docker Engine 和 Compose v2，具备 Git、Bash、curl；不会自动安装系统软件。应用仍是试运营开发版，部署成功不代表真实收款或商业上线准备已完成。

## 首次部署

### 有公网域名的 Linux 服务器

先将域名 A 记录指向服务器公网 IP。若设置了 AAAA 记录，IPv6 也必须指向可访问的本机。开放 TCP 80、443，确保这些端口没有被其他网站占用；UDP 443 供可选 HTTP/3 使用。然后执行：

```bash
git clone --branch codex/marketplace-deploy https://github.com/slobys/SoftCove.git
cd SoftCove
bash deploy.sh
```

脚本会询问域名，创建权限为 600 的 `.env`，构建应用并启动 Caddy，等待应用健康检查，再以隐藏输入初始化管理员，最后通过实际站点 HTTPS 地址检查 `/api/health`。首次生成配置会启用演示交易，不接真实支付；全站提示仅使用测试账号和安装包。Caddy 自动申请和续期证书，证书存储在独立持久卷中。服务器无需另装 Node.js。

已有 `.env` 不会被覆盖，需包含以下未加引号的部署值：

```dotenv
PUBLIC_BASE_URL=https://shop.example.com
SOFTCOVE_DOMAIN=shop.example.com
ENABLE_DEMO_CATALOG=0
DEMO_CHECKOUT_ENABLED=1
```

不要把初始化管理员密码写进 `.env`。脚本若发现旧的 `ADMIN_PASSWORD` 会停止并要求先移除，避免它进入常驻容器环境。首次输入错误可直接重新运行脚本；已有管理员不会被重置。需要重置时使用下文 `ops.sh admin`。

脚本失败后保留服务和数据，修复配置后重跑。证书或外网检查失败会返回非零状态，不能当成部署成功。查看 `bash scripts/ops.sh logs`，重点检查 DNS、错误 AAAA 记录、安全组、防火墙、80/443 端口占用。

### 已有反向代理 / NAS

```bash
cp config.example .env
# 编辑 PUBLIC_BASE_URL=https://你的实际域名
# 设置 ENABLE_DEMO_CATALOG=0；已有反代时 SOFTCOVE_DOMAIN 留空
bash deploy.sh --local
```

`--local` 不启动内置 Caddy；应用只绑定宿主机 `127.0.0.1:3100`，由现有 Nginx/Caddy/Traefik 提供 HTTPS。没有域名时可先用默认 `http://localhost:3100` 验证本地流程，远程设备可用 SSH 隧道访问。不要将管理未完成的 HTTP 服务直接暴露公网。

容器中的反代无法通过自己的 `127.0.0.1` 访问宿主机：需要由你按 NAS 网络设置接入同一私有 Docker 网络，再代理 `softcove:3100`。不可同时启用已占用 80/443 的两个反代。

默认 `TRUST_PROXY=0` 会忽略访客自行传入的转发头。内置 Caddy 会覆盖 `X-Forwarded-For` 并为应用启用 `TRUST_PROXY=1`，避免所有访客共用一个登录限额。使用现有代理时，只有确认代理覆盖该头、且应用入口不允许绕过代理，才可启用；当前只支持一个受控代理跳点。CDN/多级代理需另行配置和验证。

可用 `SOFTCOVE_HTTP_PORT=3110 bash deploy.sh --local` 改宿主机端口；同时修改 `.env` 内本地测试的 `PUBLIC_BASE_URL`。容器内部端口保持 3100。

## 从部署走到第一款软件上架

1. 打开平台，登录管理员账号，管理后台查看“开店准备”。
2. 退出后，用另一个邮箱注册“开发者”，填写介绍与官网。
3. 管理员审核开发者账号；管理员和卖家保持不同账号。
4. 开发者创建商品、定价、填写版本与支持系统，上传安装包后提交审核。
5. 管理员在隔离环境完成软件安全、签名、版权核验，再在后台批准上架。
6. 买家打开测试商品，点击“演示下单 · 不扣款”，在软件库核对商品与金额，再点击“确认模拟付款 · 不扣款”，验证授权和下载。

生产 Compose 强制隐藏首页虚构展示样品；不会删除旧数据库里的样品或真实用户数据。演示交易面向你自行上传并审核的测试商品，首页虚构样品仍不可交易。免费软件可直接验证授权。模拟订单单独标记，收入、佣金和可结算金额均不包括模拟金额。

`DEMO_CHECKOUT_ENABLED` 默认在本地模板关闭，在一键部署首次生成的配置中开启，已有配置保持原样。演示模式不调用任何支付网络，也不能接受 Stripe 密钥。含演示订单的数据卷必须继续使用演示模式；应用会拒绝把它当成真实收款数据库启动。正式运营请创建新项目/数据卷，重新配置经营信息和真实商品，保留演示环境供测试。

## 配置收款

当前只实现 Stripe Checkout。支付宝、微信原生商户接口与自动分账尚未实现，不能通过填写本地支付密钥启用。收款渠道选择确定后再接相应官方接口。

先在独立的新数据卷环境里关闭演示模式，并在 `.env` 同时设置 Stripe TEST 密钥和 Webhook 密钥，单独设置一个会使应用拒绝启动。按 [README](../README.md#三stripe-测试与真实付款) 配置 Webhook 并在真实第三方测试环境验证付款、延迟回调、退款及对账。再次执行 `bash deploy.sh`（现有反代用 `--local`）加载变更。只有签名确认才会交付，浏览器成功回跳不会授权。

后台“已配置”只表示检测到对应配置，不代表第三方账户已获准收款、回调已经连通或付款验收完成。开放真实收款前还要完成适用的用户协议、售后规则与经营审核，参见 README 的上线准备列表。

## 常用命令

```bash
bash deploy.sh --check                 # 只验证已有 Compose 配置，不修改服务
bash scripts/ops.sh status
bash scripts/ops.sh logs
bash scripts/ops.sh admin              # 隐藏输入创建 / 重置管理员，旧会话失效
bash scripts/ops.sh backup             # 默认保存到项目 backups/，短暂停止应用
bash scripts/ops.sh backup /srv/softcove-backups
```

`--check` 只校验 Compose，不替代应用配置、数据库、支付与网络检查。`--skip-admin` 仅供已有自动化环境使用；跳过后仍须用 `ops.sh admin` 初始化管理员。

所有脚本默认项目名为 `softcove`。如果以前用其他 Compose 项目名部署，必须先通过 `docker compose ls` 确认原项目，并在所有部署/运维命令前设置同一个 `COMPOSE_PROJECT_NAME=原项目名`，否则会新建一个空数据卷。不要直接修改已有卷名称或运行 `down -v`。

## 备份与恢复演练

备份工具会生成包含 SQLite 一致性快照、被商品引用的软件包和 SHA-256 清单的独立目录。`ops.sh backup` 停止应用以保证软件包与数据库对应，成功或失败均尝试恢复此前正在运行的应用；备份期间站点短暂不可用。备份缺失文件、校验失败或目标已存在时会报错。

备份目录不包含 `.env` 或 Caddy 证书。另行安全保存站点配置和必要的支付凭证；恢复时币种等配置必须与原站保持一致。备份包含账户、订单和安装包等私有资料，默认限制访问权限；root 工具容器创建的文件在 Linux 上通常归 root 所有，查看或搬运可能需要 sudo。不要上传到公开仓库，至少复制一份到另一台设备并保护访问权限。

恢复只接受空数据卷，拒绝覆盖现有站点。以下用新项目名创建恢复演练卷，绝不会覆盖原项目：

```bash
# 必须在已有镜像可用的同一源码版本下进行；新项目先构建镜像
COMPOSE_PROJECT_NAME=softcove-recovery docker compose build softcove
COMPOSE_PROJECT_NAME=softcove-recovery bash scripts/ops.sh restore /srv/softcove-backups/softcove-时间标识

# 仅启动恢复应用，使用其他本地端口，避免占用现有站点/Caddy端口
COMPOSE_PROJECT_NAME=softcove-recovery SOFTCOVE_HTTP_PORT=3110 \
  docker compose up -d --wait softcove
```

通过本地反代或 SSH 隧道，在同一原站域名下检查恢复站的账户、商品、订单、授权和实际下载内容。旧登录会话在恢复时清空，需重新登录。恢复到演练环境时不要接收真实支付回调，也不要开启新的真实交易。准备正式切换前，停止写入、再次备份并完成一致性核验。

## 更新版本

```bash
bash scripts/ops.sh backup
git pull --ff-only
bash deploy.sh                         # 已有反代时加 --local
```

数据库和安装包保存在持久卷，重建应用不会删除它们。备份和源码版本应配套保留；本版本不提供自动跨版本数据库降级。升级失败优先修复应用配置，恢复时使用原版本与新的数据卷。

## 开发验收

```bash
npm run check
npm test
npm run test:docker
```

Docker 验收创建隔离项目和临时数据，验证上架、演示下单、模拟付款授权、下载、重建保留数据、备份和新卷恢复；完成后只清理自己的项目和数据卷。它不连接真实 Stripe，也不申请公网证书。CI 另行验证 Bash、Caddy 和部署脚本；真实域名签证与支付联调仍需部署环境验收。

部署设计参考：[Docker Compose 生产部署](https://docs.docker.com/compose/how-tos/production/)、[Caddy 反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。
