# SoftCove 软湾 — 独立开发者软件交易平台

**状态：可本地运行、可测试的 MVP；尚未实际部署、未进行真实资金支付验收或公共商业上线。** 项目采用中文优先的响应式界面，允许独立开发者上架软件、管理员人工审核、买家购买和安全下载。首页 8 款演示商品均为虚构设计样品，明确标记且不可购买。

## 已实现功能

- **买家端**：发现与搜索软件、按类别/系统/价格筛选、商品详情、开发者主页、注册登录、软件库、历史订单、安全下载。
- **卖家端**：注册后先填写开发者简介与官网，等待平台人工审核；通过后可提交软件上架。提供工作台、商品定价/草稿/安装包上传、审核意见、订单与应得金额、线下结算凭证账本。
- **运营后台**：只允许通过 CLI 创建管理员；支持开发者资料审批/驳回/暂停，软件上架人工核验与紧急下架，订单与佣金查看，以及管理员确认外部已付款后登记线下转账流水（不实际转账）。
- **订单与交付**：免费商品自动授权；付费商品通过 Stripe Checkout 发起付款，仅在签名验真的 Stripe Webhook 确认付款且核对金额、币种、订单绑定后自动授权。重复事件幂等处理。部分退款调整账面金额，全额退款撤销相应授权；支持退款先于付款完成事件到达的情况。
- **安全边界**：scrypt 加盐密码哈希、HttpOnly Session、CSRF 令牌、角色访问控制、限速、容量限制、隔离私有文件、待审开发者不得上架、暂停开发者后停止新购买和既有下载。支持可选的 ClamAV 命令行扫描，但默认不安装/启用，且扫描成功仍需人工审核。

**未实现**：开发者自动提现/Stripe Connect、正式启用并维护恶意软件扫描基础设施、邮件激活及找回密码、订阅计费、许可证密钥发货、真实银行退款按钮、企业级风控、司法合规认证、正式生产监控。

技术：Node.js 原生 HTTP、SQLite、原生 JavaScript/CSS；无运行时 npm 依赖。建议 Node.js 24，最低 22.13（Node.js 22 可能提示 SQLite 为实验功能）。

## 一、Windows 本地运行

安装 Node.js 22.13 或更新版本，在 PowerShell 进入项目目录：

    cd softcove
    Copy-Item config.example .env
    npm run check
    npm test
    npm start

浏览器打开 http://localhost:3100 。

macOS/Linux 用 cp config.example .env 代替 Copy-Item 命令。

项目启动时自动生成 SQLite 数据库、添加 8 款虚构演示商品。真实商品流程：

    开发者注册 → 补全资料 → 管理员审核卖家（approved）
    → 新建草稿 → 上传软件包（默认隔离）→ 可选 ClamAV 扫描
    → 提交 pending → 管理员隔离环境扫描/人工核验
    → 审核通过 published → 买家领取或 Checkout 付款
    → 付费订单收到 Stripe 签名确认 → 自动授权 → 私有下载

未设置 Stripe 凭证时，付费购买请求会明确报错并禁用购买按钮；**不会假装完成支付**。免费软件仍可按真实授权流程领取。模拟展示商品不允许购买或下载。

## 二、初始化管理员

不能从网页直接注册管理员。仅在本地终端或安全管理环境暂时填写 .env：

    ADMIN_EMAIL=admin@example.com
    ADMIN_PASSWORD=至少14位的高强度独立密码
    ADMIN_NAME=平台管理员

在项目目录执行：

    npm run admin:create

然后从 .env 中移除管理员初始密码（建议同时删除初始邮箱变量）；不要将包含密码的 .env 提交到 Git。生产环境宜通过密钥管理器注入管理员初始凭据。再次运行脚本可安全重置同一管理员密码并注销旧会话。管理员从网站“登录”入口进入后台。

## 三、Stripe 测试与真实付款

在 .env 配置：

    PORT=3100
    PUBLIC_BASE_URL=https://your-domain.example
    DATA_DIR=./data
    APP_CURRENCY=CNY
    PLATFORM_FEE_BPS=1500
    STRIPE_SECRET_KEY=sk_test_...
    STRIPE_WEBHOOK_SECRET=whsec_...

佣金 1500 个基点 = 15%。货币现只支持一个店铺级别的 CNY 或 USD，不支持按商品多币种定价。Stripe 能否收取 CNY 以及最低收款金额要依据平台账户所在地、商户准入和结算币种确认。调试时先使用测试模式的 Stripe API 密钥，不要使用真实资金。

在 Stripe Dashboard 添加 Webhook 地址：https://your-domain.example/api/webhooks/stripe ，订阅：

- checkout.session.completed
- checkout.session.async_payment_succeeded
- checkout.session.async_payment_failed
- checkout.session.expired
- charge.refunded

本地可用 Stripe CLI 转发测试 Webhook：

    stripe listen --forward-to localhost:3100/api/webhooks/stripe

把 Stripe CLI 给出的 whsec_... 写入本地 .env；线上 Dashboard Webhook Secret 和本地 CLI Secret 不是同一个。正式上线前，需以真实 Stripe 测试环境走通付款、退款和回调；本项目自动测试模拟签名事件，不等于已经接入第三方网络验证。

**注意：** 浏览器支付成功回跳本身不意味着已经付款，本站必须收到服务端签名确认才会交付。Stripe 上的退款需要运营人员在 Stripe 后台发起，本站只通过签名 refund event 更新记录。支付失败、已过期、全额退款均不会产生有效新下载授权。

**商家资金：** 当前所有款项先由平台 Stripe 账户收取，仅记录每笔平台佣金和卖家应得余额；管理员可在真正通过外部渠道转账成功后，录入金额与唯一外部流水凭证，系统会防止重复登记及超额登记，退款导致结算超额时显示人工对账差额。未接 Stripe Connect/KYC，也**不会自动给开发者提现**。所谓“待人工结算”不是已打款，任何手工凭证不代表平台实际转账。交易手续费、拒付、争议、税务和法定留存均需在商用前另行完善。

## 四、Windows / NAS Docker 部署

包括 Dockerfile 和 compose.yaml。容器运行 Node.js 24，采用持久 Volume 保存数据库和安装包；默认端口仅绑定宿主机本地 127.0.0.1:3100，避免直接暴露未加密服务。

    cd softcove
    cp config.example .env
    # 修改 .env 中 PUBLIC_BASE_URL 为实际 HTTPS 域名
    docker compose up -d --build
    docker compose logs --tail=60 softcove

Windows PowerShell 创建 .env 改用 Copy-Item。配置 Nginx、Caddy 或 Traefik 反向代理至 127.0.0.1:3100，并启用 HTTPS、WAF/流量限制及 Webhook 转发。Docker 端口仅回环地址；远程反代部署请根据网络拓扑修改，并设置防火墙。生产域名必须和 PUBLIC_BASE_URL 一致，否则 CSRF/安全 Cookie 机制可能导致无法登录或操作。

Docker 初始化管理员：临时向 .env 添加上述 ADMIN_* 变量并重新创建容器，再执行：

    docker compose up -d
    docker compose exec softcove node scripts/create-admin.mjs

删除初始密码变量后需要重建容器，避免运行环境长期保留明文管理员密码。Linux Volume 文件权限默认按非 root 用户运行；如采用宿主机路径挂载，请确保 UID 1000 拥有读写权限。

定期备份持久卷 softcove_storage 中的 SQLite 数据库和 uploads/ 软件文件。SQLite WAL 模式可能使用 -wal/-shm 文件；应使用 SQLite 一致性备份或维护时暂停写入进行完整备份，不能只在写入期间复制单个 .db 文件。

## 五、用户、软件包与安全限制

买家、卖家、管理员是区分的角色。真实商品的草稿和驳回状态允许编辑和重新上传；待审核/已上架软件不可偷偷修改二进制。新版本应另行创建商品，后续可以加入版本演进和老买家升级资格。

每个包不超过 50 MiB，每个卖家账户文件总量不超过 500 MiB、商品数量上限为 100。文件保存于非公开的 DATA_DIR/uploads/，由服务端生成随机文件名。允许的扩展名：ZIP、7z、tar、gz、exe、msi、dmg、pkg、AppImage、deb、rpm、apk、msix。服务器不运行、不解压未知安装包；**没有自动杀毒**。后台的“人工核验确认”必须由管理员在安全隔离环境完成真实恶意软件扫描、签名和版权检查后操作。紧急下架将停止后续交易和所有下载；对于已付款用户必须另行沟通与办理退款。

本平台不提供任意 iOS IPA 应用的站外侧载能力。iOS 发行必须按照 Apple App Store 或适用地区的正规替代分发制度执行。

### 可选 ClamAV 软件包扫描

在宿主机或运行 Node 的**同一容器内**安装 ClamAV 的 `clamscan`，使用 `freshclam` 定期更新检测签名库；然后设置 `CLAMAV_ENABLED=1`，必要时通过 `CLAMAV_COMMAND` 指向可信的 `clamscan` 可执行文件。**默认 Dockerfile 不包含 ClamAV 二进制或病毒库**，直接把开关改成 1 会使上传进入 `scan_error`，并拒绝提交审核，属于安全的失败关闭行为。

扫描仅针对服务端生成的随机隔离文件路径执行，使用子进程无 Shell 调用并设置超时，结果包括 `quarantined`（未启用）、`scan_passed`、`scan_failed`（报毒）、`scan_error`（未安装、超时或异常）。被报毒/异常的文件不得提交审核；自动扫描通过后仍要在隔离环境人工审查数字签名、版权、行为和版本。ClamAV 无法保证发现所有新型恶意软件，不应该把“通过扫描”展示成平台安全认证。

## 六、生产正式上线前的阻断项

1. 集成恶意软件检测、隔离沙盒、代码签名验证、侵权申诉、恶意商家封禁及文件审核记录。
2. 完成邮箱验证、密码找回、管理后台 MFA、开发者实名/KYC 和防欺诈风控。
3. 完成 Stripe Connect 或合规本地分账系统、提现记录、对账、争议/拒付、税费、退款与平台服务费结算。
4. 完成真实 Stripe TEST 模式与生产 Webhook 联调，并增加宕机后主动对账、补单、Webhook 告警及审计。
5. 实施HTTPS、生产数据库与对象存储、备份演练、日志/指标、压力和渗透测试、CDN、SEO。
6. 由经营主体审核用户协议、开发者分发协议、隐私政策、侵权通知、售后退款政策、发票与适用地区法律资质。
7. 根据 iOS、Android、Windows/macOS 不同平台的政策和发行规则适配安装、签名与更新渠道。

这是一套供开发和试运营验证的 MVP，不得未经上线准备直接公开处理大量真实金钱和第三方二进制软件。

## 七、测试及技术目录

    npm run check
    npm test

测试覆盖：账户权限、越权/CSRF、安装包隔离和审核、免费授权及私有下载、管理员紧急下架、Stripe 回调签名/金额/Session/重放验证、佣金计算、部分与全额退款、乱序退款、未配置支付时拦截付费订单。

    softcove/
      server.mjs
      src/db.mjs
      src/security.mjs
      public/index.html
      public/app.js
      public/styles.css
      public/favicon.svg
      scripts/create-admin.mjs
      tests/marketplace.test.mjs
      Dockerfile
      compose.yaml
      config.example
      package.json

主要 API：

    GET  /api/health
    GET  /api/me
    POST /api/auth/register
    POST /api/auth/login
    POST /api/auth/logout
    GET  /api/products
    GET  /api/products/:id
    GET  /api/sellers/:id
    GET  /api/seller/overview
    PUT  /api/seller/profile
    POST /api/seller/products
    PATCH /api/seller/products/:id
    PUT  /api/seller/products/:id/file?filename=...
    POST /api/seller/products/:id/submit
    GET  /api/admin/overview
    POST /api/admin/sellers/:id/review
    POST /api/admin/settlements
    GET  /api/admin/products/:id/file
    POST /api/admin/products/:id/review
    POST /api/admin/products/:id/takedown
    POST /api/orders
    GET  /api/my/library
    GET  /api/my/library/:id/download
    POST /api/webhooks/stripe

常规敏感写入 API 需要有效的 Session、角色校验和 X-CSRF-Token（通过 /api/me 获得）。Stripe webhook 独立验证签名，不能用浏览器回调直接标记支付完成。

### GitHub 代码发布说明

本仓库发布的是**开发版源代码**，并非面向真实用户开放的商业 SaaS 生产站。不要将 `.env`、上传安装包、用户数据库、私人业务数据或任意支付私钥上传到 GitHub。提交和 CI 都不会读取真实密钥。

本项目未附带开源授权许可证；**代码可见不等于允许未经许可复制或商业使用**。如以后决定正式开源，可由版权持有人单独添加合适许可证。

---

品牌暂用「SoftCove 软湾」。正式商用前应独立核验商标、域名、支付及分发准入。
