import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// Two small, real ZIP files containing only a README.txt with their version.
const initialPackage = Buffer.from('UEsDBBQAAAAAAAAAIQBrR6T9QQAAAEEAAAAKAAAAUkVBRE1FLnR4dFNvZnRDb3ZlIGFjY2VwdGFuY2UgZml4dHVyZSwgdmVyc2lvbiAxLjAuMC4gTm8gZXhlY3V0YWJsZSBmaWxlcy4KUEsBAhQAFAAAAAAAAAAhAGtHpP1BAAAAQQAAAAoAAAAAAAAAAAAAAIABAAAAAFJFQURNRS50eHRQSwUGAAAAAAEAAQA4AAAAaQAAAAAA', 'base64');
const updatePackage = Buffer.from('UEsDBBQAAAAAAAAAIQD84bkaQQAAAEEAAAAKAAAAUkVBRE1FLnR4dFNvZnRDb3ZlIGFjY2VwdGFuY2UgZml4dHVyZSwgdmVyc2lvbiAxLjEuMC4gTm8gZXhlY3V0YWJsZSBmaWxlcy4KUEsBAhQAFAAAAAAAAAAhAPzhuRpBAAAAQQAAAAoAAAAAAAAAAAAAAIABAAAAAFJFQURNRS50eHRQSwUGAAAAAAEAAQA4AAAAaQAAAAAA', 'base64');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function siteOrigin(value) {
  const url = new URL(value);
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback))) {
    throw new Error('请使用 HTTPS 站点地址或本机 HTTP 回环地址');
  }
  return url.origin;
}

export function createDemoClient(address, canonicalAddress = address) {
  const root = siteOrigin(address);
  const origin = siteOrigin(canonicalAddress);
  return {
    root,
    origin,
    async request(route, { method = 'GET', body, auth, binary = false, expected = 200 } = {}) {
      const headers = {};
      if (method !== 'GET') headers.Origin = origin;
      if (body !== undefined) headers['Content-Type'] = binary ? 'application/octet-stream' : 'application/json';
      if (auth) {
        headers.Cookie = auth.cookie;
        headers['X-CSRF-Token'] = auth.csrf;
      }
      const res = await fetch(root + route, {
        method, headers, body: body === undefined || binary ? body : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(20000)
      });
      assert.equal(res.status, expected, `${method} ${route}（实际 HTTP ${res.status}，预期 ${expected}）`);
      const contentType = res.headers.get('content-type') || '';
      const data = contentType.startsWith('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
      const setCookie = res.headers.get('set-cookie');
      if (setCookie && root.startsWith('https://')) assert.match(setCookie, /; Secure(?:;|$)/i, 'HTTPS 登录应使用 Secure Cookie');
      return { data, cookie: setCookie?.split(';')[0], csrf: data.csrf };
    }
  };
}

export async function beginDemoVerification(client, credentials) {
  const api = client.request;
  const health = (await api('/api/health')).data;
  assert.equal(health.ok, true, '站点健康检查失败');
  const config = (await api('/api/me')).data.config;
  assert.ok(config?.demoCheckout === true && config.paymentConfigured === false, '站点必须启用演示交易并关闭支付渠道');

  const admin = await api('/api/auth/login', { method: 'POST', body: credentials });
  assert.equal(admin.data.user.role, 'admin', '验收需要管理员账号');
  const before = (await api('/api/admin/overview', { auth: admin })).data;
  assert.equal(before.deployment.paymentMode, 'demo');
  assert.equal(before.deployment.baseUrl, client.origin, '验收地址应和 PUBLIC_BASE_URL 一致');

  const label = randomBytes(6).toString('hex');
  const account = role => ({ email: `acceptance-${label}-${role}@softcove.invalid`, password: randomBytes(24).toString('hex') });
  const sellerCredentials = account('seller');
  const buyerCredentials = account('buyer');
  const seller = await api('/api/auth/register', {
    method: 'POST', body: { ...sellerCredentials, name: 'SoftCove 验收开发者', role: 'seller' }, expected: 201
  });
  const buyer = await api('/api/auth/register', {
    method: 'POST', body: { ...buyerCredentials, name: 'SoftCove 验收买家', role: 'buyer' }, expected: 201
  });
  await api('/api/seller/profile', {
    method: 'PUT', auth: seller, body: { bio: 'SoftCove 自动验收使用的测试开发者。安装包只包含用于核对版本的文本文件。', website: '' }
  });
  await api('/api/admin/sellers/' + seller.data.user.id + '/review', {
    method: 'POST', auth: admin, body: { decision: 'approve', reviewAcknowledged: true }
  });
  const product = (await api('/api/seller/products', {
    method: 'POST', auth: seller, expected: 201,
    body: {
      name: 'SoftCove 演示验收 ' + label, tagline: 'ZIP 内只有说明文档', description: '用于验证演示下单、软件交付和版本更新，压缩包只有 README.txt。',
      category: '开发工具', platforms: ['Windows', 'macOS', 'Linux'], price_minor: 9900, version: '1.0.0'
    }
  })).data;
  const id = product.id;
  const sellerPath = '/api/seller/products/' + id;
  const adminPath = '/api/admin/products/' + id;
  const productPath = '/api/products/' + id;
  const download = '/api/my/library/' + id + '/download';
  await api(sellerPath + '/file?filename=softcove-demo-1.0.0.zip', { method: 'PUT', auth: seller, body: initialPackage, binary: true });
  await api(sellerPath + '/submit', { method: 'POST', auth: seller });
  await api(productPath, { expected: 404 });
  assert.deepEqual((await api(adminPath + '/file', { auth: admin })).data, initialPackage);
  await api(adminPath + '/review', {
    method: 'POST', auth: admin, body: { decision: 'approve', scanConfirmed: true, note: '验收 ZIP 文件与仅含说明文档的内置样本一致' }
  });
  assert.equal((await api(productPath)).data.product.version, '1.0.0');

  await api(download, { auth: buyer, expected: 403 });
  const order = (await api('/api/orders', { method: 'POST', auth: buyer, body: { productId: id }, expected: 201 })).data;
  assert.equal(order.demoCheckout, true);
  assert.equal(order.status, 'pending');
  assert.equal(order.checkoutUrl, undefined);
  await api(download, { auth: buyer, expected: 403 });
  const payment = (await api('/api/orders/' + order.orderId + '/demo-complete', { method: 'POST', auth: buyer, body: {} })).data;
  assert.equal(payment.simulated, true);
  assert.deepEqual((await api(download, { auth: buyer })).data, initialPackage);
  await api(download, { expected: 401 });

  const update = (await api(sellerPath + '/update', {
    method: 'PUT', auth: seller, expected: 201, body: { version: '1.1.0', releaseNotes: '更新验收说明文档。' }
  })).data;
  const updatePath = '/api/seller/updates/' + update.id;
  await api(updatePath + '/file?filename=softcove-demo-1.1.0.zip', { method: 'PUT', auth: seller, body: updatePackage, binary: true });
  await api(updatePath + '/submit', { method: 'POST', auth: seller });
  assert.equal((await api(productPath)).data.product.version, '1.0.0');
  assert.deepEqual((await api(download, { auth: buyer })).data, initialPackage);

  return { health, admin, buyer, buyerCredentials, productId: id, productPath, download, updateId: update.id, orderId: order.orderId };
}

export async function finishDemoVerification(client, run, { admin = run.admin, buyer = run.buyer } = {}) {
  const api = client.request;
  const overview = (await api('/api/admin/overview', { auth: admin })).data;
  const update = overview.updates.find(item => item.id === run.updateId);
  assert.ok(update?.submission_id, '管理员审核队列缺少本轮提交');
  const reviewPath = '/api/admin/updates/' + run.updateId;
  assert.deepEqual((await api(reviewPath + '/file?submission=' + update.submission_id, { auth: admin })).data, updatePackage);
  await api(reviewPath + '/review', {
    method: 'POST', auth: admin,
    body: { decision: 'approve', submissionId: update.submission_id, scanConfirmed: true, note: '验收 ZIP 文件与新版内置样本一致' }
  });
  const product = (await api(run.productPath, { auth: buyer })).data.product;
  assert.equal(product.version, '1.1.0');
  assert.equal(product.has_access, true);
  assert.equal(product.release_notes, '更新验收说明文档。');
  assert.deepEqual((await api(run.download, { auth: buyer })).data, updatePackage);
  const library = (await api('/api/my/library', { auth: buyer })).data;
  assert.deepEqual(library.orders.map(order => order.id), [run.orderId]);
  assert.equal(library.orders[0].payment_provider, 'demo');
  assert.equal(library.orders[0].status, 'paid');
  const order = (await api('/api/admin/overview', { auth: admin })).data.orders.find(item => item.id === run.orderId);
  assert.ok(order, '后台缺少本轮演示订单');
  assert.equal(order.platform_fee_minor, 0);
  assert.equal(order.seller_due_minor, 0);
  return {
    site: client.origin, version: run.health.version, mode: 'demo', productId: run.productId, orderId: run.orderId,
    packages: [{ version: '1.0.0', sha256: digest(initialPackage) }, { version: '1.1.0', sha256: digest(updatePackage) }]
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('用法：node scripts/verify-demo.mjs <站点地址>，从 stdin 依次读取管理员邮箱和密码');
    const client = createDemoClient(process.argv[2]);
    const [email, password] = readFileSync(0, 'utf8').split(/\r?\n/);
    if (!email?.trim() || !password) throw new Error('stdin 需要两行，依次是管理员邮箱和密码');
    const run = await beginDemoVerification(client, { email, password });
    const report = await finishDemoVerification(client, run);
    await Promise.all([run.admin, run.buyer].map(auth => client.request('/api/auth/logout', { method: 'POST', auth })));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error('演示验收失败：' + error.message);
    process.exitCode = 1;
  }
}
