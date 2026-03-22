const db = require('./db');

const MAX_ERRORS = 10;

function logSyncError(userId, message) {
  db.prepare('INSERT INTO sync_errors (user_id, message) VALUES (?, ?)').run(userId, message);
  // Оставляем только последние MAX_ERRORS записей
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
