require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { parse: csvParse } = require('csv-parse/sync');

const db = require('./db');
const pinterest = require('./pinterest');
const { setAccountCookie, getAccountFromReq, ensureFreshToken, requireAuth } = require('./auth');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

const oauthStates = new Map();

function checkEnv() {
  const missing = ['PINTEREST_CLIENT_ID', 'PINTEREST_CLIENT_SECRET', 'REDIRECT_URI', 'SESSION_SECRET']
    .filter(k => !process.env[k]);
  return missing;
}

app.get('/api/config', (req, res) => {
  const missing = checkEnv();
  const account = getAccountFromReq(req);
  res.json({
    ready: missing.length === 0,
    missing,
    signedIn: !!account,
    username: account?.username || null
  });
});

app.get('/auth/login', (req, res) => {
  const missing = checkEnv();
  if (missing.length) return res.status(500).send(`Missing env vars: ${missing.join(', ')}`);
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now());
  res.redirect(pinterest.authUrl(state));
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || !oauthStates.has(state)) {
      return res.status(400).send('Invalid OAuth state.');
    }
    oauthStates.delete(state);
    const tok = await pinterest.exchangeCode(code);
    const expires = Math.floor(Date.now() / 1000) + (tok.expires_in || 2592000);
    const user = await pinterest.getUser(tok.access_token);
    const existing = db.prepare('SELECT * FROM accounts WHERE pinterest_user_id = ?').get(user.id);
    let accountId;
    if (existing) {
      db.prepare(`
        UPDATE accounts
        SET access_token = ?, refresh_token = ?, token_expires_at = ?, username = ?
        WHERE id = ?
      `).run(tok.access_token, tok.refresh_token || null, expires, user.username || null, existing.id);
      accountId = existing.id;
    } else {
      const info = db.prepare(`
        INSERT INTO accounts (pinterest_user_id, username, access_token, refresh_token, token_expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(user.id, user.username || null, tok.access_token, tok.refresh_token || null, expires);
      accountId = info.lastInsertRowid;
    }
    setAccountCookie(res, accountId);
    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send(`OAuth failed: ${err.message}`);
  }
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('buyserv_session');
  res.json({ ok: true });
});

app.get('/api/boards', requireAuth, async (req, res) => {
  try {
    const acct = await ensureFreshToken(req.account);
    const boards = await pinterest.listBoards(acct.access_token);
    res.json(boards.map(b => ({ id: b.id, name: b.name, privacy: b.privacy })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/boards', requireAuth, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const acct = await ensureFreshToken(req.account);
    const board = await pinterest.createBoard(acct.access_token, name, description || '');
    res.json({ id: board.id, name: board.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM products WHERE account_id = ? ORDER BY id DESC LIMIT 500
  `).all(req.account.id);
  res.json(rows);
});

app.post('/api/products', requireAuth, (req, res) => {
  const { title, description, image_url, affiliate_url, board_id, board_name } = req.body;
  if (!title || !image_url || !affiliate_url) {
    return res.status(400).json({ error: 'title, image_url, affiliate_url required' });
  }
  const info = db.prepare(`
    INSERT INTO products (account_id, title, description, image_url, affiliate_url, board_id, board_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.account.id, title, description || '', image_url, affiliate_url, board_id || null, board_name || null);
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
  res.json(row);
});

app.delete('/api/products/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ? AND account_id = ?').run(req.params.id, req.account.id);
  res.json({ ok: true });
});

async function postProduct(accessToken, product) {
  if (!product.board_id) throw new Error('No board selected.');
  const pin = await pinterest.createPin(accessToken, {
    title: product.title,
    description: product.description,
    boardId: product.board_id,
    imageUrl: product.image_url,
    link: product.affiliate_url
  });
  return pin;
}

app.post('/api/products/:id/post', requireAuth, async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND account_id = ?')
    .get(req.params.id, req.account.id);
  if (!product) return res.status(404).json({ error: 'not found' });
  try {
    const acct = await ensureFreshToken(req.account);
    const pin = await postProduct(acct.access_token, product);
    db.prepare(`
      UPDATE products
      SET status = 'posted', pinterest_pin_id = ?, posted_at = strftime('%s','now'), error = NULL
      WHERE id = ?
    `).run(pin.id, product.id);
    res.json({ ok: true, pin_id: pin.id });
  } catch (err) {
    db.prepare('UPDATE products SET status = ?, error = ? WHERE id = ?')
      .run('failed', err.message, product.id);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products/post-all', requireAuth, async (req, res) => {
  const pending = db.prepare(`
    SELECT * FROM products WHERE account_id = ? AND status IN ('draft','failed')
  `).all(req.account.id);
  const results = [];
  try {
    const acct = await ensureFreshToken(req.account);
    for (const p of pending) {
      try {
        const pin = await postProduct(acct.access_token, p);
        db.prepare(`
          UPDATE products
          SET status = 'posted', pinterest_pin_id = ?, posted_at = strftime('%s','now'), error = NULL
          WHERE id = ?
        `).run(pin.id, p.id);
        results.push({ id: p.id, ok: true, pin_id: pin.id });
      } catch (err) {
        db.prepare('UPDATE products SET status = ?, error = ? WHERE id = ?')
          .run('failed', err.message, p.id);
        results.push({ id: p.id, ok: false, error: err.message });
      }
    }
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products/import-csv', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  let rows;
  try {
    rows = csvParse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
  } catch (err) {
    return res.status(400).json({ error: `CSV parse failed: ${err.message}` });
  }

  const defaultBoardId = req.body.board_id || null;
  const defaultBoardName = req.body.board_name || null;

  const insert = db.prepare(`
    INSERT INTO products (account_id, title, description, image_url, affiliate_url, board_id, board_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

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
      if (!title || !image || !link) {
        skipped.push({ row, reason: 'missing title/image/link' });
        continue;
      }
      insert.run(req.account.id, title, desc, image, link, boardId, boardName);
      added += 1;
    }
  });
  tx();

  res.json({ added, skipped: skipped.length });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  const missing = checkEnv();
  console.log(`\nBuyServ Pinterest Poster running on http://localhost:${port}`);
  if (missing.length) {
    console.log(`\n  ! Missing env vars: ${missing.join(', ')}`);
    console.log('    Copy .env.example to .env and fill in values.\n');
  }
});
