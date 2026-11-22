import { uid, withTransaction } from './db.mjs';
import { fail, safeText } from './security.mjs';

const openStatuses = "('draft','pending','rejected')";
const editableStatuses = ['draft', 'rejected'];

export function updateSummary(update) {
  const { id, product_id, version, release_notes, status, file_name, file_size, file_sha256,
    scan_status, scan_detail, review_note, submission_id } = update;
  return { id, product_id, version, release_notes, status, file_name, file_size, file_sha256,
    scan_status, scan_detail, review_note, submission_id };
}

export function openUpdatesForSeller(db, sellerId) {
  const updates = db.prepare(`SELECT r.* FROM product_updates r JOIN products p ON p.id=r.product_id
    WHERE p.seller_id=? AND r.status IN ${openStatuses}`).all(sellerId);
  return new Map(updates.map(r => [r.product_id, updateSummary(r)]));
}

export function pendingUpdates(db) {
  return db.prepare(`SELECT r.*, p.name, p.price_minor, p.currency, u.name AS seller_name
    FROM product_updates r JOIN products p ON p.id=r.product_id JOIN users u ON p.seller_id=u.id
    WHERE r.status='pending' ORDER BY r.updated_at LIMIT 150`).all().map(r => ({
    ...updateSummary(r), name: r.name, price_minor: r.price_minor, currency: r.currency, seller_name: r.seller_name
  }));
}

function releaseProduct(db, id, sellerId = null) {
  const product = db.prepare(`SELECT p.*, u.seller_status FROM products p JOIN users u ON p.seller_id=u.id
    WHERE p.id=? AND p.is_demo=0`).get(id);
  if (!product || (sellerId !== null && product.seller_id !== sellerId)) fail(404, '未找到软件');
  if (product.status !== 'published') fail(409, '只有在售软件才能发布更新');
  return product;
}

function requireApprovedSeller(product) {
  if (product.seller_status !== 'approved') fail(403, '开发者未通过平台审核或已暂停');
}

export function saveUpdate(db, sellerId, productId, input) {
  const version = safeText(input.version, '版本号', 30, 1);
  // Version labels are identifiers. Do not impose a version ordering scheme.
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,29}$/.test(version)) fail(400, '版本号只支持字母、数字、点、下划线、加号和短横线');
  const notes = safeText(input.releaseNotes, '更新说明', 1500, 1);
  return withTransaction(db, () => {
    const product = releaseProduct(db, productId, sellerId);
    requireApprovedSeller(product);
    const prior = db.prepare(`SELECT * FROM product_updates WHERE product_id=? AND status IN ${openStatuses}`).get(productId);
    if (prior && (!editableStatuses.includes(prior.status) || input.id !== prior.id)) fail(409, '已有进行中的更新，请从工作台重新打开');
    if (!prior && input.id) fail(409, '此更新已结束，请从工作台重新打开');
    if (product.version.toLowerCase() === version.toLowerCase() ||
        db.prepare('SELECT id FROM product_updates WHERE product_id=? AND version=? AND id!=?').get(productId, version, prior?.id ?? '')) {
      fail(409, '该版本号已使用，请填写新的版本号');
    }
    const now = new Date().toISOString();
    if (prior) {
      db.prepare("UPDATE product_updates SET version=?,release_notes=?,updated_at=? WHERE id=?").run(version, notes, now, prior.id);
      return { id: prior.id, created: false };
    }
    const id = uid('update_');
    db.prepare("INSERT INTO product_updates (id,product_id,version,release_notes,status,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?)")
      .run(id, productId, version, notes, now, now);
    return { id, created: true };
  });
}

export function editableUpdate(db, sellerId, id) {
  const update = db.prepare('SELECT r.* FROM product_updates r JOIN products p ON p.id=r.product_id WHERE r.id=? AND p.seller_id=?')
    .get(id, sellerId);
  if (!update) fail(404, '未找到你的更新');
  const product = releaseProduct(db, update.product_id);
  requireApprovedSeller(product);
  if (!editableStatuses.includes(update.status)) fail(409, '此更新已提交或结束，请刷新工作台');
  return update;
}

export function verifyReviewablePackage(update, clamavEnabled) {
  if (!update.file_key || !update.file_size || !['quarantined', 'scan_passed'].includes(update.scan_status)) {
    fail(409, '请上传可审核的软件包，扫描失败或异常的文件不能发布');
  }
  if (clamavEnabled && update.scan_status !== 'scan_passed') fail(409, 'ClamAV 开启时须先通过自动扫描');
}

export function submitUpdate(db, sellerId, id, clamavEnabled) {
  withTransaction(db, () => {
    const update = editableUpdate(db, sellerId, id);
    verifyReviewablePackage(update, clamavEnabled);
    db.prepare("UPDATE product_updates SET status='pending',submission_id=?,review_note='',updated_at=? WHERE id=?")
      .run(uid(), new Date().toISOString(), id);
  });
}

export function pendingUpdate(db, id) {
  const update = db.prepare("SELECT * FROM product_updates WHERE id=? AND status='pending'").get(id);
  if (!update) fail(404, '未找到待审核的更新');
  return update;
}

export function reviewUpdate(db, adminId, id, body, clamavEnabled) {
  const { decision } = body;
  if (!['approve', 'reject'].includes(decision)) fail(400, '审核操作不正确');
  const note = safeText(body.note ?? '', '审核意见', 500, decision === 'reject' ? 3 : 0);
  return withTransaction(db, () => {
    const update = pendingUpdate(db, id);
    if (body.submissionId !== update.submission_id) fail(409, '更新已重新提交，请刷新并重新核验');
    const product = releaseProduct(db, update.product_id);
    const now = new Date().toISOString();
    const approved = decision === 'approve';
    if (approved) {
      requireApprovedSeller(product);
      verifyReviewablePackage(update, clamavEnabled);
      if (body.scanConfirmed !== true) fail(409, '必须完成人工安全复核');

      // Keep version identifiers and hashes for the audit trail. The live
      // product remains the only downloadable package for existing buyers.
      db.prepare(`INSERT INTO product_updates (id,product_id,version,status,file_name,file_sha256,created_at,updated_at)
        VALUES (?,?,?,'published',?,?,?,?) ON CONFLICT(product_id,version) DO NOTHING`)
        .run(uid('update_'), product.id, product.version, product.file_name, product.file_sha256, product.reviewed_at ?? now, now);
      db.prepare(`UPDATE products SET version=?,file_key=?,file_name=?,file_size=?,file_sha256=?,
        scan_status='manually_verified',scan_detail=?,scanned_at=?,review_note=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?`)
        .run(update.version, update.file_key, update.file_name, update.file_size, update.file_sha256, update.scan_detail,
          update.scanned_at, note, adminId, now, now, product.id);
      db.prepare("UPDATE product_updates SET file_key=NULL,file_size=NULL,scan_status='manually_verified' WHERE id=?").run(id);
    }
    const status = approved ? 'published' : 'rejected';
    db.prepare('UPDATE product_updates SET status=?, review_note=?, updated_at=? WHERE id=?').run(status, note, now, id);
    db.prepare(`INSERT INTO moderation_log (id,product_id,admin_id,decision,note,scan_confirmed,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(uid('review_'), product.id, adminId, 'update_' + decision,
      update.version + ' · ' + update.file_sha256 + (note ? ' · ' + note : ''), Number(approved), now);
    return { status, replacedKey: approved ? product.file_key : null };
  });
}
