import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openDatabase, uid, withTransaction } from '../src/db.mjs';
import { hashPassword, safeEmail, safeText } from '../src/security.mjs';
import { loadEnvironment, projectDir } from '../src/config.mjs';

loadEnvironment();
const args = process.argv.slice(2);
if (args.some(arg => !['--stdin', '--check', '--if-missing'].includes(arg))) throw new Error('不支持的管理员命令参数');
const db = openDatabase(path.resolve(projectDir, process.env.DATA_DIR || './data'), { seedDemo: false });
try {
  const exists = Boolean(db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get());
  if (args.includes('--check')) {
    process.exitCode = exists ? 0 : 1;
  } else if (args.includes('--if-missing') && exists) {
    console.log('已有管理员，未修改账户或密码。');
  } else {
    // Three newline-separated values avoid passwords in argv, Docker env or .env.
    const lines = args.includes('--stdin') ? readFileSync(0, 'utf8').split(/\r?\n/) : null;
    const email = safeEmail(lines ? lines[0] : process.env.ADMIN_EMAIL);
    const password = (lines ? lines[1] : process.env.ADMIN_PASSWORD) || '';
    if (password.length < 14 || password.length > 128 || /[\r\n\0]/.test(password)) throw new Error('管理员密码长度应为 14 至 128 个字符，不得含换行');
    const name = safeText((lines ? lines[2] : process.env.ADMIN_NAME) || '平台管理员', '管理员名称', 40, 1);
    withTransaction(db, () => {
      const existing = db.prepare('SELECT id,role FROM users WHERE email=?').get(email);
      if (existing && existing.role !== 'admin') throw new Error('该邮箱已注册非管理员账户，拒绝提升角色');
      if (existing) {
        db.prepare('UPDATE users SET password_hash=?,name=? WHERE id=?').run(hashPassword(password), name, existing.id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(existing.id);
        console.log('管理员密码已更新，所有旧会话已失效。');
      } else {
        db.prepare('INSERT INTO users (id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
          .run(uid('adm_'), email, name, hashPassword(password), 'admin', new Date().toISOString());
        console.log('管理员已创建。');
      }
    });
  }
} finally { db.close(); }
