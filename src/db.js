const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const dbFile = process.env.DEV === 'true' ? 'data_dev.db' : 'data.db';
const db = new Database(path.join(__dirname, '..', dbFile));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY,
    username   TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name    TEXT    NOT NULL,
    color   TEXT,
    UNIQUE(user_id, name)
  );

  CREATE TABLE IF NOT EXISTS plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    title       TEXT    NOT NULL,
    description TEXT,
    status      TEXT    NOT NULL DEFAULT 'active',
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    title       TEXT    NOT NULL,
    description TEXT,
    status      TEXT    NOT NULL DEFAULT 'not_started',
    priority    TEXT,
    category_id INTEGER REFERENCES categories(id),
    plan_id     INTEGER REFERENCES plans(id),
    due_date        TEXT,
    notion_page_id  TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS subtasks (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title    TEXT    NOT NULL,
    is_done  INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sync_errors (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    message    TEXT    NOT NULL,
    created_at TEXT    DEFAULT (datetime('now'))
  );
`);

// Миграции — добавляем колонки если их нет
try { db.exec(`ALTER TABLE tasks ADD COLUMN notion_page_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE plans ADD COLUMN notion_page_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE subtasks ADD COLUMN notion_block_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN waiting_reason TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN waiting_until DATE`); } catch {}

module.exports = db;
