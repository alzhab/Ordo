// Все миграции базы данных в одном файле.
// Запускаются автоматически при каждом старте через src/bot.js.
// Безопасно запускать повторно — используются IF NOT EXISTS и try/catch.
//
// Добавление новой миграции:
//   - Новая таблица → добавь CREATE TABLE IF NOT EXISTS в нужный блок db.exec()
//   - Новое поле → добавь try { ALTER TABLE ... } catch {} в конец файла
//   - SQLite не поддерживает DROP COLUMN и сложные ALTER — если нужно
//     переструктурировать таблицу, пересоздай её как tasks_new ниже.

const db = require('./connection');

// ─── Начальная схема ─────────────────────────────────────────

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

// ─── Инкрементальные ALTER миграции ──────────────────────────
// Каждый ALTER обёрнут в try/catch: SQLite бросает ошибку если колонка
// уже существует, повторный запуск при рестарте не ломает БД.

// Notion sync поля
try { db.exec(`ALTER TABLE tasks ADD COLUMN notion_page_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE plans ADD COLUMN notion_page_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE subtasks ADD COLUMN notion_block_id TEXT`); } catch {}

// Статус waiting и причина/дата ожидания
try { db.exec(`ALTER TABLE tasks ADD COLUMN waiting_reason TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN waiting_until DATE`); } catch {}

// notion_page_id для целей (goals)
try { db.exec(`ALTER TABLE goals ADD COLUMN notion_page_id TEXT`); } catch {}

// Переименование: plan_id → goal_id (задача привязывается к goal, не к plan)
try { db.exec(`ALTER TABLE tasks RENAME COLUMN plan_id TO goal_id`); } catch {}

// ─── Миграция plans → goals ──────────────────────────────────
// Таблица plans переименована в goals. Данные переносятся один раз,
// старая таблица удаляется. При повторном запуске plans уже не существует
// поэтому блок безопасно пропускается.
try {
  const plansExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='plans'`).get();
  if (plansExists) {
    db.exec(`INSERT OR IGNORE INTO goals (id, user_id, title, description, status, notion_page_id, created_at)
             SELECT id, user_id, title, description, status, notion_page_id, created_at FROM plans`);
    db.exec(`DROP TABLE plans`);
  }
} catch (e) { console.error('[db] plans migration error:', e.message); }

// ─── Фаза 7: настройки, повторяющиеся задачи, лог уведомлений ───

db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id         INTEGER PRIMARY KEY REFERENCES users(id),
    morning_time    TEXT    NOT NULL DEFAULT '09:00',
    evening_time    TEXT    NOT NULL DEFAULT '21:00',
    timezone        TEXT    NOT NULL DEFAULT 'Asia/Oral',
    morning_enabled INTEGER NOT NULL DEFAULT 1,
    review_enabled  INTEGER NOT NULL DEFAULT 1,
    quiet_until     TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS recurrent_tasks (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                 INTEGER NOT NULL REFERENCES users(id),
    title                   TEXT    NOT NULL,
    event_time              TEXT    NOT NULL,
    days                    TEXT,             -- JSON массив [0-6], NULL = ежедневно
    day_of_month            INTEGER,          -- 1-31, NULL если не ежемесячно
    reminder_before_minutes INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notification_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id),
    type      TEXT    NOT NULL,  -- 'morning' | 'review' | 'progress'
    task_id   INTEGER REFERENCES tasks(id),
    sent_at   TEXT    DEFAULT (datetime('now')),
    reacted   INTEGER NOT NULL DEFAULT 0
  );
`);

// Поля добавленные после начального релиза Фазы 7
try { db.exec(`ALTER TABLE user_settings ADD COLUMN notion_enabled INTEGER NOT NULL DEFAULT 1`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN reminder_at TEXT`); } catch {}
try { db.exec(`ALTER TABLE tasks ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0`); } catch {}

// Переименование: due_date → planned_for (семантика изменилась: не дедлайн, а дата плана)
try { db.exec(`ALTER TABLE tasks RENAME COLUMN due_date TO planned_for`); } catch {}

// ─── Пересборка таблицы tasks (без priority, без FK на plans) ───
// SQLite не поддерживает DROP COLUMN/DROP CONSTRAINT через ALTER TABLE.
// Пересоздаём таблицу если в её CREATE SQL есть 'plans' (старый FK) или 'priority'.
// Проверка по двум условиям позволяет безопасно пропускать уже выполненную миграцию.
try {
  const tasksDef = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`).get();
  if (tasksDef && (tasksDef.sql.includes('plans') || tasksDef.sql.includes('priority'))) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE tasks_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL REFERENCES users(id),
        title           TEXT    NOT NULL,
        description     TEXT,
        status          TEXT    NOT NULL DEFAULT 'todo',
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
        (id, user_id, title, description, status, category_id,
         goal_id, planned_for, notion_page_id, waiting_reason, waiting_until,
         reminder_at, reminder_sent, created_at, updated_at)
      SELECT
        id, user_id, title, description, status, category_id,
        goal_id, planned_for, notion_page_id, waiting_reason, waiting_until,
        reminder_at, reminder_sent, created_at, updated_at
      FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
    `);
    db.pragma('foreign_keys = ON');
  }
} catch (e) { console.error('[db] tasks rebuild error:', e.message); }
