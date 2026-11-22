// Runs against the built production image and isolated disposable volumes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { projectDir } from '../src/config.mjs';

const temp = mkdtempSync(path.join(tmpdir(), 'softcove-docker-'));
const project = 'softcove-test-' + randomBytes(4).toString('hex');
const recoveredProject = project + '-restore';
const envFile = path.join(temp, '.env');
writeFileSync(envFile, 'PUBLIC_BASE_URL=http://localhost:3100\nENABLE_DEMO_CATALOG=0\nDEMO_CHECKOUT_ENABLED=1\nSTRIPE_SECRET_KEY=\nSTRIPE_WEBHOOK_SECRET=\n');
const env = { ...process.env, SOFTCOVE_ENV_FILE: envFile, SOFTCOVE_HTTP_PORT: '0' };
const compose = name => ['compose', '-p', name, '--env-file', envFile, '-f', path.join(projectDir, 'compose.yaml')];
function docker(args, input, verbose = false) {
  const result = spawnSync('docker', args, { cwd: projectDir, env, input, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  if (verbose) process.stdout.write(result.stdout || '');
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
const call = (args, input, verbose) => docker([...compose(project), ...args], input, verbose);
const password = randomBytes(20).toString('hex');
let root;
async function api(route, { method = 'GET', body, auth, binary = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = binary ? 'application/octet-stream' : 'application/json';
  if (auth) { headers.Cookie = auth.cookie; headers['X-CSRF-Token'] = auth.csrf; }
  const res = await fetch(root + route, { method, headers, body: body === undefined ? undefined : binary ? body : JSON.stringify(body) });
  const payload = res.headers.get('content-type')?.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  assert.ok(res.ok, `${method} ${route}: ${res.status} ${JSON.stringify(payload)}`);
  return { data: payload, cookie: res.headers.get('set-cookie')?.split(';')[0], csrf: payload.csrf };
}
try {
  call(['build', 'softcove'], undefined, true);
  call(['up', '-d', '--wait', '--wait-timeout', '90']);
  root = 'http://' + call(['port', 'softcove', '3100']);
  assert.equal((await api('/api/health')).data.ok, true);
  assert.equal((await api('/api/products')).data.count, 0);
  call(['exec', '-T', 'softcove', 'node', 'scripts/create-admin.mjs', '--stdin', '--if-missing'], `admin@test.example\n${password}\n测试管理员\n`);
  const admin = await api('/api/auth/login', { method: 'POST', body: { email: 'admin@test.example', password } });
  const seller = await api('/api/auth/register', { method: 'POST', body: { email: 'seller@test.example', password, name: '测试开发者', role: 'seller' } });
  const buyer = await api('/api/auth/register', { method: 'POST', body: { email: 'buyer@test.example', password, name: '测试买家', role: 'buyer' } });
  await api('/api/seller/profile', { method: 'PUT', auth: seller, body: { bio: '这是一家用于自动化验收的软件开发工作室，负责维护自己的安装包。', website: '' } });
  await api('/api/admin/sellers/' + seller.data.user.id + '/review', { method: 'POST', auth: admin, body: { decision: 'approve', reviewAcknowledged: true } });
  const product = await api('/api/seller/products', { method: 'POST', auth: seller, body: { name: 'Docker 验收软件', tagline: '容器交付验收', description: '用于验证容器内上传、审核、授权、下载和备份恢复的测试软件包。', category: '开发工具', platforms: ['Windows'], price_minor: 9900, version: '1.0.0' } });
  const id = product.data.id;
  const fixture = Buffer.from('softcove smoke test installation package');
  await api('/api/seller/products/' + id + '/file?filename=fixture.zip', { method: 'PUT', auth: seller, body: fixture, binary: true });
  await api('/api/seller/products/' + id + '/submit', { method: 'POST', auth: seller, body: {} });
  await api('/api/admin/products/' + id + '/review', { method: 'POST', auth: admin, body: { decision: 'approve', scanConfirmed: true, note: '仅为自动化测试夹具，非公开软件' } });
  const order = await api('/api/orders', { method: 'POST', auth: buyer, body: { productId: id } });
  assert.equal(order.data.demoCheckout, true);
  assert.equal((await api('/api/my/library', {auth:buyer})).data.products.length, 0);
  await api('/api/orders/' + order.data.orderId + '/demo-complete', {method:'POST',auth:buyer,body:{}});
  assert.equal((await api('/api/admin/overview', {auth:admin})).data.stats.gross_minor, 0);
  const library = (await api('/api/my/library', { auth: buyer })).data;
  const downloadRoute = '/api/my/library/' + library.products[0].id + '/download';
  assert.deepEqual((await api(downloadRoute, { auth: buyer })).data, fixture);
  const update = (await api('/api/seller/products/' + id + '/update', {
    method: 'PUT', auth: seller, body: { version: '1.1.0', releaseNotes: '验证在售软件更新和恢复。' }
  })).data;
  const updatedFixture = Buffer.from('softcove smoke test version 1.1.0');
  const updateRoute = '/api/seller/updates/' + update.id;
  await api(updateRoute + '/file?filename=update.zip', { method: 'PUT', auth: seller, body: updatedFixture, binary: true });
  await api(updateRoute + '/submit', { method: 'POST', auth: seller });
  call(['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90']);
  root = 'http://' + call(['port', 'softcove', '3100']);
  assert.deepEqual((await api(downloadRoute, { auth: buyer })).data, fixture);
  const backups = path.join(temp, 'backups');
  mkdirSync(backups);
  call(['stop', 'softcove']);
  call(['run', '--rm', '--no-deps', '-T', '--user', '0:0', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '-v', backups + ':/backups', 'softcove', 'node', 'scripts/backup.mjs', 'create', '/backups/snapshot']);
  const recovery = (args, input) => docker([...compose(recoveredProject), ...args], input);
  // Reuse the exact tested image under the recovery project's default image name.
  docker(['tag', project + '-softcove', recoveredProject + '-softcove']);
  recovery(['run', '--rm', '--no-deps', '-T', '--user', '0:0', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '-v', path.join(backups, 'snapshot') + ':/backup:ro', 'softcove', 'sh', '-c', 'node scripts/backup.mjs restore /backup && chown -R node:node /app/data']);
  recovery(['up', '-d', '--wait', '--wait-timeout', '90']);
  root = 'http://' + recovery(['port', 'softcove', '3100']);
  assert.equal((await api('/api/me', { auth: buyer })).data.user, null);
  const restoredBuyer = await api('/api/auth/login', { method: 'POST', body: { email: 'buyer@test.example', password } });
  assert.deepEqual((await api(downloadRoute, { auth: restoredBuyer })).data, fixture);
  const restoredAdmin = await api('/api/auth/login', { method: 'POST', body: { email: 'admin@test.example', password } });
  const restoredUpdate = (await api('/api/admin/overview', { auth: restoredAdmin })).data.updates[0];
  const reviewRoute = '/api/admin/updates/' + restoredUpdate.id;
  const submissionId = restoredUpdate.submission_id;
  assert.deepEqual((await api(reviewRoute + '/file?submission=' + submissionId, { auth: restoredAdmin })).data, updatedFixture);
  await api(reviewRoute + '/review', { method: 'POST', auth: restoredAdmin, body: { decision: 'approve', submissionId, scanConfirmed: true } });
  assert.deepEqual((await api(downloadRoute, { auth: restoredBuyer })).data, updatedFixture);
  assert.equal((await api('/api/my/library', { auth: restoredBuyer })).data.orders[0].id, order.data.orderId);
  console.log('Docker 验收通过：模拟购买 → 送审新版 → 重建和恢复 → 审核新版 → 原订单授权下载更新。');
} finally {
  for (const name of [project, recoveredProject]) {
    spawnSync('docker', [...compose(name), 'down', '-v', '--remove-orphans', '--rmi', 'local'], { cwd: projectDir, env, encoding: 'utf8', timeout: 60000 });
  }
  // On Linux, tool-container backups belong to root; use a temporary helper to
  // remove only its own snapshot before deleting the host-created temp folder.
  const backupFolder = path.join(temp, 'backups');
  try { rmSync(temp, { recursive: true, force: true }); }
  catch {
    spawnSync('docker', ['run', '--rm', '-v', backupFolder + ':/backups', 'node:24-bookworm-slim', 'node', '-e', 'require("fs").rmSync("/backups/snapshot",{recursive:true,force:true})'], { encoding: 'utf8', timeout: 30000 });
    rmSync(temp, { recursive: true, force: true });
  }
}
