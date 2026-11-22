import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { loadConfig, projectDir } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { hashPassword, verifyPassword, createRateLimiter } from '../src/security.mjs';
import { createBackup, restoreBackup } from '../scripts/backup.mjs';
import { beginDemoVerification, createDemoClient } from '../scripts/verify-demo.mjs';

test('configuration rejects unsafe production origins and incomplete payment credentials', () => {
  for (const baseUrl of ['https://user:pass@example.com', 'https://example.com/path', 'https://example.com?x=1', 'javascript:alert(1)', 'https://example.com/#admin']) {
    assert.throws(() => loadConfig({ baseUrl }, {}));
  }
  assert.throws(() => loadConfig({ baseUrl: 'http://shop.example', nodeEnv: 'production' }, {}), /HTTPS/);
  assert.throws(() => loadConfig({}, { STRIPE_SECRET_KEY: 'sk_test_fake' }), /同时/);
  assert.throws(() => loadConfig({}, { TRUST_PROXY: 'yes' }), /TRUST_PROXY/);
  assert.throws(() => loadConfig({demoCheckout:true,stripeKey:'sk_test_fake',webhookSecret:'whsec_fake'}, {}), /同时启用/);
  assert.throws(() => loadConfig({}, { PORT: '0' }), /PORT/);
  const config = loadConfig({ baseUrl: 'https://shop.example/', demoCatalog: false }, {});
  assert.equal(config.baseUrl, 'https://shop.example');
  assert.equal(config.secureCookie, true);
  assert.equal(config.trustProxy, false);
});

test('controlled proxy separates visitors; direct mode ignores spoofed forwarding headers', () => {
  const request = ip => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': ip } });
  const direct = createRateLimiter();
  direct(request('192.0.2.1'), 'login', 1, 1000);
  assert.throws(() => direct(request('192.0.2.2'), 'login', 1, 1000), { status: 429 });
  const proxy = createRateLimiter({ trustProxy: true });
  proxy(request('192.0.2.1'), 'login', 1, 1000);
  proxy(request('192.0.2.2'), 'login', 1, 1000);
  assert.throws(() => proxy(request('192.0.2.1'), 'login', 1, 1000), { status: 429 });
  proxy(request('192.0.2.3, 192.0.2.4'), 'login', 1, 1000);
  assert.throws(() => proxy(request('invalid'), 'login', 1, 1000), { status: 429 });
});

test('production hides existing demos without deleting data; readiness is admin-only and omits secrets', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'softcove-deployment-'));
  const seeded = openDatabase(dir);
  seeded.close();
  const app = createApp({ dataDir: dir, baseUrl: 'https://shop.example', demoCatalog: false, stripeKey: 'sk_test_hidden_secret', webhookSecret: 'whsec_hidden_secret' });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const root = 'http://127.0.0.1:' + app.server.address().port;
  try {
    assert.equal((await (await fetch(root + '/api/products')).json()).count, 0);
    assert.equal((await fetch(root + '/api/products/softcove-demo-1')).status, 404);
    assert.equal((await fetch(root + '/api/sellers/softcove-demo-studio')).status, 404);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM products WHERE is_demo=1').get().n, 8);
    assert.equal((await fetch(root + '/api/admin/overview')).status, 401);
    await assert.rejects(
      beginDemoVerification(createDemoClient(root), { email: 'admin@test.example', password: 'UnusedDummyPassword!' }),
      /必须启用演示交易/
    );
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    app.db.prepare('INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
      .run('admin', 'admin@test.example', '管理员', hashPassword('AdminPasswordForTesting!'), 'admin', new Date().toISOString());
    const login = await fetch(root + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.example', password: 'AdminPasswordForTesting!' }) });
    assert.match(login.headers.get('set-cookie'), /; Secure/);
    const response = await fetch(root + '/api/admin/overview', { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(!body.includes('hidden_secret'));
    const deployment = JSON.parse(body).deployment;
    assert.equal(deployment.paymentMode, 'test');
    assert.equal(deployment.checks.find(x => x.id === 'payment').status, 'pending');
    assert.equal(deployment.checks.find(x => x.id === 'demo').status, 'complete');
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    app.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stdin administrator setup handles special characters, never prints passwords and is repeatable', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'softcove-admin-'));
  const password = 'Safe $pecial \' " # ` Password!';
  const env = { ...process.env, DATA_DIR: dir, ADMIN_PASSWORD: '' };
  const run = (args, input) => spawnSync(process.execPath, ['scripts/create-admin.mjs', ...args], { cwd: projectDir, env, input, encoding: 'utf8' });
  try {
    assert.equal(run(['--check']).status, 1);
    const result = run(['--stdin', '--if-missing'], `owner@test.example\n${password}\n店主管理员\n`);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!(result.stdout + result.stderr).includes(password));
    assert.equal(run(['--stdin', '--if-missing'], 'ignored@test.example\nChangedPassword1234!\n管理员\n').status, 0);
    assert.equal(run(['--check']).status, 0);
    const db = new DatabaseSync(path.join(dir, 'marketplace.db'));
    try {
      const user = db.prepare('SELECT * FROM users').get();
      assert.equal(user.email, 'owner@test.example');
      assert.ok(verifyPassword(password, user.password_hash));
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 0);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backup captures WAL and packages; restores entitlements, invalidates sessions and refuses overwrites or tampering', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'softcove-backup-'));
  const source = path.join(root, 'data');
  const backup = path.join(root, 'snapshot');
  const target = path.join(root, 'restored');
  const key = '11111111-1111-4111-8111-111111111111.blob';
  const bytes = Buffer.from('software installation fixture');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const db = openDatabase(source, { seedDemo: false });
  try {
    mkdirSync(path.join(source, 'uploads'));
    writeFileSync(path.join(source, 'uploads', key), bytes);
    db.exec("INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES ('seller','s@test.example','Seller','disabled','seller','2026-11-17'),('buyer','b@test.example','Buyer','disabled','buyer','2026-11-17')");
    db.prepare("INSERT INTO products (id,seller_id,name,category,file_key,file_sha256,created_at,updated_at) VALUES ('product','seller','Software','开发工具',?,?,'2026-11-17','2026-11-17')").run(key, sha);
    db.exec("INSERT INTO orders (id,buyer_id,seller_id,product_id,product_name,amount_minor,currency,status,created_at) VALUES ('order','buyer','seller','product','Software',0,'CNY','free','2026-11-17'); INSERT INTO entitlements VALUES ('ent','buyer','product','order','2026-11-17'); INSERT INTO sessions VALUES ('hash','buyer','csrf',9999999999999)");
    assert.throws(() => createBackup(source, path.join(source, 'backup')), /以外/);
    createBackup(source, backup);
    assert.throws(() => createBackup(source, backup), /覆盖/);
    restoreBackup(backup, target);
    assert.deepEqual(readFileSync(path.join(target, 'uploads', key)), bytes);
    const restored = new DatabaseSync(path.join(target, 'marketplace.db'));
    try {
      assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n, 1);
      assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    } finally { restored.close(); }
    assert.throws(() => restoreBackup(backup, source), /空数据目录/);
    writeFileSync(path.join(backup, 'uploads', key), 'tampered');
    const invalidTarget = path.join(root, 'invalid');
    mkdirSync(invalidTarget);
    assert.throws(() => restoreBackup(backup, invalidTarget), /校验/);
    assert.deepEqual(readdirSync(invalidTarget), []);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
