import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, uid } from '../src/db.mjs';
import { hashPassword, safeEmail } from '../src/security.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}
const email = safeEmail(process.env.ADMIN_EMAIL || '');
const password = process.env.ADMIN_PASSWORD || '';
if (password.length < 14) throw new Error('管理员密码长度至少 14 位，请设置 ADMIN_PASSWORD');
const name = (process.env.ADMIN_NAME || '平台管理员').trim().slice(0, 40);
const db = openDatabase(path.resolve(root, process.env.DATA_DIR || './data'));
const existing = db.prepare('SELECT id,role FROM users WHERE email=?').get(email);
if (existing && existing.role !== 'admin') throw new Error('该邮箱已注册非管理员账户，拒绝提升角色');
if (existing) {
  db.prepare('UPDATE users SET password_hash=?,name=? WHERE id=?').run(hashPassword(password), name, existing.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(existing.id);
  console.log('管理员密码已更新，所有旧会话已失效。');
} else {
  db.prepare('INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
    .run(uid('adm_'), email, name, hashPassword(password), 'admin', new Date().toISOString());
  console.log('管理员已创建：' + email);
}
db.close();
