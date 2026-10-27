import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, createReadStream, createWriteStream, mkdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { openDatabase, withTransaction, uid, CATEGORIES, PLATFORMS } from './src/db.mjs';
import { HttpError, fail, hashPassword, verifyPassword, getAuth, publicUser, createSession, clearSession, requireAuth, checkSameOrigin, checkMutation, readBody, readJSON, safeEmail, safeText, safeFilename, createRateLimiter, json } from './src/security.mjs';
import { scanPackage } from './src/scanner.mjs';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml']
};
const allowedExtensions = new Set(['.zip', '.7z', '.tar', '.gz', '.exe', '.msi', '.dmg', '.pkg', '.appimage', '.deb', '.rpm', '.apk', '.msix']);
const maxPackageBytes = 50 * 1024 * 1024;
const maxSellerStorageBytes = 500 * 1024 * 1024;
const maxSellerListings = 100;

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

function parsePlatforms(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) fail(400, '请至少选择一个支持的平台');
  const chosen = [...new Set(value)];
  if (chosen.some(x => !PLATFORMS.includes(x))) fail(400, '系统平台无效');
  return JSON.stringify(chosen);
}

function validateProduct(input, currency) {
  const name = safeText(input.name, '软件名称', 70, 2);
  const tagline = safeText(input.tagline ?? '', '一句话介绍', 130);
  const description = safeText(input.description ?? '', '详细介绍', 6000, 20);
  const category = String(input.category || '');
  if (!CATEGORIES.includes(category)) fail(400, '商品分类无效');
  const platforms = parsePlatforms(input.platforms);
  const version = safeText(input.version ?? '1.0.0', '版本号', 30, 1);
  const price = input.price_minor;
  if (!Number.isSafeInteger(price) || price < 0 || price > 5_000_000) fail(400, '价格必须是 0 至 50000 元（以分为单位的整数）');
  const icon = safeText(input.icon ?? '📦', '图标', 12, 1);
  const accent = safeText(input.accent ?? '#6878ff', '主题色', 7, 7);
  if (!/^#[0-9a-fA-F]{6}$/.test(accent)) fail(400, '主题色必须是十六进制色值');
  return { name, tagline, description, category, platforms, version, price, currency, icon, accent };
}

function publicProduct(p, detailed = false) {
  const result = {
    id: p.id, seller_id: p.seller_id, seller_name: p.seller_name || '',
    name: p.name, tagline: p.tagline, category: p.category,
    platforms: JSON.parse(p.platforms), version: p.version,
    price_minor: p.price_minor, currency: p.currency,
    icon: p.icon, accent: p.accent, is_demo: Boolean(p.is_demo),
    status: p.status, created_at: p.created_at
  };
  if (detailed) result.description = p.description;
  return result;
}

function sellerProduct(p) {
  return { ...publicProduct(p, true), file_name: p.file_name, file_size: p.file_size,
    file_sha256: p.file_sha256, scan_status: p.scan_status, scan_detail: p.scan_detail, scanned_at: p.scanned_at, review_note: p.review_note,
    reviewed_at: p.reviewed_at, updated_at: p.updated_at };
}

function selectPublicProduct(db, id) {
  return db.prepare("SELECT p.*,u.name AS seller_name FROM products p JOIN users u ON p.seller_id=u.id WHERE p.id=? AND p.status='published' AND (p.is_demo=1 OR u.seller_status='approved')").get(id);
}

function requireSellerProduct(db, auth, id) {
  const product = db.prepare('SELECT * FROM products WHERE id=? AND seller_id=?').get(id, auth.id);
  if (!product || product.is_demo) fail(404, '未找到你发布的软件');
  return product;
}

function checkEditState(product) {
  if (!['draft', 'rejected'].includes(product.status)) fail(409, '该版本已进入审核或发布，不能直接修改，请新建商品版本');
}

function sendStoredPackage(res, dataDir, product) {
  const key = product.file_key;
  if (!key || !/^[a-f0-9-]{36}\.blob$/.test(key)) fail(404, '暂无可下载的软件包');
  const folder = path.resolve(dataDir, 'uploads');
  const target = path.resolve(folder, key);
  if (path.dirname(target) !== folder || !existsSync(target)) fail(404, '软件包不存在');
  const filename = String(product.file_name || 'software.zip').replace(/["\\\r\n]/g, '_');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
    'Content-Length': statSync(target).size,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  createReadStream(target).pipe(res);
}

function getStripeSignature(body, header, secret) {
  const attrs = String(header || '').split(',').map(x => x.trim());
  const timestamp = attrs.find(x => x.startsWith('t='))?.slice(2);
  const signatures = attrs.filter(x => x.startsWith('v1=')).map(x => x.slice(3));
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const digest = createHmac('sha256', secret).update(timestamp + '.').update(body).digest();
  return signatures.some(sig => {
    if (!/^[a-f0-9]{64}$/i.test(sig)) return false;
    return timingSafeEqual(Buffer.from(sig, 'hex'), digest);
  });
}

function stripeSessionSucceeded(db, event, feeBps, isLiveKey) {
  const session = event.data?.object;
  if (!session || !session.id || !event.id || event.livemode !== isLiveKey) return;
  const orderId = session.metadata?.order_id;
  if (!orderId || typeof orderId !== 'string') return;

  withTransaction(db, () => {
    if (db.prepare('SELECT id FROM webhook_events WHERE id=?').get(event.id)) return;
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!order || order.checkout_session_id !== session.id) return;
    if (String(session.currency || '').toUpperCase() !== order.currency) return;
    if (event.type === 'checkout.session.expired' && order.status === 'pending') {
      db.prepare("UPDATE orders SET status='expired' WHERE id=?").run(order.id);
    }
    if (event.type === 'checkout.session.async_payment_failed' && order.status === 'pending') {
      db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(order.id);
    }
    if ((event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded')
      && session.payment_status === 'paid' && session.amount_total === order.amount_minor && order.status === 'pending') {
      // A real card checkout has one PaymentIntent. Persist it for later refund reconciliation.
      const intent = typeof session.payment_intent === 'string' ? session.payment_intent : '';
      if (!/^pi_[a-zA-Z0-9]+$/.test(intent)) return;
      const product = db.prepare('SELECT * FROM products WHERE id=?').get(order.product_id);
      const refund = db.prepare('SELECT refunded_minor,amount_minor FROM stripe_refunds WHERE payment_intent_id=?').get(intent);
      const refunded = refund && refund.amount_minor === order.amount_minor ? refund.refunded_minor : 0;
      const totalNet = Math.max(0, order.amount_minor - refunded);
      // Even after approval was revoked, entitlements must never be minted for unsafe listings.
      if (product && product.status === 'published' && product.scan_status === 'manually_verified' && !product.is_demo) {
        const platformFee = Math.round(totalNet * feeBps / 10000);
        const newStatus = totalNet === 0 ? 'refunded' : 'paid';
        const now = new Date().toISOString();
        db.prepare("UPDATE orders SET status=?,paid_at=?,payment_intent_id=?,platform_fee_minor=?,seller_due_minor=?,refunded_minor=?,refunded_at=? WHERE id=?")
          .run(newStatus, now, intent, platformFee, totalNet - platformFee, refunded, refunded ? now : null, order.id);
        if (newStatus === 'paid') {
          db.prepare('INSERT OR IGNORE INTO entitlements (id,buyer_id,product_id,order_id,created_at) VALUES (?,?,?,?,?)')
            .run(uid('ent_'), order.buyer_id, order.product_id, order.id, now);
        }
      } else {
        // Record the validated charge for operator reconciliation without distributing an unsafe build.
        db.prepare('UPDATE orders SET payment_intent_id=? WHERE id=?').run(intent, order.id);
      }
    }
    db.prepare('INSERT OR IGNORE INTO webhook_events (id,processed_at) VALUES (?,?)').run(event.id, new Date().toISOString());
  });
}

// Stripe charge.refunded uses the Charge payload, not a Checkout Session.
// A charge can be refunded more than once: amount_refunded is cumulative.
function stripeChargeRefunded(db, event, feeBps, isLiveKey) {
  if (event.livemode !== isLiveKey || !event.id) return;
  const charge = event.data?.object;
  const intent = typeof charge?.payment_intent === 'string' ? charge.payment_intent : '';
  if (!/^pi_[a-zA-Z0-9]+$/.test(intent) || !/^ch_[a-zA-Z0-9]+$/.test(String(charge.id || ''))) return;
  const amount = charge.amount;
  const refunded = charge.amount_refunded;
  if (!Number.isSafeInteger(amount) || amount < 1 || !Number.isSafeInteger(refunded) || refunded < 0 || refunded > amount) return;
  withTransaction(db, () => {
    if (db.prepare('SELECT id FROM webhook_events WHERE id=?').get(event.id)) return;
    const previous = db.prepare('SELECT * FROM stripe_refunds WHERE payment_intent_id=?').get(intent);
    const cumulative = Math.max(previous?.refunded_minor || 0, refunded);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO stripe_refunds (payment_intent_id,charge_id,amount_minor,refunded_minor,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(payment_intent_id) DO UPDATE SET refunded_minor=excluded.refunded_minor,updated_at=excluded.updated_at')
      .run(intent, charge.id, amount, cumulative, now);
    const order = db.prepare('SELECT * FROM orders WHERE payment_intent_id=?').get(intent);
    if (order && ['paid','refunded'].includes(order.status) && order.amount_minor === amount && String(charge.currency || '').toUpperCase() === order.currency) {
      const remaining = Math.max(0, amount - cumulative);
      const platformFee = Math.round(remaining * feeBps / 10000);
      db.prepare('UPDATE orders SET status=?,platform_fee_minor=?,seller_due_minor=?,refunded_minor=?,refunded_at=? WHERE id=?')
        .run(remaining ? 'paid' : 'refunded', platformFee, remaining - platformFee, cumulative, now, order.id);
      if (!remaining) db.prepare('DELETE FROM entitlements WHERE order_id=?').run(order.id);
    }
    db.prepare('INSERT INTO webhook_events (id,processed_at) VALUES (?,?)').run(event.id, now);
  });
}

async function createStripeCheckout({ stripeKey, baseUrl, buyer, order }) {
  const input = new URLSearchParams();
  const set = (key, value) => input.append(key, String(value));
  set('mode', 'payment');
  set('payment_method_types[0]', 'card');
  set('line_items[0][price_data][currency]', order.currency.toLowerCase());
  set('line_items[0][price_data][unit_amount]', order.amount_minor);
  set('line_items[0][price_data][product_data][name]', order.product_name);
  set('line_items[0][quantity]', 1);
  set('client_reference_id', order.id);
  set('metadata[order_id]', order.id);
  set('customer_email', buyer.email);
  set('success_url', baseUrl + '/#/library?payment=success');
  set('cancel_url', baseUrl + '/#/library?payment=cancel');
  const result = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + stripeKey, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': order.id },
    body: input.toString(),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await result.json();
  if (!result.ok || !payload.id || !payload.url || !String(payload.url).startsWith('https://checkout.stripe.com/')) {
    throw new Error('Stripe Checkout 创建失败: ' + (payload.error?.code || result.status));
  }
  return { id: payload.id, url: payload.url };
}

async function savePackage(req, dataDir, filename) {
  const extension = path.extname(filename).toLowerCase();
  if (!allowedExtensions.has(extension)) fail(400, '仅支持 zip、7z、tar、gz、exe、msi、dmg、pkg、AppImage、deb、rpm、apk、msix');
  if (String(req.headers['content-type'] || '').split(';')[0].toLowerCase() !== 'application/octet-stream') fail(415, '软件文件上传必须使用二进制格式');
  const length = Number(req.headers['content-length'] || 0);
  if (length > maxPackageBytes) fail(413, '单文件不能超过 50 MiB');

  const folder = path.join(dataDir, 'uploads');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const temp = path.join(folder, randomUUID() + '.tmp');
  const key = randomUUID() + '.blob';
  const sha = createHash('sha256');
  let count = 0;
  try {
    const counter = new Transform({
      transform(chunk, encoding, callback) {
        count += chunk.length;
        if (count > maxPackageBytes) callback(new HttpError(413, '单文件不能超过 50 MiB'));
        else { sha.update(chunk); callback(null, chunk); }
      }
    });
    await pipeline(req, counter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    if (count === 0) fail(400, '不能上传空文件');
    renameSync(temp, path.join(folder, key));
    return { key, size: count, sha256: sha.digest('hex') };
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

function summaryNumber(db, sql, args = []) {
  return db.prepare(sql).get(...args)?.n || 0;
}

function sellerBalance(db, sellerId) {
  const earned = summaryNumber(db,"SELECT COALESCE(SUM(seller_due_minor),0) AS n FROM orders WHERE seller_id=? AND status IN ('paid','refunded')",[sellerId]);
  const settled = summaryNumber(db,"SELECT COALESCE(SUM(amount_minor),0) AS n FROM manual_settlements WHERE seller_id=?",[sellerId]);
  return {
    earned_minor: earned, settled_minor: settled,
    due_minor: Math.max(0,earned - settled),
    adjustment_minor: Math.max(0,settled - earned)
  };
}

function loadConfig(opts = {}) {
  const baseUrl = String(opts.baseUrl || process.env.PUBLIC_BASE_URL || 'http://localhost:' + (process.env.PORT || 3100)).replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/i.test(baseUrl)) throw new Error('PUBLIC_BASE_URL 必须是一个有效站点域名，且不包含路径');
  const currency = String(opts.currency || process.env.APP_CURRENCY || 'CNY').toUpperCase();
  if (!['CNY', 'USD'].includes(currency)) throw new Error('仅支持 CNY 或 USD 单货币商店');
  const feeBps = Number(opts.feeBps ?? process.env.PLATFORM_FEE_BPS ?? 1500);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) throw new Error('PLATFORM_FEE_BPS 无效');
  return {
    dataDir: path.resolve(opts.dataDir || process.env.DATA_DIR || path.join(projectDir, 'data')),
    baseUrl, currency, feeBps,
    stripeKey: String(opts.stripeKey ?? process.env.STRIPE_SECRET_KEY ?? ''),
    webhookSecret: String(opts.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET ?? ''),
    clamavEnabled: (opts.clamavEnabled ?? ['1','true'].includes(String(process.env.CLAMAV_ENABLED || '').toLowerCase())) === true,
    clamavCommand: String(opts.clamavCommand || process.env.CLAMAV_COMMAND || 'clamscan'),
    secureCookie: baseUrl.startsWith('https://')
  };
}

export function createApp(options = {}) {
  const config = loadConfig(options);
  const { dataDir, baseUrl, currency, feeBps, stripeKey, webhookSecret, secureCookie, clamavEnabled, clamavCommand } = config;
  const scanner = options.scanner || scanPackage;
  const paymentConfigured = Boolean(stripeKey && webhookSecret);
  const db = openDatabase(dataDir);
  const rateLimit = createRateLimiter();

  async function dispatch(req, res) {
    securityHeaders(res);
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method || 'GET';
    const auth = getAuth(db, req);

    if (pathname === '/api/health' && method === 'GET') return json(res, 200, { ok: true, version: '0.2.0-beta.1' });
    if (pathname === '/api/me' && method === 'GET') {
      return json(res, 200, {
        user: publicUser(auth), csrf: auth?.csrf_token || null,
        config: { paymentConfigured, currency, feeBps, sellerPayouts: 'manual', maxPackageMiB: 50, clamavEnabled },
        categories: CATEGORIES, platforms: PLATFORMS
      });
    }

    if (pathname === '/api/auth/register' && method === 'POST') {
      checkSameOrigin(req, baseUrl);
      rateLimit(req, 'register', 8, 60 * 60 * 1000);
      const body = await readJSON(req);
      const email = safeEmail(body.email);
      const name = safeText(body.name, '昵称', 40, 2);
      const password = String(body.password || '');
      if (password.length < 10 || password.length > 128) fail(400, '密码长度应为 10 至 128 个字符');
      const role = body.role === 'seller' ? 'seller' : 'buyer';
      if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) fail(409, '该邮箱已经注册');
      const user = { id: uid('usr_'), email, name, role, seller_status: role === 'seller' ? 'pending' : 'none' };
      db.prepare('INSERT INTO users (id,email,name,password_hash,role,seller_status,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(user.id, email, name, hashPassword(password), role, user.seller_status, new Date().toISOString());
      const csrf = createSession(db, req, res, user, secureCookie);
      return json(res, 201, { user, csrf });
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      checkSameOrigin(req, baseUrl);
      rateLimit(req, 'login', 16, 15 * 60 * 1000);
      const body = await readJSON(req);
      const email = safeEmail(body.email);
      const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      if (!user || !verifyPassword(String(body.password || ''), user.password_hash)) fail(401, '邮箱或密码不正确');
      const csrf = createSession(db, req, res, user, secureCookie);
      return json(res, 200, { user: publicUser(user), csrf });
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      checkMutation(req, auth, baseUrl);
      clearSession(db, req, res, secureCookie);
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/products' && method === 'GET') {
      const search = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
      const category = String(url.searchParams.get('category') || '');
      const platform = String(url.searchParams.get('platform') || '');
      const price = url.searchParams.get('price') || 'all';
      const sort = url.searchParams.get('sort') || 'new';
      let products = db.prepare("SELECT p.*,u.name AS seller_name FROM products p JOIN users u ON p.seller_id=u.id WHERE p.status='published' AND (p.is_demo=1 OR u.seller_status='approved') ORDER BY p.created_at DESC LIMIT 200").all();
      if (search) products = products.filter(x => (x.name + ' ' + x.tagline + ' ' + x.description).toLowerCase().includes(search));
      if (category && CATEGORIES.includes(category)) products = products.filter(x => x.category === category);
      if (platform && PLATFORMS.includes(platform)) products = products.filter(x => JSON.parse(x.platforms).includes(platform));
      if (price === 'free') products = products.filter(x => x.price_minor === 0);
      if (price === 'paid') products = products.filter(x => x.price_minor > 0);
      if (sort === 'price_asc') products.sort((a, b) => a.price_minor - b.price_minor);
      if (sort === 'price_desc') products.sort((a, b) => b.price_minor - a.price_minor);
      if (sort === 'name') products.sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, { products: products.slice(0, 100).map(p => publicProduct(p)), count: products.length });
    }

    const productDetail = pathname.match(/^\/api\/products\/([a-zA-Z0-9_-]+)$/);
    if (productDetail && method === 'GET') {
      const product = selectPublicProduct(db, productDetail[1]);
      if (!product) fail(404, '软件不存在');
      const hasAccess = auth ? Boolean(db.prepare('SELECT id FROM entitlements WHERE buyer_id=? AND product_id=?').get(auth.id, product.id)) : false;
      return json(res, 200, { product: { ...publicProduct(product, true), has_access: hasAccess } });
    }

    const sellerDetail = pathname.match(/^\/api\/sellers\/([a-zA-Z0-9_-]+)$/);
    if (sellerDetail && method === 'GET') {
      const seller = db.prepare("SELECT id,name,seller_bio,seller_website,created_at FROM users WHERE id=? AND role='seller' AND seller_status='approved'").get(sellerDetail[1]);
      if (!seller) fail(404, '开发者不存在');
      const products = db.prepare("SELECT p.*,u.name AS seller_name FROM products p JOIN users u ON p.seller_id=u.id WHERE p.seller_id=? AND p.status='published'").all(seller.id);
      return json(res, 200, { seller, products: products.map(p => publicProduct(p)) });
    }

    if (pathname === '/api/seller/profile' && method === 'PUT') {
      checkMutation(req, auth, baseUrl);
      requireAuth(auth, ['seller']);
      const body = await readJSON(req);
      const bio = safeText(body.bio, '开发者介绍', 1000, 20);
      const website = safeText(body.website ?? '', '开发者网站', 200);
      if (website && (!/^https:\/\/[a-z0-9.-]+(?::443)?(?:\/[a-z0-9._~%!$&'()*+,;=:@\/-]*)?$/i.test(website) || website.includes('..') || website.includes('@'))) {
        fail(400, '网站必须是公开可访问的 HTTPS 地址');
      }
      const nextStatus = auth.seller_status === 'rejected' ? 'pending' : auth.seller_status;
      db.prepare("UPDATE users SET seller_bio=?,seller_website=?,seller_status=? WHERE id=?")
        .run(bio, website, nextStatus, auth.id);
      return json(res, 200, { ok:true, seller_status:nextStatus });
    }

    if (pathname === '/api/seller/overview' && method === 'GET') {
      requireAuth(auth, ['seller']);
      const profile = db.prepare('SELECT id,name,email,seller_status,seller_bio,seller_website,seller_review_note,seller_reviewed_at FROM users WHERE id=?').get(auth.id);
      const settlements = db.prepare('SELECT id,amount_minor,currency,method,external_reference,note,created_at FROM manual_settlements WHERE seller_id=? ORDER BY created_at DESC LIMIT 100').all(auth.id);
      const balance = sellerBalance(db, auth.id);
      const products = db.prepare('SELECT * FROM products WHERE seller_id=? AND is_demo=0 ORDER BY updated_at DESC').all(auth.id);
      const orders = db.prepare("SELECT o.id,o.product_name,o.amount_minor,o.currency,o.platform_fee_minor,o.seller_due_minor,o.refunded_minor,o.status,o.paid_at,o.created_at FROM orders o WHERE o.seller_id=? AND o.status IN ('paid','free') ORDER BY o.created_at DESC LIMIT 50").all(auth.id);
      return json(res, 200, {
        profile, settlements, products: products.map(sellerProduct), orders,
        stats: {
          published: products.filter(p => p.status === 'published').length,
          pending: products.filter(p => p.status === 'pending').length,
          sold: orders.filter(o => o.status === 'paid').length,
          gross_minor: summaryNumber(db, "SELECT COALESCE(SUM(amount_minor),0) AS n FROM orders WHERE seller_id=? AND status='paid'", [auth.id]),
          ...balance
        }
      });
    }

    if (pathname === '/api/seller/products' && method === 'POST') {
      checkMutation(req, auth, baseUrl);
      requireAuth(auth, ['seller']);
      if (summaryNumber(db, 'SELECT COUNT(*) AS n FROM products WHERE seller_id=?', [auth.id]) >= maxSellerListings) fail(429, '每位开发者最多可管理 100 款软件，请联系管理员扩容');
      const body = await readJSON(req);
      const p = validateProduct(body, currency);
      const id = uid('app_');
      const now = new Date().toISOString();
      db.prepare("INSERT INTO products (id,seller_id,name,tagline,description,category,platforms,version,price_minor,currency,icon,accent,status,scan_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'draft','missing',?,?)")
        .run(id, auth.id, p.name, p.tagline, p.description, p.category, p.platforms, p.version, p.price, currency, p.icon, p.accent, now, now);
      return json(res, 201, { id, status: 'draft' });
    }

    const sellerProductPath = pathname.match(/^\/api\/seller\/products\/([a-zA-Z0-9_-]+)$/);
    if (sellerProductPath && method === 'PATCH') {
      checkMutation(req, auth, baseUrl);
      requireAuth(auth, ['seller']);
      const prior = requireSellerProduct(db, auth, sellerProductPath[1]);
      checkEditState(prior);
      const body = await readJSON(req);
      const p = validateProduct(body, currency);
      db.prepare("UPDATE products SET name=?,tagline=?,description=?,category=?,platforms=?,version=?,price_minor=?,icon=?,accent=?,status='draft',review_note='',updated_at=? WHERE id=?")
        .run(p.name, p.tagline, p.description, p.category, p.platforms, p.version, p.price, p.icon, p.accent, new Date().toISOString(), prior.id);
      return json(res, 200, { ok: true });
    }

    const sellerFilePath = pathname.match(/^\/api\/seller\/products\/([a-zA-Z0-9_-]+)\/file$/);
    if (sellerFilePath && method === 'PUT') {
      checkMutation(req, auth, baseUrl);
      requireAuth(auth, ['seller']);
      rateLimit(req, 'upload', 40, 60 * 60 * 1000);
      const product = requireSellerProduct(db, auth, sellerFilePath[1]);
      checkEditState(product);
      const filename = safeFilename(url.searchParams.get('filename'));
      const uploaded = await savePackage(req, dataDir, filename);
      let scanResult;
      try {
        scanResult = await scanner(path.join(dataDir,'uploads',uploaded.key), {enabled:clamavEnabled,command:clamavCommand});
        if (!['quarantined','scan_passed','scan_failed','scan_error'].includes(scanResult?.status)) throw new Error('unknown scanner result');
      } catch {
        scanResult = {status:'scan_error', detail:'扫描无法完成，禁止自动发布'};
      }
      const scanTime = new Date().toISOString();
      try {
        withTransaction(db, () => {
          const current = requireSellerProduct(db, auth, product.id);
          checkEditState(current);
          if (current.file_key !== product.file_key) fail(409, '商品文件正在被其他上传任务修改，请重试');
          const used = summaryNumber(db, 'SELECT COALESCE(SUM(file_size),0) AS n FROM products WHERE seller_id=?', [auth.id]);
          if (used - (current.file_size || 0) + uploaded.size > maxSellerStorageBytes) fail(413, '每个开发者的软件包总量不能超过 500 MiB');
          db.prepare("UPDATE products SET file_key=?,file_name=?,file_size=?,file_sha256=?,scan_status=?,scan_detail=?,scanned_at=?,status='draft',review_note='',updated_at=? WHERE id=?")
            .run(uploaded.key,filename,uploaded.size,uploaded.sha256,scanResult.status,String(scanResult.detail || '').slice(0,400),scanTime,scanTime,product.id);
        });
      } catch (error) {
        try { unlinkSync(path.join(dataDir, 'uploads', uploaded.key)); } catch {}
        throw error;
      }
      if (product.file_key) {
        try { unlinkSync(path.join(dataDir, 'uploads', product.file_key)); } catch {}
      }
      return json(res, 200, { file_name:filename, bytes:uploaded.size, sha256:uploaded.sha256, scan_status:scanResult.status, scan_detail:scanResult.detail });
    }

    const sellerSubmit = pathname.match(/^\/api\/seller\/products\/([a-zA-Z0-9_-]+)\/submit$/);
    if (sellerSubmit && method === 'POST') {
      checkMutation(req, auth, baseUrl);
      requireAuth(auth, ['seller']);
      const product = requireSellerProduct(db, auth, sellerSubmit[1]);
      checkEditState(product);
      if (auth.seller_status !== 'approved') fail(403, '开发者尚未通过平台审核：请先填写开发者资料并等待管理员批准');
      if (!product.file_key || !product.file_size || !['quarantined','scan_passed'].includes(product.scan_status)) fail(409, '请先上传软件包；扫描失败或异常的软件不能提交');
      if (clamavEnabled && product.scan_status !== 'scan_passed') fail(409, '已开启 ClamAV，只有通过扫描的文件才允许提交');
      db.prepare("UPDATE products SET status='pending',updated_at=? WHERE id=?").run(new Date().toISOString(), product.id);
      return json(res, 200, { ok: true, status: 'pending' });
    }

    if (pathname === '/api/admin/overview' && method === 'GET') {
      requireAuth(auth, ['admin']);
      const products = db.prepare("SELECT p.*,u.name AS seller_name FROM products p JOIN users u ON p.seller_id=u.id WHERE p.is_demo=0 ORDER BY CASE WHEN p.status='pending' THEN 0 ELSE 1 END,p.updated_at DESC LIMIT 150").all();
      const orders = db.prepare("SELECT o.*,u.email AS buyer_email,s.name AS seller_name FROM orders o JOIN users u ON o.buyer_id=u.id JOIN users s ON o.seller_id=s.id ORDER BY o.created_at DESC LIMIT 100").all();
      const sellers = db.prepare("SELECT id,email,name,seller_status,seller_bio,seller_website,seller_review_note,created_at FROM users WHERE role='seller' AND id!='softcove-demo-studio' ORDER BY CASE WHEN seller_status='pending' THEN 0 ELSE 1 END,created_at DESC LIMIT 150").all().map(row => ({...row, ...sellerBalance(db,row.id)}));
      const settlements = db.prepare("SELECT m.id,m.amount_minor,m.currency,m.method,m.external_reference,m.note,m.created_at,u.name AS seller_name FROM manual_settlements m JOIN users u ON u.id=m.seller_id ORDER BY m.created_at DESC LIMIT 100").all();
      return json(res, 200, {
        products:products.map(sellerProduct),orders,sellers,settlements,
        stats: {
          sellers: summaryNumber(db, "SELECT COUNT(*) AS n FROM users WHERE role='seller' AND id!='softcove-demo-studio'"),
          sellers_pending: summaryNumber(db, "SELECT COUNT(*) AS n FROM users WHERE role='seller' AND seller_status='pending'"),
          manual_settled_minor: summaryNumber(db, 'SELECT COALESCE(SUM(amount_minor),0) AS n FROM manual_settlements'),
          pending: summaryNumber(db, "SELECT COUNT(*) AS n FROM products WHERE status='pending'"),
          orders_paid: summaryNumber(db, "SELECT COUNT(*) AS n FROM orders WHERE status='paid'"),
          gross_minor: summaryNumber(db, "SELECT COALESCE(SUM(amount_minor),0) AS n FROM orders WHERE status='paid'"),
          fees_minor: summaryNumber(db, "SELECT COALESCE(SUM(platform_fee_minor),0) AS n FROM orders WHERE status='paid'")
        }
      });
    }

    const sellerReview = pathname.match(/^\/api\/admin\/sellers\/([a-zA-Z0-9_-]+)\/review$/);
    if (sellerReview && method === 'POST') {
      checkMutation(req, auth, baseUrl);
      requireAuth(auth, ['admin']);
      const body = await readJSON(req);
      const seller = db.prepare("SELECT * FROM users WHERE id=? AND role='seller' AND id!='softcove-demo-studio'").get(sellerReview[1]);
      if (!seller) fail(404, '开发者不存在');
      const decision = String(body.decision || '');
      if (!['approve','reject','suspend'].includes(decision)) fail(400, '审核操作无效');
      const note = safeText(body.note ?? '', '审核原因', 500, decision === 'approve' ? 0 : 5);
      if (decision === 'approve' && (!seller.seller_bio || seller.seller_bio.trim().length < 20 || body.reviewAcknowledged !== true)) fail(409, '须有完整开发者介绍并完成人工账号审核');
      if (decision === 'suspend' && seller.seller_status !== 'approved') fail(409, '仅已批准的开发者可被暂停');
      if (decision === 'reject' && seller.seller_status === 'approved') fail(409, '撤销已经批准的开发者请使用暂停操作');
      withTransaction(db, () => {
        const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'suspended';
        const now = new Date().toISOString();
        db.prepare('UPDATE users SET seller_status=?,seller_review_note=?,seller_reviewed_at=? WHERE id=?')
          .run(status,note,now,seller.id);
        db.prepare('INSERT INTO seller_review_log (id,seller_id,admin_id,decision,note,created_at) VALUES (?,?,?,?,?,?)')
          .run(uid('sreview_'),seller.id,auth.id,decision,note,now);
      });
      return json(res, 200, { ok:true,seller_status:decision==='approve'?'approved':decision==='reject'?'rejected':'suspended' });
    }

    if (pathname === '/api/admin/settlements' && method === 'POST') {
      checkMutation(req, auth, baseUrl);
      requireAuth(auth, ['admin']);
      const body = await readJSON(req);
      if (body.confirmedExternally !== true) fail(409, '只有确认外部转账真实完成后才能登记；接口不会发起任何付款');
      const sellerId = safeText(body.sellerId, '开发者账号', 100, 3);
      const methodName = String(body.method || '');
      if (!['bank_transfer','other'].includes(methodName)) fail(400, '结算方式无效');
      const reference = safeText(body.externalReference, '外部交易流水', 100, 6);
      if (!/^[A-Za-z0-9_.\-\/#]{6,100}$/.test(reference)) fail(400, '外部流水号只允许英文字母、数字、点、横线、下划线、斜线及井号');
      const note = safeText(body.note ?? '', '结算备注', 500);
      const amount = body.amount_minor;
      if (!Number.isSafeInteger(amount) || amount < 1) fail(400, '结算金额必须是正整数分');
      const id = withTransaction(db, () => {
        const seller = db.prepare("SELECT id FROM users WHERE id=? AND role='seller' AND id!='softcove-demo-studio'").get(sellerId);
        if (!seller) fail(404, '开发者不存在');
        if (db.prepare('SELECT id FROM manual_settlements WHERE external_reference=?').get(reference)) fail(409, '该外部流水已经登记，请勿重复结算');
        const balance = sellerBalance(db,sellerId);
        if (amount > balance.due_minor) fail(409, '结算金额超过当前账面待结算金额，禁止超额登记');
        const created = uid('settle_');
        db.prepare('INSERT INTO manual_settlements (id,seller_id,amount_minor,currency,method,external_reference,note,recorded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(created,sellerId,amount,currency,methodName,reference,note,auth.id,new Date().toISOString());
        return created;
      });
      return json(res, 201, {id, recorded:true, transferredByPlatform:false});
    }

    const adminReview = pathname.match(/^\/api\/admin\/products\/([a-zA-Z0-9_-]+)\/review$/);
    if (adminReview && method === 'POST') {
      checkMutation(req, auth, baseUrl);
      requireAuth(auth, ['admin']);
      const body = await readJSON(req);
      const product = db.prepare('SELECT * FROM products WHERE id=?').get(adminReview[1]);
      if (!product || product.is_demo) fail(404, '没有该商品');
      if (product.status !== 'pending') fail(409, '只有待审核商品可以审核');
      const decision = String(body.decision || '');
      if (!['approve', 'reject'].includes(decision)) fail(400, '审核操作不正确');
      const note = safeText(body.note ?? '', '审核意见', 500, decision === 'reject' ? 3 : 0);
      if (decision === 'approve' && (!product.file_key || body.scanConfirmed !== true || !['quarantined','scan_passed'].includes(product.scan_status))) fail(409, '必须完成安全复核；扫描报毒或故障的文件不能上架');
      if (decision === 'approve' && clamavEnabled && product.scan_status !== 'scan_passed') fail(409, 'ClamAV 开启时须先通过自动扫描');
      if (decision === 'approve' && db.prepare('SELECT seller_status FROM users WHERE id=?').get(product.seller_id)?.seller_status !== 'approved') fail(403, '开发者未通过平台审核');
      withTransaction(db, () => {
        const now = new Date().toISOString();
        db.prepare("UPDATE products SET status=?,scan_status=?,review_note=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?")
          .run(decision === 'approve' ? 'published' : 'rejected', decision === 'approve' ? 'manually_verified' : 'quarantined', note, auth.id, now, now, product.id);
        db.prepare('INSERT INTO moderation_log (id,product_id,admin_id,decision,note,scan_confirmed,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(uid('review_'), product.id, auth.id, decision, note, decision === 'approve' ? 1 : 0, now);
      });
      return json(res, 200, { ok: true, status: decision === 'approve' ? 'published' : 'rejected' });
    }

    // Emergency takedown: immediately remove a published build from both storefront and downloads.
    const adminTakedown = pathname.match(/^\/api\/admin\/products\/([a-zA-Z0-9_-]+)\/takedown$/);
    if (adminTakedown && method === 'POST') {
      checkMutation(req, auth, baseUrl);
      requireAuth(auth, ['admin']);
      const body = await readJSON(req);
      const note = safeText(body.reason, '下架原因', 500, 5);
      const product = db.prepare('SELECT * FROM products WHERE id=? AND is_demo=0').get(adminTakedown[1]);
      if (!product) fail(404, '软件不存在');
      if (product.status !== 'published') fail(409, '仅已上架软件允许紧急下架');
      withTransaction(db, () => {
        const now = new Date().toISOString();
        db.prepare("UPDATE products SET status='archived',scan_status='quarantined',review_note=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?")
          .run(note, auth.id, now, now, product.id);
        db.prepare('INSERT INTO moderation_log (id,product_id,admin_id,decision,note,scan_confirmed,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(uid('review_'), product.id, auth.id, 'takedown', note, 0, now);
      });
      return json(res, 200, { ok: true, status: 'archived', downloadsSuspended: true });
    }

    const adminFile = pathname.match(/^\/api\/admin\/products\/([a-zA-Z0-9_-]+)\/file$/);
    if (adminFile && method === 'GET') {
      requireAuth(auth, ['admin']);
      const product = db.prepare('SELECT * FROM products WHERE id=? AND is_demo=0').get(adminFile[1]);
      if (!product) fail(404, '商品不存在');
      return sendStoredPackage(res, dataDir, product);
    }

    if (pathname === '/api/orders' && method === 'POST') {
      checkMutation(req, auth, baseUrl);
      rateLimit(req, 'orders', 30, 60 * 60 * 1000);
      const body = await readJSON(req);
      const product = selectPublicProduct(db, String(body.productId || ''));
      if (!product || product.is_demo || product.scan_status !== 'manually_verified' || !product.file_key) fail(409, '当前软件尚未开放购买');
      if (product.seller_id === auth.id) fail(409, '无法购买自己的软件');
      if (db.prepare('SELECT id FROM entitlements WHERE buyer_id=? AND product_id=?').get(auth.id, product.id)) fail(409, '你已经拥有这款软件，请到软件库下载');

      if (product.price_minor === 0) {
        const order = withTransaction(db, () => {
          if (db.prepare('SELECT id FROM entitlements WHERE buyer_id=? AND product_id=?').get(auth.id, product.id)) fail(409, '你已经领取过此软件');
          const id = uid('order_');
          const now = new Date().toISOString();
          db.prepare("INSERT INTO orders (id,buyer_id,seller_id,product_id,product_name,amount_minor,currency,status,created_at,paid_at) VALUES (?,?,?,?,?,?,?,'free',?,?)")
            .run(id, auth.id, product.seller_id, product.id, product.name, 0, product.currency, now, now);
          db.prepare('INSERT INTO entitlements (id,buyer_id,product_id,order_id,created_at) VALUES (?,?,?,?,?)')
            .run(uid('ent_'), auth.id, product.id, id, now);
          return id;
        });
        return json(res, 201, { orderId: order, status: 'free', library: true });
      }

      if (!paymentConfigured) fail(503, '平台尚未启用正式支付，请联系管理员配置 Stripe');
      const orderId = uid('order_');
      const now = new Date().toISOString();
      db.prepare("INSERT INTO orders (id,buyer_id,seller_id,product_id,product_name,amount_minor,currency,status,created_at) VALUES (?,?,?,?,?,?,?,'pending',?)")
        .run(orderId, auth.id, product.seller_id, product.id, product.name, product.price_minor, product.currency, now);
      try {
        const stripe = await createStripeCheckout({ stripeKey, baseUrl, buyer: auth, order: {
          id: orderId, product_name: product.name, amount_minor: product.price_minor, currency: product.currency
        } });
        db.prepare('UPDATE orders SET checkout_session_id=? WHERE id=?').run(stripe.id, orderId);
        return json(res, 201, { orderId, status: 'pending', checkoutUrl: stripe.url });
      } catch (error) {
        db.prepare("UPDATE orders SET status='failed' WHERE id=? AND status='pending'").run(orderId);
        console.error('Checkout setup error:', error.message);
        fail(502, '暂时无法创建支付订单，请稍后再试');
      }
    }

    if (pathname === '/api/my/library' && method === 'GET') {
      requireAuth(auth);
      const products = db.prepare("SELECT p.id,p.name,p.tagline,p.icon,p.accent,p.category,p.platforms,p.version,p.status,p.scan_status,p.file_name,p.file_size,p.is_demo,u.seller_status,e.created_at AS acquired_at,o.id AS order_id,o.status AS order_status FROM entitlements e JOIN products p ON e.product_id=p.id JOIN users u ON u.id=p.seller_id JOIN orders o ON e.order_id=o.id WHERE e.buyer_id=? ORDER BY e.created_at DESC").all(auth.id).map(p => ({ ...p, platforms: JSON.parse(p.platforms), downloadable: p.status === 'published' && p.scan_status === 'manually_verified' && p.seller_status === 'approved' && !!p.file_name }));
      const orders = db.prepare('SELECT id,product_id,product_name,amount_minor,currency,status,refunded_minor,created_at,paid_at FROM orders WHERE buyer_id=? ORDER BY created_at DESC LIMIT 100').all(auth.id);
      return json(res, 200, { products, orders });
    }

    const buyerDownload = pathname.match(/^\/api\/my\/library\/([a-zA-Z0-9_-]+)\/download$/);
    if (buyerDownload && method === 'GET') {
      requireAuth(auth);
      const product = db.prepare("SELECT p.* FROM entitlements e JOIN products p ON p.id=e.product_id JOIN users u ON u.id=p.seller_id WHERE e.buyer_id=? AND p.id=? AND p.status='published' AND p.scan_status='manually_verified' AND p.is_demo=0 AND u.seller_status='approved'").get(auth.id, buyerDownload[1]);
      if (!product) fail(403, '没有下载权限，或该版本已暂停分发');
      return sendStoredPackage(res, dataDir, product);
    }

    if (pathname === '/api/webhooks/stripe' && method === 'POST') {
      rateLimit(req, 'stripe-webhook', 180, 60 * 1000);
      if (!paymentConfigured) fail(503, '支付尚未配置');
      const raw = await readBody(req, 1024 * 1024);
      if (!getStripeSignature(raw, req.headers['stripe-signature'], webhookSecret)) fail(400, 'Webhook 签名无效');
      let event;
      try { event = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'Webhook 数据无效'); }
      if (!event.id || !event.type) fail(400, 'Webhook 事件字段缺失');
      if (['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'].includes(event.type)) {
        stripeSessionSucceeded(db, event, feeBps, stripeKey.startsWith('sk_live_'));
      } else if (event.type === 'charge.refunded') {
        stripeChargeRefunded(db, event, feeBps, stripeKey.startsWith('sk_live_'));
      }
      return json(res, 200, { received: true });
    }

    if (pathname.startsWith('/api/')) fail(404, '找不到这个接口');
    if (method !== 'GET' && method !== 'HEAD') fail(405, '不支持此请求方法');
    const entry = staticFiles[pathname];
    if (!entry) fail(404, '文件不存在');
    const target = path.join(projectDir, 'public', entry[0]);
    if (!existsSync(target)) fail(404, '页面资源不存在');
    const body = readFileSync(target);
    res.writeHead(200, { 'Content-Type': entry[1], 'Content-Length': body.length, 'Cache-Control': entry[0] === 'index.html' ? 'no-store' : 'public, max-age=300' });
    if (method === 'HEAD') res.end(); else res.end(body);
  }

  const server = http.createServer((req, res) => {
    dispatch(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('SoftCove server error:', error);
      json(res, status, { error: status === 500 ? '服务器暂时无法处理请求' : error.message });
    });
  });
  return { server, db, config };
}

function loadDotEnv() {
  const filename = path.join(projectDir, '.env');
  if (!existsSync(filename)) return;
  for (const line of readFileSync(filename, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotEnv();
  const port = Number(process.env.PORT || 3100);
  const { server } = createApp();
  server.listen(port, '0.0.0.0', () => console.log('SoftCove running on http://localhost:' + port));
}
