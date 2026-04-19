const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'buyserv.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pinterest_user_id TEXT UNIQUE,
    username TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_expires_at INTEGER,
    daily_pin_limit INTEGER DEFAULT 25,
    min_seconds_between_pins INTEGER DEFAULT 120,
    auto_disclose INTEGER DEFAULT 1,
    last_posted_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    image_url TEXT,
    image_data TEXT,
    image_mime TEXT,
    affiliate_url TEXT NOT NULL,
    board_id TEXT,
    board_name TEXT,
    status TEXT DEFAULT 'draft',
    pinterest_pin_id TEXT,
    scheduled_for INTEGER,
    error TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    posted_at INTEGER,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_products_scheduled
    ON products(status, scheduled_for);
`);

function addColumnIfMissing(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.length && !cols.find(c => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}
addColumnIfMissing('accounts', 'daily_pin_limit', 'INTEGER DEFAULT 25');
addColumnIfMissing('accounts', 'min_seconds_between_pins', 'INTEGER DEFAULT 120');
addColumnIfMissing('accounts', 'auto_disclose', 'INTEGER DEFAULT 1');
addColumnIfMissing('accounts', 'last_posted_at', 'INTEGER');
addColumnIfMissing('products', 'image_data', 'TEXT');
addColumnIfMissing('products', 'image_mime', 'TEXT');
addColumnIfMissing('products', 'scheduled_for', 'INTEGER');
addColumnIfMissing('products', 'media_type', "TEXT DEFAULT 'image'");
addColumnIfMissing('products', 'video_data', 'TEXT');
addColumnIfMissing('products', 'video_mime', 'TEXT');
addColumnIfMissing('products', 'cover_image_data', 'TEXT');
addColumnIfMissing('products', 'cover_image_mime', 'TEXT');
addColumnIfMissing('products', 'impressions', 'INTEGER');
addColumnIfMissing('products', 'saves', 'INTEGER');
addColumnIfMissing('products', 'pin_clicks', 'INTEGER');
addColumnIfMissing('products', 'outbound_clicks', 'INTEGER');
addColumnIfMissing('products', 'last_analytics_at', 'INTEGER');
addColumnIfMissing('sessions', 'user_id', 'INTEGER');

// one-time migration: if legacy admin table has a password and users is empty,
// seed a default admin user from it.
try {
  const legacy = db.prepare('SELECT password_hash FROM admin WHERE id = 1').get();
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (legacy && !hasUsers) {
    db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')`)
      .run('admin', legacy.password_hash);
  }
} catch { /* tables may not exist yet on first run */ }

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value == null ? null : String(value));
}

module.exports = db;
module.exports.getSetting = getSetting;
module.exports.setSetting = setSetting;
