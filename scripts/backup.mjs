import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, rmSync, lstatSync, chmodSync } from 'node:fs';
import { loadEnvironment, projectDir } from '../src/config.mjs';

const digest = filename => createHash('sha256').update(readFileSync(filename)).digest('hex');
const validKey = key => /^[a-f0-9-]{36}\.blob$/.test(key);

function regularFile(filename) {
  if (!lstatSync(filename).isFile()) throw new Error('备份只接受普通文件');
}

function referencedPackages(db) {
  const products = 'SELECT DISTINCT file_key,file_sha256 FROM products WHERE file_key IS NOT NULL';
  const hasUpdates = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='product_updates'").get();
  const updates = 'SELECT file_key,file_sha256 FROM product_updates WHERE file_key IS NOT NULL';
  return db.prepare(hasUpdates ? products + ' UNION ' + updates : products).all();
}

function verifySnapshot(folder) {
  const manifest = JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'softcove-backup-v1' || !Array.isArray(manifest.files) || !/^[a-f0-9]{64}$/.test(manifest.database_sha256)) throw new Error('备份清单格式无效');
  const database = path.join(folder, 'marketplace.db');
  regularFile(database);
  if (digest(database) !== manifest.database_sha256) throw new Error('备份数据库校验失败');
  const seen = new Set();
  for (const file of manifest.files) {
    if (!validKey(file.key) || !/^[a-f0-9]{64}$/.test(file.sha256) || seen.has(file.key)) throw new Error('备份文件清单无效');
    seen.add(file.key);
    const target = path.join(folder, 'uploads', file.key);
    regularFile(target);
    if (digest(target) !== file.sha256) throw new Error('备份软件包校验失败');
  }
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('备份数据库完整性检查失败');
    for (const product of referencedPackages(db)) {
      if (!manifest.files.some(file => file.key === product.file_key && file.sha256 === product.file_sha256)) throw new Error('备份缺少数据库引用的软件包');
    }
  } finally { db.close(); }
  return manifest;
}

export function createBackup(dataDir, destination) {
  const source = path.resolve(dataDir);
  const target = path.resolve(destination);
  if (target === source || target.startsWith(source + path.sep)) throw new Error('备份目录必须位于数据目录以外');
  if (existsSync(target)) throw new Error('备份目标已存在，拒绝覆盖');
  const staging = target + '.partial-' + randomUUID();
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const databasePath = path.join(source, 'marketplace.db');
    regularFile(databasePath);
    // Allow SQLite to recover WAL metadata after shutdown. ops.sh stops the
    // application first so package files cannot change during the snapshot.
    const db = new DatabaseSync(databasePath);
    try { db.prepare('VACUUM INTO ?').run(path.join(staging, 'marketplace.db')); }
    finally { db.close(); }
    chmodSync(path.join(staging, 'marketplace.db'), 0o600);
    mkdirSync(path.join(staging, 'uploads'), { mode: 0o700 });
    const snapshot = new DatabaseSync(path.join(staging, 'marketplace.db'), { readOnly: true });
    let products;
    try { products = referencedPackages(snapshot); }
    finally { snapshot.close(); }
    const files = products.map(product => {
      if (!validKey(product.file_key)) throw new Error('软件包存储键无效，拒绝备份');
      const from = path.join(source, 'uploads', product.file_key);
      regularFile(from);
      const to = path.join(staging, 'uploads', product.file_key);
      copyFileSync(from, to);
      chmodSync(to, 0o600);
      return { key: product.file_key, sha256: product.file_sha256 };
    });
    writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ format: 'softcove-backup-v1', created_at: new Date().toISOString(), database_sha256: digest(path.join(staging, 'marketplace.db')), files }, null, 2), { mode: 0o600 });
    verifySnapshot(staging);
    renameSync(staging, target);
    return target;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function restoreBackup(backupDir, dataDir) {
  const source = path.resolve(backupDir);
  const target = path.resolve(dataDir);
  if (existsSync(target) && readdirSync(target).length) throw new Error('仅允许恢复到空数据目录；请使用新数据卷，现有数据不会被覆盖');
  const manifest = verifySnapshot(source);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  copyFileSync(path.join(source, 'marketplace.db'), path.join(target, 'marketplace.db'));
  chmodSync(path.join(target, 'marketplace.db'), 0o600);
  mkdirSync(path.join(target, 'uploads'), { mode: 0o700 });
  for (const file of manifest.files) {
    const to = path.join(target, 'uploads', file.key);
    copyFileSync(path.join(source, 'uploads', file.key), to);
    chmodSync(to, 0o600);
  }
  const db = new DatabaseSync(path.join(target, 'marketplace.db'));
  try { db.exec('DELETE FROM sessions;'); } finally { db.close(); }
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvironment();
  const [command, folder] = process.argv.slice(2);
  if (!['create', 'restore', 'verify'].includes(command) || !folder) throw new Error('用法：node scripts/backup.mjs create|restore|verify <备份目录>');
  const dataDir = path.resolve(projectDir, process.env.DATA_DIR || './data');
  if (command === 'create') createBackup(dataDir, folder);
  if (command === 'restore') restoreBackup(folder, dataDir);
  if (command === 'verify') verifySnapshot(folder);
  console.log(command === 'restore' ? '已恢复到空数据目录，旧登录会话已注销。' : '备份完整性检查通过。');
}
