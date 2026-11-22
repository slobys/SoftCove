// Runs against the built production image and isolated disposable volumes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { projectDir } from '../src/config.mjs';
import { beginDemoVerification, createDemoClient, finishDemoVerification } from '../scripts/verify-demo.mjs';

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
const credentials = { email: 'admin@test.example', password };
const clientThrough = cli => createDemoClient('http://' + cli(['port', 'softcove', '3100']), 'http://localhost:3100');

try {
  call(['build', 'softcove'], undefined, true);
  call(['up', '-d', '--wait', '--wait-timeout', '90']);
  const initial = clientThrough(call);
  assert.equal((await initial.request('/api/products')).data.count, 0);
  call(['exec', '-T', 'softcove', 'node', 'scripts/create-admin.mjs', '--stdin', '--if-missing'], `${credentials.email}\n${password}\n测试管理员\n`);
  const run = await beginDemoVerification(initial, credentials);
  const oldPackage = (await initial.request(run.download, { auth: run.buyer })).data;
  call(['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90']);
  assert.deepEqual((await clientThrough(call).request(run.download, { auth: run.buyer })).data, oldPackage);
  const backups = path.join(temp, 'backups');
  mkdirSync(backups);
  call(['stop', 'softcove']);
  call(['run', '--rm', '--no-deps', '-T', '--user', '0:0', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '-v', backups + ':/backups', 'softcove', 'node', 'scripts/backup.mjs', 'create', '/backups/snapshot']);
  const recovery = (args, input) => docker([...compose(recoveredProject), ...args], input);
  // Reuse the exact tested image under the recovery project's default image name.
  docker(['tag', project + '-softcove', recoveredProject + '-softcove']);
  recovery(['run', '--rm', '--no-deps', '-T', '--user', '0:0', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '-v', path.join(backups, 'snapshot') + ':/backup:ro', 'softcove', 'sh', '-c', 'node scripts/backup.mjs restore /backup && chown -R node:node /app/data']);
  recovery(['up', '-d', '--wait', '--wait-timeout', '90']);
  const restored = clientThrough(recovery);
  assert.equal((await restored.request('/api/me', { auth: run.buyer })).data.user, null);
  const restoredBuyer = await restored.request('/api/auth/login', { method: 'POST', body: run.buyerCredentials });
  assert.deepEqual((await restored.request(run.download, { auth: restoredBuyer })).data, oldPackage);
  const restoredAdmin = await restored.request('/api/auth/login', { method: 'POST', body: credentials });
  const report = await finishDemoVerification(restored, run, { admin: restoredAdmin, buyer: restoredBuyer });
  console.log('Docker 验收通过：模拟购买 → 送审新版 → 重建和恢复 → 审核新版 → 原订单授权下载更新。');
  console.log(JSON.stringify(report));
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
