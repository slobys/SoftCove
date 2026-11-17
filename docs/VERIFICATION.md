# v0.3.0-beta.1 验收记录

日期：2026-11-17。验收对象为 `codex/marketplace-deploy` 的本轮源码。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `npm run check` | 通过 | 服务、前端、脚本和测试 JavaScript 语法 |
| `npm test` | 14 / 14 通过 | 原有 8 组交易 / 权限测试，新增 5 组部署 / 备份 / 管理员测试和 1 组模拟结账测试 |
| `npm run test:docker` | 通过 | 真实 Node.js 24 Linux 容器：开发者注册审核、软件上传上架、演示下单、模拟付款授权、私有下载、容器重建保留数据、备份、新卷恢复及重新登录下载 |
| `tests/deploy-script-smoke.sh` | 通过 | 首次创建配置、应用配置验证、健康等待、站点访问、重复运行保留管理员和配置、ops.sh 停机备份和空卷恢复 |
| 生产 Compose 配置 | 通过 | 合并 base / production，验证域名与服务配置 |
| Caddy 配置 | 通过 | 官方 `caddy:2-alpine` 的配置校验，未申请公网证书 |
| 浏览器后台 | 通过 | 实际登录管理员，查看“开店准备”；桌面与 390px 窄屏，未发现新增面板横向溢出 |
| `git diff --check` | 通过 | 无补丁空白错误 |

本机 Node.js 为 22.21.0，Docker 测试使用 Node.js 24。部署脚本在 Windows Git Bash 调用真实 Linux Docker 容器验收；本地测试适配层只转换 Windows 宿主机文件路径，未替换 Docker 或应用逻辑。CI 已配置 Ubuntu 上运行相同脚本，实际远端 CI 结果需以对应提交的 Actions 记录为准。

备份容器继承应用的 `cap_drop: ALL`，需临时增加访问文件与更改归属所需的能力。此权限仅用于 `ops.sh` 的维护容器，不会加入常驻应用。测试曾发现并修复此处导致的 Linux SQLite 只读错误。

恢复测试确认软件包内容和下载授权保留，旧会话失效；篡改备份或恢复到非空目录会失败。部署测试使用临时账户和虚构安装包，无真实用户数据或资金交易。

尚未验收：用户服务器的 DNS / 公网 HTTPS 签证、NAS 特定反代拓扑、真实 Stripe TEST 网络回调和付款退款、正式收款资质、支付宝 / 微信原生支付、生产杀毒服务。不能据以上测试宣称平台已完成商业上线。

另已在浏览器验证演示商品下单、确认模拟付款和下载授权，订单明确显示“模拟完成 · 未收款”。模拟订单不计入收入、佣金或结算；含演示订单的数据库禁止直接切换为真实收款。`npm test` 同时覆盖金额篡改、越权、CSRF、重复确认、卖家暂停与模式隔离。

界面截图为本地测试数据：[模拟交易](screenshots/demo-checkout.jpg)、[桌面](screenshots/admin-desktop.jpg)、[窄屏](screenshots/admin-mobile.jpg)。
