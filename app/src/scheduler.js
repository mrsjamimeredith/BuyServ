// Background worker that posts scheduled products, enforcing per-account
// rate limits. Runs inside the main Node process.

const db = require('./db');
const pinterest = require('./pinterest');
const { getAccountById, ensureFreshToken } = require('./auth');
const { addDisclosure } = require('./compliance');

const TICK_MS = 30 * 1000;
let timer = null;

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
  const pin = await pinterest.createPin(account.access_token, {
    title: product.title,
    description,
    boardId: product.board_id,
    imageUrl: product.image_url || undefined,
    imageData: product.image_data || undefined,
    imageMime: product.image_mime || undefined,
    link: product.affiliate_url
  });
  db.prepare(`
    UPDATE products
    SET status = 'posted', pinterest_pin_id = ?, posted_at = strftime('%s','now'), error = NULL
    WHERE id = ?
  `).run(pin.id, product.id);
  db.prepare('UPDATE accounts SET last_posted_at = strftime(\'%s\',\'now\') WHERE id = ?')
    .run(account.id);
  return pin;
}

async function tick() {
  const now = Math.floor(Date.now() / 1000);
  // Pull due and "post now" queued items.
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
      // Rate limit checks
      const postedToday = countPostedLast24h(accountId);
      if (postedToday >= (account.daily_pin_limit || 25)) break;
      if (account.last_posted_at &&
          now - account.last_posted_at < (account.min_seconds_between_pins || 120)) {
        break;
      }
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

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(e => console.error('[scheduler] tick error:', e)); }, TICK_MS);
  setTimeout(() => { tick().catch(() => {}); }, 3000);
}

module.exports = { start, postOne, countPostedLast24h };
