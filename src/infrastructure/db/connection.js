// Единственная точка открытия SQLite соединения.
// Экспортирует один инстанс db — better-sqlite3 синхронный,
// все запросы выполняются в том же потоке без колбэков и промисов.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// DEV=true → data_dev.db, чтобы разработка не трогала продакшен данные.
// DATA_DIR задаётся на Railway где БД живёт на volume (/data).
// По умолчанию файл создаётся в корне проекта.
const dbFile = process.env.DEV === 'true' ? 'data_dev.db' : 'data.db';
const dbDir  = process.env.DATA_DIR || path.join(__dirname, '../../..');
fs.mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, dbFile);

let db;
try {
  db = new Database(dbPath);
  // WAL (Write-Ahead Logging): позволяет читать БД пока идёт запись.
  // Без WAL читатели блокируются на время каждого INSERT/UPDATE.
  db.pragma('journal_mode = WAL');
  // Включаем FK явно — в SQLite они выключены по умолчанию для обратной совместимости.
  db.pragma('foreign_keys = ON');
} catch (e) {
  console.error('[db] FATAL error opening database:', e.message, e.stack);
  process.exit(1);
}

module.exports = db;
