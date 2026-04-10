const db = require('../connection');

// Максимальное количество хранимых ошибок на пользователя.
// При превышении старые записи удаляются автоматически.
const MAX_ERRORS = 10;

// Записывает ошибку и сразу удаляет лишние — таблица не растёт бесконечно.
// Используется в handlers когда Notion sync падает, чтобы пользователь
// мог посмотреть историю через /settings → Ошибки синхронизации.
function logSyncError(userId, message) {
  db.prepare('INSERT INTO sync_errors (user_id, message) VALUES (?, ?)').run(userId, message);
  db.prepare(`
    DELETE FROM sync_errors WHERE user_id = ? AND id NOT IN (
      SELECT id FROM sync_errors WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    )
  `).run(userId, userId, MAX_ERRORS);
}

function getSyncErrors(userId) {
  return db.prepare(
    'SELECT message, created_at FROM sync_errors WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(userId, MAX_ERRORS);
}

function clearSyncErrors(userId) {
  db.prepare('DELETE FROM sync_errors WHERE user_id = ?').run(userId);
}

module.exports = { logSyncError, getSyncErrors, clearSyncErrors };
