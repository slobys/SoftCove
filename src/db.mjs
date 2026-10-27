import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const CATEGORIES = ['开发工具', 'AI 工具', '效率办公', '设计创作', '网络工具', '系统工具', '教育学习', '其他'];
export const PLATFORMS = ['Windows', 'macOS', 'Linux', 'Android'];

export function uid(prefix = '') {
  return prefix + randomUUID();
}

export function withTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = operation();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, 'marketplace.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec([
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('buyer','seller','admin')), seller_status TEXT NOT NULL DEFAULT 'none', seller_bio TEXT NOT NULL DEFAULT '', seller_website TEXT NOT NULL DEFAULT '', seller_review_note TEXT NOT NULL DEFAULT '', seller_reviewed_at TEXT, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)",
    "CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, seller_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, tagline TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL, platforms TEXT NOT NULL DEFAULT '[]', version TEXT NOT NULL DEFAULT '1.0.0', price_minor INTEGER NOT NULL DEFAULT 0 CHECK(price_minor >= 0), currency TEXT NOT NULL DEFAULT 'CNY', icon TEXT NOT NULL DEFAULT '📦', accent TEXT NOT NULL DEFAULT '#6288fa', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','published','rejected','archived')), is_demo INTEGER NOT NULL DEFAULT 0, file_key TEXT, file_name TEXT, file_size INTEGER, file_sha256 TEXT, scan_status TEXT NOT NULL DEFAULT 'missing', scan_detail TEXT NOT NULL DEFAULT '', scanned_at TEXT, review_note TEXT NOT NULL DEFAULT '', reviewed_by TEXT, reviewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_products_status ON products(status)",
    "CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id)",
    "CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, buyer_id TEXT NOT NULL REFERENCES users(id), seller_id TEXT NOT NULL REFERENCES users(id), product_id TEXT NOT NULL REFERENCES products(id), product_name TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','paid','free','failed','expired','refunded')), checkout_session_id TEXT UNIQUE, payment_intent_id TEXT UNIQUE, platform_fee_minor INTEGER NOT NULL DEFAULT 0, seller_due_minor INTEGER NOT NULL DEFAULT 0, refunded_minor INTEGER NOT NULL DEFAULT 0, refunded_at TEXT, created_at TEXT NOT NULL, paid_at TEXT)",
    "CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id)",
    "CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id)",
    "CREATE TABLE IF NOT EXISTS entitlements (id TEXT PRIMARY KEY, buyer_id TEXT NOT NULL REFERENCES users(id), product_id TEXT NOT NULL REFERENCES products(id), order_id TEXT NOT NULL REFERENCES orders(id), created_at TEXT NOT NULL, UNIQUE(buyer_id, product_id))",
    "CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, processed_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS stripe_refunds (payment_intent_id TEXT PRIMARY KEY, charge_id TEXT NOT NULL, amount_minor INTEGER NOT NULL, refunded_minor INTEGER NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS moderation_log (id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), admin_id TEXT NOT NULL REFERENCES users(id), decision TEXT NOT NULL, note TEXT NOT NULL, scan_confirmed INTEGER NOT NULL, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS seller_review_log (id TEXT PRIMARY KEY, seller_id TEXT NOT NULL REFERENCES users(id), admin_id TEXT NOT NULL REFERENCES users(id), decision TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS manual_settlements (id TEXT PRIMARY KEY, seller_id TEXT NOT NULL REFERENCES users(id), amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL, method TEXT NOT NULL, external_reference TEXT NOT NULL UNIQUE, note TEXT NOT NULL DEFAULT '', recorded_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_settlements_seller ON manual_settlements(seller_id)"
  ].join(';\n') + ';');

  // Additive migration for pre-existing MVP databases: preserve users, orders and entitlements.
  const orderColumns = new Set(db.prepare('PRAGMA table_info(orders)').all().map(c => c.name));
  if (!orderColumns.has('payment_intent_id')) db.exec('ALTER TABLE orders ADD COLUMN payment_intent_id TEXT');
  if (!orderColumns.has('refunded_minor')) db.exec('ALTER TABLE orders ADD COLUMN refunded_minor INTEGER NOT NULL DEFAULT 0');
  if (!orderColumns.has('refunded_at')) db.exec('ALTER TABLE orders ADD COLUMN refunded_at TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_intent ON orders(payment_intent_id)');

  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
  if (!userColumns.has('seller_status')) db.exec("ALTER TABLE users ADD COLUMN seller_status TEXT NOT NULL DEFAULT 'none'");
  if (!userColumns.has('seller_bio')) db.exec("ALTER TABLE users ADD COLUMN seller_bio TEXT NOT NULL DEFAULT ''");
  if (!userColumns.has('seller_website')) db.exec("ALTER TABLE users ADD COLUMN seller_website TEXT NOT NULL DEFAULT ''");
  if (!userColumns.has('seller_review_note')) db.exec("ALTER TABLE users ADD COLUMN seller_review_note TEXT NOT NULL DEFAULT ''");
  if (!userColumns.has('seller_reviewed_at')) db.exec('ALTER TABLE users ADD COLUMN seller_reviewed_at TEXT');
  const productColumns = new Set(db.prepare('PRAGMA table_info(products)').all().map(c => c.name));
  if (!productColumns.has('scan_detail')) db.exec("ALTER TABLE products ADD COLUMN scan_detail TEXT NOT NULL DEFAULT ''");
  if (!productColumns.has('scanned_at')) db.exec('ALTER TABLE products ADD COLUMN scanned_at TEXT');
  // Existing developer accounts start pending review, not implicitly pre-approved.
  db.exec("UPDATE users SET seller_status='pending' WHERE role='seller' AND seller_status='none' AND id!='softcove-demo-studio'");
  db.exec("UPDATE users SET seller_status='approved' WHERE id='softcove-demo-studio'");

  seedCatalog(db);
  return db;
}

function seedCatalog(db) {
  const hasDemo = db.prepare('SELECT id FROM products WHERE is_demo=1 LIMIT 1').get();
  if (hasDemo) return;
  const sellerId = 'softcove-demo-studio';
  const now = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO users (id,email,name,password_hash,role,seller_status,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(sellerId, 'demo@softcove.invalid', 'SoftCove 精选实验室', 'LOGIN_DISABLED', 'seller', 'approved', now);

  // Fictitious design examples. No package is attached; checkout is always disabled for demos.
  const items = [
    { name: 'FlowPilot', tagline: '为每个灵感找到顺畅的工作流', category: '效率办公', platforms: ['Windows', 'macOS'], version: '2.6.0', price: 4900, icon: '✦', accent: '#6878ff', description: '演示商品：想象中的桌面工作流与任务自动化工具，展示多平台软件如何被发现和购买。' },
    { name: 'Nebula Notes', tagline: '把零散想法连接成知识宇宙', category: '效率办公', platforms: ['Windows', 'macOS', 'Linux'], version: '1.8.4', price: 0, icon: '◈', accent: '#14b8a6', description: '演示商品：想象中的本地优先知识管理和双向链接笔记软件。' },
    { name: 'PixelForge', tagline: '从设计稿到作品，只差一次点击', category: '设计创作', platforms: ['Windows', 'macOS'], version: '3.1.2', price: 8900, icon: '◆', accent: '#f97384', description: '演示商品：想象中的快速视觉资产制作和批量导出工具。' },
    { name: 'CodeHarbor', tagline: '开发者的高效工具箱', category: '开发工具', platforms: ['Windows', 'Linux', 'macOS'], version: '0.9.0', price: 3900, icon: '⌘', accent: '#35a1fa', description: '演示商品：想象中的代码片段、接口调试与命令管理工具。' },
    { name: 'Astra AI', tagline: '把 AI 能力带入你的日常桌面', category: 'AI 工具', platforms: ['Windows', 'macOS'], version: '1.2.1', price: 6900, icon: '✳', accent: '#9b7bfa', description: '演示商品：想象中的通用多模型 AI 助手，可在本地桌面打开。' },
    { name: 'WaveCast', tagline: '轻松打造清晰流畅的音视频体验', category: '设计创作', platforms: ['Windows', 'macOS'], version: '2.0.3', price: 5900, icon: '◉', accent: '#ffa34e', description: '演示商品：想象中的音视频录制与转换软件。' },
    { name: 'NetScope', tagline: '网络状态，一眼尽知', category: '网络工具', platforms: ['Windows', 'Linux'], version: '1.5.0', price: 0, icon: '⌁', accent: '#10b5b7', description: '演示商品：想象中的网络连接监测和简单故障分析工具。' },
    { name: 'TutorBloom', tagline: '把学习变成好奇心的旅程', category: '教育学习', platforms: ['Android', 'Windows'], version: '1.0.6', price: 2900, icon: '✿', accent: '#f6b14f', description: '演示商品：想象中的互动学习工具，展示 Android 安装包也可作为商品管理。' }
  ];
  const insert = db.prepare("INSERT OR IGNORE INTO products (id,seller_id,name,tagline,description,category,platforms,version,price_minor,currency,icon,accent,status,is_demo,scan_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  withTransaction(db, () => {
    items.forEach((item, index) => insert.run('softcove-demo-' + (index + 1), sellerId, item.name, item.tagline, item.description, item.category, JSON.stringify(item.platforms), item.version, item.price, 'CNY', item.icon, item.accent, 'published', 1, 'demo', now, now));
  });
}
