import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { hashPassword } from '../src/security.mjs';

async function setup(options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'softcove-test-'));
  const app = createApp({ dataDir: dir, baseUrl: 'http://localhost:3100', currency: 'CNY', feeBps: 1500, ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const root = 'http://127.0.0.1:' + app.server.address().port;
  return { ...app, dir, root, async close() { await new Promise(resolve => this.server.close(resolve)); this.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function request(t, route, { method = 'GET', body, cookie = '', csrf = '', headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (csrf) h['X-CSRF-Token'] = csrf;
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  const res = await fetch(t.root + route, { method, headers: h, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data: payload, res };
}

async function register(t, email, role) {
  const out = await request(t, '/api/auth/register', { method:'POST', body:{ email, name: '测试' + role, password: 'ReasonablyLongPass123!', role } });
  assert.equal(out.status, 201, JSON.stringify(out.data));
  const cookie = out.res.headers.get('set-cookie').split(';')[0];
  return { cookie, csrf: out.data.csrf, id: out.data.user.id, role: out.data.user.role };
}

function createProductInput(price = 0) {
  return { name:'Test Package',tagline:'Verified demo build',description:'This is a genuine test fixture for software marketplace integration.',category:'开发工具',platforms:['Windows','Linux'],version:'1.0.0',price_minor:price,icon:'⌘',accent:'#3589ee' };
}

async function approveSeller(t, seller, admin) {
  const profile = await request(t,'/api/seller/profile',{method:'PUT',body:{
    bio:'专注于开发实用软件的独立工作室，坚持安全维护、版本更新和正版授权。',
    website:'https://example.org'
  },cookie:seller.cookie,csrf:seller.csrf});
  assert.equal(profile.status,200,JSON.stringify(profile.data));
  const approved = await request(t,'/api/admin/sellers/' + seller.id + '/review',{
    method:'POST',body:{decision:'approve',note:'已完成人工资料检查',reviewAcknowledged:true},
    cookie:admin.cookie,csrf:admin.csrf
  });
  assert.equal(approved.status,200,JSON.stringify(approved.data));
}

async function publish(t, seller, admin, price = 0) {
  await approveSeller(t,seller,admin);
  const created = await request(t, '/api/seller/products', {method:'POST',body:createProductInput(price),cookie:seller.cookie,csrf:seller.csrf});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.id;
  const fixture = Buffer.from([0x50,0x4b,0x03,0x04,0x53,0x6f,0x66,0x74,0x43,0x6f,0x76,0x65]);
  const uploaded = await request(t, '/api/seller/products/' + id + '/file?filename=build.zip', {method:'PUT',body:fixture,cookie:seller.cookie,csrf:seller.csrf,headers:{ 'Content-Type':'application/octet-stream' },raw:true});
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  const submitted = await request(t, '/api/seller/products/' + id + '/submit', {method:'POST',body:{},cookie:seller.cookie,csrf:seller.csrf});
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.status, 'pending');
  const approved = await request(t, '/api/admin/products/' + id + '/review', {method:'POST',body:{decision:'approve',scanConfirmed:true,note:'隔离环境人工复核通过'},cookie:admin.cookie,csrf:admin.csrf});
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  return { id, fixture };
}

test('storefront assets and key security headers', async () => {
  const t = await setup();
  try {
    const home = await request(t, '/');
    assert.equal(home.status,200);
    assert.ok(home.data.toString().includes('SoftCove'));
    const csp = home.res.headers.get('content-security-policy');
    assert.ok(csp.includes("script-src 'self'"));
    assert.ok(csp.includes("style-src 'self' 'unsafe-inline'"));
    assert.ok(!csp.includes('unsafe-eval'));
    assert.equal(home.res.headers.get('x-content-type-options'),'nosniff');
    const script = await request(t,'/app.js');
    assert.equal(script.status,200);
    assert.ok(script.data.toString().includes('mobile-nav'));
    const styles = await request(t,'/styles.css');
    assert.equal(styles.status,200);
    assert.ok(styles.data.toString().includes('.app-card'));
    assert.equal((await request(t,'/unknown-static.html')).status,404);
  } finally { await t.close(); }
});

test('CLI administrator provisioning and session invalidation on reset', async () => {
  const t = await setup();
  try {
    const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const runCLI = password => spawnSync(process.execPath, ['scripts/create-admin.mjs'], {
      cwd,
      env: { ...process.env, ADMIN_EMAIL:'provision@test.example', ADMIN_PASSWORD:password, ADMIN_NAME:'平台管理员', DATA_DIR:t.dir },
      encoding:'utf8'
    });
    const initial = runCLI('OriginalAdminPassword12345!');
    assert.equal(initial.status,0, initial.stderr);
    const login = await request(t,'/api/auth/login',{
      method:'POST',body:{email:'provision@test.example',password:'OriginalAdminPassword12345!'}
    });
    assert.equal(login.status,200);
    const cookie = login.res.headers.get('set-cookie').split(';')[0];
    assert.equal((await request(t,'/api/me',{cookie})).data.user.role,'admin');
    const rotated = runCLI('RotatedAdminPassword12345!');
    assert.equal(rotated.status,0,rotated.stderr);
    assert.equal((await request(t,'/api/me',{cookie})).data.user,null);
    const stale = await request(t,'/api/auth/login',{
      method:'POST',body:{email:'provision@test.example',password:'OriginalAdminPassword12345!'}
    });
    assert.equal(stale.status,401);
    const fresh = await request(t,'/api/auth/login',{
      method:'POST',body:{email:'provision@test.example',password:'RotatedAdminPassword12345!'}
    });
    assert.equal(fresh.status,200);
  } finally { await t.close(); }
});

test('buyer/seller/admin ACL, quarantine workflow, free entitlement, protected download', async () => {
  const t = await setup();
  try {
    const list = await request(t, '/api/products');
    assert.equal(list.status, 200);
    assert.equal(list.data.products.length, 8);
    assert.ok(list.data.products.every(p => p.is_demo));
    const seller = await register(t, 'seller@test.example', 'seller');
    const buyer = await register(t, 'buyer@test.example', 'buyer');
    const other = await register(t, 'other@test.example', 'buyer');
    const attemptedAdmin = await register(t, 'fakeadmin@test.example', 'admin');
    assert.equal(attemptedAdmin.role, 'buyer');

    t.db.prepare('INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
      .run('admin-1','operator@test.example','Test Admin',hashPassword('StrongAdminPassword123!'),'admin',new Date().toISOString());
    const login = await request(t, '/api/auth/login', { method:'POST',body:{email:'operator@test.example',password:'StrongAdminPassword123!'} });
    assert.equal(login.status, 200);
    const admin = { cookie:login.res.headers.get('set-cookie').split(';')[0],csrf:login.data.csrf,id:login.data.user.id };
    await approveSeller(t,seller,admin);

    const noCsrf = await request(t,'/api/seller/products',{method:'POST',body:createProductInput(),cookie:seller.cookie});
    assert.equal(noCsrf.status,403);
    const notSeller = await request(t,'/api/seller/products',{method:'POST',body:createProductInput(),cookie:buyer.cookie,csrf:buyer.csrf});
    assert.equal(notSeller.status,403);
    const notAdmin = await request(t,'/api/admin/overview',{cookie:seller.cookie});
    assert.equal(notAdmin.status,403);

    const created = await request(t,'/api/seller/products',{method:'POST',body:createProductInput(),cookie:seller.cookie,csrf:seller.csrf});
    assert.equal(created.status,201);
    const id = created.data.id;
    let invisible = await request(t,'/api/products/' + id);
    assert.equal(invisible.status,404);
    const submitWithoutPackage = await request(t,'/api/seller/products/' + id + '/submit',{method:'POST',body:{},cookie:seller.cookie,csrf:seller.csrf});
    assert.equal(submitWithoutPackage.status,409);

    const unauthorizedUpload = await request(t,'/api/seller/products/' + id + '/file?filename=other.zip',{method:'PUT',raw:true,body:Buffer.from('test'),cookie:buyer.cookie,csrf:buyer.csrf,headers:{'Content-Type':'application/octet-stream'}});
    assert.equal(unauthorizedUpload.status,403);

    const fixture = Buffer.from([0x50,0x4b,0x03,0x04,0x54,0x45,0x53,0x54]);
    const uploaded = await request(t,'/api/seller/products/' + id + '/file?filename=code.zip',{method:'PUT',raw:true,body:fixture,cookie:seller.cookie,csrf:seller.csrf,headers:{'Content-Type':'application/octet-stream'}});
    assert.equal(uploaded.status,200,JSON.stringify(uploaded.data));
    assert.equal(uploaded.data.scan_status,'quarantined');
    const submit = await request(t,'/api/seller/products/' + id + '/submit',{method:'POST',body:{},cookie:seller.cookie,csrf:seller.csrf});
    assert.equal(submit.status,200);
    invisible = await request(t,'/api/products/' + id);
    assert.equal(invisible.status,404);
    const noScan = await request(t,'/api/admin/products/' + id + '/review',{method:'POST',body:{decision:'approve',scanConfirmed:false},cookie:admin.cookie,csrf:admin.csrf});
    assert.equal(noScan.status,409);
    const sellerApprove = await request(t,'/api/admin/products/' + id + '/review',{method:'POST',body:{decision:'approve',scanConfirmed:true},cookie:seller.cookie,csrf:seller.csrf});
    assert.equal(sellerApprove.status,403);
    const approve = await request(t,'/api/admin/products/' + id + '/review',{method:'POST',body:{decision:'approve',scanConfirmed:true},cookie:admin.cookie,csrf:admin.csrf});
    assert.equal(approve.status,200,JSON.stringify(approve.data));
    const publicProduct = await request(t,'/api/products/' + id);
    assert.equal(publicProduct.status,200);
    assert.equal(publicProduct.data.product.is_demo,false);
    assert.equal(publicProduct.data.product.has_access,false);

    const acquire = await request(t,'/api/orders',{method:'POST',body:{productId:id},cookie:buyer.cookie,csrf:buyer.csrf});
    assert.equal(acquire.status,201,JSON.stringify(acquire.data));
    assert.equal(acquire.data.status,'free');
    const dup = await request(t,'/api/orders',{method:'POST',body:{productId:id},cookie:buyer.cookie,csrf:buyer.csrf});
    assert.equal(dup.status,409);
    const noAccess = await request(t,'/api/my/library/' + id + '/download',{cookie:other.cookie});
    assert.equal(noAccess.status,403);
    const anonymous = await request(t,'/api/my/library/' + id + '/download');
    assert.equal(anonymous.status,401);
    const authorized = await request(t,'/api/my/library/' + id + '/download',{cookie:buyer.cookie});
    assert.equal(authorized.status,200);
    assert.deepEqual(authorized.data,fixture);
    assert.ok(authorized.res.headers.get('content-disposition').includes('attachment'));
    const library = await request(t,'/api/my/library',{cookie:buyer.cookie});
    assert.equal(library.data.products.length,1);
    assert.equal(library.data.orders[0].status,'free');
    assert.equal((await request(t,'/uploads/private.blob')).status,404);
    const unauthorizedTakedown = await request(t,'/api/admin/products/' + id + '/takedown',{method:'POST',cookie:buyer.cookie,csrf:buyer.csrf,body:{reason:'测试无权限操作'}});
    assert.equal(unauthorizedTakedown.status,403);
    const takenDown = await request(t,'/api/admin/products/' + id + '/takedown',{method:'POST',cookie:admin.cookie,csrf:admin.csrf,body:{reason:'隔离环境复检发现潜在安全风险'}});
    assert.equal(takenDown.status,200);
    assert.equal((await request(t,'/api/products/' + id)).status,404);
    assert.equal((await request(t,'/api/my/library/' + id + '/download',{cookie:buyer.cookie})).status,403);
    const libraryAfter = await request(t,'/api/my/library',{cookie:buyer.cookie});
    assert.equal(libraryAfter.data.products[0].downloadable,false);
    const sellerAfter = await request(t,'/api/seller/overview',{cookie:seller.cookie});
    assert.equal(sellerAfter.data.products[0].status,'archived');
  } finally { await t.close(); }
});

test('Stripe signature, amount/session verification, replay protection, commission and entitlement', async () => {
  const secret = 'whsec_softcove_test';
  const t = await setup({ stripeKey:'sk_test_not_a_real_key',webhookSecret:secret });
  try {
    const seller = await register(t, 'seller2@test.example','seller');
    const buyer = await register(t, 'buyer2@test.example','buyer');
    t.db.prepare('INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
      .run('admin-2','admin2@test.example','Test Admin',hashPassword('StrongAdminPassword123!'),'admin',new Date().toISOString());
    const login = await request(t,'/api/auth/login',{method:'POST',body:{email:'admin2@test.example',password:'StrongAdminPassword123!'}});
    const admin = { cookie:login.res.headers.get('set-cookie').split(';')[0],csrf:login.data.csrf };
    const {id} = await publish(t,seller,admin,9900);
    const orderId = 'test-stripe-order';
    const stripeSession = 'cs_test_authenticated_session';
    t.db.prepare("INSERT INTO orders (id,buyer_id,seller_id,product_id,product_name,amount_minor,currency,status,checkout_session_id,created_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)")
      .run(orderId,buyer.id,seller.id,id,'Test Package',9900,'CNY',stripeSession,new Date().toISOString());

    function webhook(eventId, amount, sigGood = true, sessionId = stripeSession, intent = 'pi_testintent', oid = orderId) {
      const event = { id:eventId, type:'checkout.session.completed',livemode:false,data:{object:{ id:sessionId,payment_status:'paid',payment_intent:intent,amount_total:amount,currency:'cny',metadata:{order_id:oid} }} };
      const raw = JSON.stringify(event);
      const timestamp = Math.floor(Date.now()/1000);
      const sig = createHmac('sha256',sigGood ? secret : 'invalid_secret').update(timestamp + '.' + raw).digest('hex');
      return request(t,'/api/webhooks/stripe',{method:'POST',raw:true,body:raw,headers:{'Content-Type':'application/json','Stripe-Signature':'t=' + timestamp + ',v1=' + sig}});
    }

    assert.equal((await webhook('evt_bad_signature',9900,false)).status,400);
    assert.equal((await webhook('evt_bad_amount',9800)).status,200);
    assert.equal((await request(t,'/api/my/library',{cookie:buyer.cookie})).data.products.length,0);
    assert.equal((await webhook('evt_bad_session',9900,true,'cs_other')).status,200);
    assert.equal((await request(t,'/api/my/library',{cookie:buyer.cookie})).data.products.length,0);
    assert.equal((await webhook('evt_valid',9900)).status,200);
    assert.equal((await webhook('evt_valid',9900)).status,200);
    const acquired = await request(t,'/api/my/library',{cookie:buyer.cookie});
    assert.equal(acquired.data.products.length,1);
    assert.equal(acquired.data.orders[0].status,'paid');
    const stored = t.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    assert.equal(stored.platform_fee_minor,1485);
    assert.equal(stored.seller_due_minor,8415);
    assert.equal(stored.payment_intent_id,'pi_testintent');
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM entitlements WHERE buyer_id=?').get(buyer.id).n,1);
    const fakeBrowserFulfillment = await request(t,'/api/orders/' + orderId + '/mark-paid',{method:'POST',cookie:buyer.cookie,csrf:buyer.csrf,body:{}});
    assert.equal(fakeBrowserFulfillment.status,404);

    // Fully or partially refunded charges change the ledger; full refunds revoke fulfillment.
    async function refund(eventId, amountRefunded, intent = 'pi_testintent', signed = true) {
      const event = { id:eventId, type:'charge.refunded',livemode:false,
        data:{object:{id:'ch_testcharge',payment_intent:intent,amount:9900,amount_refunded:amountRefunded,currency:'cny'}} };
      const raw = JSON.stringify(event);
      const stamp = Math.floor(Date.now()/1000);
      const sig = createHmac('sha256',signed ? secret : 'bad-key').update(stamp + '.' + raw).digest('hex');
      return request(t,'/api/webhooks/stripe',{method:'POST',raw:true,body:raw,headers:{'Content-Type':'application/json','Stripe-Signature':'t=' + stamp + ',v1=' + sig}});
    }
    assert.equal((await refund('evt_bad_refund',9900,'pi_testintent',false)).status,400);
    assert.equal((await refund('evt_partial',4000)).status,200);
    const partial = t.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    assert.equal(partial.status,'paid');
    assert.equal(partial.refunded_minor,4000);
    assert.equal(partial.platform_fee_minor,885);
    assert.equal(partial.seller_due_minor,5015);
    assert.equal((await request(t,'/api/my/library',{cookie:buyer.cookie})).data.products.length,1);
    assert.equal((await refund('evt_refunded',9900)).status,200);
    assert.equal((await refund('evt_refunded',9900)).status,200);
    const fullyRefunded = t.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    assert.equal(fullyRefunded.status,'refunded');
    assert.equal(fullyRefunded.refunded_minor,9900);
    assert.equal(fullyRefunded.seller_due_minor,0);
    assert.equal((await request(t,'/api/my/library',{cookie:buyer.cookie})).data.products.length,0);
    assert.equal((await request(t,'/api/my/library/' + id + '/download',{cookie:buyer.cookie})).status,403);

    // Stripe webhooks can arrive out of order: an early full refund must prevent entitlement minting.
    const earlyOrder = 'early-refund-order';
    const earlySession = 'cs_test_early_order';
    t.db.prepare("INSERT INTO orders (id,buyer_id,seller_id,product_id,product_name,amount_minor,currency,status,checkout_session_id,created_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)")
      .run(earlyOrder,buyer.id,seller.id,id,'Test Package',9900,'CNY',earlySession,new Date().toISOString());
    assert.equal((await refund('evt_early_refund',9900,'pi_early')).status,200);
    assert.equal((await webhook('evt_early_paid',9900,true,earlySession,'pi_early',earlyOrder)).status,200);
    assert.equal(t.db.prepare('SELECT status FROM orders WHERE id=?').get(earlyOrder).status,'refunded');
    assert.equal((await request(t,'/api/my/library',{cookie:buyer.cookie})).data.products.length,0);
  } finally { await t.close(); }
});


test('seller onboarding blocks publishing, suspension pauses buyer downloads', async () => {
  const t = await setup();
  try {
    const seller = await register(t,'onboarding@test.example','seller');
    const buyer = await register(t,'onboarding-buyer@test.example','buyer');
    assert.equal((await request(t,'/api/me',{cookie:seller.cookie})).data.user.seller_status,'pending');
    t.db.prepare('INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
      .run('seller-admin','seller-admin@test.example','运营',hashPassword('AdministratorPass123!'),'admin',new Date().toISOString());
    const login = await request(t,'/api/auth/login',{method:'POST',body:{email:'seller-admin@test.example',password:'AdministratorPass123!'}});
    const admin = {cookie:login.res.headers.get('set-cookie').split(';')[0],csrf:login.data.csrf};
    const create = await request(t,'/api/seller/products',{method:'POST',body:createProductInput(),cookie:seller.cookie,csrf:seller.csrf});
    assert.equal(create.status,201);
    const id = create.data.id;
    assert.equal((await request(t,'/api/seller/products/' + id + '/file?filename=hello.zip',{
      method:'PUT',body:Buffer.from('simple-fixture'),raw:true,cookie:seller.cookie,csrf:seller.csrf,headers:{'Content-Type':'application/octet-stream'}
    })).status,200);
    const blocked = await request(t,'/api/seller/products/' + id + '/submit',{
      method:'POST',body:{},cookie:seller.cookie,csrf:seller.csrf
    });
    assert.equal(blocked.status,403,'unapproved sellers cannot list products');
    assert.equal((await request(t,'/api/seller/profile',{
      method:'PUT',body:{bio:'short',website:''},cookie:seller.cookie,csrf:seller.csrf
    })).status,400);
    const profile = await request(t,'/api/seller/profile',{
      method:'PUT',body:{bio:'测试独立开发者工作室，专注于创作高质量的跨平台桌面软件和售后维护服务。',website:'https://example.org'},
      cookie:seller.cookie,csrf:seller.csrf
    });
    assert.equal(profile.status,200);
    const unacknowledged = await request(t,'/api/admin/sellers/' + seller.id + '/review',{
      method:'POST',body:{decision:'approve'},cookie:admin.cookie,csrf:admin.csrf
    });
    assert.equal(unacknowledged.status,409);
    const unauthorized = await request(t,'/api/admin/sellers/' + seller.id + '/review',{
      method:'POST',body:{decision:'approve',reviewAcknowledged:true},cookie:buyer.cookie,csrf:buyer.csrf
    });
    assert.equal(unauthorized.status,403);
    assert.equal((await request(t,'/api/admin/sellers/' + seller.id + '/review',{
      method:'POST',body:{decision:'approve',reviewAcknowledged:true},cookie:admin.cookie,csrf:admin.csrf
    })).status,200);
    assert.equal((await request(t,'/api/seller/products/' + id + '/submit',{
      method:'POST',body:{},cookie:seller.cookie,csrf:seller.csrf
    })).status,200);
    assert.equal((await request(t,'/api/admin/products/' + id + '/review',{
      method:'POST',body:{decision:'approve',scanConfirmed:true},cookie:admin.cookie,csrf:admin.csrf
    })).status,200);
    assert.equal((await request(t,'/api/orders',{
      method:'POST',body:{productId:id},cookie:buyer.cookie,csrf:buyer.csrf
    })).status,201);
    assert.equal((await request(t,'/api/my/library/' + id + '/download',{cookie:buyer.cookie})).status,200);
    assert.equal((await request(t,'/api/admin/sellers/' + seller.id + '/review',{
      method:'POST',body:{decision:'suspend',note:'风险回查需要暂停该开发者所有软件'},cookie:admin.cookie,csrf:admin.csrf
    })).status,200);
    assert.equal((await request(t,'/api/products/' + id)).status,404);
    assert.equal((await request(t,'/api/my/library/' + id + '/download',{cookie:buyer.cookie})).status,403);
    assert.equal((await request(t,'/api/admin/sellers/' + seller.id + '/review',{
      method:'POST',body:{decision:'approve',reviewAcknowledged:true},cookie:admin.cookie,csrf:admin.csrf
    })).status,200);
    assert.equal((await request(t,'/api/my/library/' + id + '/download',{cookie:buyer.cookie})).status,200);
  } finally { await t.close(); }
});

test('manual settlement ledger never transfers funds and prevents replay/overpay', async () => {
  const t = await setup();
  try {
    const seller = await register(t,'settlement@test.example','seller');
    const buyer = await register(t,'settlement-buyer@test.example','buyer');
    t.db.prepare('INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
      .run('settle-admin','settle-admin@test.example','运营',hashPassword('AdministratorPass123!'),'admin',new Date().toISOString());
    const login = await request(t,'/api/auth/login',{method:'POST',body:{email:'settle-admin@test.example',password:'AdministratorPass123!'}});
    const admin = {cookie:login.res.headers.get('set-cookie').split(';')[0],csrf:login.data.csrf};
    const {id} = await publish(t,seller,admin,10000);
    const orderId = 'manual-fixture-order';
    t.db.prepare("INSERT INTO orders (id,buyer_id,seller_id,product_id,product_name,amount_minor,currency,status,platform_fee_minor,seller_due_minor,created_at,paid_at) VALUES (?,?,?,?,?,? ,?,'paid',?,?,?,?)")
      .run(orderId,buyer.id,seller.id,id,'Test Package',10000,'CNY',1500,8500,new Date().toISOString(),new Date().toISOString());
    const call = (body,auth = admin) => request(t,'/api/admin/settlements',{method:'POST',body,cookie:auth.cookie,csrf:auth.csrf});
    const body = {sellerId:seller.id,amount_minor:3000,method:'bank_transfer',externalReference:'BANK-ABC-20261027',confirmedExternally:true};
    assert.equal((await call({...body,confirmedExternally:false})).status,409);
    assert.equal((await call(body,buyer)).status,403);
    const first = await call(body);
    assert.equal(first.status,201,JSON.stringify(first.data));
    assert.equal(first.data.transferredByPlatform,false);
    assert.equal((await call(body)).status,409,'duplicate external references must be blocked');
    assert.equal((await call({...body,amount_minor:9000,externalReference:'BANK-OTHER-0001'})).status,409);
    const overview = await request(t,'/api/seller/overview',{cookie:seller.cookie});
    assert.equal(overview.data.stats.earned_minor,8500);
    assert.equal(overview.data.stats.settled_minor,3000);
    assert.equal(overview.data.stats.due_minor,5500);
    assert.equal(overview.data.settlements.length,1);
    // A later Stripe refund would reduce booked earnings and could require overpayment reconciliation.
    t.db.prepare('UPDATE orders SET seller_due_minor=1000,platform_fee_minor=200,refunded_minor=8800 WHERE id=?').run(orderId);
    const adjusted = await request(t,'/api/seller/overview',{cookie:seller.cookie});
    assert.equal(adjusted.data.stats.due_minor,0);
    assert.equal(adjusted.data.stats.adjustment_minor,2000);
    assert.equal((await call({...body,amount_minor:100,externalReference:'BANK-OTHER-0002'})).status,409);
  } finally { await t.close(); }
});

test('optional ClamAV integration fails closed and still requires human approval', async () => {
  let status = 'scan_failed';
  const t = await setup({clamavEnabled:true,scanner:async() => ({status,detail:'自动扫描测试结果：' + status})});
  try {
    const seller = await register(t,'scan-test@test.example','seller');
    t.db.prepare('INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
      .run('scan-admin','scan-admin@test.example','运营',hashPassword('AdministratorPass123!'),'admin',new Date().toISOString());
    const login = await request(t,'/api/auth/login',{method:'POST',body:{email:'scan-admin@test.example',password:'AdministratorPass123!'}});
    const admin = {cookie:login.res.headers.get('set-cookie').split(';')[0],csrf:login.data.csrf};
    await approveSeller(t,seller,admin);
    const created = await request(t,'/api/seller/products',{method:'POST',body:createProductInput(),cookie:seller.cookie,csrf:seller.csrf});
    assert.equal(created.status,201);
    const id=created.data.id;
    const upload = () => request(t,'/api/seller/products/'+id+'/file?filename=scan.zip',{method:'PUT',
      raw:true,body:Buffer.from('test-scanning'),cookie:seller.cookie,csrf:seller.csrf,headers:{'Content-Type':'application/octet-stream'}});
    const infected = await upload();
    assert.equal(infected.status,200);
    assert.equal(infected.data.scan_status,'scan_failed');
    assert.equal((await request(t,'/api/seller/products/'+id+'/submit',{method:'POST',body:{},cookie:seller.cookie,csrf:seller.csrf})).status,409);
    status='scan_error';
    assert.equal((await upload()).data.scan_status,'scan_error');
    assert.equal((await request(t,'/api/seller/products/'+id+'/submit',{method:'POST',body:{},cookie:seller.cookie,csrf:seller.csrf})).status,409);
    status='scan_passed';
    assert.equal((await upload()).data.scan_status,'scan_passed');
    assert.equal((await request(t,'/api/seller/products/'+id+'/submit',{method:'POST',body:{},cookie:seller.cookie,csrf:seller.csrf})).status,200);
    assert.equal((await request(t,'/api/admin/products/'+id+'/review',{method:'POST',
      body:{decision:'approve',scanConfirmed:false},cookie:admin.cookie,csrf:admin.csrf})).status,409);
    assert.equal((await request(t,'/api/admin/products/'+id+'/review',{method:'POST',
      body:{decision:'approve',scanConfirmed:true},cookie:admin.cookie,csrf:admin.csrf})).status,200);
  } finally { await t.close(); }
});

test('a paid listing never becomes free without Stripe credentials', async () => {
  const t = await setup();
  try {
    const seller = await register(t,'seller3@test.example','seller');
    const buyer = await register(t,'buyer3@test.example','buyer');
    t.db.prepare('INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
      .run('admin-3','admin3@test.example','Test Admin',hashPassword('StrongAdminPassword123!'),'admin',new Date().toISOString());
    const login = await request(t,'/api/auth/login',{method:'POST',body:{email:'admin3@test.example',password:'StrongAdminPassword123!'}});
    const admin = { cookie:login.res.headers.get('set-cookie').split(';')[0],csrf:login.data.csrf };
    const {id} = await publish(t,seller,admin,1200);
    const blocked = await request(t,'/api/orders',{method:'POST',cookie:buyer.cookie,csrf:buyer.csrf,body:{productId:id}});
    assert.equal(blocked.status,503);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,0);
  } finally { await t.close(); }
});
