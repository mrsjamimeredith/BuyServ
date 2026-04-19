const db = require('./db');
const pinterest = require('./pinterest');
const { getAccountById, allAccounts, ensureFreshToken } = require('./auth');
const { addDisclosure } = require('./compliance');

const TICK_MS = 30 * 1000;
const ANALYTICS_REFRESH_MS = 60 * 60 * 1000; // every hour
const ANALYTICS_STALE_SECONDS = 12 * 3600;   // older than 12h -> refresh

let postTimer = null;
let analyticsTimer = null;

function countPostedLast24h(accountId) {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM products
    WHERE account_id = ? AND status = 'posted' AND posted_at > ?
  `).get(accountId, since);
  return row?.n || 0;
}

async function postOne(product, account) {
  const description = account.auto_disclose ? addDisclosure(product.description) : product.description;

  let videoMediaId = null;
  if (product.media_type === 'video' && product.video_data) {
    const buf = Buffer.from(product.video_data, 'base64');
    videoMediaId = await pinterest.uploadVideo(account.access_token, buf, product.video_mime || 'video/mp4');
  }

  const pin = await pinterest.createPin(account.access_token, {
    title: product.title,
    description,
    boardId: product.board_id,
    imageUrl: product.image_url || undefined,
    imageData: product.image_data || undefined,
    imageMime: product.image_mime || undefined,
    link: product.affiliate_url,
    videoMediaId: videoMediaId || undefined,
    coverImageData: product.cover_image_data || undefined,
    coverImageMime: product.cover_image_mime || undefined,
    coverImageUrl: product.image_url && videoMediaId ? product.image_url : undefined
  });

  // drop large video blob post-upload to save DB space
  db.prepare(`
    UPDATE products
    SET status = 'posted', pinterest_pin_id = ?, posted_at = strftime('%s','now'),
        error = NULL, video_data = NULL
    WHERE id = ?
  `).run(pin.id, product.id);
  db.prepare(`UPDATE accounts SET last_posted_at = strftime('%s','now') WHERE id = ?`).run(account.id);
  return pin;
}

async function postTick() {
  const now = Math.floor(Date.now() / 1000);
  const due = db.prepare(`
    SELECT * FROM products
    WHERE status IN ('scheduled','queued')
      AND (scheduled_for IS NULL OR scheduled_for <= ?)
    ORDER BY COALESCE(scheduled_for, 0) ASC, id ASC
    LIMIT 50
  `).all(now);

  const byAccount = new Map();
  for (const p of due) {
    if (!byAccount.has(p.account_id)) byAccount.set(p.account_id, []);
    byAccount.get(p.account_id).push(p);
  }

  for (const [accountId, items] of byAccount) {
    const accountRaw = getAccountById(accountId);
    if (!accountRaw) continue;
    let account;
    try { account = await ensureFreshToken(accountRaw); }
    catch (e) { console.error(`[scheduler] token refresh failed for acct ${accountId}:`, e.message); continue; }

    for (const p of items) {
      const postedToday = countPostedLast24h(accountId);
      if (postedToday >= (account.daily_pin_limit || 25)) break;
      if (account.last_posted_at && (Math.floor(Date.now() / 1000) - account.last_posted_at) < (account.min_seconds_between_pins || 120)) break;
      try {
        await postOne(p, account);
        account.last_posted_at = Math.floor(Date.now() / 1000);
      } catch (err) {
        console.error(`[scheduler] post failed for product ${p.id}:`, err.message);
        db.prepare('UPDATE products SET status = ?, error = ? WHERE id = ?')
          .run('failed', err.message, p.id);
      }
    }
  }
}

async function refreshAnalyticsForPin(account, product) {
  try {
    const data = await pinterest.getPinAnalytics(account.access_token, product.pinterest_pin_id, 30);
    // Pinterest returns either keyed by date or summary; we use ALL bucket totals.
    // Structure: { "ALL": { "summary_metrics": { IMPRESSION: n, SAVE: n, ... } } } per app_types
    const bucket = data?.ALL || data?.all || data;
    const sums = bucket?.summary_metrics || bucket?.lifetime_metrics || {};
    const impressions = Number(sums.IMPRESSION || 0);
    const saves = Number(sums.SAVE || 0);
    const pin_clicks = Number(sums.PIN_CLICK || 0);
    const outbound_clicks = Number(sums.OUTBOUND_CLICK || 0);
    db.prepare(`
      UPDATE products
      SET impressions = ?, saves = ?, pin_clicks = ?, outbound_clicks = ?,
          last_analytics_at = strftime('%s','now')
      WHERE id = ?
    `).run(impressions, saves, pin_clicks, outbound_clicks, product.id);
    return { impressions, saves, pin_clicks, outbound_clicks };
  } catch (err) {
    console.error(`[analytics] pin ${product.pinterest_pin_id} failed:`, err.message);
    return null;
  }
}

async function analyticsTick() {
  const staleBefore = Math.floor(Date.now() / 1000) - ANALYTICS_STALE_SECONDS;
  for (const acctRaw of allAccounts()) {
    let account;
    try { account = await ensureFreshToken(acctRaw); }
    catch { continue; }
    const pins = db.prepare(`
      SELECT * FROM products
      WHERE account_id = ? AND status = 'posted' AND pinterest_pin_id IS NOT NULL
        AND (last_analytics_at IS NULL OR last_analytics_at < ?)
      ORDER BY posted_at DESC
      LIMIT 50
    `).all(account.id, staleBefore);
    for (const p of pins) {
      await refreshAnalyticsForPin(account, p);
      await new Promise(r => setTimeout(r, 250)); // gentle pacing
    }
  }
}

function start() {
  if (postTimer) return;
  postTimer = setInterval(() => postTick().catch(e => console.error('[scheduler] post tick error:', e)), TICK_MS);
  setTimeout(() => postTick().catch(() => {}), 3000);
  analyticsTimer = setInterval(() => analyticsTick().catch(e => console.error('[scheduler] analytics tick error:', e)), ANALYTICS_REFRESH_MS);
  setTimeout(() => analyticsTick().catch(() => {}), 60 * 1000);
}

module.exports = { start, postOne, countPostedLast24h, refreshAnalyticsForPin, analyticsTick };
