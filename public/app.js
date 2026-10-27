const $ = selector => document.querySelector(selector);
const app = $('#app');
const state = {
  me: null, csrf: null, config: { paymentConfigured: false, currency: 'CNY', feeBps: 1500 },
  categories: [], platforms: [],
  catalog: [], catalogCount: 0,
  search: '', category: '', platform: '', price: 'all', sort: 'new',
  authMode: 'login', registerRole: 'buyer',
  sellerData: null, adminData: null, libraryData: null
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function asText(value) { return esc(value); }
function money(minor, currency = state.config.currency) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format((Number(minor) || 0) / 100);
}
function fmtDate(input) { if (!input) return '—'; return new Date(input).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }); }
function roleName(role) { return ({ buyer: '用户', seller: '开发者', admin: '管理员' })[role] || ''; }
function title(text, sub = '') {
  return '<section class="page-head"><div class="container"><div class="breadcrumb"><a href="#/">首页</a><span> / </span><span>' + esc(text) + '</span></div><h1>' + esc(text) + '</h1>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div></section>';
}
function statusPill(status, refundedMinor = 0) {
  const labels = { draft: '草稿', pending: '待审核', published: '已上架', rejected: '已驳回', archived: '已下架', approved: '已通过', suspended: '已暂停', paid: '支付成功', free: '免费领取', failed: '支付失败', expired: '已过期', refunded: '已全额退款' };
  if (status === 'paid' && refundedMinor > 0) return '<span class="status status-partial">部分退款 ' + money(refundedMinor) + '</span>';
  return '<span class="status status-' + esc(status) + '">' + esc(labels[status] || status) + '</span>';
}
function chipPlatform(name) { return '<span class="platform-tag">' + esc(name) + '</span>'; }
function toast(text, bad = false) {
  const box = document.createElement('div');
  box.className = 'toast' + (bad ? ' error' : '');
  box.textContent = text;
  $('#toasts').append(box);
  setTimeout(() => box.remove(), 4000);
}
async function api(path, method = 'GET', data, isBinary = false) {
  const headers = { Accept: 'application/json' };
  if (state.csrf) headers['X-CSRF-Token'] = state.csrf;
  let body;
  if (isBinary) {
    headers['Content-Type'] = 'application/octet-stream';
    body = data;
  } else if (data !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(data);
  }
  let response;
  try { response = await fetch(path, { method, headers, credentials: 'same-origin', body }); }
  catch { throw new Error('网络连接失败，请检查服务是否正在运行'); }
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) throw new Error(result.error || '请求失败（' + response.status + '）');
  return result;
}
async function refreshMe() {
  const info = await api('/api/me');
  state.me = info.user;
  state.csrf = info.csrf;
  state.config = info.config;
  state.categories = info.categories;
  state.platforms = info.platforms;
}
function navItem(href, name, isActive) { return '<a href="' + href + '"' + (isActive ? ' class="active"' : '') + '>' + name + '</a>'; }
function currentRoute() { return (location.hash || '#/').slice(1).split('?')[0]; }
function nav() {
  const route = currentRoute();
  const seller = state.me && state.me.role === 'seller';
  const admin = state.me && state.me.role === 'admin';
  return '<header class="navbar"><div class="container nav-inner">' +
    '<a class="brand" href="#/" aria-label="SoftCove 首页"><span class="brand-symbol"><span class="brand-mark">≈</span></span><span><span class="brand-name">SoftCove</span><span class="brand-sub" style="display:block">软 湾 · 软 件 市 集</span></span></a>' +
    '<nav class="nav-links" aria-label="主导航">' +
    navItem('#/', '发现软件', route === '/') +
    navItem('#/explore', '全部应用', route === '/explore') +
    navItem(seller ? '#/seller' : '#/auth?role=seller', '开发者中心', route.startsWith('/seller')) +
    navItem('#/library', '我的软件库', route === '/library') + (admin ? navItem('#/admin', '平台管理', route === '/admin') : '') +
    '</nav><div class="nav-actions">' +
    (state.me ? '<a class="nav-user" href="' + (admin ? '#/admin' : seller ? '#/seller' : '#/library') + '"><span class="avatar">' + esc(state.me.name.slice(0, 1)) + '</span><span>' + esc(state.me.name) + '</span></a><button class="btn btn-light btn-sm" data-action="logout">退出</button>' :
      '<a class="btn btn-light btn-sm" href="#/auth">登录</a><a class="btn btn-primary btn-sm" href="#/auth?mode=register">免费注册 ↗</a>') +
    '</div></div><nav class="mobile-nav" aria-label="手机快捷导航">' +
    navItem('#/', '发现', route === '/') +
    navItem('#/explore', '全部软件', route === '/explore') +
    navItem(seller ? '#/seller' : '#/auth?role=seller', '开发者中心', route.startsWith('/seller')) +
    navItem('#/library', '我的软件库', route === '/library') +
    (admin ? navItem('#/admin', '管理后台', route === '/admin') : '') +
    '</nav></header>';
}
function footer() {
  return '<footer class="footer"><div class="container"><div class="footer-inner"><div>' +
    '<a href="#/" class="brand"><span class="brand-symbol"><span class="brand-mark">≈</span></span><span><span class="brand-name">SoftCove</span><span class="brand-sub" style="display:block">好软件，自有好去处</span></span></a>' +
    '<p>连接独立开发者与热爱软件的人。</p></div><div class="footer-links"><a href="#/">发现软件</a><a href="#/explore">全部应用</a><a href="#/auth?role=seller">开发者入驻</a><a href="#/library">我的软件库</a></div></div>' +
    '<div class="footer-note">© SoftCove · 独立开发者软件市集 MVP。展示样品为虚构产品，不可购买。平台仅在收到可信支付确认后交付付费商品；开发者款项不自动结算。</div>' +
    '</div></footer>';
}
function shell(body) { app.innerHTML = '<div class="site-shell">' + nav() + '<main>' + body + '</main>' + footer() + '</div>'; }

function art(p, large = false) {
  return '<div class="' + (large ? 'detail-cover' : 'app-art') + '" style="--accent:' + esc(p.accent) + '">' +
    (p.is_demo && !large ? '<span class="art-tag">设计示例 · 不可购买</span>' : '') +
    '<div class="app-icon">' + esc(p.icon) + '</div></div>';
}
function productCard(p) {
  return '<a class="app-card" href="#/product/' + encodeURIComponent(p.id) + '">' +
    art(p) +
    '<div class="app-body"><div class="app-title-row"><span class="app-title">' + esc(p.name) + '</span><span class="app-ver">v' + esc(p.version) + '</span></div>' +
    '<p class="app-desc">' + esc(p.tagline) + '</p><div class="platform-tags">' + p.platforms.slice(0, 3).map(chipPlatform).join('') + '</div>' +
    '<div class="app-bottom"><div><div class="price' + (p.price_minor === 0 ? ' free' : '') + '">' + (p.price_minor === 0 ? '免费' : money(p.price_minor, p.currency)) + '</div>' +
    '<div class="demo-hint">' + (p.is_demo ? '展示样品' : esc(p.seller_name || '独立开发者')) + '</div></div><span class="card-arrow">↗</span></div></div></a>';
}
function empty(emoji, heading, text, action = '') {
  return '<div class="empty-state"><span class="empty-emoji">' + emoji + '</span><h3>' + esc(heading) + '</h3><p>' + esc(text) + '</p>' + action + '</div>';
}

function filters() {
  return '<form class="search-panel" id="search-form"><span class="search-icon">⌕</span><input aria-label="搜索软件" name="search" placeholder="搜索软件、工具或功能关键词..." value="' + esc(state.search) + '"/><button class="btn btn-primary btn-sm" type="submit">搜索 →</button></form>' +
    '<div class="filters"><div class="filter-chips">' +
    '<button class="chip ' + (!state.category ? 'active' : '') + '" data-action="category" data-value="">全部应用</button>' +
    state.categories.map(c => '<button class="chip ' + (state.category === c ? 'active' : '') + '" data-action="category" data-value="' + esc(c) + '">' + esc(c) + '</button>').join('') + '</div></div>' +
    '<div class="filters"><span class="result-count">找到 ' + state.catalogCount + ' 款软件' + (state.catalogCount > 0 ? ' · 示例商品已明确标记' : '') + '</span>' +
    '<div class="selects"><select id="platform-filter" class="select" aria-label="支持系统">' +
    '<option value="">全部系统</option>' + state.platforms.map(s => '<option ' + (state.platform === s ? 'selected' : '') + ' value="' + esc(s) + '">' + esc(s) + '</option>').join('') + '</select>' +
    '<select id="price-filter" class="select" aria-label="价格筛选"><option value="all">全部价格</option><option value="free"' + (state.price === 'free' ? ' selected' : '') + '>免费</option><option value="paid"' + (state.price === 'paid' ? ' selected' : '') + '>付费</option></select>' +
    '<select id="sort-filter" class="select" aria-label="排序方式">' + [['new','最新上架'],['name','名称排序'],['price_asc','价格从低到高'],['price_desc','价格从高到低']].map(x => '<option value="' + x[0] + '"' + (state.sort === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></div></div>';
}
function catalog() {
  return '<div class="container"><div id="catalog" class="section"><div class="section-head"><div><div class="section-kicker">EXPLORE & DISCOVER</div><h2>发现下一款心仪的软件</h2><p class="section-note">从灵感到效率，每一款好工具都值得被看见。</p></div><a class="link" href="#/auth?role=seller">我也要上架 ↗</a></div>' +
    filters() +
    (state.catalog.length ? '<div class="catalog-grid">' + state.catalog.map(productCard).join('') + '</div>' :
      empty('⌕', '暂时没有找到结果', '调整搜索词、系统平台或者价格条件再试一次。', '<button class="btn btn-light" data-action="clear-filters">清除全部筛选</button>')) +
    '</div></div>';
}
function hero() {
  return '<section class="hero"><div class="container hero-content"><div class="hero-copy">' +
    '<div class="eyebrow"><span class="pulse"></span> MADE FOR INDEPENDENT CREATORS</div>' +
    '<h1>让每一份<span class="gradient-word">好软件</span><br/>都找到懂它的人。</h1>' +
    '<p class="hero-desc">一个为独立开发者而生的软件市集。发现有想法的工具、分享你的作品，让软件从创造走向价值。</p>' +
    '<div class="hero-actions"><a href="#/explore" class="btn btn-teal btn-lg">探索软件世界 <span>↗</span></a><a href="#/auth?role=seller" class="btn btn-outline btn-lg" style="color:#d3e4f6;border-color:#375468">成为开发者 →</a></div>' +
    '<div class="hero-claim"><span><b>✓</b> 独立开发者</span><span><b>✓</b> 人工上架审核</span><span><b>✓</b> 支付后自动交付</span></div></div>' +
    '<div class="spotlight" aria-hidden="true"><div class="spotlight-head"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="spotlight-label">SOFTCOVE / DISCOVER</span></div>' +
    '<div class="spotlight-feature"><span class="feature-icon">✦</span><div><small>DEVELOPER PICK · PREVIEW</small><strong>把好创意，变成好产品</strong><div class="mini-tags"><span>Desktop</span><span>Creator Tools</span></div></div></div>' +
    '<div class="spotlight-list"><div class="mini-card"><span class="mini-icon">◈</span><b>效率工具</b><small>Make it flow</small></div><div class="mini-card"><span class="mini-icon">✳</span><b>AI 应用</b><small>Think different</small></div><div class="mini-card"><span class="mini-icon">⌘</span><b>开发工具</b><small>Build better</small></div></div>' +
    '<div class="spotlight-foot">✦ 发现 · 创作 · 分享</div></div></div></section>';
}
function homePage(explore = false) {
  return (explore ? title('探索全部软件', '每一个优秀的独立作品，都值得被发现。') :
    hero() + '<div class="container"><div class="benefit-strip"><div class="benefit"><span class="benefit-symbol">⌘</span><div><strong>专注独立软件</strong><p>为认真打磨产品的创作者而设</p></div></div><div class="benefit"><span class="benefit-symbol">◇</span><div><strong>审核后发布</strong><p>商品进入公开市场前需人工复核</p></div></div><div class="benefit"><span class="benefit-symbol">↯</span><div><strong>自动交付</strong><p>可信付款回调后，下载权限自动发放</p></div></div></div></div>') +
    catalog() +
    '<section class="cta-section"><div class="container"><div class="cta-panel"><div><div class="section-kicker" style="color:#73efd0">BUILD. SHARE. GROW.</div><h2>你开发的软件，也值得被更多人看见。</h2><p>上传安装包、设置价格、提交审核，从第一笔订单开始。</p></div><a href="#/auth?role=seller" class="btn btn-teal btn-lg">免费入驻，发布作品 ↗</a></div></div></section>';
}

function productPage(p) {
  const isFree = p.price_minor === 0;
  let cta = '';
  let message = '上架安装包需通过管理员人工安全复核。';
  if (p.is_demo) {
    cta = '<button class="btn btn-primary btn-block btn-lg" disabled>展示样品 · 暂不开放购买</button>';
    message = '这是设计示例，并非真实售卖商品。不会收取任何费用。';
  } else if (p.has_access) {
    cta = '<a class="btn btn-primary btn-block btn-lg" href="/api/my/library/' + encodeURIComponent(p.id) + '/download">下载已购买软件 ↓</a>';
    message = '你已拥有这个软件，可以随时从软件库再次下载。';
  } else if (!state.me) {
    cta = '<a class="btn btn-primary btn-block btn-lg" href="#/auth">登录后' + (isFree ? '免费领取' : '购买软件') + ' ↗</a>';
  } else if (!isFree && !state.config.paymentConfigured) {
    cta = '<button class="btn btn-primary btn-block btn-lg" disabled>付费通道尚未开放</button>';
    message = '尚未配置 Stripe 正式支付，当前不能购买付费软件。';
  } else {
    cta = '<button class="btn btn-primary btn-block btn-lg" data-action="buy" data-id="' + esc(p.id) + '">' + (isFree ? '免费领取 ↗' : '安全支付并获取软件 ↗') + '</button>';
  }
  return '<section class="page-head"><div class="container"><div class="breadcrumb"><a href="#/">首页</a><span> / </span><a href="#/explore">全部应用</a><span> / </span><span>' + esc(p.name) + '</span></div><h1>发现好软件</h1><p>用值得信赖的方式，支持优秀开发者。</p></div></section>' +
    '<div class="container page-section"><div class="detail-wrap"><article class="detail-main">' +
    art(p, true) +
    '<div class="detail-copy"><div class="platform-tags">' + p.platforms.map(chipPlatform).join('') + (p.is_demo ? chipPlatform('展示样品') : '') + '</div>' +
    '<h2 class="detail-title">' + esc(p.name) + '</h2><p class="detail-tagline">' + esc(p.tagline) + '</p><hr style="border:0;border-top:1px solid #edf1f5;margin:24px 0"/>' +
    '<h3 style="font-size:16px">关于这款软件</h3><p class="detail-description">' + esc(p.description || p.tagline) + '</p></div></article>' +
    '<aside class="detail-aside"><div class="overline">GET THIS SOFTWARE</div><div class="price' + (isFree ? ' free' : '') + '" style="margin:9px 0 19px">' + (isFree ? '免费' : money(p.price_minor, p.currency)) + '</div>' +
    cta + '<p class="purchase-help">' + esc(message) + '</p><div class="aside-sep"></div>' +
    '<div class="info-row"><span>开发者</span><b><a class="link" href="#/studio/' + encodeURIComponent(p.seller_id) + '">' + esc(p.seller_name) + ' ↗</a></b></div>' +
    '<div class="info-row"><span>当前版本</span><b>' + esc(p.version) + '</b></div>' +
    '<div class="info-row"><span>所属分类</span><b>' + esc(p.category) + '</b></div>' +
    '<div class="info-row"><span>支持平台</span><b>' + p.platforms.map(esc).join(' / ') + '</b></div>' +
    '<div class="mini-safe">◎ 授权下载 · 文件隔离存储</div>' +
    '<p class="details-caption">软件下载不等于自动安装。请审查软件所请求的权限，并遵守其许可协议。</p></aside></div></div>';
}
function studioPage(s) {
  return title('开发者：' + s.seller.name, '了解开发者与他们发布的作品') +
    '<section class="container page-section"><div class="panel"><h3>' + esc(s.seller.name) + '</h3><p class="section-note">加入时间：' + fmtDate(s.seller.created_at) + '</p>' + (s.seller.seller_bio ? '<p class="detail-description">' + esc(s.seller.seller_bio) + '</p>' : '') + (s.seller.seller_website ? '<a class="link" href="' + esc(s.seller.seller_website) + '" rel="noopener noreferrer" target="_blank">访问开发者网站 ↗</a>' : '') + '</div>' +
    (s.products.length ? '<div class="catalog-grid">' + s.products.map(productCard).join('') + '</div>' : empty('🪄','还没有公开作品','开发者的商品上线后会显示在这里。')) + '</section>';
}
function dashSide(isAdmin, active) {
  return '<aside class="dash-side"><h3>' + (isAdmin ? 'CONTROL CENTER' : 'CREATOR STUDIO') + '</h3>' +
    '<a href="#/' + (isAdmin ? 'admin' : 'seller') + '" class="side-link ' + (active === 'overview' ? 'active' : '') + '"><span class="side-icon">▤</span> 概览</a>' +
    (isAdmin ? '' : '<a href="#/seller/new" class="side-link ' + (active === 'new' ? 'active' : '') + '"><span class="side-icon">⊕</span> 发布新软件</a>') +
    '<a href="#/library" class="side-link"><span class="side-icon">◈</span> 我的软件库</a>' +
    '<a href="#/explore" class="side-link"><span class="side-icon">⌕</span> 浏览商店</a></aside>';
}

function sellerProfilePanel(profile) {
  const status = profile?.seller_status || 'pending';
  const statusLabel = statusPill(status);
  const notice = status === 'approved'
    ? '开发者账号已通过平台人工资料审核，可以提交软件上架申请。此审核不等于政府实名/KYC。'
    : status === 'suspended'
      ? '此开发者账号已被暂停；所有相关软件对外隐藏，既有下载也暂停。请联系管理员。'
      : status === 'rejected'
        ? '开发者资料被驳回，可更新资料并再次等待审核。原因：' + (profile?.seller_review_note || '未提供')
        : '账号等待平台审核。在通过前可创建草稿和上传安装包，但不能提交上架申请。';
  return '<div class="panel"><h3>开发者入驻资料 ' + statusLabel + '</h3>' +
    '<div class="notice ' + (status === 'suspended' || status === 'rejected' ? 'danger' : 'warning') + '">' + esc(notice) + '</div>' +
    '<form id="seller-profile-form" style="margin-top:18px">' +
    '<div class="form-field"><label for="seller-bio">工作室/开发者介绍（至少20字）</label>' +
    '<textarea class="textarea" id="seller-bio" name="bio" required minlength="20" maxlength="1000" placeholder="作品方向、技术背景、软件授权和售后维护方式…">' + esc(profile?.seller_bio || '') + '</textarea></div>' +
    '<div class="form-field"><label for="seller-website">网站（选填，仅接受 HTTPS）</label><input class="input" id="seller-website" name="website" maxlength="200" value="' + esc(profile?.seller_website || '') + '" placeholder="https://example.com"/></div>' +
    '<button class="btn btn-light btn-sm" type="submit">保存开发者资料</button>' +
    '</form></div>';
}
function sellerSettlementPanel(data) {
  const stats = data.stats;
  const settlements = data.settlements || [];
  return '<div class="panel"><h3>结算账本</h3>' +
    '<p class="panel-sub">累计应得 ' + money(stats.earned_minor) + ' · 已登记线下结算 ' + money(stats.settled_minor) + ' · 可结算 ' + money(stats.due_minor) + '</p>' +
    (stats.adjustment_minor > 0 ? '<div class="notice danger">退款导致已结算金额比当前应得款多 ' + money(stats.adjustment_minor) + '，需人工对账追偿；不会自动扣取卖家银行账户资金。</div>' : '') +
    (settlements.length ? '<div class="table-scroller"><table class="data-table"><thead><tr><th>金额</th><th>外部凭证</th><th>方式</th><th>登记日期</th></tr></thead><tbody>' +
      settlements.map(x => '<tr><td><strong>' + money(x.amount_minor,x.currency) + '</strong></td><td>' + esc(x.external_reference) + '</td><td>' + (x.method === 'bank_transfer' ? '线下银行转账' : '其他线下方式') + '</td><td>' + fmtDate(x.created_at) + '</td></tr>').join('') + '</tbody></table></div>' :
      '<p class="section-note">暂无线下结算记录。平台不会自动打款，只有真实外部转账后管理员才会登记凭证。</p>') +
    '</div>';
}
function sellerPage(data) {
  const stats = data.stats;
  const rows = data.products.map(p => '<tr><td><strong>' + esc(p.name) + '</strong><div class="muted">v' + esc(p.version) + ' · ' + p.platforms.map(esc).join('/') + '</div></td>' +
    '<td>' + money(p.price_minor, p.currency) + '</td><td>' + statusPill(p.status) + (p.review_note ? '<div class="muted" title="' + esc(p.review_note) + '">' + esc(p.review_note.slice(0, 48)) + '</div>' : '') + '</td>' +
    '<td>' + (p.file_name ? '<span title="' + esc(p.file_sha256 || '') + '">' + esc(p.file_name) + '</span>' : '未上传') + '</td>' +
    '<td><div class="table-actions">' +
    (['draft','rejected'].includes(p.status) ? '<a class="btn btn-light btn-sm" href="#/seller/edit/' + encodeURIComponent(p.id) + '">继续编辑</a>' : '') +
    (p.status === 'published' ? '<a class="btn btn-light btn-sm" href="#/product/' + encodeURIComponent(p.id) + '">查看商品</a>' : '') +
    '</div></td></tr>').join('');
  return title('开发者工作台', '管理作品、跟踪订单，开启你的软件创作生意。') +
    '<section class="container page-section"><div class="dash-layout">' + dashSide(false, 'overview') +
    '<div class="dash-main"><div class="dash-head"><div><h2>创作概览</h2><p>欢迎回来，' + esc(state.me.name) + '。让下一个好作品在这里发光。</p></div><a class="btn btn-primary" href="#/seller/new">＋ 发布新软件</a></div>' +
    '<div class="stat-grid"><div class="stat-card"><div class="stat-label">已发布软件 <span class="stat-symbol">◈</span></div><div class="stat-value">' + stats.published + '</div><div class="stat-foot">另有 ' + stats.pending + ' 款待审核</div></div>' +
    '<div class="stat-card"><div class="stat-label">已支付订单 <span class="stat-symbol">↗</span></div><div class="stat-value">' + stats.sold + '</div><div class="stat-foot">不计免费领取</div></div>' +
    '<div class="stat-card"><div class="stat-label">待人工结算金额 <span class="stat-symbol">¥</span></div><div class="stat-value">' + money(stats.due_minor) + '</div><div class="stat-foot">自动打款尚未启用</div></div></div>' +
    sellerProfilePanel(data.profile) +
    '<div class="notice warning" style="margin-bottom:20px">款项说明：平台记录佣金与开发者账面应得金额，结算记录仅由管理员在实际线下转账后登记，不会触发自动提现。</div>' +
    '<div class="panel"><h3>我的软件 <span class="muted">(' + data.products.length + ')</span></h3>' +
    (data.products.length ? '<div class="table-scroller"><table class="data-table"><thead><tr><th>软件名称</th><th>定价</th><th>状态</th><th>安装包</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>' :
      empty('✧','你的第一个作品从这里开始','发布产品介绍、上传软件安装包，然后提交平台人工审核。','<a class="btn btn-primary" href="#/seller/new">＋ 开始发布</a>')) +
    '</div><div class="panel"><h3>最近订单</h3>' +
    (data.orders.length ? '<div class="table-scroller"><table class="data-table"><thead><tr><th>产品</th><th>支付金额</th><th>应得金额</th><th>状态</th><th>日期</th></tr></thead><tbody>' +
    data.orders.map(o => '<tr><td><strong>' + esc(o.product_name) + '</strong></td><td>' + money(o.amount_minor,o.currency) + '</td><td>' + money(o.seller_due_minor,o.currency) + '</td><td>' + statusPill(o.status,o.refunded_minor) + '</td><td>' + fmtDate(o.paid_at || o.created_at) + '</td></tr>').join('') +
    '</tbody></table></div>' : '<p class="section-note">暂无实际订单。你的软件审核上架后，交易记录会出现在这里。</p>') +
    '</div>' + sellerSettlementPanel(data) + '</div></div></section>';
}
function sellerFormPage(existing) {
  const edit = Boolean(existing);
  const p = existing || { name:'',tagline:'',description:'',category:'开发工具',platforms:['Windows'],version:'1.0.0',price_minor:0,currency:state.config.currency,icon:'✦',accent:'#6878ff' };
  return title(edit ? '编辑作品：' + p.name : '发布你的新软件', '好作品值得被看见。填写基本信息并提交审核。') +
    '<section class="container page-section"><div class="dash-layout">' + dashSide(false, 'new') +
    '<div class="dash-main"><form id="seller-product-form" data-id="' + esc(p.id || '') + '" class="form-layout"><div class="panel"><h3>01 · 基础信息</h3>' +
    '<div class="form-grid"><div class="form-field"><label for="p-name">软件名称 *</label><input class="input" id="p-name" name="name" required minlength="2" maxlength="70" value="' + esc(p.name) + '" placeholder="例如：我的效率助手"/></div>' +
    '<div class="form-field"><label for="p-version">版本号 *</label><input class="input" id="p-version" name="version" required maxlength="30" value="' + esc(p.version) + '" placeholder="1.0.0"/></div></div>' +
    '<div class="form-field"><label for="p-tagline">一句话介绍</label><input class="input" id="p-tagline" name="tagline" maxlength="130" value="' + esc(p.tagline) + '" placeholder="告诉大家这款软件最有价值的地方"/></div>' +
    '<div class="form-field"><label for="p-description">详细介绍 *（至少 20 字）</label><textarea class="textarea" id="p-description" name="description" required minlength="20" maxlength="6000" placeholder="介绍主要功能、使用方法、系统要求、许可证条款和注意事项…">' + esc(p.description) + '</textarea></div>' +
    '<div class="form-grid"><div class="form-field"><label>软件分类</label><select class="input" name="category">' + state.categories.map(c => '<option value="' + esc(c) + '"' + (p.category === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div>' +
    '<div class="form-field"><label>价格（' + esc(state.config.currency) + '，0 表示免费）</label><input class="input" name="price" type="number" min="0" max="50000" step="0.01" required value="' + (p.price_minor / 100).toFixed(2) + '"/></div></div>' +
    '<div class="form-field"><label>支持的操作系统 *</label><div class="checkbox-grid">' + state.platforms.map(os => '<label class="check-pill"><input type="checkbox" name="platforms" value="' + esc(os) + '"' + (p.platforms.includes(os) ? ' checked' : '') + ' /> ' + esc(os) + '</label>').join('') + '</div></div>' +
    '<div class="form-grid"><div class="form-field"><label>图标（单个 Emoji/符号）</label><input class="input" name="icon" value="' + esc(p.icon) + '" maxlength="12"/></div>' +
    '<div class="form-field"><label>主题色</label><input class="input" type="color" name="accent" value="' + esc(p.accent) + '"/></div></div>' +
    '</div><div class="panel"><h3>02 · 软件安装包</h3>' +
    '<div class="file-drop"><span class="file-symbol">⇧</span><h4>' + (p.file_name ? '已上传：' + esc(p.file_name) : '上传你的软件安装包') + '</h4>' +
    '<p>支持 Windows / macOS / Linux / Android 常见安装包及 ZIP，单文件最大 50 MiB，每位开发者总容量 500 MiB。上传后先隔离保存，需管理员审核。</p>' +
    '<input type="file" name="package" id="package" accept=".zip,.7z,.tar,.gz,.exe,.msi,.dmg,.pkg,.AppImage,.deb,.rpm,.apk,.msix"/>' +
    (p.file_sha256 ? '<p>文件 SHA-256：' + esc(p.file_sha256) + '</p><p>扫描状态：' + esc(p.scan_detail || p.scan_status || '') + '</p>' : '') +
    '</div></div>' +
    '<div class="notice warning">重要：必须拥有软件及素材的发布授权。禁止上传恶意程序、盗版软件或侵权文件。平台将要求管理员在隔离环境中检查文件，并明确审核确认后才能公开售卖。</div>' +
    (p.review_note ? '<div class="notice danger" style="margin-top:13px">上次审核意见：' + esc(p.review_note) + '</div>' : '') +
    '<div class="action-row"><button type="submit" class="btn btn-light" name="intent" value="draft">保存草稿</button><button type="submit" class="btn btn-primary" name="intent" value="submit"' + (state.sellerData?.profile?.seller_status !== 'approved' ? ' disabled title="开发者资料通过审核后才能提交"' : '') + '>保存并提交审核 ↗</button><a class="btn btn-outline" href="#/seller">返回工作台</a></div></form></div></div></section>';
}

function adminSellerPanels(data) {
  const sellers = data.sellers || [];
  const settlements = data.settlements || [];
  return '<div class="panel"><h3>开发者入驻审核 (' + sellers.length + ')</h3><p class="panel-sub">审核的是发布资质与提交信息，并非自动完成法定身份/KYC 认证。</p>' +
    (sellers.length ? '<div class="table-scroller"><table class="data-table"><thead><tr><th>开发者资料</th><th>状态</th><th>可结算</th><th>操作</th></tr></thead><tbody>' +
      sellers.map(s => '<tr><td><strong>' + esc(s.name) + '</strong><div class="muted">' + esc(s.email) + '</div>' +
        '<div class="muted" title="' + esc(s.seller_bio) + '">' + esc((s.seller_bio || '暂无开发者介绍').slice(0,90)) + '</div>' +
        (s.seller_website ? '<div class="muted">' + esc(s.seller_website) + '</div>' : '') +
        (s.seller_review_note ? '<div class="muted">审核备注：' + esc(s.seller_review_note) + '</div>' : '') + '</td>' +
        '<td>' + statusPill(s.seller_status) + '</td>' +
        '<td>' + money(s.due_minor) + (s.adjustment_minor ? '<div class="muted">需对账追回 ' + money(s.adjustment_minor) + '</div>' : '') + '</td>' +
        '<td><div class="table-actions">' +
        (s.seller_status !== 'approved' ? '<button class="btn btn-primary btn-sm" data-action="seller-approve" data-id="' + esc(s.id) + '">审核通过</button>' : '') +
        (['pending','rejected'].includes(s.seller_status) ? '<button class="btn btn-danger btn-sm" data-action="seller-reject" data-id="' + esc(s.id) + '">驳回</button>' : '') +
        (s.seller_status === 'approved' ? '<button class="btn btn-danger btn-sm" data-action="seller-suspend" data-id="' + esc(s.id) + '">暂停卖家</button>' : '') +
        (s.due_minor > 0 ? '<button class="btn btn-light btn-sm" data-action="seller-payout" data-id="' + esc(s.id) + '" data-due="' + s.due_minor + '">登记线下结算</button>' : '') +
        '</div></td></tr>').join('') + '</tbody></table></div>' : '<p class="section-note">暂无真实开发者账号。</p>') + '</div>' +
    '<div class="panel"><h3>线下结算登记</h3><p class="panel-sub">此账本只记录管理员确认已经通过外部渠道完成的转账，不会调用银行或 Stripe 转账 API。</p>' +
      (settlements.length ? '<div class="table-scroller"><table class="data-table"><thead><tr><th>开发者</th><th>金额</th><th>外部流水号</th><th>时间</th></tr></thead><tbody>' +
        settlements.map(s => '<tr><td>' + esc(s.seller_name) + '</td><td><strong>' + money(s.amount_minor,s.currency) + '</strong></td><td>' + esc(s.external_reference) + '</td><td>' + fmtDate(s.created_at) + '</td></tr>').join('') +
        '</tbody></table></div>' : '<p class="section-note">尚未登记任何外部支付凭证。</p>') + '</div>';
}
function adminPage(data) {
  const stats = data.stats;
  const queue = data.products.filter(p => p.status === 'pending');
  const liveProducts = data.products.filter(p => p.status === 'published');
  const rows = queue.map(p => '<tr><td><strong>' + esc(p.name) + '</strong><div class="muted">作者：' + esc(p.seller_name) + ' · ' + esc(p.version) + '</div></td>' +
    '<td>' + money(p.price_minor,p.currency) + '</td>' +
    '<td title="' + esc(p.file_sha256 || '') + '">' + esc(p.file_name || '未上传') + '<div class="muted">' + (p.file_size ? (p.file_size / 1024 / 1024).toFixed(2) + ' MiB' : '') + '</div></td>' +
    '<td>' + statusPill(p.status) + '<div class="muted">' + esc(p.scan_detail || p.scan_status || '') + '</div></td><td><div class="table-actions"><a class="btn btn-light btn-sm" href="/api/admin/products/' + encodeURIComponent(p.id) + '/file" download>隔离下载 ↓</a>' +
    '<button class="btn btn-sm btn-primary" data-action="approve" data-id="' + esc(p.id) + '">审核通过</button>' +
    '<button class="btn btn-sm btn-danger" data-action="reject" data-id="' + esc(p.id) + '">驳回</button></div></td></tr>').join('');
  return title('平台管理中心','审核真实商品、查看订单及交易佣金。') +
    '<section class="container page-section"><div class="dash-layout">' + dashSide(true,'overview') + '<div class="dash-main">' +
    '<div class="dash-head"><div><h2>平台运营概览</h2><p>软件安全与交易交付，需要每一次认真把关。</p></div></div>' +
    '<div class="stat-grid"><div class="stat-card"><div class="stat-label">入驻开发者 <span class="stat-symbol">♧</span></div><div class="stat-value">' + stats.sellers + '</div><div class="stat-foot">不包含演示账号</div></div>' +
    '<div class="stat-card"><div class="stat-label">待审商品 <span class="stat-symbol">⌛</span></div><div class="stat-value">' + stats.pending + '</div><div class="stat-foot">需要人工安全检查</div></div>' +
    '<div class="stat-card"><div class="stat-label">已记录平台佣金 <span class="stat-symbol">¥</span></div><div class="stat-value">' + money(stats.fees_minor) + '</div><div class="stat-foot">未扣税与退款 · 非实际结算</div></div></div>' +
    adminSellerPanels(data) +
    '<div class="notice danger" style="margin-bottom:19px"><strong>审核提醒：</strong>安装包默认隔离，ClamAV 为可选自动扫描且可能漏报。人工需另行核验软件签名、版权与运行行为，不能仅凭自动扫描就直接上架。</div>' +
    '<div class="panel"><h3>待审核软件 (' + queue.length + ')</h3>' +
    (queue.length ? '<div class="table-scroller"><table class="data-table"><thead><tr><th>软件信息</th><th>定价</th><th>文件</th><th>状态</th><th>审核操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>' :
    empty('✓','审核队列已清空','当前没有待人工复核的软件。')) + '</div>' +
    '<div class="panel"><h3>已上架软件 (' + liveProducts.length + ')</h3><p class="panel-sub">发现恶意行为、版权投诉或其他紧急问题，可立即下架并暂停所有下载权限。已付款订单须另行人工处理退款。</p>' +
    (liveProducts.length ? '<div class="table-scroller"><table class="data-table"><thead><tr><th>软件名称</th><th>开发者</th><th>价格</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
      liveProducts.map(p => '<tr><td><strong>' + esc(p.name) + '</strong></td><td>' + esc(p.seller_name) + '</td><td>' + money(p.price_minor,p.currency) + '</td><td>' + statusPill(p.status) + '</td><td><button class="btn btn-danger btn-sm" data-action="takedown" data-id="' + esc(p.id) + '">紧急下架</button></td></tr>').join('') +
      '</tbody></table></div>' : '<p class="section-note">暂无真实上架商品。</p>') + '</div>' +
    '<div class="panel"><h3>最近订单</h3><p class="panel-sub">订单快照以数据库为准；只有 Stripe 验签事件可把付费订单标记为成功。</p>' +
    (data.orders.length ? '<div class="table-scroller"><table class="data-table"><thead><tr><th>商品</th><th>买家</th><th>金额</th><th>平台佣金</th><th>状态</th><th>时间</th></tr></thead><tbody>' +
    data.orders.map(o => '<tr><td><strong>' + esc(o.product_name) + '</strong><div class="muted">' + esc(o.seller_name) + '</div></td><td>' + esc(o.buyer_email) + '</td><td>' + money(o.amount_minor,o.currency) + '</td><td>' + money(o.platform_fee_minor,o.currency) + '</td><td>' + statusPill(o.status,o.refunded_minor) + '</td><td>' + fmtDate(o.created_at) + '</td></tr>').join('') +
    '</tbody></table></div>' : '<p class="section-note">暂无交易订单。</p>') + '</div>' +
    '</div></div></section>';
}
function libraryPage(data) {
  const products = data.products || [];
  const orders = data.orders || [];
  const query = location.hash.split('?')[1] || '';
  const paymentNote = query.includes('payment=success') ? '<div class="notice warning" style="margin-bottom:20px">支付页面已返回。请以 Stripe 的服务端支付通知为准；只有收到验证通过的付款通知，软件才会自动出现在下方。若尚未出现，请稍后刷新。</div>' : '';
  return title('我的软件库','所有已获得授权的软件，都安全保存在这里。') +
    '<section class="container page-section">' + paymentNote +
    (products.length ? '<div class="library-list">' + products.map(p => '<div class="library-item">' +
      '<div class="app-icon" style="--accent:' + esc(p.accent) + '">' + esc(p.icon) + '</div>' +
      '<div class="library-info"><h3>' + esc(p.name) + ' <span class="muted">v' + esc(p.version) + '</span></h3><p>获取时间：' + fmtDate(p.acquired_at) + ' · ' + esc(p.platforms.join(' / ')) + '</p></div>' +
      (p.downloadable ? '<a class="btn btn-primary btn-sm" href="/api/my/library/' + encodeURIComponent(p.id) + '/download">下载软件 ↓</a>' : '<span class="status status-archived">暂停下载</span>') +
      '</div>').join('') + '</div>' :
      empty('◈','你的软件库还是空的','探索精选作品，免费领取或购买后，你拥有的正式软件会显示在这里。','<a class="btn btn-primary" href="#/explore">探索软件 ↗</a>')) +
    '<div class="panel" style="margin-top:24px"><h3>订单记录</h3>' +
    (orders.length ? '<div class="table-scroller"><table class="data-table"><thead><tr><th>软件</th><th>金额</th><th>状态</th><th>创建时间</th></tr></thead><tbody>' +
    orders.map(o => '<tr><td><strong>' + esc(o.product_name) + '</strong></td><td>' + money(o.amount_minor,o.currency) + '</td><td>' + statusPill(o.status,o.refunded_minor) + '</td><td>' + fmtDate(o.created_at) + '</td></tr>').join('') + '</tbody></table></div>' :
    '<p class="section-note">暂无订单。</p>') + '</div></section>';
}
function authPage() {
  const register = state.authMode === 'register';
  return '<div class="container"><section class="auth-shell"><div class="auth-art">' +
    '<div><div class="overline">WELCOME TO SOFTCOVE</div><h2>好创意，<br/>值得一片港湾。</h2><p>无论你是在寻找让生活更好的工具，还是想让自己的软件被世界看见，故事都从这里开始。</p></div>' +
    '<div class="hero-claim"><span><b>✓</b> 独立开发者</span><span><b>✓</b> 安全交付</span></div></div>' +
    '<div class="auth-card"><h2>' + (register ? '创建 SoftCove 账户' : '欢迎回来') + '</h2>' +
    '<p>' + (register ? '加入软湾，开始你的软件探索之旅。' : '登录后管理你的软件与订单。') + '</p>' +
    '<div class="auth-switch"><button type="button" class="' + (!register ? 'active' : '') + '" data-action="auth-mode" data-value="login">登录</button>' +
    '<button type="button" class="' + (register ? 'active' : '') + '" data-action="auth-mode" data-value="register">注册账号</button></div>' +
    '<form id="auth-form">' + (register ? '<div class="form-field"><label>你的称呼</label><input class="input" name="name" minlength="2" maxlength="40" required placeholder="怎么称呼你？"/></div>' : '') +
    '<div class="form-field"><label>邮箱地址</label><input class="input" type="email" name="email" required placeholder="you@example.com" autocomplete="email"/></div>' +
    '<div class="form-field"><label>密码</label><input class="input" type="password" name="password" minlength="' + (register ? '10' : '1') + '" required placeholder="' + (register ? '至少 10 位，建议使用独立密码' : '请输入密码') + '" autocomplete="' + (register ? 'new-password' : 'current-password') + '"/></div>' +
    (register ? '<div class="form-field"><label>注册用途</label><div class="checkbox-grid"><label class="check-pill"><input type="radio" name="role" value="buyer"' + (state.registerRole === 'buyer' ? ' checked' : '') + '/> 购买软件</label>' +
    '<label class="check-pill"><input type="radio" name="role" value="seller"' + (state.registerRole === 'seller' ? ' checked' : '') + '/> 我是开发者，准备卖软件</label></div></div>' : '') +
    '<button class="btn btn-primary btn-block btn-lg" type="submit">' + (register ? '立即注册 →' : '安全登录 →') + '</button></form>' +
    '<div class="auth-foot">' + (register ? '已有账号？<a href="#/auth" data-action="auth-mode" data-value="login">立即登录</a>' : '还没有账号？<a href="#/auth?mode=register" data-action="auth-mode" data-value="register">创建一个</a>') + '</div>' +
    '</div></section></div>';
}
function gate(role, label) {
  if (!state.me) return title('请先登录') + '<section class="container page-section">' + empty('🔐','登录后访问','登录后即可进入' + label,'<a class="btn btn-primary" href="#/auth">前往登录</a>') + '</section>';
  if (role && state.me.role !== role) return title('没有访问权限') + '<section class="container page-section">' + empty('⊘','权限不足','当前账户无法进入' + label + '；如需发布软件，请用开发者账号注册。') + '</section>';
  return null;
}

async function loadCatalog() {
  const q = new URLSearchParams({ q: state.search, category: state.category, platform: state.platform, price: state.price, sort: state.sort });
  const data = await api('/api/products?' + q);
  state.catalog = data.products;
  state.catalogCount = data.count;
}
async function render() {
  const route = currentRoute();
  try {
    let body;
    if (route === '/' || route === '/explore') {
      await loadCatalog();
      body = homePage(route === '/explore');
    } else if (route.startsWith('/product/')) {
      const id = route.slice('/product/'.length);
      const data = await api('/api/products/' + encodeURIComponent(id));
      body = productPage(data.product);
    } else if (route.startsWith('/studio/')) {
      const id = route.slice('/studio/'.length);
      body = studioPage(await api('/api/sellers/' + encodeURIComponent(id)));
    } else if (route === '/auth') {
      const params = new URLSearchParams(location.hash.split('?')[1] || '');
      state.registerRole = params.get('role') === 'seller' ? 'seller' : state.registerRole;
      if (params.get('role') === 'seller' || params.get('mode') === 'register') state.authMode = 'register';
      body = authPage();
    } else if (route === '/seller') {
      body = gate('seller','开发者工作台');
      if (!body) { state.sellerData = await api('/api/seller/overview'); body = sellerPage(state.sellerData); }
    } else if (route === '/seller/new' || route.startsWith('/seller/edit/')) {
      body = gate('seller','开发者编辑器');
      if (!body) {
        state.sellerData = await api('/api/seller/overview');
        const id = route.startsWith('/seller/edit/') ? route.split('/').pop() : '';
        const existing = id ? state.sellerData.products.find(p => p.id === id) : null;
        body = id && !existing ? title('作品不存在') : sellerFormPage(existing);
      }
    } else if (route === '/admin') {
      body = gate('admin','平台管理');
      if (!body) { state.adminData = await api('/api/admin/overview'); body = adminPage(state.adminData); }
    } else if (route === '/library') {
      body = gate(null,'我的软件库');
      if (!body) { state.libraryData = await api('/api/my/library'); body = libraryPage(state.libraryData); }
    } else {
      body = title('这个页面走丢了') + '<section class="container page-section">' + empty('⌁','找不到页面','也许它被搬到了新的地方。','<a class="btn btn-primary" href="#/">返回首页</a>') + '</section>';
    }
    // If an older async route finished after navigation, do not replace the new page.
    if (route !== currentRoute()) return;
    shell(body);
  } catch (error) {
    shell(title('无法打开页面') + '<section class="container page-section">' + empty('⚠','加载失败',error.message,'<button class="btn btn-primary" data-action="retry">重新加载</button>') + '</section>');
    toast(error.message, true);
  }
}
async function applyFilters() { await render(); }

document.addEventListener('click', async event => {
  const element = event.target.closest('[data-action]');
  if (!element) return;
  const action = element.dataset.action;
  if (action === 'auth-mode') {
    event.preventDefault();
    state.authMode = element.dataset.value;
    if (state.authMode === 'login') { state.registerRole = 'buyer'; location.hash = '#/auth'; }
    else location.hash = '#/auth?mode=register';
    await render();
  }
  if (action === 'logout') {
    event.preventDefault();
    try { await api('/api/auth/logout','POST',{}); await refreshMe(); toast('已安全退出'); location.hash = '#/'; await render(); }
    catch(error) { toast(error.message,true); }
  }
  if (action === 'category') {
    state.category = element.dataset.value;
    await applyFilters();
  }
  if (action === 'clear-filters') {
    state.search = ''; state.category = ''; state.platform = ''; state.price = 'all'; state.sort = 'new';
    await applyFilters();
  }
  if (action === 'retry') await render();
  if (action === 'buy') {
    element.disabled = true;
    try {
      const order = await api('/api/orders','POST',{productId:element.dataset.id});
      if (order.library) { toast('领取成功，已加入我的软件库'); location.hash = '#/library'; await render(); }
      else if (order.checkoutUrl) location.assign(order.checkoutUrl);
    } catch(error) { toast(error.message,true); element.disabled = false; }
  }
  if (['seller-approve','seller-reject','seller-suspend'].includes(action)) {
    const decision = action.split('-')[1] === 'suspend' ? 'suspend' : action.split('-')[1];
    let note = '';
    if (decision === 'approve') {
      if (!confirm('已人工核对该开发者的资料和发布资质？\n此操作不代表已完成法定 KYC 或支付账户审核。')) return;
      note = '已人工审核开发者发布资料';
    } else {
      note = prompt('请填写审核原因（至少5字）：',decision==='suspend' ? '检测到风险，暂时暂停卖家全部软件分发' : '入驻介绍和软件发布资质尚不完整') || '';
      if (note.trim().length < 5) return;
      if (decision === 'suspend' && !confirm('将立即隐藏该卖家的所有软件并暂停既有买家的下载。确定继续？')) return;
    }
    element.disabled = true;
    try {
      await api('/api/admin/sellers/' + encodeURIComponent(element.dataset.id) + '/review','POST',{
        decision,note,reviewAcknowledged:decision==='approve'
      });
      toast('开发者审核记录已更新');
      await render();
    } catch(error) {element.disabled=false;toast(error.message,true);}
  }
  if (action === 'seller-payout') {
    const due = Number(element.dataset.due);
    const raw = prompt('请输入已经通过银行等外部渠道转账成功的金额（单位：' + state.config.currency + '），最大 ' + money(due) + '。\n本按钮不会自动转账。', (due/100).toFixed(2));
    if (raw===null) return;
    const amount = Number(raw);
    const minor = Math.round(amount*100);
    if (!Number.isFinite(amount) || amount <= 0 || minor > due || Math.abs(minor/100-amount) > 0.0000001) { toast('金额无效或超过可结算额',true);return; }
    const ref = prompt('输入外部银行/支付系统的真实转账流水号（至少6位，仅字母数字和 -_./#）：') || '';
    if (ref.length < 6) return;
    if (!confirm('再次确认：转账 ' + money(minor) + ' 已经通过外部机构实际完成，凭证 ' + ref + '。\n此操作仅登记账本，不会发起付款。')) return;
    element.disabled = true;
    try {
      await api('/api/admin/settlements','POST',{
        sellerId:element.dataset.id,amount_minor:minor,method:'bank_transfer',
        externalReference:ref,note:'管理员确认外部线下已支付',confirmedExternally:true
      });
      toast('线下结算凭证已登记（无自动打款）');
      await render();
    } catch(error){element.disabled=false;toast(error.message,true);}
  }
  if (action === 'takedown') {
    const reason = prompt('请输入紧急下架原因（至少 5 个字符）：\n下架后将立即暂停所有购买和下载。', '安全核验异常，需要重新审查安装包') || '';
    if (reason.trim().length < 5) return;
    if (!confirm('确认立即下架？已有购买者也将暂时无法下载。必须由运营人员另外处理退款及用户通知。')) return;
    element.disabled = true;
    try {
      await api('/api/admin/products/' + encodeURIComponent(element.dataset.id) + '/takedown','POST',{reason});
      toast('商品已紧急下架，所有下载权限已暂停');
      await render();
    } catch(error) { element.disabled = false; toast(error.message,true); }
  }
  if (action === 'approve' || action === 'reject') {
    const approved = action === 'approve';
    let note = '';
    if (approved) {
      if (!confirm('你是否已在隔离环境进行恶意软件扫描、签名及版权核验？\n\n即使启用 ClamAV 自动扫描，仍需要人工核验版权、签名和运行行为。只有真正完成核验才能确定。')) return;
    } else {
      note = prompt('填写驳回理由（至少 3 个字符）：','安装包或发布信息未通过安全/版权审核') || '';
      if (note.trim().length < 3) return;
    }
    element.disabled = true;
    try {
      await api('/api/admin/products/' + encodeURIComponent(element.dataset.id) + '/review','POST',{decision:approved ? 'approve' : 'reject',scanConfirmed:approved,note});
      toast(approved ? '审核通过，软件已上架' : '已驳回并通知展示在卖家后台');
      await render();
    } catch(error) { element.disabled = false; toast(error.message,true); }
  }
});
document.addEventListener('change', async event => {
  if (event.target.id === 'platform-filter') { state.platform = event.target.value; await applyFilters(); }
  if (event.target.id === 'price-filter') { state.price = event.target.value; await applyFilters(); }
  if (event.target.id === 'sort-filter') { state.sort = event.target.value; await applyFilters(); }
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (!['search-form','auth-form','seller-product-form','seller-profile-form'].includes(form.id)) return;
  event.preventDefault();
  if (form.id === 'search-form') {
    state.search = form.elements.search.value.trim();
    await applyFilters();
    return;
  }
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    if (form.id === 'auth-form') {
      const data = new FormData(form);
      const payload = { email: data.get('email'), password: data.get('password') };
      if (state.authMode === 'register') {
        payload.name = data.get('name');
        payload.role = data.get('role') || 'buyer';
      }
      const endpoint = state.authMode === 'register' ? 'register' : 'login';
      await api('/api/auth/' + endpoint, 'POST', payload);
      await refreshMe();
      toast(state.authMode === 'register' ? '注册成功，欢迎来到软湾！' : '登录成功，欢迎回来');
      location.hash = state.me.role === 'seller' ? '#/seller' : state.me.role === 'admin' ? '#/admin' : '#/library';
      await render();
    }
    if (form.id === 'seller-profile-form') {
      const data = new FormData(form);
      await api('/api/seller/profile','PUT',{bio:data.get('bio'),website:data.get('website')});
      await refreshMe();
      toast('资料已保存，等待管理员审核；审核通过后才能提交软件上架');
      await render();
    }
    if (form.id === 'seller-product-form') {
      const data = new FormData(form);
      const price = Number(data.get('price'));
      if (!Number.isFinite(price) || price < 0 || price > 50000) throw new Error('价格范围无效');
      const priceMinor = Math.round(price * 100);
      const payload = {
        name: data.get('name'), tagline: data.get('tagline'), description: data.get('description'),
        version: data.get('version'), category: data.get('category'), platforms: data.getAll('platforms'),
        price_minor: priceMinor, icon: data.get('icon'), accent: data.get('accent')
      };
      const id = form.dataset.id || '';
      const result = id ? await api('/api/seller/products/' + encodeURIComponent(id),'PATCH',payload) :
        await api('/api/seller/products','POST',payload);
      const productId = id || result.id;
      const file = data.get('package');
      if (file && file.size > 0) {
        if (file.size > state.config.maxPackageMiB * 1024 * 1024) throw new Error('安装包超过 50 MiB，请使用更小的构建包');
        toast('上传中：' + file.name);
        const scan = await api('/api/seller/products/' + encodeURIComponent(productId) + '/file?filename=' + encodeURIComponent(file.name),'PUT',file,true);
        if (['scan_error','scan_failed'].includes(scan.scan_status)) throw new Error(scan.scan_detail || '自动扫描未通过，软件已隔离，请修改后重新上传');
        if (scan.scan_status === 'scan_passed') toast('ClamAV 已扫描，仍需要平台人工复核');
      }
      if (submit && submit.value === 'submit') {
        await api('/api/seller/products/' + encodeURIComponent(productId) + '/submit','POST',{});
        toast('提交成功！等待平台人工审核');
      } else toast('草稿已保存');
      location.hash = '#/seller';
      await render();
    }
  } catch(error) {
    toast(error.message,true);
  } finally { if (submit) submit.disabled = false; }
});
window.addEventListener('hashchange', () => { render(); window.scrollTo({ top: 0, behavior: 'instant' }); });
refreshMe().then(() => render()).catch(error => {
  app.innerHTML = '<div class="boot"><span>⚠</span><strong>无法连接 SoftCove 服务</strong><span>' + esc(error.message) + '</span><button class="btn btn-primary" id="boot-retry">重试</button></div>';
  $('#boot-retry')?.addEventListener('click', () => location.reload());
});
