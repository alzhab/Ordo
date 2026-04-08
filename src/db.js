const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const dbFile = process.env.DEV === 'true' ? 'data_dev.db' : 'data.db';
const dbDir  = process.env.DATA_DIR || path.join(__dirname, '..');
fs.mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, dbFile);
console.log(`[db] opening ${dbPath}`);
const db = new Database(dbPath);

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
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    title       TEXT    NOT NULL,
    description TEXT,
    status      TEXT    NOT NULL DEFAULT 'not_started',
    priority    TEXT,
    category_id INTEGER REFERENCES categories(id),
    goal_id     INTEGER REFERENCES goals(id),
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

// Миграция — переименование plans → goals, plan_id → goal_id
try { db.exec(`ALTER TABLE goals ADD COLUMN notion_page_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks RENAME COLUMN plan_id TO goal_id`); } catch {}

// Если plans ещё существует (старый деплой) — копируем данные в goals и удаляем plans
try {
  const plansExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='plans'`).get();
  if (plansExists) {
    db.exec(`INSERT OR IGNORE INTO goals (id, user_id, title, description, status, notion_page_id, created_at)
             SELECT id, user_id, title, description, status, notion_page_id, created_at FROM plans`);
    db.exec(`DROP TABLE plans`);
  }
} catch (e) { console.error('[db] plans migration error:', e.message); }

// Фаза 7 — настройки пользователя и лог уведомлений
db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id),
    morning_time  TEXT    NOT NULL DEFAULT '09:00',
    evening_time  TEXT    NOT NULL DEFAULT '21:00',
    timezone      TEXT    NOT NULL DEFAULT 'Asia/Oral',
    morning_enabled INTEGER NOT NULL DEFAULT 1,
    review_enabled  INTEGER NOT NULL DEFAULT 1,
    quiet_until   TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS recurrent_tasks (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                 INTEGER NOT NULL REFERENCES users(id),
    title                   TEXT    NOT NULL,
    event_time              TEXT    NOT NULL,
    days                    TEXT,
    day_of_month            INTEGER,
    reminder_before_minutes INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT    DEFAULT (datetime('now'))
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

// Миграция — notion_enabled для отключения синка на уровне пользователя
try { db.exec(`ALTER TABLE user_settings ADD COLUMN notion_enabled INTEGER NOT NULL DEFAULT 1`); } catch {}

// Миграции — напоминания для обычных задач
try { db.exec(`ALTER TABLE tasks ADD COLUMN reminder_at TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0`); } catch {}

// Миграция — due_date → planned_for
try { db.exec(`ALTER TABLE tasks RENAME COLUMN due_date TO planned_for`); } catch {}

// Миграция — пересоздаём tasks если FK всё ещё указывает на plans (а не goals)
try {
  const tasksDef = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`).get();
  if (tasksDef && tasksDef.sql.includes('plans')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE tasks_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL REFERENCES users(id),
        title           TEXT    NOT NULL,
        description     TEXT,
        status          TEXT    NOT NULL DEFAULT 'todo',
        priority        TEXT,
        category_id     INTEGER REFERENCES categories(id),
        goal_id         INTEGER REFERENCES goals(id),
        planned_for     TEXT,
        notion_page_id  TEXT,
        waiting_reason  TEXT,
        waiting_until   TEXT,
        reminder_at     TEXT,
        reminder_sent   INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO tasks_new
        (id, user_id, title, description, status, priority, category_id,
         goal_id, planned_for, notion_page_id, waiting_reason, waiting_until,
         reminder_at, reminder_sent, created_at, updated_at)
      SELECT
        id, user_id, title, description, status, priority, category_id,
        goal_id, planned_for, notion_page_id, waiting_reason, waiting_until,
        reminder_at, reminder_sent, created_at, updated_at
      FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
    `);
    db.pragma('foreign_keys = ON');
  }
} catch (e) { console.error('[db] tasks FK fix error:', e.message); }

module.exports = db;
