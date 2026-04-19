const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'buyserv.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pinterest_user_id TEXT UNIQUE,
    username TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_expires_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    image_url TEXT NOT NULL,
    affiliate_url TEXT NOT NULL,
    board_id TEXT,
    board_name TEXT,
    status TEXT DEFAULT 'draft',
    pinterest_pin_id TEXT,
    error TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    posted_at INTEGER,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );
`);

module.exports = db;
