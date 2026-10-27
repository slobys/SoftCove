import { randomBytes, scryptSync, createHash, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => { throw new HttpError(status, message); };

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return 'scrypt:' + salt + ':' + hash;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const candidate = scryptSync(password, parts[1], 64);
    const actual = Buffer.from(parts[2], 'hex');
    return actual.length === candidate.length && timingSafeEqual(actual, candidate);
  } catch {
    return false;
  }
}

export function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  const found = cookies.map(x => x.trim()).find(x => x.startsWith(name + '='));
  return found ? found.slice(name.length + 1) : '';
}

export function getAuth(db, req) {
  const token = cookieValue(req, 'softcove_session');
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const row = db.prepare('SELECT u.id,u.name,u.email,u.role,u.seller_status,s.csrf_token,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(tokenHash(token));
  if (!row || row.expires_at <= Date.now()) return null;
  return row;
}

export function publicUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, role: user.role, seller_status: user.role === 'seller' ? (user.seller_status || 'pending') : undefined };
}

export function createSession(db, req, res, user, secure = false) {
  const old = cookieValue(req, 'softcove_session');
  if (/^[a-f0-9]{64}$/.test(old)) {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(old));
  }
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(24).toString('hex');
  const maxAge = 60 * 60 * 24 * 7;
  db.prepare('INSERT INTO sessions (token_hash,user_id,csrf_token,expires_at) VALUES (?,?,?,?)')
    .run(tokenHash(token), user.id, csrf, Date.now() + maxAge * 1000);
  res.setHeader('Set-Cookie', 'softcove_session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (secure ? '; Secure' : ''));
  return csrf;
}

export function clearSession(db, req, res, secure = false) {
  const old = cookieValue(req, 'softcove_session');
  if (/^[a-f0-9]{64}$/.test(old)) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(old));
  res.setHeader('Set-Cookie', 'softcove_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (secure ? '; Secure' : ''));
}

export function requireAuth(auth, roles = []) {
  if (!auth) fail(401, '请先登录');
  if (roles.length > 0 && !roles.includes(auth.role)) fail(403, '没有权限操作');
  return auth;
}

export function checkSameOrigin(req, baseUrl) {
  const origin = req.headers.origin;
  const expected = new URL(baseUrl).origin;
  if (origin && origin !== expected) fail(403, '请求来源不可信');
  if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, '拒绝跨站请求');
}

export function checkMutation(req, auth, baseUrl) {
  checkSameOrigin(req, baseUrl);
  requireAuth(auth);
  const input = req.headers['x-csrf-token'] || '';
  if (typeof input !== 'string' || input.length !== auth.csrf_token.length) fail(403, 'CSRF 校验失败，请刷新页面');
  if (!timingSafeEqual(Buffer.from(input), Buffer.from(auth.csrf_token))) fail(403, 'CSRF 校验失败，请刷新页面');
}

export async function readBody(req, maxBytes = 100_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) fail(413, '请求内容太大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJSON(req, maxBytes = 100_000) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415, '请使用 JSON 提交数据');
  let body;
  try { body = JSON.parse((await readBody(req, maxBytes)).toString('utf8')); }
  catch { fail(400, 'JSON 格式无效'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '请求格式无效');
  return body;
}

export function safeEmail(input) {
  const email = String(input || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, '请输入有效邮箱');
  return email;
}

export function safeText(value, field, max = 500, min = 0) {
  if (typeof value !== 'string') fail(400, field + '格式不正确');
  const v = value.trim();
  if (v.length < min || v.length > max) fail(400, field + '长度应为 ' + min + '-' + max + ' 个字符');
  return v;
}

export function safeFilename(input) {
  const base = String(input || '').replaceAll('\\', '/').split('/').pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!base || base.length > 160 || base.startsWith('.')) fail(400, '无效的软件包文件名');
  return base;
}

export function createRateLimiter() {
  const records = new Map();
  return function limit(req, group, max, ms) {
    const ip = req.socket.remoteAddress || 'unknown';
    const key = group + ':' + ip;
    const now = Date.now();
    if (records.size > 8000) {
      for (const [k, record] of records) if (record.reset <= now) records.delete(k);
    }
    const record = records.get(key);
    if (!record || record.reset <= now) { records.set(key, { count: 1, reset: now + ms }); return; }
    record.count++;
    if (record.count > max) fail(429, '操作过于频繁，请稍后再试');
  };
}

export function json(res, status, data, extra = {}) {
  const payload = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, 'Cache-Control': 'no-store', ...extra });
  res.end(payload);
}
