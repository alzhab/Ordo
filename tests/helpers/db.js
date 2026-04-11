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

    CREATE TABLE IF NOT EXISTS goals (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL REFERENCES users(id),
      title          TEXT    NOT NULL,
      description    TEXT,
      status         TEXT    NOT NULL DEFAULT 'active',
      notion_page_id TEXT,
      created_at     TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL REFERENCES users(id),
      title               TEXT    NOT NULL,
      description         TEXT,
      status              TEXT    NOT NULL DEFAULT 'todo',
      category_id         INTEGER REFERENCES categories(id),
      goal_id             INTEGER REFERENCES goals(id),
      planned_for         TEXT,
      notion_page_id      TEXT,
      waiting_reason      TEXT,
      waiting_until       TEXT,
      reminder_at         TEXT,
      reminder_sent       INTEGER NOT NULL DEFAULT 0,
      is_recurring        INTEGER NOT NULL DEFAULT 0,
      recur_days          TEXT,
      recur_day_of_month  INTEGER,
      recur_time          TEXT,
      recur_remind_before INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT DEFAULT (datetime('now')),
      updated_at          TEXT DEFAULT (datetime('now'))
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id         INTEGER PRIMARY KEY REFERENCES users(id),
      morning_time    TEXT    NOT NULL DEFAULT '09:00',
      evening_time    TEXT    NOT NULL DEFAULT '21:00',
      timezone        TEXT    NOT NULL DEFAULT 'Asia/Oral',
      morning_enabled INTEGER NOT NULL DEFAULT 1,
      review_enabled  INTEGER NOT NULL DEFAULT 1,
      quiet_until     TEXT,
      notion_enabled  INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notification_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL REFERENCES users(id),
      type      TEXT    NOT NULL,
      task_id   INTEGER REFERENCES tasks(id),
      sent_at   TEXT    DEFAULT (datetime('now')),
      reacted   INTEGER NOT NULL DEFAULT 0
    );

  `);

  // Тестовый пользователь
  db.prepare('INSERT INTO users (id, username) VALUES (1, \'testuser\')').run();

  return db;
}

module.exports = { createTestDb };
