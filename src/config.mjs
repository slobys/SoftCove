import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnvironment() {
  const filename = path.join(projectDir, '.env');
  if (existsSync(filename)) process.loadEnvFile(filename);
}

function flag(value, name, fallback) {
  if (value === undefined || value === '') return fallback;
  if ([true, '1', 'true'].includes(value)) return true;
  if ([false, '0', 'false'].includes(value)) return false;
  throw new Error(name + ' 必须为 0 或 1');
}

export function loadConfig(opts = {}, env = process.env) {
  const port = Number(opts.port ?? env.PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1 至 65535 的整数');
  const baseUrl = String(opts.baseUrl ?? env.PUBLIC_BASE_URL ?? 'http://localhost:' + port).replace(/\/+$/, '');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('PUBLIC_BASE_URL 必须是有效的 HTTP(S) 站点地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('PUBLIC_BASE_URL 必须是 HTTP(S) 站点地址，不能含账号、路径、查询参数或锚点');
  }
  const secureCookie = url.protocol === 'https:';
  if ((opts.nodeEnv ?? env.NODE_ENV) === 'production' && !secureCookie && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('生产环境 PUBLIC_BASE_URL 必须使用 HTTPS；本地回环测试除外');
  }
  const currency = String(opts.currency ?? env.APP_CURRENCY ?? 'CNY').toUpperCase();
  if (!['CNY', 'USD'].includes(currency)) throw new Error('仅支持 CNY 或 USD 单货币商店');
  const feeBps = Number(opts.feeBps ?? env.PLATFORM_FEE_BPS ?? 1500);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) throw new Error('PLATFORM_FEE_BPS 无效');
  const stripeKey = String(opts.stripeKey ?? env.STRIPE_SECRET_KEY ?? '');
  const webhookSecret = String(opts.webhookSecret ?? env.STRIPE_WEBHOOK_SECRET ?? '');
  if (Boolean(stripeKey) !== Boolean(webhookSecret)) throw new Error('Stripe API 密钥和 Webhook 密钥必须同时配置或同时留空');
  if (stripeKey && (!/^sk_(test|live)_[A-Za-z0-9_]+$/.test(stripeKey) || !/^whsec_[A-Za-z0-9_]+$/.test(webhookSecret))) {
    throw new Error('Stripe 密钥格式无效，请使用 sk_test_/sk_live_ 和 whsec_ 密钥');
  }
  const demoCheckout = flag(opts.demoCheckout ?? env.DEMO_CHECKOUT_ENABLED, 'DEMO_CHECKOUT_ENABLED', false);
  if (demoCheckout && stripeKey) throw new Error('演示交易不能与 Stripe 收款同时启用，请使用独立数据卷');
  return {
    port, baseUrl: url.origin, currency, feeBps, secureCookie, stripeKey, webhookSecret,
    demoCheckout,
    dataDir: path.resolve(opts.dataDir ?? env.DATA_DIR ?? path.join(projectDir, 'data')),
    demoCatalog: flag(opts.demoCatalog ?? env.ENABLE_DEMO_CATALOG, 'ENABLE_DEMO_CATALOG', true),
    trustProxy: flag(opts.trustProxy ?? env.TRUST_PROXY, 'TRUST_PROXY', false),
    clamavEnabled: flag(opts.clamavEnabled ?? env.CLAMAV_ENABLED, 'CLAMAV_ENABLED', false),
    clamavCommand: String(opts.clamavCommand ?? env.CLAMAV_COMMAND ?? 'clamscan')
  };
}
