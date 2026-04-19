const crypto = require('crypto');
const db = require('./db');
const pinterest = require('./pinterest');
const { encrypt, decrypt } = require('./crypto');

// ---------- Admin password ----------
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

function getAdmin() {
  return db.prepare('SELECT * FROM admin WHERE id = 1').get();
}

function setAdminPassword(password) {
  const hash = hashPassword(password);
  const existing = getAdmin();
  if (existing) {
    db.prepare('UPDATE admin SET password_hash = ? WHERE id = 1').run(hash);
  } else {
    db.prepare('INSERT INTO admin (id, password_hash) VALUES (1, ?)').run(hash);
  }
}

// ---------- Session cookies (random token, server-stored hash) ----------
const COOKIE_NAME = 'buyserv_sid';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').run(hashToken(token), expires);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_SECONDS * 1000
  });
}

function destroySession(req, res) {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.clearCookie(COOKIE_NAME);
}

function isAuthed(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return false;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token));
  if (!row) return false;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return false;
  }
  return true;
}

function cleanupSessions() {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}

// ---------- Login rate limit (in-memory) ----------
const loginAttempts = new Map();
function recordLoginAttempt(ip, ok) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  if (ok) { loginAttempts.delete(ip); return; }
  rec.count += 1;
  if (rec.count >= 5) rec.lockedUntil = now + 15 * 60 * 1000;
  loginAttempts.set(ip, rec);
}
function isLoginLocked(ip) {
  const rec = loginAttempts.get(ip);
  return !!(rec && rec.lockedUntil > Date.now());
}

// ---------- CSRF ----------
function csrfToken(req) {
  const sid = req.cookies?.[COOKIE_NAME];
  if (!sid) return null;
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(sid).digest('hex');
}

function csrfCheck(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const expected = csrfToken(req);
  const got = req.get('x-csrf-token');
  if (!expected || expected !== got) return res.status(403).json({ error: 'invalid_csrf' });
  next();
}

// ---------- Pinterest accounts ----------
function hydrateAccount(row) {
  if (!row) return null;
  return {
    ...row,
    access_token: decrypt(row.access_token),
    refresh_token: row.refresh_token ? decrypt(row.refresh_token) : null
  };
}

function getAccountById(id) {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(id));
  return hydrateAccount(row);
}

function allAccounts() {
  return db.prepare('SELECT * FROM accounts ORDER BY id').all().map(hydrateAccount);
}

function saveTokens(accountId, { accessToken, refreshToken, expiresAt }) {
  db.prepare(`
    UPDATE accounts
    SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ?
    WHERE id = ?
  `).run(
    encrypt(accessToken),
    refreshToken ? encrypt(refreshToken) : null,
    expiresAt,
    accountId
  );
}

async function ensureFreshToken(account) {
  const now = Math.floor(Date.now() / 1000);
  if (account.token_expires_at && account.token_expires_at - 60 > now) return account;
  if (!account.refresh_token) return account;
  const tok = await pinterest.refreshToken(account.refresh_token);
  const expires = Math.floor(Date.now() / 1000) + (tok.expires_in || 2592000);
  saveTokens(account.id, {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || null,
    expiresAt: expires
  });
  return { ...account, access_token: tok.access_token, token_expires_at: expires };
}

function requireAuth(req, res, next) {
  if (!isAuthed(req)) {
    if ((req.originalUrl || req.url).startsWith('/api/')) {
      return res.status(401).json({ error: 'not_authenticated' });
    }
    return res.redirect('/');
  }
  next();
}

function pickAccount(req) {
  const id = req.query.account_id || req.body?.account_id;
  if (id) return getAccountById(id);
  const all = allAccounts();
  return all[0] || null;
}

module.exports = {
  // admin
  getAdmin, setAdminPassword, verifyPassword,
  // sessions
  createSession, destroySession, isAuthed, cleanupSessions,
  // rate limit
  recordLoginAttempt, isLoginLocked,
  // csrf
  csrfToken, csrfCheck,
  // accounts
  getAccountById, allAccounts, saveTokens, ensureFreshToken,
  // middleware
  requireAuth, pickAccount
};
