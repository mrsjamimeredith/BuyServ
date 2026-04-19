const crypto = require('crypto');
const db = require('./db');
const pinterest = require('./pinterest');
const { encrypt, decrypt } = require('./crypto');

// ---------- Password hashing ----------
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

// ---------- Users ----------
function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function listUsers() {
  return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all();
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function createUser(username, password, role = 'editor') {
  if (!username || !/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) {
    throw new Error('Username must be 2–32 chars, letters/numbers/._-');
  }
  if (!password || password.length < 10) throw new Error('Password must be at least 10 characters');
  if (!['admin', 'editor', 'viewer'].includes(role)) throw new Error('Invalid role');
  const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), role);
  return getUserById(info.lastInsertRowid);
}

function updateUser(id, { password, role }) {
  const u = getUserById(id);
  if (!u) throw new Error('User not found');
  if (password != null) {
    if (password.length < 10) throw new Error('Password must be at least 10 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
  }
  if (role != null) {
    if (!['admin', 'editor', 'viewer'].includes(role)) throw new Error('Invalid role');
    // Prevent removing the last admin
    if (u.role === 'admin' && role !== 'admin') {
      const admins = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get().n;
      if (admins <= 1) throw new Error('Cannot demote the last admin');
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }
  return getUserById(id);
}

function deleteUser(id) {
  const u = getUserById(id);
  if (!u) return;
  if (u.role === 'admin') {
    const admins = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get().n;
    if (admins <= 1) throw new Error('Cannot delete the last admin');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// ---------- Sessions ----------
const COOKIE_NAME = 'buyserv_sid';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, expires);
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

function currentUser(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token));
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  if (!row.user_id) return null;
  return getUserById(row.user_id);
}

function isAuthed(req) { return !!currentUser(req); }

function cleanupSessions() {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}

// ---------- Login rate limit (in-memory) ----------
const loginAttempts = new Map();
function recordLoginAttempt(ip, ok) {
  const rec = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  if (ok) { loginAttempts.delete(ip); return; }
  rec.count += 1;
  if (rec.count >= 5) rec.lockedUntil = Date.now() + 15 * 60 * 1000;
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

// ---------- Middleware ----------
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    if ((req.originalUrl || req.url).startsWith('/api/')) return res.status(401).json({ error: 'not_authenticated' });
    return res.redirect('/');
  }
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'insufficient_role' });
    next();
  };
}

function canWrite(user) { return user && (user.role === 'admin' || user.role === 'editor'); }
function canAdmin(user) { return user && user.role === 'admin'; }

function pickAccount(req) {
  const id = req.query.account_id || req.body?.account_id;
  if (id) return getAccountById(id);
  const all = allAccounts();
  return all[0] || null;
}

module.exports = {
  // password
  hashPassword, verifyPassword,
  // users
  userCount, listUsers, getUserById, getUserByUsername,
  createUser, updateUser, deleteUser,
  // sessions
  createSession, destroySession, isAuthed, currentUser, cleanupSessions,
  // rate limit
  recordLoginAttempt, isLoginLocked,
  // csrf
  csrfToken, csrfCheck,
  // accounts
  getAccountById, allAccounts, saveTokens, ensureFreshToken,
  // middleware
  requireAuth, requireRole, canWrite, canAdmin, pickAccount
};
