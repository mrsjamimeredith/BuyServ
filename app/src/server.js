require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { parse: csvParse } = require('csv-parse/sync');

const db = require('./db');
const pinterest = require('./pinterest');
const scraper = require('./scraper');
const aiImage = require('./aiImage');
const amazon = require('./amazon');
const compliance = require('./compliance');
const scheduler = require('./scheduler');
const { encrypt } = require('./crypto');
const auth = require('./auth');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const videoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '75mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Auto-clean expired sessions hourly.
setInterval(() => auth.cleanupSessions(), 60 * 60 * 1000);

// Public static after dynamic routes that might intercept /.
const publicDir = path.join(__dirname, '..', 'public');

// ---------- OAuth state ----------
const oauthStates = new Map();

function checkEnv() {
  return ['PINTEREST_CLIENT_ID', 'PINTEREST_CLIENT_SECRET', 'REDIRECT_URI', 'SESSION_SECRET']
    .filter(k => !process.env[k]);
}

// ---------- Public endpoints (no auth) ----------
app.get('/api/config', (req, res) => {
  const missingEnv = checkEnv();
  const setupDone = auth.userCount() > 0;
  const me = auth.currentUser(req);
  res.json({
    ready: missingEnv.length === 0 && setupDone,
    missingEnv,
    setupDone,
    signedIn: !!me,
    me: me ? { id: me.id, username: me.username, role: me.role } : null,
    aiImageConfigured: aiImage.isConfigured(),
    amazonConfigured: amazon.isConfigured()
  });
});

app.post('/api/setup', (req, res) => {
  if (auth.userCount() > 0) return res.status(400).json({ error: 'already_setup' });
  try {
    const { username, password } = req.body || {};
    const user = auth.createUser(username || 'admin', password, 'admin');
    auth.createSession(res, user.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (auth.isLoginLocked(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  if (auth.userCount() === 0) return res.status(400).json({ error: 'not_setup' });
  const { username, password } = req.body || {};
  const user = username ? auth.getUserByUsername(username) : null;
  const ok = user && password && auth.verifyPassword(password, user.password_hash);
  auth.recordLoginAttempt(ip, !!ok);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
  auth.createSession(res, user.id);
  res.json({ ok: true, role: user.role });
});

app.post('/api/logout', (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

// ---------- Everything below requires auth ----------
app.use('/api', (req, res, next) => {
  const open = ['/api/config', '/api/setup', '/api/login', '/api/logout'];
  if (open.includes(req.path)) return next();
  return auth.requireAuth(req, res, next);
});
app.use('/api', auth.csrfCheck);

app.get('/api/csrf', (req, res) => res.json({ token: auth.csrfToken(req) }));

// ---------- User management (admin only) ----------
app.get('/api/users', auth.requireRole('admin'), (req, res) => res.json(auth.listUsers()));

app.post('/api/users', auth.requireRole('admin'), (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    const u = auth.createUser(username, password, role || 'editor');
    res.json({ id: u.id, username: u.username, role: u.role });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.patch('/api/users/:id', auth.requireRole('admin'), (req, res) => {
  try {
    const { password, role } = req.body || {};
    const u = auth.updateUser(req.params.id, { password, role });
    res.json({ id: u.id, username: u.username, role: u.role });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/users/:id', auth.requireRole('admin'), (req, res) => {
  try {
    if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'cannot_delete_self' });
    auth.deleteUser(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/me/password', (req, res) => {
  const { current, next: nxt } = req.body || {};
  if (!auth.verifyPassword(current || '', req.user.password_hash)) {
    return res.status(401).json({ error: 'current password incorrect' });
  }
  try { auth.updateUser(req.user.id, { password: nxt }); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ---------- Pinterest OAuth ----------
app.get('/auth/connect', (req, res) => {
  const me = auth.currentUser(req);
  if (!me) return res.redirect('/');
  if (me.role !== 'admin') return res.status(403).send('Only admins can connect Pinterest accounts.');
  const missing = checkEnv();
  if (missing.length) return res.status(500).send(`Missing env vars: ${missing.join(', ')}`);
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now());
  res.redirect(pinterest.authUrl(state));
});

app.get('/auth/callback', async (req, res) => {
  try {
    const me = auth.currentUser(req);
    if (!me) return res.redirect('/');
    if (me.role !== 'admin') return res.status(403).send('Only admins can connect Pinterest accounts.');
    const { code, state } = req.query;
    if (!code || !state || !oauthStates.has(state)) return res.status(400).send('Invalid OAuth state.');
    oauthStates.delete(state);
    const tok = await pinterest.exchangeCode(code);
    const expires = Math.floor(Date.now() / 1000) + (tok.expires_in || 2592000);
    const user = await pinterest.getUser(tok.access_token);
    const existing = db.prepare('SELECT * FROM accounts WHERE pinterest_user_id = ?').get(user.id);
    if (existing) {
      auth.saveTokens(existing.id, {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token || null,
        expiresAt: expires
      });
      db.prepare('UPDATE accounts SET username = ? WHERE id = ?').run(user.username || null, existing.id);
    } else {
      db.prepare(`
        INSERT INTO accounts (pinterest_user_id, username, access_token, refresh_token, token_expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        user.id,
        user.username || null,
        encrypt(tok.access_token),
        tok.refresh_token ? encrypt(tok.refresh_token) : null,
        expires
      );
    }
    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send(`OAuth failed: ${err.message}`);
  }
});

// ---------- Accounts ----------
app.get('/api/accounts', (req, res) => {
  const rows = auth.allAccounts().map(a => ({
    id: a.id,
    username: a.username,
    daily_pin_limit: a.daily_pin_limit,
    min_seconds_between_pins: a.min_seconds_between_pins,
    auto_disclose: !!a.auto_disclose,
    posted_last_24h: scheduler.countPostedLast24h(a.id)
  }));
  res.json(rows);
});

app.patch('/api/accounts/:id', auth.requireRole('admin'), (req, res) => {
  const { daily_pin_limit, min_seconds_between_pins, auto_disclose } = req.body || {};
  const fields = [];
  const vals = [];
  if (daily_pin_limit != null) { fields.push('daily_pin_limit = ?'); vals.push(Math.max(1, Math.min(200, Number(daily_pin_limit)))); }
  if (min_seconds_between_pins != null) { fields.push('min_seconds_between_pins = ?'); vals.push(Math.max(30, Math.min(86400, Number(min_seconds_between_pins)))); }
  if (auto_disclose != null) { fields.push('auto_disclose = ?'); vals.push(auto_disclose ? 1 : 0); }
  if (!fields.length) return res.json({ ok: true });
  vals.push(req.params.id);
  db.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

app.delete('/api/accounts/:id', auth.requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Boards ----------
app.get('/api/boards', async (req, res) => {
  const account = auth.pickAccount(req);
  if (!account) return res.json([]);
  try {
    const acct = await auth.ensureFreshToken(account);
    const boards = await pinterest.listBoards(acct.access_token);
    res.json(boards.map(b => ({ id: b.id, name: b.name, privacy: b.privacy })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/boards', auth.requireRole('admin', 'editor'), async (req, res) => {
  const account = auth.pickAccount(req);
  if (!account) return res.status(400).json({ error: 'no_account' });
  try {
    const { name, description } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const acct = await auth.ensureFreshToken(account);
    const board = await pinterest.createBoard(acct.access_token, name, description || '');
    res.json({ id: board.id, name: board.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Products ----------
app.get('/api/products', (req, res) => {
  const accountId = req.query.account_id;
  const cols = `id, account_id, title, description, image_url, affiliate_url,
    board_id, board_name, status, pinterest_pin_id, scheduled_for, error,
    created_at, posted_at, media_type,
    (image_data IS NOT NULL) AS has_image_data,
    (video_data IS NOT NULL) AS has_video_data,
    (cover_image_data IS NOT NULL) AS has_cover_image,
    impressions, saves, pin_clicks, outbound_clicks, last_analytics_at`;
  const rows = accountId
    ? db.prepare(`SELECT ${cols} FROM products WHERE account_id = ? ORDER BY id DESC LIMIT 500`).all(accountId)
    : db.prepare(`SELECT ${cols} FROM products ORDER BY id DESC LIMIT 500`).all();
  res.json(rows);
});

function insertProduct({ accountId, title, description, image_url, image_data, image_mime, affiliate_url, board_id, board_name, scheduled_for, media_type, video_data, video_mime, cover_image_data, cover_image_mime }) {
  const info = db.prepare(`
    INSERT INTO products (
      account_id, title, description,
      image_url, image_data, image_mime,
      affiliate_url, board_id, board_name,
      scheduled_for, status,
      media_type, video_data, video_mime, cover_image_data, cover_image_mime
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId, title, description || '',
    image_url || null, image_data || null, image_mime || null,
    affiliate_url, board_id || null, board_name || null,
    scheduled_for || null, scheduled_for ? 'scheduled' : 'draft',
    media_type || 'image', video_data || null, video_mime || null,
    cover_image_data || null, cover_image_mime || null
  );
  return db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
}

const productUpload = videoUpload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'video', maxCount: 1 },
  { name: 'cover_image', maxCount: 1 }
]);

app.post('/api/products', auth.requireRole('admin', 'editor'), productUpload, (req, res) => {
  const account = auth.pickAccount(req);
  if (!account) return res.status(400).json({ error: 'no_account' });

  const body = req.body || {};
  const files = req.files || {};

  let image_data = null, image_mime = null;
  if (files.image?.[0]) {
    image_data = files.image[0].buffer.toString('base64');
    image_mime = files.image[0].mimetype || 'image/jpeg';
  } else if (body.image_base64) {
    image_data = body.image_base64;
    image_mime = body.image_mime || 'image/png';
  }

  let video_data = null, video_mime = null;
  if (files.video?.[0]) {
    video_data = files.video[0].buffer.toString('base64');
    video_mime = files.video[0].mimetype || 'video/mp4';
  }

  let cover_image_data = null, cover_image_mime = null;
  if (files.cover_image?.[0]) {
    cover_image_data = files.cover_image[0].buffer.toString('base64');
    cover_image_mime = files.cover_image[0].mimetype || 'image/jpeg';
  } else if (body.cover_image_base64) {
    cover_image_data = body.cover_image_base64;
    cover_image_mime = body.cover_image_mime || 'image/png';
  }

  const isVideo = !!video_data;
  if (isVideo && !cover_image_data && !body.image_url) {
    return res.status(400).json({ error: 'Video pins require a cover image (upload or URL)' });
  }

  const payload = {
    accountId: account.id,
    title: body.title,
    description: body.description,
    image_url: body.image_url,
    image_data,
    image_mime,
    affiliate_url: body.affiliate_url,
    board_id: body.board_id,
    board_name: body.board_name,
    scheduled_for: body.scheduled_for ? Number(body.scheduled_for) : null,
    media_type: isVideo ? 'video' : 'image',
    video_data,
    video_mime,
    cover_image_data,
    cover_image_mime
  };
  const errs = compliance.validateProduct(payload);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  const row = insertProduct(payload);
  // Strip large blobs from response
  const { video_data: _vd, cover_image_data: _cid, image_data: _id, ...safe } = row;
  res.json(safe);
});

app.delete('/api/products/:id', auth.requireRole('admin', 'editor'), (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/products/:id/post', auth.requireRole('admin', 'editor'), async (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const account = auth.getAccountById(p.account_id);
  if (!account) return res.status(400).json({ error: 'account_gone' });
  try {
    const acct = await auth.ensureFreshToken(account);
    await scheduler.postOne(p, acct);
    res.json({ ok: true });
  } catch (err) {
    db.prepare('UPDATE products SET status = ?, error = ? WHERE id = ?')
      .run('failed', err.message, p.id);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products/:id/schedule', auth.requireRole('admin', 'editor'), (req, res) => {
  const { scheduled_for } = req.body || {};
  const ts = Number(scheduled_for);
  if (!ts || ts < Math.floor(Date.now() / 1000) - 60) {
    return res.status(400).json({ error: 'scheduled_for must be a future unix timestamp' });
  }
  db.prepare(`UPDATE products SET status = 'scheduled', scheduled_for = ?, error = NULL WHERE id = ?`)
    .run(ts, req.params.id);
  res.json({ ok: true });
});

app.post('/api/products/queue-all', auth.requireRole('admin', 'editor'), (req, res) => {
  const accountId = req.body?.account_id;
  const where = accountId ? 'account_id = ? AND ' : '';
  const vals = accountId ? [accountId] : [];
  const info = db.prepare(`
    UPDATE products SET status = 'queued', scheduled_for = NULL, error = NULL
    WHERE ${where}status IN ('draft','failed')
  `).run(...vals);
  res.json({ queued: info.changes });
});

// ---------- CSV import ----------
app.post('/api/products/import-csv', auth.requireRole('admin', 'editor'), upload.single('file'), (req, res) => {
  const account = auth.pickAccount(req);
  if (!account) return res.status(400).json({ error: 'no_account' });
  if (!req.file) return res.status(400).json({ error: 'file required' });

  let rows;
  try {
    rows = csvParse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ error: `CSV parse failed: ${err.message}` });
  }

  const defaultBoardId = req.body.board_id || null;
  const defaultBoardName = req.body.board_name || null;

  const pick = (row, ...keys) => {
    for (const k of keys) {
      if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
    }
    return '';
  };

  let added = 0;
  const skipped = [];
  const tx = db.transaction(() => {
    for (const row of rows) {
      const title = pick(row, 'title', 'Title', 'name', 'Name');
      const image = pick(row, 'image_url', 'image', 'Image', 'Image URL');
      const link = pick(row, 'affiliate_url', 'link', 'url', 'URL', 'Link');
      const desc = pick(row, 'description', 'Description');
      const boardId = pick(row, 'board_id', 'Board ID') || defaultBoardId;
      const boardName = pick(row, 'board', 'board_name', 'Board') || defaultBoardName;
      if (!title || !image || !link) { skipped.push({ row, reason: 'missing title/image/link' }); continue; }
      insertProduct({
        accountId: account.id, title, description: desc, image_url: image,
        affiliate_url: link, board_id: boardId, board_name: boardName
      });
      added += 1;
    }
  });
  tx();
  res.json({ added, skipped: skipped.length });
});

// ---------- URL scrape ----------
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'valid URL required' });
  try {
    const data = await scraper.scrape(url);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scrape/bulk', async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: 'urls array required' });
  const results = [];
  for (const url of urls.slice(0, 50)) {
    try { results.push({ ok: true, ...(await scraper.scrape(url)) }); }
    catch (err) { results.push({ ok: false, url, error: err.message }); }
  }
  res.json({ results });
});

// ---------- Analytics ----------
app.post('/api/products/:id/analytics/refresh', async (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  if (!p.pinterest_pin_id) return res.status(400).json({ error: 'not_posted' });
  const account = auth.getAccountById(p.account_id);
  if (!account) return res.status(400).json({ error: 'account_gone' });
  try {
    const acct = await auth.ensureFreshToken(account);
    const result = await scheduler.refreshAnalyticsForPin(acct, p);
    if (!result) return res.status(500).json({ error: 'analytics fetch failed — see server logs' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/analytics/refresh-all', async (req, res) => {
  try {
    await scheduler.analyticsTick();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/accounts/:id/analytics', async (req, res) => {
  const account = auth.getAccountById(req.params.id);
  if (!account) return res.status(404).json({ error: 'not_found' });
  try {
    const acct = await auth.ensureFreshToken(account);
    const days = Math.max(1, Math.min(180, Number(req.query.days) || 30));
    const data = await pinterest.getUserAnalytics(acct.access_token, days);
    const bucket = data?.ALL || data?.all || data;
    const sums = bucket?.summary_metrics || bucket?.lifetime_metrics || {};
    res.json({
      days,
      impressions: Number(sums.IMPRESSION || 0),
      saves: Number(sums.SAVE || 0),
      pin_clicks: Number(sums.PIN_CLICK || 0),
      outbound_clicks: Number(sums.OUTBOUND_CLICK || 0),
      raw: bucket
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Amazon PA-API ----------
app.get('/api/amazon/config', auth.requireRole('admin'), (req, res) => {
  const c = amazon.getCreds();
  res.json({
    configured: !!c,
    associate_tag: c?.associate_tag || null,
    marketplace: c?.marketplace || null,
    // never send the secret back
    access_key_masked: c?.access_key ? c.access_key.slice(0, 4) + '…' + c.access_key.slice(-4) : null,
    marketplaces: Object.keys(amazon.MARKETPLACES)
  });
});

app.post('/api/amazon/config', auth.requireRole('admin'), (req, res) => {
  try {
    amazon.saveCreds(req.body || {});
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/amazon/config', auth.requireRole('admin'), (req, res) => {
  amazon.clearCreds();
  res.json({ ok: true });
});

app.post('/api/amazon/test', auth.requireRole('admin'), async (req, res) => {
  try {
    const r = await amazon.test();
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/amazon/search', auth.requireRole('admin', 'editor'), async (req, res) => {
  try {
    const { q, index, page } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const items = await amazon.searchItems(q, {
      itemCount: 10,
      itemPage: Number(page) || 1,
      searchIndex: index || 'All'
    });
    res.json({ items });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/amazon/import', auth.requireRole('admin', 'editor'), (req, res) => {
  const account = auth.pickAccount(req);
  if (!account) return res.status(400).json({ error: 'no_account' });
  const { items, board_id, board_name } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items required' });
  let added = 0;
  const tx = db.transaction(() => {
    for (const it of items) {
      if (!it.title || !it.image_url || !it.url) continue;
      insertProduct({
        accountId: account.id,
        title: String(it.title).slice(0, 100),
        description: (it.description || '').slice(0, 500),
        image_url: it.image_url,
        affiliate_url: it.url,
        board_id: board_id || null,
        board_name: board_name || null
      });
      added += 1;
    }
  });
  tx();
  res.json({ added });
});

// ---------- AI image generation ----------
app.post('/api/ai/image', async (req, res) => {
  try {
    const { prompt, size } = req.body || {};
    if (!prompt || prompt.length < 5) return res.status(400).json({ error: 'prompt required' });
    const { data, mime } = await aiImage.generate({ prompt, size });
    res.json({ image_base64: data, image_mime: mime });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Pages ----------
app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.use(express.static(publicDir));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  const missing = checkEnv();
  console.log(`\nBuyServ Pinterest Poster on http://localhost:${port}`);
  if (missing.length) {
    console.log(`\n  ! Missing env vars: ${missing.join(', ')}`);
    console.log('    Copy .env.example to .env and fill in values.\n');
  }
  scheduler.start();
  console.log('  Scheduler started (30s tick).');
});
