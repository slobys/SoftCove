export function deploymentReadiness(db, config) {
  const count = sql => Number(db.prepare(sql).get().n);
  const paymentMode = config.demoCheckout ? 'demo' : !config.stripeKey ? 'disabled' : config.stripeKey.startsWith('sk_live_') ? 'live' : 'test';
  const checks = [
    { id: 'https', title: '站点与安全登录', status: config.secureCookie ? 'configured' : 'pending',
      detail: config.secureCookie ? '已配置 HTTPS 地址；证书和外网访问需在部署后验证。' : '当前为本地 HTTP 测试。公开访问前请配置 HTTPS 域名。' },
    { id: 'payment', title: '付费收款', status: paymentMode === 'live' ? 'configured' : 'pending',
      detail: paymentMode === 'demo' ? '当前为演示交易：只模拟确认，不收款，模拟订单不计入收入或结算。正式收款须使用新数据卷。' : paymentMode === 'disabled' ? '尚未配置 Stripe，付费购买关闭；可先验证免费交付。' : paymentMode === 'test' ? '已配置 Stripe 测试密钥；尚不能收取真实款项。' : '已配置 Stripe 正式密钥；仍须验证付款、签名回调、退款与对账。' },
    { id: 'seller', title: '开发者入驻', status: count("SELECT COUNT(*) AS n FROM users WHERE role='seller' AND seller_status='approved' AND id!='softcove-demo-studio'") ? 'complete' : 'pending',
      detail: '使用独立开发者账号填写资料，再由管理员审核；管理员和卖家使用不同账号。' },
    { id: 'products', title: '真实软件上架', status: count("SELECT COUNT(*) AS n FROM products p JOIN users u ON u.id=p.seller_id WHERE p.is_demo=0 AND p.status='published' AND u.seller_status='approved'") ? 'complete' : 'pending',
      detail: '上传安装包、提交审核，并在隔离环境完成人工核验后上架。' },
    { id: 'demo', title: '演示商品', status: config.demoCatalog ? 'pending' : 'complete',
      detail: config.demoCatalog ? '首页仍显示虚构样品。正式运营请设置 ENABLE_DEMO_CATALOG=0。' : '虚构演示商品已隐藏，历史数据保留。' },
    { id: 'scanner', title: '软件包检查', status: 'manual',
      detail: config.clamavEnabled ? '已开启自动扫描开关；病毒库、扫描可用性和人工审核仍需维护。' : '未开启自动扫描。每次上架前需自行完成隔离扫描、签名和版权核验。' }
  ];
  return { version: '0.3.0-beta.1', baseUrl: config.baseUrl, paymentMode, checks,
    notice: '这是配置与上架进度检查，不是商业上线认证。仍需完成支付联调、备份恢复演练和经营协议。' };
}
