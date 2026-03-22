const Database = require('better-sqlite3');

function createTestDb() {
  const db = new Database(':memory:');
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
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL REFERENCES users(id),
      title          TEXT    NOT NULL,
      description    TEXT,
      status         TEXT    NOT NULL DEFAULT 'active',
      notion_page_id TEXT,
      created_at     TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      title           TEXT    NOT NULL,
      description     TEXT,
      status          TEXT    NOT NULL DEFAULT 'not_started',
      priority        TEXT,
      category_id     INTEGER REFERENCES categories(id),
      plan_id         INTEGER REFERENCES plans(id),
      due_date        TEXT,
      notion_page_id  TEXT,
      waiting_reason  TEXT,
      waiting_until   TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subtasks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id         INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title           TEXT    NOT NULL,
      is_done         INTEGER NOT NULL DEFAULT 0,
      position        INTEGER NOT NULL DEFAULT 0,
      notion_block_id TEXT
    );
  `);

  // Тестовый пользователь
  db.prepare('INSERT INTO users (id, username) VALUES (1, \'testuser\')').run();

  return db;
}

module.exports = { createTestDb };
