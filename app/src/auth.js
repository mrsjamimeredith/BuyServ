const crypto = require('crypto');
const db = require('./db');
const pinterest = require('./pinterest');

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

function setAccountCookie(res, accountId) {
  const secret = process.env.SESSION_SECRET;
  const sig = sign(accountId, secret);
  res.cookie('buyserv_session', `${accountId}.${sig}`, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30
  });
}

function getAccountFromReq(req) {
  const raw = req.cookies?.buyserv_session;
  if (!raw) return null;
  const [id, sig] = raw.split('.');
  if (!id || !sig) return null;
  const expected = sign(id, process.env.SESSION_SECRET);
  if (expected !== sig) return null;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(id));
  return account || null;
}

async function ensureFreshToken(account) {
  const now = Math.floor(Date.now() / 1000);
  if (account.token_expires_at && account.token_expires_at - 60 > now) {
    return account;
  }
  if (!account.refresh_token) return account;
  const tok = await pinterest.refreshToken(account.refresh_token);
  const expires = Math.floor(Date.now() / 1000) + (tok.expires_in || 2592000);
  db.prepare(`
    UPDATE accounts
    SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ?
    WHERE id = ?
  `).run(tok.access_token, tok.refresh_token || null, expires, account.id);
  return { ...account, access_token: tok.access_token, token_expires_at: expires };
}

function requireAuth(req, res, next) {
  const account = getAccountFromReq(req);
  if (!account) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not_authenticated' });
    return res.redirect('/');
  }
  req.account = account;
  next();
}

module.exports = { setAccountCookie, getAccountFromReq, ensureFreshToken, requireAuth };
